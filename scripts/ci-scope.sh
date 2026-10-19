#!/usr/bin/env bash
# What a CI run has to check (.github/workflows/ci.yml, job `scope`).
#
#   scripts/ci-scope.sh <base-commit> <head-commit>
#
# Prints two lines, `code=<bool>` and `surface=<bool>`.
#
# `code=false` when every file changed between the two commits is
# documentation (under docs/, or a Markdown file anywhere): the run then checks
# the format of those files and the tests that read documentation, nothing
# else. `code=true` otherwise, and when there is no base to compare with (a new
# branch, a tag, a schedule, a manual run): the whole CI runs.
#
# `surface=true` when a changed file can change what a person sees in the
# browser: the pages, the components and the styles of the application, the
# browser tests themselves, and the plugins (the reference and the mission form
# are drawn from their catalogs, presets and tools). A pull request runs the
# browser tests (`e2e`) only then; a push to main runs them whatever changed.
# `surface=true` too when there is no base to compare with.
set -euo pipefail

base="${1:-}"
head="${2:-HEAD}"

if [[ -z "$base" || "$base" =~ ^0+$ ]] || ! git cat-file -e "${base}^{commit}" 2>/dev/null; then
  echo "code=true"
  echo "surface=true"
  exit 0
fi

changed=$(git diff --name-only "$base" "$head")
if [[ -z "$changed" ]]; then
  echo "code=true"
  echo "surface=true"
  exit 0
fi

code=false
surface=false
while IFS= read -r path; do
  if [[ "$path" != docs/* && "$path" != *.md ]]; then
    code=true
  fi
  case "$path" in
    apps/gateway/src/app/* | apps/gateway/src/components/* | apps/gateway/src/styles/* | \
      apps/gateway/tests/e2e/* | plugins/*)
      surface=true
      ;;
  esac
done <<<"$changed"

echo "code=$code"
echo "surface=$surface"
