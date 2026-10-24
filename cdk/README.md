# grun CDK app

One stack per environment, `grun-<env>`, built from a configuration file that is
passed at synth time:

```sh
npx cdk synth  -c config=<path>/<env>.yaml
npx cdk diff   -c config=<path>/<env>.yaml
npx cdk deploy -c config=<path>/<env>.yaml
```

`config/example.yaml` is a documented example with placeholder values (it is
what CI synthesises); `config/schema.json` is the schema and `lib/config.ts`
the same contract as TypeScript types. Nothing environment-specific is in this
repository.

## Layout

| Path | What |
|---|---|
| `bin/grun.ts` | the app: loads the configuration and creates the stack |
| `lib/stack.ts` | the stack: network import, cluster, alerts, image, selector, secret sync, budget, one `OrgRunners` per organisation |
| `lib/org-runners.ts` | one organisation: providers per shape, task roles, `GitHubRunners`, warm pools, alarms |
| `lib/runner-image.ts` | the CodeBuild image builder and its components |
| `lib/access.ts` | webhook access: API Gateway custom domain with mutual TLS |
| `lib/iam.ts` | role naming (`grun-<env>-...`, no path) and the permissions boundary |
| `lib/config.ts` | configuration type, defaults, validation |
| `lambda/provider-selector/` | routing by label and the task cap |
| `lambda/secret-sync/` | GitHub Apps from SSM into Secrets Manager |
| `test/` | unit tests (`aws-cdk-lib/assertions` on the synthesised stack, the Lambdas) |

## Before the first deploy

The stack imports things it does not create. These must exist (the
configuration names them):

1. A VPC with public subnets (one per availability zone listed). Runner tasks
   get a public IP; there is no NAT. If the tasks must reach private services,
   admit the runner security group (the stack output `RunnerSecurityGroupId`, or
   your own, listed in `network.securityGroupIds`) on the other side.
2. The permissions boundary policy (default name `pb@tech-grun`) in the account. The Go module `boundary/` renders the document, and the bootstrap roles' own boundary; see "Permissions boundaries" in the root README.
   CDK itself must be bootstrapped for the qualifier in `cdk.qualifier`, with the Deploy boundary on every bootstrap role (root README, "The bootstrap"): the estate deploys it, and CDK's own template leaves four of the five bootstrap roles without the boundary.
3. An ECR pull-through cache for the registry that holds ci-plane's runner
   image, and the image tag named in `runnerImage.version`.
4. For each organisation: an ACM certificate for its webhook domain in the stack
   region; the GitHub App created and installed (its credentials in the SSM
   parameter named by `sluisParameter`); and a reader role in the account that
   holds the parameters, which trusts the `grun-*` roles of this account and may
   `ssm:GetParameter` on exactly those parameters and decrypt them
   (`sluis.readerRoleArn`).
5. An S3 object holding the Cloudflare origin-pull CA bundle (PEM)
   (`webhook.mtls`). The deploying principal must be able to read it: API Gateway
   fetches the trust store during the deployment.
6. Optionally, a JSON secret with the build farm's client certificate
   (`buildkit.clientCertSecret`) and the private CA PEM (`runnerImage.extraCertificates`).
7. In Billing, activate the cost allocation tags `component` and `company`
   (and `environment`, if you want to break spend down by it) in the account
   that runs the stack. The key names are `costTags.componentKey`,
   `costTags.companyKey` and `costTags.environmentKey`; activate whatever the
   configuration says if it differs from these defaults. The daily budget
   filters on `<componentKey>=<componentValue>` (default `component=ci`);
   without the activation it sees no spend. Activation takes up to a day and
   only covers spend from then on.
8. If you use `runner.secretEnv`: the SSM SecureString parameters it names, in
   the stack's account and region, filled by whatever owns them. They need not
   exist at deploy time, but a task fails to start while one is missing.

After the deploy:

- Point DNS at the API Gateway regional domain names printed in the outputs
  (`Webhook<Org>RegionalDomainName`), proxied through Cloudflare with
  Authenticated Origin Pulls on.
