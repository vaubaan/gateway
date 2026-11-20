#!/bin/sh
# Vercel's "Ignored Build Step" (vercel.json `ignoreCommand`, at most 256
# characters, hence this file). Exit 0 skips the build, anything else builds.
# Only main and feature/website deploy. The site builds when one of its inputs
# changed since the last deployed commit (VERCEL_GIT_PREVIOUS_SHA; HEAD^ when
# Vercel gives none). A diff that cannot run (a commit missing from the
# shallow clone) exits non-zero: the site builds, the safe side.
case "$VERCEL_GIT_COMMIT_REF" in
  main | feature/website) ;;
  *) exit 0 ;;
esac
cd "$(dirname "$0")/../../.." || exit 1
exec git diff --quiet "${VERCEL_GIT_PREVIOUS_SHA:-HEAD^}" HEAD -- \
  apps/website \
  apps/gateway/src/app/agent-bootstrap.md \
  packages/telemetry packages/shared packages/gateway-core packages/policy-engine \
  packages/design-tokens packages/plugin-page \
  plugins docs deploy package-lock.json
