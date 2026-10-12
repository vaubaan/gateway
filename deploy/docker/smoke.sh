#!/usr/bin/env bash
# Container smoke test for the gateway image (plan P0.4 DoD; CI job "docker").
#
#   deploy/docker/smoke.sh <image>
#
# 1. incomplete configuration  -> the container exits non-zero and names the key
# 2. http public URL           -> same, naming public_url
# 3. complete configuration    -> /healthz answers 200 within the start period
# 4. native addons traced      -> argon2 (prebuilt .node) loads inside the image
set -euo pipefail

IMAGE="${1:?usage: smoke.sh <image>}"
PORT="${SMOKE_PORT:-3999}"
NAME="vaubaan-smoke-$$"
MASTER_KEY="$(head -c 32 /dev/urandom | base64 | tr -d '\n')"
BOOTSTRAP="smoke-$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')"

cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT

fail() { echo "SMOKE FAIL: $*" >&2; exit 1; }
pass() { echo "SMOKE OK:   $*"; }

# 1. Incomplete configuration must exit with a named key.
set +e
out="$(docker run --rm -e VAUBAAN_PUBLIC_URL=https://gateway.example.com "$IMAGE" 2>&1)"
code=$?
set -e
[ "$code" -ne 0 ] || fail "container started with an incomplete configuration"
echo "$out" | grep -q 'encryption.master_key: missing required key (env: VAUBAAN_MASTER_KEY or VAUBAAN_MASTER_KEY_FILE)' \
  || fail "exit message does not name VAUBAAN_MASTER_KEY:\n$out"
echo "$out" | grep -q 'store.path: missing required key' || fail "exit message does not name store.path"
echo "$out" | grep -q 'bootstrap_token: missing required key' || fail "exit message does not name bootstrap_token"
pass "incomplete configuration exits $code naming the missing keys"

# 2. An http public URL is refused.
set +e
out="$(docker run --rm \
  -e VAUBAAN_PUBLIC_URL=http://gateway.example.com \
  -e VAUBAAN_STORE_PATH=/data/gateway.db \
  -e VAUBAAN_MASTER_KEY="$MASTER_KEY" \
  -e VAUBAAN_ADMIN_EMAILS=ops@example.com \
  -e VAUBAAN_BOOTSTRAP_TOKEN="$BOOTSTRAP" \
  "$IMAGE" 2>&1)"
code=$?
set -e
[ "$code" -ne 0 ] || fail "container accepted an http public URL"
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
docker logs "$NAME" 2>&1 | grep -q "$MASTER_KEY" && fail "master key leaked into the logs"
docker logs "$NAME" 2>&1 | grep -q "$BOOTSTRAP" && fail "bootstrap token leaked into the logs"
pass "no secret in the container logs"

# 4. Native addons are present in the traced output and load.
docker exec "$NAME" node -e "require('argon2').hash('smoke').then(h=>{if(!h.startsWith('\$argon2id'))process.exit(1)})" \
  || fail "argon2 does not load inside the image (check outputFileTracingIncludes)"
pass "argon2 loads inside the image (libsodium is bundled; the encryptor ran during boot)"

# Non-root.
[ "$(docker exec "$NAME" id -u)" = "10001" ] || fail "process is not running as uid 10001"
pass "process runs as non-root"

echo "SMOKE PASSED"