- Confirm the alert subscription emails (SNS sends a confirmation to each
  address, once: the alert topic carries every alert, a failed runner image
  build included).
- The App credentials arrive within one sync interval (5 minutes). Until then
  the webhook rejects deliveries; GitHub keeps them for redelivery.

## Configuration reference

Every field the environment's configuration file can set. Required fields are
marked; everything else has the default shown. The schema is authoritative.

| Field | | Meaning |
|---|---|---|
| `env` | required | environment name; the stack is `grun-<env>` and every role `grun-<env>-...` |
| `region` | required | stack region |
| `account` | | account id; default: the account of the credentials |
| `network.vpcId` | required | existing VPC |
| `network.availabilityZones` | required | its zones |
| `network.publicSubnetIds` | required | one public subnet per zone, same order |
| `network.securityGroupIds` | | existing security groups for the tasks; default: the stack creates one with no inbound rule |
| `iam.permissionsBoundary` | `pb@tech-grun` | boundary policy name, applied to every role |
| `cdk.qualifier` | `hnb659fds` | the CDK bootstrap qualifier the stack deploys through (roles and buckets `cdk-<qualifier>-*`); 1 to 10 lowercase letters and digits |
| `sluis.readerRoleArn` | required | role the sync Lambda assumes |
| `sluis.region` | stack region | region of the SSM parameters |
| `sluis.syncIntervalMinutes` | 5 | sync schedule; keep it well under 30 (see below) |
| `runnerImage.repository` | required | `<account>.dkr.ecr.<region>.amazonaws.com/<cache prefix>/<path>` of ci-plane's runner image |
| `runnerImage.version` | required | its tag; changing it rebuilds the image on the next deploy |
| `runnerImage.runnerVersion` | `latest` | GitHub runner version baked in |
| `runnerImage.rebuildIntervalDays` | 7 | scheduled rebuild (0 disables); keep it well under GitHub's 30-day limit on old runners |
| `runnerImage.computeType` | `BUILD_GENERAL1_LARGE` | CodeBuild size of the image build |
| `runnerImage.cloudWatchAgent` | true | install the CloudWatch agent |
| `runnerImage.extraCertificates.path` / `.pem` | | private CA to trust: a file (relative to the configuration file) or the PEM itself. Also sets `NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt` on every task, since Node does not read the system store |
| `runnerImage.extraCertificates.name` | `private-ca` | |
| `shapes[]` | the six below | `label`, `vcpu`, `memoryGiB`, `ephemeralStorageGiB` (21 to 200), `spot` (false: on-demand; true: Fargate Spot, see "Fargate Spot") |
| `requireSelfHostedLabel` | false | false lets a job say `runs-on: fg-large` alone |
| `logRetentionDays` | 30 | every log group (the runner tasks' own: see `runner.logRetentionDays`) |
| `runnerEnvironment.goproxy` | | `CI_RUNNER_GOPROXY` |
| `runnerEnvironment.npmRegistry` | | `CI_RUNNER_NPM_REGISTRY` |
| `runnerEnvironment.nixSubstituter` | | URL of a Nix binary cache in front of cache.nixos.org (ci-plane's cache-redirect serves one under `/nix`). Sets `NIX_CONFIG` on every task to `substituters = <url> https://cache.nixos.org/` and `connect-timeout = 5`: the cache first, the upstream as the automatic fallback, no image rebuild (the image's nix is a single-user install, so NIX_CONFIG applies as it is). Narinfos keep the upstream's signatures, so Nix's default trusted key verifies them |
| `runnerEnvironment.mavenRegistry` | | `CI_RUNNER_MAVEN_REGISTRY`: the base of a Maven pull-through cache with one path per upstream (`<base>/central`, `/google`, `/gradle-plugins`; a name of its own with no path, such as `https://maven.cache.example.test`, which ci-plane's cache-redirect serves at the root of its Maven front-end). The shared `setup-devbox` step (truvity/ci-actions) probes it and points Gradle builds at it through an init script; a cache that does not answer is a warning, never a failed job. Read-only for the jobs, so any tier |
| `runnerEnvironment.gradleBuildCache` | | `CI_RUNNER_GRADLE_BUILD_CACHE`: the URL of Gradle's remote build cache (a name of its own with no path, such as `https://gradle.cache.example.test`: ci-plane's cache-redirect serves it at the root of its build cache front-end), registered by the same step with push on. **Writable by the jobs**: name the cache of this stack's own environment, so a tier reads only what its own jobs wrote (the preview and stable tiers each have their own cache-redirect and bucket). A build still turns the build cache on itself (`org.gradle.caching=true`) |
| `runnerEnvironment.bazelRemoteCache` | | `CI_RUNNER_BAZEL_REMOTE_CACHE` |
| `runnerEnvironment.remoteBuilders` | | `CI_RUNNER_REMOTE_BUILDERS` |
| `runnerEnvironment.goCacheBucket` | | `CI_RUNNER_GOCACHE_S3_BUCKET`: the bucket of the Go build cache and the archive caches of this runner. truvity/ci-actions prefers it over the caller's organisation variable, so one organisation variable serves tiers that each have a bucket of their own. The task role must be allowed to use it |
| `runnerEnvironment.goCacheRegion` | | `CI_RUNNER_GOCACHE_S3_REGION`; needs `goCacheBucket` |
| `runnerEnvironment.buildxCache` | | `CI_RUNNER_BUILDX_CACHE`: the registry reference of the BuildKit cache (`<registry>/<repository>`). The shared workflows prefer it over the caller's variable |
| `runnerEnvironment.extra` | | more variables for every task |
| `buildkit.tlsDir` | `/etc/ci-buildkit-tls` | `CI_BUILDKIT_TLS_DIR`; holds `ca.pem`, `cert.pem`, `key.pem` |
| `buildkit.tlsServerName` | | `CI_BUILDKIT_TLS_SERVERNAME` |
| `runner.secretEnv` | | `{ENV_NAME: SSM parameter name or ARN}`: ECS injects each as that environment variable when a task starts (see below) |
| `runner.idleTimeoutMinutes` | 5 (the library's) | minutes a registered runner may stay idle before the idle reaper stops it and removes it from GitHub (see "Runner hygiene") |
| `runner.logRetentionDays` | `logRetentionDays` | retention of the runner tasks' log groups (the runner and init containers' stdout); the orchestration functions, the state machine and the image builder keep `logRetentionDays` |
| `runner.traceToStdout` | false | `ACTIONS_RUNNER_PRINT_LOG_TO_STDOUT` on every task. The upstream runner image sets it to 1, which copies the listener's and the worker's whole diagnostic trace (`[RUNNER …]` / `[WORKER …]`, INFO included) to stdout and so into the task's log group: nearly all of what those groups ingest. Off, stdout keeps the runner's terminal output (start-up, `Running job`, `Job … completed`, its error lines) and the hooks' lines; the trace is still written to `_diag` in the task, where cdk-github-runners reads the job's result |
| `runner.requeue` | true | the requeue function (see "Runner hygiene"): a runner again for a job still queued after the runner started for it went away |
| `runner.secretKmsKeyArn` | | key that encrypts those parameters; the execution role gets `kms:Decrypt` on it. Omit for the AWS-managed SSM key |
| `telemetry.otlpEndpoint`, `telemetry.issuerUrl` | | where grun-agent sends the runner's warnings and errors and each job's peaks (OTLP/HTTP JSON, `/v1/logs` and `/v1/metrics`), and the issuer whose `<issuerUrl>/token` trades the task role's web identity token for an access token (RFC 8693). Set, the task roles may call `sts:GetWebIdentityToken` for `stsAudience` (ES384, at most 300 s). Absent: the peaks are printed in the job log and nothing is sent (see "grun-agent") |
| `telemetry.stsAudience` | `issuerUrl` | audience asked of STS |
| `telemetry.otlpAudience` | `otlp` | audience and exchange client id of the access token |
| `telemetry.sampleSeconds` | 5 | seconds between two samples of the task's stats |
| `costTags.componentKey`, `componentValue` | `component`, `ci` | the stack tag `<componentKey>=<componentValue>`; the daily budget filters on it |
| `costTags.environmentKey` | `environment` | the stack tag `<environmentKey>=<env>` |
| `costTags.companyKey` | `company` | each organisation's resources and runner tasks carry `<companyKey>=<organisation name>` |
| `buildkit.clientCertSecret.arn` | | JSON secret; with `caKey`, `certKey`, `keyKey` naming its fields (defaults `ca`, `cert`, `key`) |
| `costCap.maxConcurrentTasks` | 20 | task cap |
| `costCap.onExceed` | `skip` | `skip` or `defer` (see below) |
| `costCap.dailyBudgetUsd` | 15 | daily AWS Budget |
| `alerts.emails` | required | alert recipients: alarms, budget, and failed runner image builds (an EventBridge rule on the image builder's CodeBuild project: `FAILED`, `FAULT` or `TIMED_OUT`; a stopped build is not an alert) |
| `warm.startHourUtc`, `startMinuteUtc`, `weekDays`, `durationHours` | 6, 0, `MON-FRI`, 12 | warm window (UTC) |
| `warm.pools[]` | | `shape` and `count` each |
| `webhook.mtls.truststoreBucket`, `truststoreKey`, `truststoreVersion` | bucket and key required | Cloudflare origin-pull CA bundle in S3 |
| `reports.bucketName` | generated | reports bucket name |
| `reports.taskRolesCanWrite` | true | task roles may read and write the reports bucket |
| `dashboard` | true | CloudWatch dashboard and saved Logs Insights queries |
| `orgs[].name` | required | GitHub organisation (organisation-level registration) |
| `orgs[].sluisParameter` | required | SSM parameter with the App (`app_id`, `installation_id`, `private_key`, `webhook_secret`) |
| `orgs[].webhook.domainName`, `.certificateArn` | required | custom domain and its ACM certificate |
| `orgs[].taskRole.managedPolicyArns` | | managed policies for the organisation's runner task roles |
| `orgs[].taskRole.statements` | | IAM policy statements (JSON form) for them |
| `orgs[].environment` | | extra variables for this organisation's tasks |
| `orgs[].warm` | true | give this organisation the warm pools |
| `orgs[].runnerGroup` | the organisation's default group | GitHub runner group the runners register in (see "Runner groups and labels") |
| `orgs[].allow` | absent: unrestricted | non-empty list of `{repository: owner/name, workflows?: [names], refs?: [globs]}`: a runner is started only for a job of one of these repositories (see "Runner hygiene") |

Default shapes: `fg-large` 4 vCPU / 12 GB / 100 GiB, `fg-medium` 2 / 8 / 50,
`fg-small` 1 / 4 / 50, `fg-xsmall` 0.5 / 1 / 21, `fg-medium-spot` 2 / 8 / 50 on
Fargate Spot and `fg-xlarge` 8 / 16 / 100. Fargate takes only certain CPU and memory pairs; an
invalid pair fails at deploy.

### Fargate Spot

A shape with `spot: true` runs its tasks on the `FARGATE_SPOT` capacity provider of the
stack's cluster (cdk-github-runners' `spot` option, ARM64 on Spot since 2024-09), at
the Spot discount on every vCPU-hour and GB-hour. The price is the failure model:

- **A Spot interruption fails the job.** ECS stops the task (two minutes' warning, which
  the runner does not use), the runner dies and the job ends as a failure or
  a lost-runner or shutdown-signal error. GitHub does not retry it, and the
  requeue (`runner.requeue`) starts a runner again only for a job that is still queued
  after its runner went away, not for a job that was running. The way to recover is a
  rerun of the job.
- So Spot belongs where a rerun is cheap and nobody is waiting: the preview tier, and
  there first the fleet jobs (Renovate, parity). Never a stable tier (its configuration
  should refuse a Spot shape), never a warm pool (the config check refuses it).
- A job picks Spot by its label alone (`fg-medium-spot`); the provider selector treats
  it as any other shape. The task role, the environment and grun-agent are the same
  as the on-demand shape's, and the role's name (`<stack>-<org>-fg-medium-spot-task`) must
  be admitted by whoever runs the telemetry issuer like any other.
- The agent's records carry the shape in `size`, so Spot and on-demand jobs compare by
  that label.

### Runner groups and labels

Two stacks serving one GitHub organisation (two tiers, say) each have their own
GitHub App, and GitHub sends every `workflow_job` of the organisation to every
App installed on the repository. What keeps a job from starting a runner in both
stacks is the label: a provider starts a runner only for a job that carries all
of its labels (`<shape label>`, `linux`, `arm64`). So **give each stack shape
labels of its own** (`shapes[].label`, for example a different prefix per tier);
a label two stacks share is a job that both of them serve. The label is also
what a workflow puts in `runs-on`, so it is the tier a job chooses.

`orgs[].runnerGroup` registers the organisation's runners in a GitHub runner
group instead of the default group, and the group's repository access then
decides which repositories the runners may serve (a pilot on one repository, for
example). The group is made in GitHub (organisation settings, or `POST
/orgs/{org}/actions/runner-groups`), not by this app, and must exist before the
first job: a runner that cannot join its group does not start. The App needs the
organisation permission "Self-hosted runners: read and write" it already needs
for registration. A job from a repository the group does not admit never gets
the runner, which then waits and is torn down at its timeout; to avoid the
waste, install the App on the same repositories (a selected installation).

### grun-agent

Every task carries `agent/grun-agent.ts`, bundled with esbuild at synth time into one
file (`/opt/grun/grun-agent.js` in the image) and run by the GitHub runner's own Node
(`externals/node<N>`), so it needs nothing else from the image. cdk-github-runners'
user job hooks start and stop it (`agent/job-started.sh`, `agent/job-completed.sh`).
It is fail-open: it never fails, blocks or noticeably slows a job, and its own errors
go to `~/.grun-agent/agent.log` of the runner user in the task.

- **Peaks, per job (one task is one job).** Every `telemetry.sampleSeconds` it reads
  `${ECS_CONTAINER_METADATA_URI_V4}/task/stats` and keeps the task's peak memory (all
  containers, less the inactive page cache, and with it), peak CPU over one interval
  and the average. The job-completed hook prints them as one line,
  `::notice title=grun peak::fg-medium 2 vCPU / 8192 MiB: memory 3120 MiB peak (38%) …`,
  which is also a check-run annotation (`GET /repos/{owner}/{repo}/check-runs/{job id}/annotations`).
