# grun: GitHub Actions runners on AWS ECS Fargate (cdk-github-runners):
# a CDK app (TypeScript, cdk/) and the ci-measure tool (Go, cmd/).
# `just --list` for an overview.

# Disable go.work (a parent workspace interferes with standalone builds)
export GOWORK := "off"

default:
    @just --list

# Format all Go files
fmt:
    golangci-lint fmt ./cmd/...

# Compile check; writes the binary to bin/ci-measure
build:
    go build -o bin/ci-measure ./cmd/ci-measure

# Run unit tests
test:
    go test ./cmd/...

# Run linters. `config verify` first: `run` accepts unknown top-level keys
# silently, so a settings block in the wrong place is otherwise invisible.
lint:
    golangci-lint config verify
    golangci-lint run ./cmd/...

# Go vulnerability check
vuln:
    govulncheck ./cmd/...

# Why this repository can be public: no particulars in the tree. Own CI job.
leak-canary:
    hack/leak-canary.sh

# Measure runner behaviour from the GitHub API (read-only on GitHub).
# Example: just measure -org my-org -repos my-repo -days 28 -out reports/$(date +%F)/my-repo
measure *ARGS:
    go run ./cmd/ci-measure {{ARGS}}

# CDK app: install the pinned dependencies (a clean, lockfile-exact install).
# The Go recipes above name ./cmd/... on purpose: ./... would walk
# cdk/node_modules.
cdk-install:
    cd cdk && npm ci --no-audit --no-fund

# CDK app: type-check the app, the Lambdas and the tests
cdk-build: cdk-install
    cd cdk && npx tsc --noEmit

# CDK app: unit tests (assertions on the synthesised stack, and the Lambdas)
cdk-test: cdk-install
    cd cdk && npx vitest run

# CDK app: synthesise the example configuration. Nothing is deployed.
cdk-synth: cdk-install
    cd cdk && npx cdk synth --quiet -c config=config/example.yaml

# CDK app: synthesise an environment's own configuration, e.g.
#   just cdk-synth-config ../gitops/cfg/grun/devel.yaml
cdk-synth-config CONFIG: cdk-install
    c=$(realpath "{{CONFIG}}") && cd cdk && npx cdk synth --quiet -c config="$c"

# All the checks CI runs
check: build test lint vuln leak-canary cdk-build cdk-test cdk-synth
