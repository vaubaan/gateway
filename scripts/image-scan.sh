#!/usr/bin/env bash
# Vulnerability scan of a built gateway image with Trivy (CI job `docker`, and
# the release pipeline on each architecture before anything is pushed or
# attested; locally the same command after `npm run docker:build`).
#
#   scripts/image-scan.sh <image> [tool directory]
#
# Fails on a HIGH or CRITICAL vulnerability that has a fixed version, in the
# Debian packages of the base image or in the npm packages the image ships.
# One without a fix yet is listed, not gated: nothing could be done about it
# but drop the package. Reviewed exceptions: .trivyignore.yaml, each with a
# statement and an expiry date (docs/workflow/coding-workflow.md, "Security
# checks"). The vulnerability database is cached between runs by the caller
# (TRIVY_CACHE_DIR); Trivy refreshes it when it is older than a day.
#
# Exit code 1 means a gated vulnerability; anything else above 0, a broken run.
set -euo pipefail

image=${1:?usage: scripts/image-scan.sh <image> [tool directory]}
repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
tools=${2:-${RUNNER_TEMP:-$repo_root/.cache}/security-tools}
trivy=$("$repo_root/scripts/fetch-tool.sh" trivy "$tools")
export TRIVY_CACHE_DIR=${TRIVY_CACHE_DIR:-$repo_root/.cache/trivy}

common=(
  --scanners vuln
  --pkg-types 'os,library'
  --ignorefile "$repo_root/.trivyignore.yaml"
  --no-progress
  --disable-telemetry
  --table-mode detailed
)

echo "== HIGH and CRITICAL, with or without a fix (information) =="
"$trivy" image "${common[@]}" --severity HIGH,CRITICAL --exit-code 0 "$image"

echo "== The gate: HIGH and CRITICAL with a fixed version =="
if ! "$trivy" image "${common[@]}" --severity HIGH,CRITICAL --ignore-unfixed --exit-code 1 \
  --skip-db-update "$image"; then
  echo "image-scan: $image ships a HIGH or CRITICAL vulnerability that has a fix (table above)." >&2
  echo "image-scan: upgrade the package or the base image (docs/workflow/coding-workflow.md, \"Security checks\")." >&2
  exit 1
fi
echo "image-scan: no HIGH or CRITICAL vulnerability with a fixed version in $image."
