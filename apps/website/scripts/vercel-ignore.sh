#!/bin/sh
# Vercel's "Ignored Build Step" (vercel.json `ignoreCommand`, at most 256
# characters, hence this file). Exit 0 skips the build, exit 1 builds; any
# other code FAILS the deployment, so every doubt answers 1.
# Only main and feature/website deploy. The site builds when one of its inputs
# changed since the last deployed commit (VERCEL_GIT_PREVIOUS_SHA; HEAD^ when
# Vercel gives none). Vercel clones shallow: a base missing from the clone
# builds.
case "$VERCEL_GIT_COMMIT_REF" in
  main | feature/website) ;;
  *) exit 0 ;;
esac
cd "$(dirname "$0")/../../.." || exit 1
base="${VERCEL_GIT_PREVIOUS_SHA:-HEAD^}"
git cat-file -e "$base^{commit}" 2>/dev/null || exit 1
git diff --quiet "$base" HEAD -- \
  apps/website \
  apps/gateway/src/app/agent-bootstrap.md \
  packages/telemetry packages/shared packages/gateway-core packages/policy-engine \
  packages/design-tokens packages/plugin-page \
  plugins docs deploy package-lock.json
[ $? -eq 0 ] && exit 0
exit 1
