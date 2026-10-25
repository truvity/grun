import {
  Duration,
  Tags,
  aws_cloudwatch as cloudwatch,
  aws_cloudwatch_actions as cwActions,
  aws_ec2 as ec2,
  aws_ecs as ecs,
  aws_events as events,
  aws_iam as iam,
  aws_lambda as lambda,
  aws_s3 as s3,
  aws_kms as kms,
  aws_secretsmanager as secretsmanager,
  aws_sns as sns,
  aws_ssm as ssm,
} from 'aws-cdk-lib';
import {
  FargateRunnerProvider,
  GitHubRunners,
  IConfigurableRunnerImageBuilder,
  LambdaAccess,
  ScheduledWarmRunner,
} from '@cloudsnorkel/cdk-github-runners';
import { Construct } from 'constructs';
import { CustomDomainApiAccess } from './access';
import { FARGATE_DEFAULT_STORAGE_GIB, GrunConfig, OrgConfig, SYSTEM_CA_BUNDLE, Shape, costTags, nixConfig, stackName, taskRoleName } from './config';
import { retention } from './runner-image';

export interface OrgRunnersProps {
  config: GrunConfig;
  org: OrgConfig;
  shapes: Shape[];
  vpc: ec2.IVpc;
  publicSubnets: ec2.ISubnet[];
  securityGroups: ec2.ISecurityGroup[];
  cluster: ecs.Cluster;
  imageBuilder: IConfigurableRunnerImageBuilder;
  providerSelector: lambda.IFunction;
  alertTopic: sns.ITopic;
  reportsBucket: s3.IBucket;
  /** True for the first organisation: it owns the stack-wide dashboard. */
  firstOrg: boolean;
}

/** The runner environment of one organisation's tasks: cache endpoints, the buildkit client settings, extras. */
export function runnerEnvironment(config: GrunConfig, org: OrgConfig): Record<string, string> {
  const e = config.runnerEnvironment ?? {};
  const env: Record<string, string> = {};
  if (e.goproxy) env.CI_RUNNER_GOPROXY = e.goproxy;
  if (e.npmRegistry) env.CI_RUNNER_NPM_REGISTRY = e.npmRegistry;
  // The image's nix.conf lists only the upstream cache; this overlay (it wins) puts the
  // env's pull-through cache first. Task environment, so no image rebuild.
  if (e.nixSubstituter) env.NIX_CONFIG = nixConfig(e.nixSubstituter);
  // Gradle: the Maven pull-through cache and the remote build cache. The shared setup-devbox
  // step probes each, exports CI_MAVEN_REGISTRY / CI_GRADLE_BUILD_CACHE and installs an init
  // script. A tier that must not read a cache its jobs can write sets only the first.
  if (e.mavenRegistry) env.CI_RUNNER_MAVEN_REGISTRY = e.mavenRegistry;
  if (e.gradleBuildCache) env.CI_RUNNER_GRADLE_BUILD_CACHE = e.gradleBuildCache;
  if (e.bazelRemoteCache) env.CI_RUNNER_BAZEL_REMOTE_CACHE = e.bazelRemoteCache;
  if (e.remoteBuilders) env.CI_RUNNER_REMOTE_BUILDERS = e.remoteBuilders;
  // The runner's own caches: the shared actions prefer these over the caller's organisation
  // variables, so each tier reads and writes only its own bucket and registry cache.
  if (e.goCacheBucket) env.CI_RUNNER_GOCACHE_S3_BUCKET = e.goCacheBucket;
  if (e.goCacheRegion) env.CI_RUNNER_GOCACHE_S3_REGION = e.goCacheRegion;
  if (e.buildxCache) env.CI_RUNNER_BUILDX_CACHE = e.buildxCache;
  // Node (installed by proto or devbox, not the system one) does not read the
  // system store that holds the private CA; the ARC runners exported this too.
  if (config.runnerImage.extraCertificates) env.NODE_EXTRA_CA_CERTS = SYSTEM_CA_BUNDLE;
  const bk = config.buildkit;
  if (bk?.clientCertSecret) env.CI_BUILDKIT_TLS_DIR = bk.tlsDir ?? '/etc/ci-buildkit-tls';
  if (bk?.tlsServerName) env.CI_BUILDKIT_TLS_SERVERNAME = bk.tlsServerName;
  // The upstream runner image sets ACTIONS_RUNNER_PRINT_LOG_TO_STDOUT=1, which copies the
  // listener's and the worker's whole trace (INFO included) to stdout and so into the log
  // group; the runner writes the same trace to _diag in the task either way, and the job's
  // output lives in GitHub. Off unless runner.traceToStdout asks for it.
  env.ACTIONS_RUNNER_PRINT_LOG_TO_STDOUT = config.runner?.traceToStdout ? 'true' : 'false';
  // grun-agent (agent/): who the task is, and where its telemetry goes. GRUN_SIZE is
  // per shape (OrgRunners).
  env.GRUN_TIER = config.env;
  env.GRUN_ORG = org.name;
  env.GRUN_REGION = config.region;
  const t = config.telemetry;
  if (t) {
    env.GRUN_OTLP_ENDPOINT = t.otlpEndpoint;
    env.GRUN_OTLP_ISSUER = t.issuerUrl;
    env.GRUN_OTLP_STS_AUDIENCE = t.stsAudience ?? t.issuerUrl;
    env.GRUN_OTLP_AUDIENCE = t.otlpAudience ?? 'otlp';
    if (t.sampleSeconds) env.GRUN_SAMPLE_SECONDS = String(t.sampleSeconds);
  }
  return { ...env, ...(e.extra ?? {}), ...(org.environment ?? {}) };
}

