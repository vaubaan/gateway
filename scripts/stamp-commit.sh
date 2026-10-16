#!/usr/bin/env bash
# Writes the checked-out commit into apps/gateway/build-commit.txt, the way
# `git archive` does for a deployed tree (.gitattributes: export-subst), so an
# image built from a checkout (the CI's) reports that commit on /healthz.
# Leaves the file modified: run it in a throw-away checkout only.
# ADR docs/decisions/deployed-commit-stamped-by-git-archive.md.
set -euo pipefail

root="$(git rev-parse --show-toplevel)"
git -C "$root" archive --format=tar HEAD apps/gateway/build-commit.txt | tar -x -C "$root"
stamp="$(cat "$root/apps/gateway/build-commit.txt")"
if ! [[ "$stamp" =~ ^[0-9a-f]{40}$ ]]; then
  echo "stamp-commit: apps/gateway/build-commit.txt was not stamped (got '$stamp')" >&2
  exit 1
fi
echo "stamp-commit: ${stamp}"
