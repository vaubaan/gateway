#!/usr/bin/env bash
# Container smoke test for the gateway image (plan P0.4 DoD; CI job "docker").
#
#   deploy/docker/smoke.sh <image>
#
# 1. incomplete configuration  -> the container exits 78 (EX_CONFIG) and names the key
# 2. http public URL           -> same, naming public_url
# 3. complete configuration    -> /healthz answers 200 within the start period, no secret logged
# 4. native addons traced      -> argon2 and better-sqlite3 (prebuilt .node) load inside the image
# 5. non-root                  -> the process runs as uid 10001
# 6. no env file shipped       -> the standalone output carries no apps/gateway/.env*
# 7. no test file shipped      -> no test, spec, fixture or demo tree of this repository in the image
#
# Optional expectations, set by the release pipeline (.github/workflows/release.yml),
# which knows what it built:
#   SMOKE_EXPECT_VERSION   /healthz must answer this version (root package.json)
#   SMOKE_EXPECT_COMMIT    /healthz must answer this commit (7 characters)
#   SMOKE_EXPECT_ARCH      Node's process.arch inside the image (x64, arm64)
set -euo pipefail

EXIT_CONFIG_ERROR=78
# A refused configuration must stop the container by itself; a regression that
# keeps it running fails here (timeout exits 124) instead of hanging CI.
FAIL_FAST_TIMEOUT_SECONDS=60

IMAGE="${1:?usage: smoke.sh <image>}"
PORT="${SMOKE_PORT:-3999}"
NAME="vaubaan-smoke-$$"
MASTER_KEY="$(head -c 32 /dev/urandom | base64 | tr -d '\n')"
BOOTSTRAP="smoke-$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')"

cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT

fail() { printf 'SMOKE FAIL: %b\n' "$*" >&2; exit 1; }
pass() { printf 'SMOKE OK:   %s\n' "$*"; }

# 1. Incomplete configuration must exit with a named key.
set +e
out="$(timeout "$FAIL_FAST_TIMEOUT_SECONDS" docker run --rm -e VAUBAAN_PUBLIC_URL=https://gateway.example.com "$IMAGE" 2>&1)"
code=$?
set -e
[ "$code" -eq "$EXIT_CONFIG_ERROR" ] || fail "incomplete configuration exited $code, expected $EXIT_CONFIG_ERROR:\n$out"
echo "$out" | grep -q 'encryption.master_key: missing required key (env: VAUBAAN_MASTER_KEY or VAUBAAN_MASTER_KEY_FILE)' \
  || fail "exit message does not name VAUBAAN_MASTER_KEY:\n$out"
echo "$out" | grep -q 'store.path: missing required key' || fail "exit message does not name store.path"
echo "$out" | grep -q 'bootstrap_token: missing required key' || fail "exit message does not name bootstrap_token"
pass "incomplete configuration exits $code naming the missing keys"

# 2. An http public URL is refused.
set +e
out="$(timeout "$FAIL_FAST_TIMEOUT_SECONDS" docker run --rm \
  -e VAUBAAN_PUBLIC_URL=http://gateway.example.com \
  -e VAUBAAN_STORE_PATH=/data/gateway.db \
  -e VAUBAAN_MASTER_KEY="$MASTER_KEY" \
  -e VAUBAAN_ADMIN_EMAILS=ops@example.com \
  -e VAUBAAN_BOOTSTRAP_TOKEN="$BOOTSTRAP" \
  "$IMAGE" 2>&1)"
code=$?
set -e
[ "$code" -eq "$EXIT_CONFIG_ERROR" ] || fail "http public URL exited $code, expected $EXIT_CONFIG_ERROR:\n$out"
echo "$out" | grep -q 'public_url: must use https' || fail "exit message does not refuse http:\n$out"
pass "http public URL refused"

# 3. Complete configuration serves /healthz.
docker run -d --name "$NAME" -p "127.0.0.1:${PORT}:3000" \
  -e VAUBAAN_PUBLIC_URL=https://gateway.example.com \
  -e VAUBAAN_STORE_PATH=/data/gateway.db \
  -e VAUBAAN_MASTER_KEY="$MASTER_KEY" \
  -e VAUBAAN_ADMIN_EMAILS=ops@example.com \
  -e VAUBAAN_BOOTSTRAP_TOKEN="$BOOTSTRAP" \
  "$IMAGE" >/dev/null
for _ in $(seq 1 30); do
  if body="$(curl -fsS "http://127.0.0.1:${PORT}/healthz" 2>/dev/null)"; then
    echo "$body" | grep -q '"status":"ok"' || fail "/healthz answered without status ok: $body"
    pass "/healthz answers 200: $body"
    break
  fi
  if [ "$(docker inspect -f '{{.State.Running}}' "$NAME")" != "true" ]; then
    docker logs "$NAME" >&2 || true
    fail "container stopped before /healthz answered"
  fi
  sleep 1
