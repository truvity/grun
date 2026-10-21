# grun

GitHub Actions self-hosted runners on AWS ECS Fargate, deployed with
[cdk-github-runners](https://github.com/CloudSnorkel/cdk-github-runners), plus
`ci-measure`, a tool that measures how runners behave.

| Part | Status | What it is |
|---|---|---|
| `cmd/ci-measure` | available | Go tool: start latency, duration, minutes, step breakdown and estimated cost of workflow jobs, read from the GitHub REST API |
| [`cdk/`](cdk/README.md) | available | CDK app (TypeScript): the cdk-github-runners deployment for ECS Fargate, its runner image, the GitHub App secret sync, cost guards |
| [`boundary/`](boundary) | available | Go module `github.com/truvity/grun/boundary` (its only dependency is the standard-library-only `aws-structure/policy` module): the IAM permissions boundaries the stack needs, as policy documents generated from parameters |

This repository is public and generic. It holds mechanism only: account ids,
bucket names, hostnames and organisation-specific configuration are inputs
supplied by the caller and live in the operator's own configuration
repository, not here. `hack/leak-canary.sh` runs in CI and fails the build if a
particular slips in.

## The CDK app

`cdk/` deploys one stack, `grun-<env>`, with one
[cdk-github-runners](https://github.com/CloudSnorkel/cdk-github-runners)
`GitHubRunners` construct per GitHub organisation. Runners are ephemeral ECS
Fargate ARM tasks in the public subnets of an existing VPC (no NAT), started by
`workflow_job` webhooks.

What it builds, in short:

- **Providers**: `fg-large` (4 vCPU / 24 GB), `fg-medium` (2 / 14), `fg-small`
  (1 / 6) per organisation, each with ephemeral storage sized for builds and a
  task role per organisation whose policies come from the configuration.
- **Runner image**: cdk-github-runners' CodeBuild image builder (Linux arm64)
  on top of [ci-plane](https://github.com/truvity/ci-plane)'s runner image, taken
  through the account's ECR pull-through cache, plus the runner layout, job
  hooks, CloudWatch agent and (optionally) a private CA. A new ci-plane version
  in the configuration rebuilds the image on the next deploy; a weekly schedule
  keeps the GitHub runner current. cdk-github-runners indexes the pushed image
  for SOCI.
- **GitHub Apps from elsewhere**: a scheduled Lambda (every 5 minutes) assumes a
  reader role, reads each organisation's App from SSM and writes it into the
  Secrets Manager secrets cdk-github-runners reads. The setup wizard is off.
- **Webhook**: an API Gateway custom domain per organisation, mutual TLS (for
  Cloudflare Authenticated Origin Pulls), default endpoint disabled.
- **Guards**: a provider-selector Lambda routes by label and refuses a job when
  the cluster already runs the configured number of tasks; a daily AWS Budget
  with alerts; alarms; log retention everywhere.
- **Identity**: every IAM role is `grun-<env>-...` with no path and carries the
  permissions boundary stack-wide.
- **Warm capacity**: runners started ahead of demand on a weekly schedule.
- **Reports bucket** (no expiry) for `ci-measure`.

Details, the full configuration reference and the known limits are in
[`cdk/README.md`](cdk/README.md).

### How deploy works

The repository holds mechanism only. An environment's configuration (accounts,
VPC and subnet ids, ECR registry, endpoints, certificates, policies) lives in
the operator's own configuration repository and is passed at synth time:

```sh
# from a checkout of the configuration repository, in an environment with
# credentials for the target account
cd <path-to>/grun/cdk
npm ci
npx cdk diff   -c config=<path-to-gitops>/cfg/grun/devel.yaml
npx cdk deploy -c config=<path-to-gitops>/cfg/grun/devel.yaml
```

A person or an agent runs this; there is no pipeline that deploys. Before
deploying, check the prerequisites in the "Before the first deploy" section of
[`cdk/README.md`](cdk/README.md). `just cdk-synth-config <path>` synthesises a
configuration without deploying it.

## Permissions boundaries

The stack runs under two IAM permissions boundaries, and this repository
declares their shape so that the people who create them do not have to guess
what the stack needs. The Go module `github.com/truvity/grun/boundary` (its own
`go.mod`, versioned by tags `boundary/vX.Y.Z`; its only dependency is
`github.com/truvity/aws-structure/policy`, a standard-library-only module) renders
each as a typed `policy.Document` from parameters. It knows no account, name or
environment: every name is an input.

| Boundary | Put on | Allows |
|---|---|---|
| **Runtime** (`boundary.Runtime`) | the stack's own roles, `<rolePrefix>*` (state machines, Lambda functions, ECS tasks) | everything except IAM writes; the two exceptions are `iam:PassRole` of the stack's roles to ECS tasks and creating the ECS service-linked role |
| **Deploy** (`boundary.Deploy`) | the CDK bootstrap roles, `cdk-<qualifier>-*` (CloudFormation execution, deploy, file and image publishing, lookup) | an allow list: the stack's services, and in IAM only the stack's roles, created only with the Runtime boundary |

The documents are the component's part only. The estate's own guards (no edit
of a boundary policy, no removal of a boundary from a role or user) are
appended by whatever creates the boundaries, so each document is held to 5,000
characters minified (IAM's limit is 6,144) and the constructors return an
error beyond that.

```go
p := boundary.Params{
    RolePrefix:          "grun-",             // the stack's role names start with it
    RuntimeBoundaryName: "<runtime boundary policy name>",
    Qualifier:           "<cdk qualifier>",   // the CDK default is hnb659fds
    ReadParameterPaths:  []string{"<ssm path>/*"}, // optional, no leading slash
    ReadBuckets:         []string{"<bucket>"},     // optional
    Partition:           "aws",
}
runtime, err := boundary.Runtime(p) // a policy.Document, for RuntimeBoundaryName
deploy, err := boundary.Deploy(p)   // a policy.Document, for the bootstrap roles' boundary
body, err := json.Marshal(deploy)   // canonical minified JSON, ready for a managed policy
```

To wire them in a consumer:

1. **Create the boundaries** as customer managed policies from the two
   documents (plus your own guards). `RuntimeBoundaryName` is the name you
   give the Runtime policy; the Deploy policy takes any name you like.
2. **Bootstrap CDK** with the generated template, so the Deploy boundary is
   on every bootstrap role: `just bootstrap <account> <region> <deploy boundary
   name> <config>` (see "The bootstrap template" below). Plain
   `cdk bootstrap --custom-permissions-boundary` is not enough: CDK's default
   template applies the boundary to the CloudFormation execution role only.
3. **Set `iam.permissionsBoundary`** in the stack's configuration to the
   Runtime boundary's name. Every role the stack creates then carries it, and
   the Deploy boundary refuses to create a `<rolePrefix>*` role without it.

### The bootstrap template

`cdk bootstrap --custom-permissions-boundary <name>` sets the template's
`InputPermissionsBoundary` parameter, and CDK's default bootstrap template uses
it for `CloudFormationExecutionRole` only. `FilePublishingRole`,
`ImagePublishingRole`, `LookupRole` and `DeploymentActionRole` are created with
no boundary. Where people may create only roles that carry an approved boundary,
the bootstrap fails with an explicit deny on the first of them.

`cdk/bootstrap/template.ts` generates the template that fixes this, from the
one the pinned `aws-cdk` CLI ships (`cdk/node_modules`, so the input is fixed by
`package-lock.json`; no network). It loads it with CDK's own
`cloudformation-include` (`CfnInclude`) under `BootstraplessSynthesizer`, which
adds no `BootstrapVersion` parameter, no `CheckBootstrapVersion` rule and no
asset metadata, then copies the execution role's `PermissionsBoundary` to every
`AWS::IAM::Role` (and `AWS::IAM::User`) that has none. It fails if the
execution role has no `PermissionsBoundary` to copy, so a CLI release that moves
it is noticed rather than guessed past. Nothing else changes: the output equals
the shipped template except for the added properties (a test compares them), and
the boundary stays conditional on the parameter, so bootstrapping without
`--custom-permissions-boundary` still creates unbounded roles. The output is
JSON, which CloudFormation and `cdk bootstrap --template` accept.

```sh
# write the template (offline)
just bootstrap-template <out.json>

# bootstrap: generates the template to a temporary file, then runs
#   cdk bootstrap aws://<account>/<region> --custom-permissions-boundary <name> \
#     --template <generated> -c config=<config>
just bootstrap <account> <region> <deploy boundary name> <path>/<env>.yaml
```

The boundary policy must exist in the account before bootstrapping. `cdk
bootstrap` runs the app, which is why `bootstrap` takes the configuration.
After an `aws-cdk` upgrade, bootstrap again if the shipped template's version
rose: the generated template follows the CLI.

The Deploy boundary lists services (CloudFormation, API Gateway, CloudWatch,
CodeBuild, DynamoDB, ECS, EventBridge, Lambda, Logs, Secrets Manager, SNS, SQS,
Step Functions and a few more) rather than resources, because CloudFormation
generates most physical names. A change to the stack that adds a resource of
another service would fail at deploy time, so `cdk/test/boundary-drift.test.ts`
fails first: it compares every resource type of the synthesised example stack
with the coverage the Go package writes (`just boundary-coverage`). When it
fails, widen `boundary/deploy.go` (and `limitedTypes` in
`boundary/coverage.go` for a narrowly allowed service), run
`just boundary-golden`, review the diff, and update the boundary in the account
before deploying.

`boundary/testdata/earlier-runtime.json` is the Runtime boundary as an
earlier tool rendered it; a test shows the Runtime document equals it except
for the two guard statements the caller now appends.

## ci-measure

Read-only on GitHub. Every API response is cached on disk (`.cache/gh`), so
re-running a report costs no API quota. Reports are written as Markdown plus
CSV files to a local directory; keep them out of git (`reports/` is ignored).

You need Go and a GitHub token with read access to the repositories and their
Actions data (`gh auth login` is enough; the tool reads the token from the
environment or from `gh`).

```sh
# Build once
just build

# Estimate the API calls and see which repositories match, without fetching
just measure -org my-org -repos my-repo -days 28 -dry-run

# Measure one or several repositories over the last 28 days
just measure -org my-org -repos repo-a,repo-b -days 28 -out reports/$(date +%F)/baseline

# Every non-archived private repository of the organisation
just measure -org my-org -repos all -visibility private -days 14 -out reports/$(date +%F)/all
```

`go run ./cmd/ci-measure -h` lists every flag. The ones you usually need:

| Flag | Meaning |
|---|---|
| `-org` | GitHub organisation (default `truvity`) |
| `-repos` | comma-separated names, or `all` |
| `-visibility` | with `-repos all`: `private`, `public` or `all` |
| `-days`, `-from`, `-to` | the window (UTC days) |
| `-out` | output directory |
| `-costs` | JSON file overriding the label cost table |
| `-min-remaining` | stop when the rate limit drops below this many calls |
| `-dry-run` | list repositories and estimate API calls, then exit |

### Cost model

Costs are estimates. The built-in label table and rates are examples: runner
labels such as `arc-large` or `fg-medium` are placeholders, and self-hosted
rates are an assumed all-in range per runner-minute. Pass your own table with
`-costs costs.json`:

```json
{
  "labels": {
    "my-runners-large": { "kind": "arc", "min_per_min": 0.005, "max_per_min": 0.012 },
    "my-fargate-small": { "kind": "fargate", "vcpu": 1, "gb": 6 }
  },
  "fargate_vcpu_hour": 0.03725,
  "fargate_gb_hour": 0.00409
}
```

`kind` is `arc` (self-hosted pool with a per-minute range), `fargate` (priced
from the task shape, per second with a minimum) or `hosted` (GitHub-hosted,
not costed).

## Development

Tools come from [devbox](https://www.jetify.com/devbox); recipes from
[just](https://just.systems).

```sh
devbox shell
just check   # build, test, lint, vuln, leak-canary, cdk-build, cdk-test, cdk-synth: what CI runs
                # (test, lint and vuln cover the boundary module too)
```

The CDK app is the one place this repository uses Node and npm rather than the
estate's usual JavaScript tooling: CDK in TypeScript is what cdk-github-runners
is built for. Dependencies are pinned to exact versions in
`cdk/package-lock.json`; `just cdk-install` installs them with `npm ci`. The Go
recipes name `./cmd/...` so that they never walk `cdk/node_modules`.

## Licence

MIT, see [LICENSE](LICENSE).
