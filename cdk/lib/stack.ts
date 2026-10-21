import * as path from 'node:path';
import {
  CfnOutput,
  DefaultStackSynthesizer,
  Duration,
  RemovalPolicy,
  Stack,
  StackProps,
  Tags,
  aws_apigateway as apigateway,
  aws_budgets as budgets,
  aws_cloudwatch as cloudwatch,
  aws_cloudwatch_actions as cwActions,
  aws_ec2 as ec2,
  aws_ecs as ecs,
  aws_events as events,
  aws_events_targets as targets,
  aws_iam as iam,
  aws_lambda as lambda,
  aws_lambda_nodejs as nodejs,
  aws_logs as logs,
  aws_s3 as s3,
  aws_sns as sns,
  aws_sns_subscriptions as subs,
} from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { DEFAULT_PERMISSIONS_BOUNDARY, DEFAULT_SHAPES, GrunConfig, costTags, qualifier, stackName } from './config';
import { applyIdentityRules } from './iam';
import { OrgRunners } from './org-runners';
import { RunnerImage, retention } from './runner-image';
import type { SyncConfig } from '../lambda/secret-sync/handler';

export interface GrunStackProps extends StackProps {
  config: GrunConfig;
  /** The private CA as a file, resolved by the caller. */
  caFile?: string;
}

const LAMBDA_ROOT = path.join(__dirname, '..', 'lambda');

export class GrunStack extends Stack {
  public readonly cluster: ecs.Cluster;
  public readonly alertTopic: sns.Topic;
  public readonly orgs: Record<string, OrgRunners> = {};

