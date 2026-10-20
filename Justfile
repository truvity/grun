# grun: GitHub Actions runners on AWS ECS Fargate (cdk-github-runners)
# and the ci-measure tool. `just --list` for an overview.

# Disable go.work (a parent workspace interferes with standalone builds)
export GOWORK := "off"

default:
    @just --list

# Format all Go files
fmt:
    golangci-lint fmt ./...

# Compile check; writes the binary to bin/ci-measure
build:
    go build -o bin/ci-measure ./cmd/ci-measure

# Run unit tests
test:
    go test ./...

# Run linters. `config verify` first: `run` accepts unknown top-level keys
# silently, so a settings block in the wrong place is otherwise invisible.
lint:
    golangci-lint config verify
    golangci-lint run ./...

# Go vulnerability check
vuln:
    govulncheck ./...

# Why this repository can be public: no particulars in the tree. Own CI job.
leak-canary:
    hack/leak-canary.sh

# Measure runner behaviour from the GitHub API (read-only on GitHub).
# Example: just measure -org my-org -repos my-repo -days 28 -out reports/$(date +%F)/my-repo
measure *ARGS:
    go run ./cmd/ci-measure {{ARGS}}

# All the checks CI runs
check: build test lint vuln leak-canary