- **The runner's warnings and errors.** With the trace off stdout
  (`runner.traceToStdout`), the runner still writes it to `_diag`. Every 30 seconds the
  agent reads what `Runner_*.log` and `Worker_*.log` gained and keeps the `WARN`, `ERR`
  and `CRIT` records with their continuation lines (a stack trace), at most 1000 per task.
  Records written before the job started are included; a task that never gets a job, and
  what the runner writes after the job-completed hook, are not.
- **Time at the CPU cap, the disk, the job's name** (added 2026-10-24; fields are only
  ever added to the record, never renamed). The CPU rate over each sampling interval is
  compared with the task's vCPU: the seconds of intervals at 95 % or more of it are
  `cpu_at_cap_s`, out of `cpu_measured_s` seconds measured (`cpu_at_cap_fraction` is
  their ratio). A job shorter than the task stats' own refresh (about 6 s) would report
  no CPU at all, because the endpoint serves cached readings; the agent then takes the
  runner container's cgroup CPU time (`cpu.stat` or `cpuacct`) at the start and at the
  end and reports its average as both figures, `cpu_source=cgroup` (otherwise
  `task-stats`, or `none`). Disk is `statfs` of `/` (`GRUN_DISK_PATH` changes it): the
  used bytes at the first reading (`disk_start_mib`: the image and its layers), at the
  peak (`peak_disk_mib`) and the size of the volume (`disk_total_mib`); a job's own use is
  the difference. The job's display name with its matrix values
  (`recipes / ci-verify`, `test (go, 1.27)`) is `job_name`; `GITHUB_JOB` (the job id) stays
  `job` in the resource. The name is read from the job message the runner's Worker
  traces into `_diag/Worker_*.log`, and the field is absent when it is not there.