  constructor(scope: Construct, id: string, props: GrunStackProps) {
    // The stack deploys through the bootstrap of its own qualifier (cdk.qualifier):
    // the roles and the buckets it uses are cdk-<qualifier>-*, which the Deploy
    // boundary (boundary/) names. The bootstrap is the estate's to deploy.
    super(scope, id, { ...props, synthesizer: props.synthesizer ?? new DefaultStackSynthesizer({ qualifier: qualifier(props.config) }) });
    const { config } = props;
    const name = stackName(config);
    if (id !== name) throw new Error(`the stack must be called ${name}`);

    // Every role of the stack: named grun-<env>-..., no path, with the boundary.
    applyIdentityRules(this, config.iam?.permissionsBoundary ?? DEFAULT_PERMISSIONS_BOUNDARY, name);
    // Cost allocation: the budget below filters on the component tag. Each
    // organisation adds its own company tag (see OrgRunners).
    const tagNames = costTags(config);
    Tags.of(this).add(tagNames.componentKey, tagNames.componentValue);
    Tags.of(this).add(tagNames.environmentKey, config.env);

    const shapes = config.shapes ?? DEFAULT_SHAPES;

    // ---- network: an existing VPC, public subnets, no NAT
    const vpc = ec2.Vpc.fromVpcAttributes(this, 'Vpc', {
      vpcId: config.network.vpcId,
      availabilityZones: config.network.availabilityZones,
      publicSubnetIds: config.network.publicSubnetIds,
    });
    const publicSubnets = vpc.publicSubnets;
    let securityGroups: ec2.ISecurityGroup[];
    if (config.network.securityGroupIds?.length) {
      securityGroups = config.network.securityGroupIds.map((sg, i) => ec2.SecurityGroup.fromSecurityGroupId(this, `RunnerSg${i}`, sg));
    } else {
      const sg = new ec2.SecurityGroup(this, 'RunnerSg', {
        vpc,
        description: `${name} runner tasks: no inbound, all outbound`,
        allowAllOutbound: true,
      });
      new CfnOutput(this, 'RunnerSecurityGroupId', {
        description: 'Security group of the runner tasks. Admit it where the runners must reach in (private gateway, EKS endpoint).',
        value: sg.securityGroupId,
      });
      securityGroups = [sg];
    }

    // ---- one cluster for every provider: the task cap counts it
    this.cluster = new ecs.Cluster(this, 'Cluster', {
      clusterName: name,
      vpc,
      enableFargateCapacityProviders: true,
    });

    // ---- alerts
    this.alertTopic = new sns.Topic(this, 'Alerts', { displayName: `${name} alerts` });
    for (const email of config.alerts.emails) this.alertTopic.addSubscription(new subs.EmailSubscription(email));

    // ---- the runner image
    const image = new RunnerImage(this, 'RunnerImage', { config, caFile: props.caFile });

    // ---- reports bucket for the measurement tool (no expiry)
    const reportsBucket = new s3.Bucket(this, 'Reports', {
      bucketName: config.reports?.bucketName,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    // ---- provider selector: routing and the task cap
    const cap = config.costCap ?? {};
    const maxTasks = cap.maxConcurrentTasks ?? 20;
    const selector = new nodejs.NodejsFunction(this, 'ProviderSelector', {
      description: 'Routes a job to the runner shape its label asks for and refuses it when the task cap is reached',
      entry: path.join(LAMBDA_ROOT, 'provider-selector', 'handler.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      timeout: Duration.seconds(10),
      memorySize: 256,
      environment: {
        CLUSTER_ARN: this.cluster.clusterArn,
        MAX_CONCURRENT_TASKS: String(maxTasks),
        ON_EXCEED: cap.onExceed ?? 'skip',
        SHAPE_LABELS: [...shapes].sort((a, b) => a.vcpu - b.vcpu || a.memoryGiB - b.memoryGiB).map((s) => s.label).join(','),
        STACK_NAME: name,
      },
      logGroup: new logs.LogGroup(this, 'ProviderSelectorLogs', {
        retention: retention(config.logRetentionDays ?? 30),
        removalPolicy: RemovalPolicy.DESTROY,
      }),
      bundling: { externalModules: ['@aws-sdk/*'], sourceMap: false },
    });
    selector.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['ecs:ListTasks'],
        resources: ['*'],
        conditions: { ArnEquals: { 'ecs:cluster': this.cluster.clusterArn } },
      }),
    );
    const capRefused = new cloudwatch.Metric({
      namespace: 'Grun',
      metricName: 'CapRefused',
      dimensionsMap: { Stack: name },
      statistic: 'Sum',
      period: Duration.minutes(5),
    });
    new cloudwatch.Alarm(this, 'TaskCapReached', {
      alarmDescription: `${name}: a job was refused because ${maxTasks} runner tasks are already running`,
      metric: capRefused,
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }).addAlarmAction(new cwActions.SnsAction(this.alertTopic));

    // ---- one runner stack per organisation
    for (const org of config.orgs) {
      this.orgs[org.name] = new OrgRunners(this, org.name, {
        config,
        org,
        shapes,
        vpc,
        publicSubnets,
        securityGroups,
        cluster: this.cluster,
        imageBuilder: image.builder,
        providerSelector: selector,
        alertTopic: this.alertTopic,
        reportsBucket,
        firstOrg: org === config.orgs[0],
      });
    }

    // ---- failed image builds go to the same people
    const first = this.orgs[config.orgs[0].name];
    const failedBuilds = first.runners.failedImageBuildsTopic(image);
    for (const email of config.alerts.emails) failedBuilds.addSubscription(new subs.EmailSubscription(email));

    // ---- secret sync: sluis export -> the runners' own secrets
    this.addSecretSync(config);

    // ---- spend guard
    this.addBudget(config, name);

    new CfnOutput(this, 'ReportsBucketName', { value: reportsBucket.bucketName });
    new CfnOutput(this, 'ClusterName', { value: this.cluster.clusterName });
    new CfnOutput(this, 'AlertsTopicArn', { value: this.alertTopic.topicArn });
  }

