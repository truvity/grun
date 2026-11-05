#!/usr/bin/env bash
# Schema-validate every committed golden render against the Kubernetes API.
#
# The goldens compare text, so a manifest the API server refuses (a field
# one level too high, a misspelt key) is a clean diff. This runs
# `kubeconform -strict` over every golden: unknown fields fail, as do wrong
# types. Kinds with no schema in the Kubernetes set (ARC's
# AutoscalingRunnerSet) are skipped. The goldens are the same bytes the
# `golden` recipe proves the templates render, so run both.
#
#   hack/schema.sh                     the Kubernetes version below
#   K8S_VERSION=1.35.0 hack/schema.sh  another one
#
# Fetching the schemas needs network access (kubeconform's default
# location, github.com/yannh/kubernetes-json-schema).
set -uo pipefail

cd "$(dirname "$0")/.." || exit 2

version=${K8S_VERSION:-1.36.0}
goldens=(tests/golden/*/*.yaml)
[ -e "${goldens[0]}" ] || { echo "no goldens -- that is a failure, not a pass" >&2; exit 1; }

fail=0
for golden in "${goldens[@]}"; do
  if ! out=$(kubeconform -strict -kubernetes-version "$version" -ignore-missing-schemas -summary "$golden" 2>&1); then
    echo "SCHEMA: $golden"
    sed 's/^/    /' <<< "$out" | head -20
    fail=1
  fi
done

if [ "$fail" -eq 0 ]; then
  echo "schema: ${#goldens[@]} goldens valid against Kubernetes $version"
fi
exit "$fail"