- **Telemetry** (`telemetry`): the records as OTLP logs every minute, and at the end the
  peaks as gauges (`grun_job_memory_peak_bytes`, `grun_job_memory_usage_peak_bytes`,
  `grun_job_cpu_peak_cores`, `grun_job_cpu_average_cores`, `grun_job_duration_seconds`,
  `grun_task_vcpu`, `grun_task_memory_bytes`, `grun_job_cpu_at_cap_seconds`,
  `grun_job_disk_peak_bytes`; labels `tier`, `org`, `size`, `repo`,
  `workflow`, `workflow_job`) and one log event (`event=grun.job.peak` with the numbers).
  Every log carries the resource `service.name=grun`, `tier`, `org`, `size`, `repo`,
  `workflow`, `job`, `run_id`, `run_attempt`, `runner`, `task_id`. The token: the task
  role's `sts:GetWebIdentityToken` (audience `stsAudience`, ES384, 300 s), traded at
  `<issuerUrl>/token` (client `otlpAudience`, empty password) for an access token for
  `otlpAudience`, renewed a minute before it expires. Whoever runs the issuer must grant
  each task role (`<stack>-<org>-<shape>-task`) the client.

### Runner hygiene

Two settings narrow what a runner of this stack can be used for. `orgs[].allow`
decides which jobs start a runner at all: for a tier that admits only reviewed
workflows (a release tier) it is the fence, enforced before any capacity is
spent. `runner.idleTimeoutMinutes` shrinks the window in which a runner that
nobody picked up can be handed a job it was not started for.