done
curl -fsS "http://127.0.0.1:${PORT}/healthz" >/dev/null || fail "/healthz never answered"
if [ -n "${SMOKE_EXPECT_VERSION:-}" ]; then
  grep -qF "\"version\":\"${SMOKE_EXPECT_VERSION}\"" <<<"$body" \
    || fail "/healthz does not answer version ${SMOKE_EXPECT_VERSION}: $body"
  pass "/healthz answers version ${SMOKE_EXPECT_VERSION}"
fi
if [ -n "${SMOKE_EXPECT_COMMIT:-}" ]; then
  grep -qF "\"commit\":\"${SMOKE_EXPECT_COMMIT}\"" <<<"$body" \
    || fail "/healthz does not answer commit ${SMOKE_EXPECT_COMMIT}: $body"
  pass "/healthz answers commit ${SMOKE_EXPECT_COMMIT}"
fi
if [ -n "${SMOKE_EXPECT_ARCH:-}" ]; then
  arch="$(docker exec "$NAME" node -p process.arch)"
  [ "$arch" = "$SMOKE_EXPECT_ARCH" ] || fail "image runs on ${arch}, expected ${SMOKE_EXPECT_ARCH}"
  pass "image runs on ${arch}"
fi
# Capture the logs once: `docker logs | grep -q` under pipefail can die of SIGPIPE
# on a match and turn a leak into a false pass.
logs="$(docker logs "$NAME" 2>&1)" || fail "cannot read the container logs"
[ -n "$logs" ] || fail "the container logged nothing"
if grep -qF -- "$MASTER_KEY" <<<"$logs"; then fail "master key leaked into the logs"; fi
if grep -qF -- "$BOOTSTRAP" <<<"$logs"; then fail "bootstrap token leaked into the logs"; fi
pass "no secret in the container logs"

# 4. Native addons are present in the traced output and load. The image has
#    no node_modules besides the traced standalone tree, so a passing hash /
#    query proves the prebuilt .node binaries were traced by the build.
docker exec "$NAME" node -e "require('argon2').hash('smoke').then(h=>{if(!h.startsWith('\$argon2id'))process.exit(1)})" \
  || fail "argon2 does not load inside the image (check outputFileTracingIncludes)"
pass "argon2 loads inside the image (libsodium is bundled; the encryptor ran during boot)"
docker exec "$NAME" node -e "const D=require('better-sqlite3');const r=new D(':memory:').prepare('select 1 as one').get();if(r.one!==1)process.exit(1)" \
  || fail "better-sqlite3 does not load inside the image (check outputFileTracingIncludes)"
pass "better-sqlite3 loads inside the image (in-memory query ran)"

# 5. Non-root.
[ "$(docker exec "$NAME" id -u)" = "10001" ] || fail "process is not running as uid 10001"
pass "process runs as non-root"

# 6. No env file shipped: Next copies apps/gateway/.env* into the standalone
#    output, so the build context must have excluded them.
shipped="$(docker exec "$NAME" sh -c 'ls apps/gateway/.env* 2>/dev/null' || true)"
[ -z "$shipped" ] || fail "env file shipped inside the image: $shipped"
pass "no env file inside the image"

# 7. No test file shipped: the image is the traced standalone output, and a trace
#    that follows an import from a test helper (or a tracing include that is too
#    wide) would carry tests, fixtures, the simulated identity provider or the
#    demo launcher into production. Third-party packages are not this
#    repository's to judge: node_modules is skipped. The list must be empty,
#    and the search itself must have looked at something.
searched="$(docker exec "$NAME" sh -c 'find /app -path "*/node_modules" -prune -o -type f -print | wc -l')"
[ "${searched:-0}" -gt 0 ] || fail "the test-file search found no file at all under /app"
tests_shipped="$(docker exec "$NAME" sh -c '
  find /app -path "*/node_modules" -prune -o \
    \( -type f \( -name "*.test.*" -o -name "*.spec.*" -o -name "*.bench.*" \
               -o -name "testing.ts" -o -name "testing.js" -o -name "vitest.config.*" \
               -o -name "playwright.config.*" \) \
       -o -type d \( -name tests -o -name __tests__ -o -name e2e -o -name fixtures \) \) \
    -print' | head -n 20)"
[ -z "$tests_shipped" ] || fail "test files shipped inside the image:\n$tests_shipped"
pass "no test, spec, fixture or demo file inside the image (${searched} files searched)"

echo "SMOKE PASSED"
