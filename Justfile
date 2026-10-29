# grun: GitHub Actions runners on AWS ECS Fargate (cdk-github-runners):
# a CDK app (TypeScript, cdk/), the ci-measure tool (Go, cmd/) and the
# permissions-boundary package (Go, boundary/, its own module) and the
# config schema's Go validator (cdk/config/, its own module).
# `just --list` for an overview.

# Disable go.work (a parent workspace interferes with standalone builds)
export GOWORK := "off"

default:
    @just --list

# Format all Go files
fmt:
    golangci-lint fmt ./cmd/...
    cd boundary && golangci-lint fmt ./...
    cd cdk/config && golangci-lint fmt ./...

# Compile check; writes the binary to bin/ci-measure
build:
    go build -o bin/ci-measure ./cmd/ci-measure

# Run unit tests (ci-measure, then the boundary and config modules)
test:
    go test ./cmd/...
    cd boundary && go test ./...
    cd cdk/config && go test ./...

# Run linters. `config verify` first: `run` accepts unknown top-level keys
# silently, so a settings block in the wrong place is otherwise invisible.
lint:
    golangci-lint config verify
    golangci-lint run ./cmd/...
    cd boundary && golangci-lint run ./...
    cd cdk/config && golangci-lint run ./...

# Go vulnerability check
vuln:
    govulncheck ./cmd/...
    cd boundary && govulncheck ./...
    cd cdk/config && govulncheck ./...

# Runner image: the entrypoint script's syntax and its behaviour as a
# non-root user (needs bash and openssl). The image build itself runs in
# release.yaml on a tag.
image-test:
    bash -n image/runner/runner-extra-ca.sh hack/extra-ca-cases.sh
    bash hack/extra-ca-cases.sh

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

# All the checks CI runs
check: build test lint vuln leak-canary image-test cdk-build cdk-test cdk-synth
