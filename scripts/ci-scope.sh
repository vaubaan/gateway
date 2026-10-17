#!/usr/bin/env bash
# What a CI run has to check (.github/workflows/ci.yml, job `scope`).
#
#   scripts/ci-scope.sh <base-commit> <head-commit>
#
# Prints `code=false` when every file changed between the two commits is
# documentation (under docs/, or a Markdown file anywhere): the run then checks
# the format of those files and the tests that read documentation, nothing
# else. Prints `code=true` otherwise, and when there is no base to compare with
# (a new branch, a tag, a schedule, a manual run): the whole CI runs.
set -euo pipefail

base="${1:-}"
head="${2:-HEAD}"

if [[ -z "$base" || "$base" =~ ^0+$ ]] || ! git cat-file -e "${base}^{commit}" 2>/dev/null; then
  echo "code=true"
  exit 0
fi

changed=$(git diff --name-only "$base" "$head")
if [[ -z "$changed" ]]; then
  echo "code=true"
  exit 0
fi

while IFS= read -r path; do
  if [[ "$path" != docs/* && "$path" != *.md ]]; then
    echo "code=true"
    exit 0
  fi
done <<<"$changed"

echo "code=false"
