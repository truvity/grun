# grun: GitHub Actions runners on AWS ECS Fargate (cdk-github-runners):
# a CDK app (TypeScript, cdk/), the ci-measure tool (Go, cmd/) and the
# permissions-boundary package (Go, boundary/, its own module).
# `just --list` for an overview.

# Disable go.work (a parent workspace interferes with standalone builds)
export GOWORK := "off"

default:
    @just --list

# Format all Go files
fmt:
    golangci-lint fmt ./cmd/...
    cd boundary && golangci-lint fmt ./...

# Compile check; writes the binary to bin/ci-measure
build:
    go build -o bin/ci-measure ./cmd/ci-measure

# Run unit tests (ci-measure, then the boundary module)
test:
    go test ./cmd/...
    cd boundary && go test ./...

# Run linters. `config verify` first: `run` accepts unknown top-level keys
# silently, so a settings block in the wrong place is otherwise invisible.
lint:
    golangci-lint config verify
    golangci-lint run ./cmd/...
    cd boundary && golangci-lint run ./...

# Go vulnerability check
vuln:
    govulncheck ./cmd/...
    cd boundary && govulncheck ./...

# Why this repository can be public: no particulars in the tree. Own CI job.
leak-canary:
    hack/leak-canary.sh

# Measure runner behaviour from the GitHub API (read-only on GitHub).
# Example: just measure -org my-org -repos my-repo -days 28 -out reports/$(date +%F)/my-repo
measure *ARGS:
    go run ./cmd/ci-measure {{ARGS}}

# Write the Deploy boundary's coverage (allowed IAM namespaces and the
# CloudFormation resource types they cover) for the CDK app's drift test.
# Generated, never committed.
boundary-coverage:
    cd boundary && go run ./cmd/boundary-services -o ../cdk/test/boundary-coverage.generated.json

# Rewrite the boundary golden files after changing a document; review the diff.
boundary-golden:
    cd boundary && go test ./... -update

# CDK app: install the pinned dependencies (a clean, lockfile-exact install).
# The Go recipes above name ./cmd/... on purpose: ./... would walk
# cdk/node_modules.
cdk-install:
    cd cdk && npm ci --no-audit --no-fund

# CDK app: type-check the app, the Lambdas and the tests
cdk-build: cdk-install
    cd cdk && npx tsc --noEmit

# CDK app: unit tests (assertions on the synthesised stack, and the Lambdas)
cdk-test: cdk-install boundary-coverage
    cd cdk && npx vitest run

# CDK app: synthesise the example configuration. Nothing is deployed.
cdk-synth: cdk-install
    cd cdk && npx cdk synth --quiet -c config=config/example.yaml

# CDK app: synthesise an environment's own configuration, e.g.
#   just cdk-synth-config ../gitops/cfg/grun/devel.yaml
cdk-synth-config CONFIG: cdk-install
    c=$(realpath "{{CONFIG}}") && cd cdk && npx cdk synth --quiet -c config="$c"

# CDK app: write the CDK bootstrap template with the permissions boundary on
# every role, generated from the template shipped in the pinned aws-cdk CLI
# (cdk/bootstrap/template.ts). Offline; nothing is deployed. Example:
#   just bootstrap-template /tmp/bootstrap.json
bootstrap-template OUT: cdk-install
    out=$(realpath -m "{{OUT}}") && cd cdk && npx tsx bootstrap/template.ts "$out"

# CDK app: bootstrap an account and region with the generated template, so the
# boundary named BOUNDARY (a policy that must already exist in the account) is
# on every bootstrap role. `cdk bootstrap` runs the app, hence the CONFIG.
# Changes the account: a person or an agent runs this, never CI. Example:
#   just bootstrap <account> <region> <boundary policy name> <path>/<env>.yaml
bootstrap ACCOUNT REGION BOUNDARY CONFIG: cdk-install
    #!/usr/bin/env bash
    set -euo pipefail
    cfg=$(realpath "{{CONFIG}}")
    tpl=$(mktemp --suffix=.json)
    trap 'rm -f "$tpl"' EXIT
    cd cdk
    npx tsx bootstrap/template.ts "$tpl"
    npx cdk bootstrap "aws://{{ACCOUNT}}/{{REGION}}" \
      --custom-permissions-boundary "{{BOUNDARY}}" \
      --template "$tpl" \
      -c config="$cfg"

# All the checks CI runs
check: build test lint vuln leak-canary cdk-build cdk-test cdk-synth
