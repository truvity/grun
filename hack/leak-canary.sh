#!/usr/bin/env bash
# This repository is public and its history cannot be unpublished, so the
# rule ("mechanism only; particulars are caller inputs") is enforced
# mechanically rather than remembered: no account ids, ARNs, internal
# hostnames, ticket keys or tokens, in the tree or in documentation
# examples. Use <placeholders> in docs.
#
# Copied from truvity/workstation. Add a pattern the first time something
# new turns out to be a particular. Never add an exception without one.
set -uo pipefail

patterns=(
  '[0-9]{12}'                          # AWS account id
  'arn:aws'                            # any ARN
  '[0-9]{12}\.dkr\.ecr\.'              # ECR registry host
  '\.svc\.cluster\.local'              # in-cluster DNS
  '/secrets/'                          # SSM parameter paths
  'truvity-[a-z0-9-]*-(ci-cache|artifacts|state)'   # S3 buckets
  '\.truvity\.(xyz|com|co)'            # internal hostnames
  'glpat-|ghp_|github_pat_'            # tokens, in case of an accident
  '\bINF[-][0-9]+'                     # internal ticket keys
  'truvity\.private'                   # internal DNS zone
)

fail=0
for p in "${patterns[@]}"; do
  # git grep: tracked and untracked-but-not-ignored files only, so local
  # output directories (.cache, reports, bin) are never scanned. This
  # script is excluded: it necessarily contains the patterns it bans.
  if hits=$(git grep -InE --untracked -e "$p" -- . ':!hack/leak-canary.sh' 2>/dev/null); then
    echo "LEAK: pattern /$p/ matched — particulars belong in caller arguments:"
    echo "$hits" | head -5 | sed 's/^/    /'
    fail=1
  fi
done

if [ "$fail" = 0 ]; then
  echo "leak canary clean — ${#patterns[@]} patterns checked, no particulars found"
fi
exit $fail