/**
 * Everything for one GitHub organisation: a Fargate ARM provider per shape
 * (each with the organisation's task role), one GitHubRunners construct whose
 * webhook is served on the organisation's own domain, and the warm pools.
 */
export class OrgRunners extends Construct {
  public readonly runners: GitHubRunners;
  public readonly providers: Record<string, FargateRunnerProvider> = {};
  public readonly taskRoles: iam.IRole[] = [];

  constructor(scope: Construct, id: string, props: OrgRunnersProps) {
    super(scope, id);
    const { config, org } = props;
    const tagNames = costTags(config);
    // Everything of this organisation carries the company tag (task
    // definitions, log groups, the webhook, ...).
    Tags.of(this).add(tagNames.companyKey, org.name);
    const env = runnerEnvironment(config, org);
    const logRetention = retention(config.logRetentionDays ?? 30);
    // The runner tasks' own log groups may keep less than the orchestration's.
    const taskLogRetention = retention(config.runner?.logRetentionDays ?? config.logRetentionDays ?? 30);

    for (const shape of props.shapes) {
      const provider = new FargateRunnerProvider(this, shape.label, {
        labels: [shape.label, 'linux', 'arm64'],
        group: org.runnerGroup,
        imageBuilder: props.imageBuilder,
        vpc: props.vpc,
        subnetSelection: { subnets: props.publicSubnets },
        assignPublicIp: true,
        securityGroups: props.securityGroups,
        cluster: props.cluster,
        cpu: Math.round(shape.vcpu * 1024),
        memoryLimitMiB: Math.round(shape.memoryGiB * 1024),
        // The library takes 21 to 200 (and puts 25 in for none); 20 is left out below.
        ephemeralStorageGiB: Math.max(shape.ephemeralStorageGiB ?? 50, FARGATE_DEFAULT_STORAGE_GIB + 1),
        spot: shape.spot ?? false,
        logRetention: taskLogRetention,
        // The task definition carries the tag too and the state machine
        // propagates it (PropagateTags), but the tag here rides on RunTask
        // itself, so a task is tagged even if propagation is ever dropped.
        tags: { [tagNames.companyKey]: org.name },
      });
      this.providers[shape.label] = provider;
      // 20 GiB is what Fargate gives a task with no ephemeral storage setting, free of charge;
      // it cannot be set explicitly (the minimum of the setting is 21), so it is left out.
      if (shape.ephemeralStorageGiB === FARGATE_DEFAULT_STORAGE_GIB) {
        (provider.task.node.defaultChild as ecs.CfnTaskDefinition).addPropertyDeletionOverride('EphemeralStorage');
      }

      // The container and task are marked internal by the library but are the
      // only handle on the task definition; there is no property for them.
      for (const [k, v] of Object.entries(env)) provider.container.addEnvironment(k, v);
      provider.container.addEnvironment('GRUN_SIZE', shape.label);
      this.addClientCertificate(provider, config);
      this.addSecretEnvironment(provider, config);

      // Task role: named for the pass-role rule of the permissions boundary,
      // with the organisation's policies from the config.
      const role = provider.task.taskRole;
      (role.node.defaultChild as iam.CfnRole).roleName = taskRoleName(config, org.name, shape.label);
      for (const arn of org.taskRole?.managedPolicyArns ?? []) {
        role.addManagedPolicy(iam.ManagedPolicy.fromManagedPolicyArn(this, `${shape.label}-${arn.split('/').pop()}`, arn));
      }
      for (const s of org.taskRole?.statements ?? []) {
        role.addToPrincipalPolicy(iam.PolicyStatement.fromJson(s));
      }
      if (config.reports?.taskRolesCanWrite ?? true) props.reportsBucket.grantReadWrite(role);
      // grun-agent's telemetry: a web identity token for the issuer's audience only, with
      // the algorithm and lifetime the agent asks for. sts:IdentityTokenAudience is
      // multi-valued, hence ForAllValues (safe: the audience is a required parameter).
      if (config.telemetry) {
        role.addToPrincipalPolicy(
          new iam.PolicyStatement({
            sid: 'OutboundIdentityTokenForTelemetry',
            actions: ['sts:GetWebIdentityToken'],
            resources: ['*'],
            conditions: {
              'ForAllValues:StringEquals': { 'sts:IdentityTokenAudience': config.telemetry.stsAudience ?? config.telemetry.issuerUrl },
              StringEquals: { 'sts:SigningAlgorithm': 'ES384' },
              NumericLessThanEquals: { 'sts:DurationSeconds': '300' },
            },
          }),
        );
      }
      this.taskRoles.push(role);
    }

    this.runners = new GitHubRunners(this, 'Runners', {
      providers: Object.values(this.providers),
      requireSelfHostedLabel: config.requireSelfHostedLabel ?? false,
      providerSelector: props.providerSelector,
      idleTimeout: config.runner?.idleTimeoutMinutes !== undefined ? Duration.minutes(config.runner.idleTimeoutMinutes) : undefined,
      logOptions: { logRetention },
      webhookAccess: new CustomDomainApiAccess({
        domainName: org.webhook.domainName,
        certificateArn: org.webhook.certificateArn,
        truststore: {
          bucket: config.webhook.mtls.truststoreBucket,
          key: config.webhook.mtls.truststoreKey,
          version: config.webhook.mtls.truststoreVersion,
        },
        outputPrefix: `Webhook${pascal(org.name)}`,
      }),
      // The setup wizard is not used: the Apps come from sluis.
      setupAccess: LambdaAccess.noAccess(),
      // The status function stays invokable by role; it returns sensitive detail, so it has no URL.
      statusAccess: LambdaAccess.noAccess(),
    });

    if (config.warm && (org.warm ?? true)) {
      const w = config.warm;
      w.pools.forEach((pool, i) => {
        new ScheduledWarmRunner(this, `Warm-${pool.shape}-${i}`, {
          runners: this.runners,
          provider: this.providers[pool.shape],
          count: pool.count,
          owner: org.name,
          registrationLevel: 'org',
          schedule: events.Schedule.cron({
            minute: String(w.startMinuteUtc ?? 0),
            hour: String(w.startHourUtc ?? 6),
            weekDay: w.weekDays ?? 'MON-FRI',
          }),
          duration: Duration.minutes(Math.round((w.durationHours ?? 12) * 60)),
        });
      });
    }

    // Alarms: a failing management function means jobs may not get a runner;
    // a failed runner start means a job is stuck waiting.
    const alarmAction = new cwActions.SnsAction(props.alertTopic);
    const lambdaErrors = new cloudwatch.Alarm(this, 'ManagementLambdaErrors', {
      alarmDescription: `${stackName(config)}/${org.name}: a cdk-github-runners management function failed; jobs may not get runners`,
      metric: this.runners.metricLambdaErrors({ period: Duration.minutes(5) }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    lambdaErrors.addAlarmAction(alarmAction);
    const failedRunners = new cloudwatch.Alarm(this, 'RunnersFailedToStart', {
      alarmDescription: `${stackName(config)}/${org.name}: runner executions are failing`,
      metric: this.runners.metricFailed({ period: Duration.minutes(15) }),
      threshold: 3,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    failedRunners.addAlarmAction(alarmAction);

    // The orchestrator log group and the dashboard's searches are shared by
    // every GitHubRunners in the stack (they are stack singletons), so the
    // dashboard and the saved queries are made once, by the first organisation.
    if ((config.dashboard ?? true) && props.firstOrg) {
      this.runners.createLogsInsightsQueries(stackName(config));
      this.runners.createDashboard(stackName(config));
    }
  }

  /** Secrets Manager secrets the sync Lambda fills for this organisation. */
  public get secrets(): { github: secretsmanager.ISecret; privateKey: secretsmanager.ISecret; webhook: secretsmanager.ISecret } {
    const s = this.runners.secrets;
    return { github: s.github, privateKey: s.githubPrivateKey, webhook: s.webhook };
  }

  /**
   * Variables ECS fills from SSM Parameter Store when the task starts
   * (runner.secretEnv). The library has no property for container secrets, so
   * this uses the same container handle as the plain environment. The task
   * definition holds the parameter reference only; the execution role (not the
   * task role) is granted read on exactly these parameters, plus kms:Decrypt
   * on runner.secretKmsKeyArn when it is set.
   */
  private addSecretEnvironment(provider: FargateRunnerProvider, config: GrunConfig): void {
    const entries = Object.entries(config.runner?.secretEnv ?? {});
    if (entries.length === 0) return;
    const key = config.runner?.secretKmsKeyArn
      ? kms.Key.fromKeyArn(this, `${provider.node.id}-secret-key`, config.runner.secretKmsKeyArn)
      : undefined;
    for (const [name, ref] of entries) {
      const parameter = ssm.StringParameter.fromSecureStringParameterAttributes(this, `${provider.node.id}-${name}`, {
        parameterName: parameterNameOf(ref),
        encryptionKey: key,
      });
      provider.container.addSecret(name, ecs.Secret.fromSsmParameter(parameter));
    }
  }

  /**
   * Mounts the build-farm client certificate as ca.pem, cert.pem and key.pem
   * in one directory. ECS can only inject a secret as an environment variable,
   * so an init container (the runner image itself) writes the three files to a
   * volume shared with the runner container, then exits. The runner container
   * waits for it to succeed.
   */
  private addClientCertificate(provider: FargateRunnerProvider, config: GrunConfig): void {
    const cert = config.buildkit?.clientCertSecret;
    if (!cert) return;
    const dir = config.buildkit?.tlsDir ?? '/etc/ci-buildkit-tls';
    const secret = secretsmanager.Secret.fromSecretCompleteArn(this, `${provider.node.id}-client-cert`, cert.arn);
    const task = provider.task;
    task.addVolume({ name: 'ci-buildkit-tls' });
    const init = task.addContainer('tls-init', {
      image: ecs.ContainerImage.fromEcrRepository(provider.image.imageRepository, provider.image.imageTag),
      essential: false,
      user: 'root',
      entryPoint: ['sh', '-c'],
      command: [
        'set -eu; umask 022; ' +
          'printf "%s\\n" "$TLS_CA" > "$TLS_DIR/ca.pem"; ' +
          'printf "%s\\n" "$TLS_CERT" > "$TLS_DIR/cert.pem"; ' +
          'printf "%s\\n" "$TLS_KEY" > "$TLS_DIR/key.pem"; ' +
          'chmod 0644 "$TLS_DIR"/ca.pem "$TLS_DIR"/cert.pem "$TLS_DIR"/key.pem',
      ],
      environment: { TLS_DIR: dir },
      secrets: {
        TLS_CA: ecs.Secret.fromSecretsManager(secret, cert.caKey ?? 'ca'),
        TLS_CERT: ecs.Secret.fromSecretsManager(secret, cert.certKey ?? 'cert'),
        TLS_KEY: ecs.Secret.fromSecretsManager(secret, cert.keyKey ?? 'key'),
      },
      logging: ecs.LogDriver.awsLogs({ logGroup: provider.logGroup, streamPrefix: 'tls-init' }),
    });
    init.addMountPoints({ sourceVolume: 'ci-buildkit-tls', containerPath: dir, readOnly: false });
    provider.container.addMountPoints({ sourceVolume: 'ci-buildkit-tls', containerPath: dir, readOnly: true });
    provider.container.addContainerDependencies({ container: init, condition: ecs.ContainerDependencyCondition.SUCCESS });
  }
}

/** The parameter name of a name or an ARN (the name keeps its leading slash when it has one). */
export function parameterNameOf(ref: string): string {
  if (!ref.startsWith('arn:')) return ref;
  const i = ref.indexOf(':parameter/');
  return ref.slice(i + ':parameter'.length);
}

export function pascal(s: string): string {
  return s
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((p) => p[0].toUpperCase() + p.slice(1))
    .join('');
}