**`runner.idleTimeoutMinutes`** is cdk-github-runners' `idleTimeout`. Every
runner start queues a check for the idle reaper; the reaper looks at the runner
on GitHub and, when it is registered, **not busy** and has been registered for
longer than the timeout (it measures from the `cdkghr:started` label, that is
from registration, not from the start of the task), stops the runner's Step
Functions execution and deletes the runner from GitHub, after which the task
powers itself off. It does **not** stop a runner that is busy (a long job is
never cut), a runner that has not registered yet (it is checked again later),
or a warm runner (those carry their pool's duration as their own limit; a job
that reaches a warm runner is unaffected). The point: a runner started for a
job that GitHub then cancelled or gave to another runner is registered and
idle, and until the reaper removes it any later job that matches its labels
can land on it. The default is five minutes; two minutes is enough for a task
that registers within a minute. The value reaches the webhook Lambda
(`IDLE_TIMEOUT_SECONDS`) and the Step Functions default. Too small a value
removes a runner that is still waiting for GitHub to hand it its job, so the
job queues again, so keep it above the registration time of the slowest shape.

**`runner.requeue`** (on by default) covers what the reaper leaves behind.
GitHub sends a job's `workflow_job` queued webhook once, when the job is
created, and the stack starts one runner for it. A matrix with `max-parallel`
creates all its jobs at once but dispatches only so many at a time, so its last
jobs become runnable after their runners were reaped, and without another
webhook they stay queued until somebody cancels them (seen on a renovate fleet
of 18 jobs at `max-parallel: 4`: the last two queued all night). The requeue
function runs every five minutes. For each run of which a runner of this stack
ended in the last 30 minutes without a job (aborted `IdleRunner`) or failed to
start, it reads the run's jobs as the organisation's App and starts, through the
same state machine and with the webhook's input, one runner per job of the same
label set that is still queued, less the runners still running for that run.
Runners are interchangeable within a label set, which is why it counts per run
and not per job: a stranded job's own runner has usually served another job. It
leaves alone a completed run (a re-run can leave queued records in one), a job
queued for more than six hours, and anything beyond the task cap (the next round
tries again). A runner it starts that is still not handed a job is reaped like
any other and the next round starts another, so a waiting job costs one idle
task per round. Its log lines (`Queued jobs without a runner`, `Started a runner
for a queued job`) are in its own log group, and it alarms after three failed
rounds.

