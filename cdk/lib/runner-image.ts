import { Duration, Stack, aws_codebuild as codebuild, aws_iam as iam, aws_logs as logs } from 'aws-cdk-lib';
import {
  Architecture,
  BaseContainerImage,
  IConfigurableRunnerImageBuilder,
  Os,
  RunnerImageBuilder,
  RunnerImageBuilderType,
  RunnerImageComponent,
  RunnerVersion,
} from '@cloudsnorkel/cdk-github-runners';
import { Construct } from 'constructs';
import { AGENT_TARGET, COMPLETED_HOOK, STARTED_HOOK, agentBundle } from './agent';
import { GrunConfig } from './config';

export interface ParsedRepository {
  host: string;
  region: string;
  account: string;
  path: string;
}

/** Splits <account>.dkr.ecr.<region>.amazonaws.com/<path>. */
export function parseEcrRepository(repository: string): ParsedRepository {
  const m = /^([a-z0-9-]+)\.dkr\.ecr\.([a-z0-9-]+)\.amazonaws\.com\/(.+)$/.exec(repository);
  if (!m) throw new Error(`not an ECR repository reference: ${repository}`);
  return { host: `${m[1]}.dkr.ecr.${m[2]}.amazonaws.com`, region: m[2], account: m[1], path: m[3] };
}

export interface RunnerImageProps {
  config: GrunConfig;
  /** The private CA as a file, when the config names one. */
  caFile?: string;
}

/**
 * The runner image, built by cdk-github-runners' CodeBuild image builder
 * (Linux, arm64) on top of ci-plane's runner image.
 *
 * ci-plane keeps owning the content: nix, devbox, the docker client, git-lfs.
 * The builder's components add what its container contract needs: the runner
 * layout and the job hooks (githubRunner), the packages the hooks use
 * (requiredPackages), the CloudWatch agent, and the private CA. The runner
 * user already exists in the base image, so runnerUser() is left out.
 *
 * The base image is pulled through the account's ECR pull-through cache. The
 * CodeBuild project runs outside any VPC (the builder refuses public subnets
 * and the build needs none).
 *
 * Rebuild triggers: the builder hashes the base image reference with every
 * component, so a new runnerImage.version in the config changes the build
 * spec and the deploy rebuilds. The weekly schedule rebuilds the same tag to
 * pick up the newest runner release and OS updates; GitHub stops accepting
 * runners that are more than 30 days behind.
 *
 * SOCI: the builder indexes the pushed image after the build (it downloads
 * CloudSnorkel's standalone-soci-indexer release; there is nothing to enable).
 */
export class RunnerImage extends Construct {
  public readonly builder: IConfigurableRunnerImageBuilder;

