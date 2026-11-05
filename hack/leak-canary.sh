#!/usr/bin/env bash
# This repository is public and its history cannot be unpublished, so the
# rule ("mechanism only; particulars are caller inputs") is enforced
# mechanically rather than remembered: no account ids, ARNs, internal
# hostnames, ticket keys or tokens, in the tree or in documentation
# examples. Use <placeholders> in docs.
#
# Copied from truvity/workstation. Add a pattern the first time something
# new turns out to be a particular. Never add an exception without one.
#
# Perl regexes (git grep -P), for two refinements taken from
# truvity/ci-support's copy when the arc-runners chart arrived:
#
# - The 12-digit patterns are anchored on word boundaries. Without them,
#   `[0-9]{12}` also matches a 12-digit run inside a longer string -- and a
#   sha256 image digest is exactly that. `\b` keeps every real shape (bare,
#   in an ARN, as an ECR host: each is bounded by a non-word character).
# - The parameter-store pattern excludes `/var/run/secrets/`, which is where
#   Kubernetes mounts a pod's own credentials and is therefore in any
#   manifest that reads one.
set -uo pipefail

patterns=(
  '\b[0-9]{12}\b'                      # AWS account id
  'arn:aws'                            # any ARN
  '\b[0-9]{12}\.dkr\.ecr\.'            # ECR registry host
  '\.svc\.cluster\.local'              # in-cluster DNS
  '(?<!/var/run)/secrets/'             # SSM parameter paths, not Kubernetes' own
  'truvity-[a-z0-9-]*-(ci-cache|artifacts|state)'   # S3 buckets
  '\.truvity\.(xyz|com|co)'            # internal hostnames
  'glpat-|ghp_|github_pat_'            # tokens, in case of an accident
  '\bINF[-][0-9]+'                     # internal ticket keys
  'truvity\.private'                   # internal DNS zone
  '[Oo][Pp][Ww][Ee][Rr][Mm]'           # a private organisation's name
  '\bSQU[-][0-9]+'                     # its ticket keys
)

# The loop below reads a git grep failure as "no hit", so a git built
# without Perl regexes would pass everything. Prove -P works first, on a
# line this script is known to hold.
if ! git grep -qP -e '^(?<!x)patterns=\($' -- hack/leak-canary.sh; then
  echo "leak-canary: git grep -P does not work here; refusing to report clean" >&2
  exit 2
fi

fail=0
for p in "${patterns[@]}"; do
  # git grep: tracked and untracked-but-not-ignored files only, so local
  # output directories (.cache, reports, bin) are never scanned. This
  # script is excluded: it necessarily contains the patterns it bans.
  if hits=$(git grep -InP --untracked -e "$p" -- . ':!hack/leak-canary.sh' 2>/dev/null); then
    echo "LEAK: pattern /$p/ matched — particulars belong in caller arguments:"
    echo "$hits" | head -5 | sed 's/^/    /'
    fail=1
  fi
done

if [ "$fail" = 0 ]; then
  echo "leak canary clean — ${#patterns[@]} patterns checked, no particulars found"
fi
exit $fail