**`orgs[].allow`** is the webhook allow-list, checked by the provider selector
before it routes the job or looks at capacity. A job whose repository is not
listed (compared without case) starts nothing: the selector returns no
provider and logs one CloudWatch embedded metric, `Grun` / `AllowRefused`
(dimension `Stack`; `organization`, `repository`, `workflow` and `ref` are
plain properties for Logs Insights, not dimensions). There is no alarm on it on
purpose: a refused job is the list doing its job, and a typo in the list shows
as a job that waits, which the metric explains. When an entry has
`workflows`, the job's `workflow_job.workflow_name` must equal one of them
exactly (case-sensitive). When it has `refs`, the job's `workflow_job.head_branch`
(the tag name for a tag push) must match one glob, in which `*` matches any
characters including `/` and nothing else is special. An organisation without
`allow` is unrestricted. All organisations of a stack share one selector, so
the lists travel as one JSON variable keyed by organisation login
(`ALLOW_LIST`; an organisation without a list is `null` in it); as soon as any
organisation has a list, a job from a login that is not in the file at all is
refused (fail closed). `head_branch` is only a hint, because a branch can be
named like a tag; the repository check is the hard part and `workflows` and
`refs` narrow it. The list does not govern warm runners: they bypass the
selector and register at organisation level, so the runner group's repository
access is what limits them.

