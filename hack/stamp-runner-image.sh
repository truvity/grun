#!/usr/bin/env bash
# Stamp the runner image a release has just pushed into the arc-runners
# chart's defaults, and the release version into every chart's Chart.yaml.
#
#   hack/stamp-runner-image.sh <version> <digest>
#   hack/stamp-runner-image.sh v0.2.0 sha256:…
#
# It rewrites `digest:` and `tag:` inside the top-level `runnerImage:`
# mapping of charts/arc-runners/values.yaml only (never a blind sed over
# every `digest:` line: the janitor image has a tag of its own), then
# proves the result by rendering the chart and finding the digest in it.
# A release that published a chart naming no image digest would install
# whatever `latest` is on the day.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

[ $# -eq 2 ] || { echo "usage: $0 <version> <digest>" >&2; exit 2; }
version=$1
digest=$2

case "$version" in
  v[0-9]*.[0-9]*.[0-9]*) ;;
  *) echo "::error::$version is not a v<major>.<minor>.<patch> tag" >&2; exit 2 ;;
esac
case "$digest" in
  sha256:*) ;;
  *) echo "::error::$digest is not a sha256 digest" >&2; exit 2 ;;
esac
hex=${digest#sha256:}
if [ ${#hex} -ne 64 ] || [ -n "${hex//[0-9a-f]/}" ]; then
  echo "::error::$digest is not a sha256 digest" >&2; exit 2
fi

values="$here/charts/arc-runners/values.yaml"
tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT

# Inside `runnerImage:` (from that line to the next top-level key), and
# only there: two-space-indented `digest:` and `tag:`, keeping any
# trailing comment.
awk -v digest="$digest" -v tag="$version" '
  /^[A-Za-z_][A-Za-z0-9_]*:/ { inside = ($0 ~ /^runnerImage:[[:space:]]*$/) }
  inside && /^  digest:/ { sub(/^  digest:[[:space:]]*("[^"]*"|[^[:space:]#]*)/, "  digest: \"" digest "\""); d++ }
  inside && /^  tag:/    { sub(/^  tag:[[:space:]]*("[^"]*"|[^[:space:]#]*)/, "  tag: " tag); t++ }
  { print }
  END { if (d != 1 || t != 1) { printf "runnerImage: found %d digest and %d tag lines, want one of each\n", d, t > "/dev/stderr"; exit 3 } }
' "$values" > "$tmp"
cat "$tmp" > "$values"

for c in "$here"/charts/*/Chart.yaml; do
  sed -i -E "s|^version: .*$|version: ${version#v}|; s|^appVersion: .*$|appVersion: ${version#v}|" "$c"
done

rendered=$(helm template t "$here/charts/arc-runners" \
  -f "$here/tests/ci/arc-runners.yaml")
want="image: ghcr.io/truvity/grun/runner@${digest}"
if ! grep -qF "$want" <<< "$rendered"; then
  echo "::error::the stamped chart does not render $want" >&2
  exit 1
fi
if grep -q 'image: .*/runner:' <<< "$rendered"; then
  echo "::error::the stamped chart still renders a runner image by tag" >&2
  exit 1
fi
echo "stamped arc-runners: runner image ${digest:0:19}… (${version}), charts at ${version#v}"
