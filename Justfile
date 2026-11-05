# grun: GitHub Actions runners on AWS ECS Fargate (cdk-github-runners):
# a CDK app (TypeScript, cdk/), the ci-measure tool (Go, cmd/) and the
# permissions-boundary package (Go, boundary/, its own module) and the
# config schema's Go validator (cdk/config/, its own module); and the
# arc-runners Helm chart (charts/arc-runners) for runners on Kubernetes.
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

# arc-runners chart: lint from the CI base values (it does not render
# bare: it refuses to guess the organization and the controller's
# namespace), and the syntax of every script under hack/.
chart-lint:
    helm lint charts/arc-runners -f tests/ci/arc-runners.yaml
    for f in hack/*.sh; do bash -n "$f"; done

# Render every tests/cases/<chart>/<case>/values.yaml and compare it with
# tests/golden/<chart>/<case>.yaml; prove every tests/invalid/<chart>/
# fixture is refused, for the reason its first line names.
chart-golden:
    bash hack/golden.sh

# Rewrite the goldens after a template change. Review the diff.
chart-golden-update:
    bash hack/golden.sh update

# Schema-validate the golden renders (kubeconform -strict against the
# Kubernetes API): the goldens compare text, this proves the API server
# would accept what they say. Needs network access for the schemas.
chart-schema:
    bash hack/schema.sh

# The janitor's sweep script, extracted from the rendered chart and run
# against a stub kubectl.
chart-janitor:
    bash hack/janitor-cases.sh

# The release's digest stamper, on a scratch copy of the charts: it must
# stamp the runner image and the chart version, and refuse a bad digest.
chart-stamp:
    #!/usr/bin/env bash
    set -euo pipefail
    work=$(mktemp -d)
    trap 'rm -rf "$work"' EXIT
    mkdir -p "$work/hack" "$work/tests"
    cp -r charts "$work/"
    cp -r tests/ci "$work/tests/"
    cp hack/stamp-runner-image.sh "$work/hack/"
    d=sha256:4444444444444444444444444444444444444444444444444444444444444444
    "$work/hack/stamp-runner-image.sh" v9.8.7 "$d"
    grep -qx 'version: 9.8.7' "$work/charts/arc-runners/Chart.yaml"
    grep -qx '  tag: v9.8.7 # stamped at release with the release tag' "$work/charts/arc-runners/values.yaml"
    # Only runnerImage moves: the janitor's image keeps its own tag.
    [ "$(yq '.janitor.image.tag' "$work/charts/arc-runners/values.yaml")" = "$(yq '.janitor.image.tag' charts/arc-runners/values.yaml)" ]
    if "$work/hack/stamp-runner-image.sh" v9.8.7 sha256:abc 2>/dev/null; then
      echo "the stamper accepted a short digest"; exit 1
    fi
    if "$work/hack/stamp-runner-image.sh" 9.8.7 "$d" 2>/dev/null; then
      echo "the stamper accepted a version without the v"; exit 1
    fi
    git diff --exit-code -- charts/
    echo "stamper OK"

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
check: build test lint vuln leak-canary image-test cdk-build cdk-test cdk-synth chart-lint chart-golden chart-schema chart-janitor chart-stamp