## Design notes

**Identity.** The stack name is `grun-<env>`. An aspect gives every IAM role
that has no explicit name a name `grun-<env>-<construct path>-<hash>` within 64
characters, no path; the task roles are `grun-<env>-<org>-<shape>-task`.
`PermissionsBoundary.of(stack)` puts the boundary on every role. The boundary
allows `iam:PassRole` only for `grun-*` roles and only to ECS tasks, which is
exactly what the Step Functions state machine does when it starts a task.

**Task roles.** cdk-github-runners creates one task definition per provider and
there is no property to share a role between them, so each organisation has one
task role per shape, all with the same policies from the configuration.

**One cluster.** All providers share one ECS cluster (`grun-<env>`). The task
cap counts the tasks in it.

**Runner image.** The base image ends in `USER runner`; the builder's component
scripts install packages and need root, so the image build starts with `USER
root`, runs the components, fixes ownership of `/home/runner` and returns to
`USER runner`. The base must therefore keep a `runner` user with its home at
`/home/runner`. The base image is pulled through the ECR pull-through cache; the
CodeBuild role may import from and create the cached repository. The build runs
outside any VPC.

**Client certificate files.** ECS can inject a secret only as an environment
variable. For `buildkit.clientCertSecret` each task gets an init container (the
runner image itself) that writes `ca.pem`, `cert.pem` and `key.pem` to a volume
shared with the runner container and exits; the runner container waits for it.
The files are readable by every process in the task, which is the point: the
job's tools are the clients of the build farm.

**Cost tags.** The stack carries `component=ci` and `environment=<env>`; every
resource under an organisation carries `company=<organisation name>`, and so
does every runner task: the task definition has the tag, the state machine
propagates it (`PropagateTags: TASK_DEFINITION`), and the provider also sends it
with `RunTask` itself, so a library change that stopped propagating would not
untag the tasks. A test asserts the propagation. Tags show in Cost Explorer once
activated in Billing (step 7 above).

**Secrets from SSM.** `runner.secretEnv` maps a variable name to an SSM
parameter (SecureString), for example a build farm client certificate that
cert-manager issues and an external secrets operator writes to the Parameter
Store:

```yaml
runner:
  secretEnv:
    CI_BUILDKIT_TLS_CA_PEM: /<path>/ca
    CI_BUILDKIT_TLS_CERT_PEM: /<path>/cert
    CI_BUILDKIT_TLS_KEY_PEM: /<path>/key
  secretKmsKeyArn: arn:<partition>:kms:<region>:<account>:key/<id>   # optional
```