  constructor(scope: Construct, id: string, props: RunnerImageProps) {
    super(scope, id);
    const { config } = props;
    const img = config.runnerImage;
    const repo = parseEcrRepository(img.repository);
    const stack = Stack.of(this);

    // The base image ends with USER runner, while the builder's component
    // scripts install packages and need root. Switch to root first and back
    // to runner last (the provider also starts the container as runner).
    const components: RunnerImageComponent[] = [
      RunnerImageComponent.custom({ name: 'RootUser', dockerCommands: ['USER root'] }),
      RunnerImageComponent.requiredPackages(),
      RunnerImageComponent.githubRunner(
        !img.runnerVersion || img.runnerVersion === 'latest' ? RunnerVersion.latest() : RunnerVersion.specific(img.runnerVersion),
      ),
    ];
    // grun-agent (agent/): the per-job sampler and the runner's warnings and errors,
    // started and stopped by the job hooks, run by the runner's own Node.
    components.push(
      RunnerImageComponent.custom({ name: 'GrunAgent', assets: [{ source: agentBundle(), target: AGENT_TARGET }] }),
      RunnerImageComponent.jobStartedHook(STARTED_HOOK),
      RunnerImageComponent.jobCompletedHook(COMPLETED_HOOK),
    );
    if (img.cloudWatchAgent ?? true) components.push(RunnerImageComponent.cloudWatchAgent());
    if (props.caFile) {
      components.push(RunnerImageComponent.extraCertificates(props.caFile, img.extraCertificates?.name ?? 'private-ca'));
    }
    components.push(
      RunnerImageComponent.custom({
        name: 'RunnerOwnership',
        // The runner archive and the hooks were unpacked as root over the
        // base image's runner directory; the runner user must own all of it.
        commands: ['chown -R runner:runner /home/runner /opt/hostedtoolcache'],
        dockerCommands: ['USER runner'],
      }),
    );

    this.builder = RunnerImageBuilder.new(this, 'Builder', {
      os: Os.LINUX_UBUNTU,
      architecture: Architecture.ARM64,
      builderType: RunnerImageBuilderType.CODE_BUILD,
      baseDockerImage: BaseContainerImage.fromString(`${img.repository}:${img.version}`),
      // The builder logs in to its own registry; the base image may live elsewhere.
      dockerSetupCommands: [
        `aws ecr get-login-password --region ${repo.region} | docker login --username AWS --password-stdin ${repo.host}`,
      ],
      components,
      rebuildInterval: Duration.days(img.rebuildIntervalDays ?? 7),
      logRetention: retention(config.logRetentionDays ?? 30),
      codeBuildOptions: {
        computeType:
          (img.computeType ?? 'BUILD_GENERAL1_LARGE') === 'BUILD_GENERAL1_SMALL' ? codebuild.ComputeType.SMALL : codebuild.ComputeType.LARGE,
      },
    });

    // Pulling through the cache creates the cached repository on first use and
    // imports the upstream layers: more than a plain pull.
    this.builder.grantPrincipal.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: [
          'ecr:BatchGetImage',
          'ecr:GetDownloadUrlForLayer',
          'ecr:BatchCheckLayerAvailability',
          'ecr:BatchImportUpstreamImage',
          'ecr:CreateRepository',
        ],
        resources: [stack.formatArn({ service: 'ecr', region: repo.region, account: repo.account, resource: 'repository', resourceName: repo.path })],
      }),
    );
    this.builder.grantPrincipal.addToPrincipalPolicy(new iam.PolicyStatement({ actions: ['ecr:GetAuthorizationToken'], resources: ['*'] }));
  }

  /**
   * The builder's CodeBuild project, which a failed-build alert has to watch.
   *
   * The library creates it as the builder's child 'CodeBuild' when the first
   * provider binds the image, so call this after the providers exist. Its own
   * alert (RunnerStack.failedImageBuildsTopic) is a CodeStar Notifications
   * rule, which races the creation of that service's service-linked role on a
   * fresh account; the stack watches the project with EventBridge instead. A
   * library that moves the child fails the synth here rather than silently
   * losing the alert.
   */
  buildProject(): codebuild.IProject {
    const project = (this.builder as unknown as Construct).node.tryFindChild('CodeBuild');
    if (!(project instanceof codebuild.Project)) {
      throw new Error('the image builder has no CodeBuild project to watch (unused, or cdk-github-runners changed its layout)');
    }
    return project;
  }
}

export function retention(days: number): logs.RetentionDays {
  const map: Record<number, logs.RetentionDays> = {
    1: logs.RetentionDays.ONE_DAY,
    3: logs.RetentionDays.THREE_DAYS,
    5: logs.RetentionDays.FIVE_DAYS,
    7: logs.RetentionDays.ONE_WEEK,
    14: logs.RetentionDays.TWO_WEEKS,
    30: logs.RetentionDays.ONE_MONTH,
    60: logs.RetentionDays.TWO_MONTHS,
    90: logs.RetentionDays.THREE_MONTHS,
    120: logs.RetentionDays.FOUR_MONTHS,
    150: logs.RetentionDays.FIVE_MONTHS,
    180: logs.RetentionDays.SIX_MONTHS,
    365: logs.RetentionDays.ONE_YEAR,
  };
  const r = map[days];
  if (r === undefined) throw new Error(`unsupported log retention: ${days} days`);
  return r;
}