  private addSecretSync(config: GrunConfig): void {
    const name = stackName(config);
    const syncConfig: Omit<SyncConfig, 'targets'> & { targets: unknown[] } = {
      readerRoleArn: config.sluis.readerRoleArn,
      ssmRegion: config.sluis.region ?? config.region,
      targets: config.orgs.map((org) => {
        const s = this.orgs[org.name].secrets;
        return {
          org: org.name,
          parameter: org.sluisParameter,
          githubSecretId: s.github.secretArn,
          privateKeySecretId: s.privateKey.secretArn,
          webhookSecretId: s.webhook.secretArn,
          runnerLevel: 'org',
        };
      }),
    };
    const fn = new nodejs.NodejsFunction(this, 'SecretSync', {
      description: 'Copies the GitHub Apps from the sluis account into the runners\' Secrets Manager secrets',
      entry: path.join(LAMBDA_ROOT, 'secret-sync', 'handler.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      timeout: Duration.seconds(60),
      memorySize: 256,
      // A deploy that overlaps a run must not run two at once.
      reservedConcurrentExecutions: 1,
      environment: { SYNC_CONFIG: this.toJsonString(syncConfig) },
      logGroup: new logs.LogGroup(this, 'SecretSyncLogs', {
        retention: retention(config.logRetentionDays ?? 30),
        removalPolicy: RemovalPolicy.DESTROY,
      }),
      bundling: { externalModules: ['@aws-sdk/*'], sourceMap: false },
    });
    fn.addToRolePolicy(new iam.PolicyStatement({ actions: ['sts:AssumeRole'], resources: [config.sluis.readerRoleArn] }));
    for (const org of config.orgs) {
      const s = this.orgs[org.name].secrets;
      for (const secret of [s.github, s.privateKey, s.webhook]) {
        secret.grantRead(fn);
        fn.addToRolePolicy(new iam.PolicyStatement({ actions: ['secretsmanager:PutSecretValue'], resources: [secret.secretArn] }));
      }
    }
    // Rotation in sluis has no overlap, and cdk-github-runners redelivers
    // failed webhooks for 30 minutes: stay well inside that window.
    new events.Rule(this, 'SecretSyncSchedule', {
      description: `${name}: sync the GitHub Apps into the runners' secrets`,
      schedule: events.Schedule.rate(Duration.minutes(config.sluis.syncIntervalMinutes ?? 5)),
      targets: [new targets.LambdaFunction(fn)],
    });
    new cloudwatch.Alarm(this, 'SecretSyncFailing', {
      alarmDescription: `${name}: the GitHub App sync is failing; a rotated webhook secret or key will not reach the runners`,
      metric: fn.metricErrors({ period: Duration.minutes(5) }),
      threshold: 1,
      evaluationPeriods: 3,
      datapointsToAlarm: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }).addAlarmAction(new cwActions.SnsAction(this.alertTopic));
  }

  private addBudget(config: GrunConfig, name: string): void {
    const tag = costTags(config);
    // Budgets checks at create time that it may publish to the topic, so the
    // policy must exist before the budget does. The budget only references the
    // topic, which would not order it after the policy.
    const policy = this.alertTopic.addToResourcePolicy(
      new iam.PolicyStatement({
        principals: [new iam.ServicePrincipal('budgets.amazonaws.com')],
        actions: ['sns:Publish'],
        resources: [this.alertTopic.topicArn],
        conditions: { StringEquals: { 'aws:SourceAccount': this.account } },
      }),
    );
    const subscriber = [{ subscriptionType: 'SNS', address: this.alertTopic.topicArn }];
    // A DAILY budget accepts ACTUAL notifications only: AWS rejects FORECASTED
    // on it at create time ("DAILY budget only supports notification type as
    // ACTUAL"), which `cdk synth` cannot see. Do not add a forecast here.
    const notify = (threshold: number) => ({
      notification: { notificationType: 'ACTUAL', comparisonOperator: 'GREATER_THAN', threshold, thresholdType: 'PERCENTAGE' },
      subscribers: subscriber,
    });
    const budget = new budgets.CfnBudget(this, 'DailyBudget', {
      budget: {
        budgetName: `${name}-daily`,
        budgetType: 'COST',
        timeUnit: 'DAILY',
        budgetLimit: { amount: config.costCap?.dailyBudgetUsd ?? 15, unit: 'USD' },
        // Everything tagged as this component. The budget lives in the
        // environment's account, which is what scopes it to the environment.
        // Needs the component cost allocation tag to be activated in Billing.
        costFilters: { TagKeyValue: [`user:${tag.componentKey}$${tag.componentValue}`] },
      },
      notificationsWithSubscribers: [notify(80), notify(100)],
    });
    if (policy.policyDependable) budget.node.addDependency(policy.policyDependable);
    // Fail fast: the budget is created in seconds and API Gateway custom
    // domains with mutual TLS keep provisioning for minutes. A budget that is
    // rejected after the domains exist rolls back into domains that are still
    // updating, which cannot be deleted ("There is already an update in
    // progress for the domain") and leaves the stack in ROLLBACK_FAILED.
    for (const domain of this.node.findAll()) {
      if (domain instanceof apigateway.CfnDomainName) domain.addDependency(budget);
    }
  }
}
