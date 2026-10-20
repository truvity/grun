# grun

GitHub Actions self-hosted runners on AWS ECS Fargate, deployed with
[cdk-github-runners](https://github.com/CloudSnorkel/cdk-github-runners), plus
`ci-measure`, a tool that measures how runners behave.

| Part | Status | What it is |
|---|---|---|
| `cmd/ci-measure` | available | Go tool: start latency, duration, minutes, step breakdown and estimated cost of workflow jobs, read from the GitHub REST API |
| CDK app (TypeScript) | planned | The cdk-github-runners deployment for ECS Fargate |

This repository is public and generic. It holds mechanism only: account ids,
bucket names, hostnames and organisation-specific configuration are inputs
supplied by the caller and live in the operator's own configuration
repository, not here. `hack/leak-canary.sh` runs in CI and fails the build if a
particular slips in.

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
just check   # build, test, lint, vuln, leak-canary: what CI runs
```

## Licence

MIT, see [LICENSE](LICENSE).
