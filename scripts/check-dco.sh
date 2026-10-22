#!/usr/bin/env bash
#
# Fails when a commit in a range has no Signed-off-by trailer (Developer Certificate of Origin).
# CI runs it on pull requests (.github/workflows/dco.yml). Merge commits are not checked.
#
# usage: bash scripts/check-dco.sh <base>..<head>

set -euo pipefail

range="${1:-}"
if [ -z "$range" ] || [ "$range" = "--help" ]; then
  sed -n '2,8p' "$0"
  [ "$range" = "--help" ] && exit 0
  exit 2
fi

missing=0
for sha in $(git rev-list --no-merges "$range"); do
  if ! git show -s --format=%B "$sha" | grep -qiE '^Signed-off-by: .+ <.+@.+>$'; then
    echo "missing Signed-off-by: $(git show -s --format='%h %s' "$sha")"
    missing=1
  fi
done

if [ "$missing" = "1" ]; then
  echo
  echo "Sign off each commit with 'git commit -s' (or 'git commit --amend -s' / 'git rebase --signoff')."
  echo "See the Developer Certificate of Origin section of CONTRIBUTING.md."
fi
exit "$missing"
