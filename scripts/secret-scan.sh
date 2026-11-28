#!/usr/bin/env bash
# Secret scan of the whole git history with gitleaks (job `audit` of
# ci.yml, on every branch push; locally the same command, from a full clone).
#
#   scripts/secret-scan.sh [tool directory]
#
# The whole history, every time: it takes seconds, and a range computed from
# the push would miss a force-push or a new branch. Rules: gitleaks' defaults;
# reviewed exceptions: .gitleaks.toml and .gitleaksignore. Findings are printed
# redacted. Exit code 1 means a leak; anything else above 0, a broken run.
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
tools=${1:-${RUNNER_TEMP:-$repo_root/.cache}/security-tools}
gitleaks=$("$repo_root/scripts/fetch-tool.sh" gitleaks "$tools")

if [ "$(git -C "$repo_root" rev-parse --is-shallow-repository)" = "true" ]; then
  echo "secret-scan: the clone is shallow; check out with fetch-depth: 0" >&2
  exit 2
fi

"$gitleaks" git "$repo_root" \
  --config "$repo_root/.gitleaks.toml" \
  --gitleaks-ignore-path "$repo_root/.gitleaksignore" \
  --redact \
  --no-banner \
  --verbose