Each entry becomes a container `secrets` entry of the runner container in every
task definition of every organisation. ECS reads the parameter when the task
starts and puts the value in the container's environment; the task definition
holds only the parameter's ARN, so the value is in no template, no plain
environment and no log. The task execution role (not the task role, so jobs
cannot read the parameters) gets `ssm:GetParameters` and friends on exactly
these parameters, and `kms:Decrypt` on `secretKmsKeyArn` when it is set. An ARN
is reduced to its parameter name in the stack's own account and region. Plain
variables, such as `CI_BUILDKIT_TLS_SERVERNAME`, go in `buildkit.tlsServerName`
or `runnerEnvironment.extra`; the same name in both places is refused.

**Provider selector.** Called by the webhook for each queued job. It picks the
provider whose labels contain the job's shape label (the larger one if a job
names two; cdk-github-runners' default choice if it names none), then counts the
cluster's pending and running tasks (`ecs:ListTasks`). At or over the cap it
returns no provider, which skips the job, and writes a CloudWatch embedded
metric (`Grun` / `CapRefused`) that an alarm turns into an alert. With
`costCap.onExceed: defer` it fails instead, so the webhook delivery fails and
cdk-github-runners redelivers it for 30 minutes. The cap is soft: jobs that
arrive within the same second all see the same count, and warm runners bypass
the selector (they count towards the cap but are not refused by it). The
spend guard is the daily budget; AWS Budgets data lags by up to a day.

**Secret sync.** `lambda/secret-sync` assumes the reader role, reads each
organisation's SSM parameter, and writes three secrets per organisation:
`github` (`{domain, appId, personalAuthToken: "", runnerLevel: "org"}`),
`githubPrivateKey` (the PEM) and `webhook` (`{webhookSecret}`). It compares the
SHA-256 of the desired and current value and writes only on change, logs only
organisation names and outcomes, and runs with reserved concurrency 1. Webhook
secret rotation upstream has no overlap, so for a short time deliveries are
signed with a secret the runners do not yet know; cdk-github-runners redelivers
failed deliveries for 30 minutes, and the 5 minute schedule fits inside that.

**Warm capacity.** EventBridge rules run in UTC, so the window is given in UTC:
the default (06:00 UTC for 12 hours, Monday to Friday) covers 08:00 to 19:00 in
Amsterdam in both summer and winter time, with an hour of slack at one end.
Exact local-time scheduling would need EventBridge Scheduler, which
cdk-github-runners' `ScheduledWarmRunner` does not use.

## cdk-github-runners limits met

- **Custom domain and mutual TLS**: not offered by `LambdaAccess.apiGateway()`.
  `LambdaAccess` is an abstract class meant to be implemented, so `lib/access.ts`
  provides `CustomDomainApiAccess`: a `LambdaRestApi` with a regional custom
  domain, TLS 1.2, a mutual TLS trust store from S3 and the execute-api endpoint
  disabled. DNS is not managed here.
- **Existing secrets**: the `Secrets` construct creates its own secrets and takes
  no existing ones, hence the sync Lambda.
- **Several `GitHubRunners` in one stack**: supported, but the orchestrator log
  group and the dashboard's metric searches are stack singletons, so the
  dashboard and saved queries are created once (by the first organisation).
- **SOCI**: the CodeBuild builder indexes the pushed image after the build, with
  CloudSnorkel's `standalone-soci-indexer` (downloaded at build time from the
  latest GitHub release, so it is not pinned). Whether Fargate on Arm uses the
  index is to be confirmed by measuring a cold start. The index is skipped when
  the image carries a `DISABLE_SOCI` label.
- **Scheduled warm runners** have no deploy-time fill, and take UTC schedules.
- **Task environment**: there is no property for extra environment variables,
  container secrets or extra containers on the Fargate provider; the app uses
  the provider's `container` and `task` fields (`addEnvironment`, `addSecret`), which the library marks as internal. A library
  upgrade may need this code adjusted (the tests will say).

## Development

```sh
just cdk-install   # npm ci
just cdk-build     # tsc --noEmit
just cdk-test      # vitest
just cdk-synth     # synthesise config/example.yaml
```

Synthesis bundles the two Lambdas with esbuild; no Docker is needed.
