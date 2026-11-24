#!/usr/bin/env bash
# Container smoke test for the gateway image (CI job "docker").
#
#   deploy/docker/smoke.sh <image>
#
# 1. incomplete configuration  -> the container exits 78 (EX_CONFIG) and names the key, a source of
#                                 client addresses among them (NODE_ENV=production)
# 2. http public URL           -> same, naming public_url
# 3. complete configuration    -> /healthz answers 200 within the start period, no secret logged,
#                                 run hardened as deploy/compose.yaml runs it: read-only root,
#                                 no capability, no new privilege, /tmp a tmpfs, /data a volume
# 4. native addons traced      -> argon2 and better-sqlite3 (prebuilt .node) load inside the image
# 5. non-root                  -> the process runs as uid 10001, with no capability, on a
#                                 root filesystem it cannot write
# 6. no env file shipped       -> the standalone output carries no apps/gateway/.env*
# 7. no test file shipped      -> no test, spec, fixture or demo tree of this repository in the image
# 8. security headers          -> every page answers with the headers the application owns
# 9. started as root           -> on a root-owned volume, the entrypoint gives /data to uid 10001
#                                 without following a link planted there, and the server runs as
#                                 10001 with no capability (Railway's RAILWAY_RUN_UID=0)
# 10. v4 importer shipped       -> apps/gateway/import-v4.mjs loads in the image, refuses root,
#                                 runs as 10001 through the entrypoint, and opens the instance
#                                 (a configured dry run refuses an unknown owner) (handbook import-from-v4)
# 11. reseal shipped            -> apps/gateway/reseal.mjs loads in the image, refuses root, and a
#                                 dry run through the entrypoint opens the instance's store
#                                 (handbook configuration, "Rotating the master key")
# 12. backup shipped            -> apps/gateway/backup.mjs refuses root, and through the entrypoint
#                                 writes a copy of the store on /data that passes integrity_check
#                                 (handbook store, "Backup")
# 13. restore shipped           -> apps/gateway/restore.mjs refuses root; through the entrypoint a dry
#                                 run of the step-12 copy passes and names its key versions; it never
#                                 replaces the live store (73), nor forces over it while the gateway
#                                 holds it (75); http is refused (64). At first boot, a new volume with
#                                 VAUBAAN_RESTORE_FROM: a wrong hash stops the boot (exit 1) and writes
#                                 no store, an http source exits 78 without echoing it, the right hash
#                                 restores and serves /healthz, and a restart only warns
#                                 (handbook store, "Restore")
# 14. key apart from the store  -> a key generated on /keys (a volume of its own, as compose.yaml
#                                 mounts it) boots without the key-beside-store warning, mode 0600;
#                                 a key generated on /data, beside the store, boots with it once
#                                 (ADR master-key-generated-and-handed-over-by-the-instance)
#   15. local mode                VAUBAAN_LOCAL=true and one volume: a key, a setup link, a
#                                 session cookie without Secure
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
DATA_VOLUME="vaubaan-smoke-hardened-$$"
ROOT_NAME="vaubaan-smoke-root-$$"
VOLUME="vaubaan-smoke-data-$$"
RESTORE_NAME="vaubaan-smoke-restore-$$"
RESTORE_VOLUME="vaubaan-smoke-restore-data-$$"
KEY_NAME="vaubaan-smoke-key-$$"
KEY_DATA_VOLUME="vaubaan-smoke-key-data-$$"
KEY_VOLUME="vaubaan-smoke-key-keys-$$"
LOCAL_NAME="vaubaan-smoke-local-$$"
LOCAL_VOLUME="vaubaan-smoke-local-data-$$"
MASTER_KEY="$(head -c 32 /dev/urandom | base64 | tr -d '\n')"
BOOTSTRAP="smoke-$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')"

cleanup() {
  docker rm -f "$NAME" "$ROOT_NAME" "$RESTORE_NAME" "$KEY_NAME" "$LOCAL_NAME" >/dev/null 2>&1 || true
  docker volume rm -f "$VOLUME" "$RESTORE_VOLUME" "$DATA_VOLUME" "$KEY_DATA_VOLUME" "$KEY_VOLUME" \
    "$LOCAL_VOLUME" >/dev/null 2>&1 || true
}
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
echo "$out" | grep -q 'trusted_proxies: a source of client addresses is required in production' \
  || fail "exit message does not ask for a source of client addresses:\n$out"
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

# 3. Complete configuration serves /healthz, hardened as deploy/compose.yaml runs it
#    (the four keys of its `gateway` service, the data on a volume).
docker volume create "$DATA_VOLUME" >/dev/null
docker run -d --name "$NAME" -p "127.0.0.1:${PORT}:3000" \
  --read-only --cap-drop ALL --security-opt no-new-privileges:true --tmpfs /tmp \
  -v "$DATA_VOLUME:/data" \
  -e VAUBAAN_PUBLIC_URL=https://gateway.example.com \
  -e VAUBAAN_TRUSTED_PROXIES=127.0.0.1 \
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
body="$(curl -fsS "http://127.0.0.1:${PORT}/healthz")" || fail "/healthz never answered"
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

# 5. Non-root, no capability, a root filesystem it cannot write.
[ "$(docker exec "$NAME" id -u)" = "10001" ] || fail "process is not running as uid 10001"
caps="$(docker exec "$NAME" awk '/^CapEff:/{print $2}' /proc/1/status)"
[ "$caps" = "0000000000000000" ] || fail "the hardened server keeps capabilities $caps"
if docker exec "$NAME" sh -c 'touch /app/smoke-write' 2>/dev/null; then
  fail "the root filesystem is writable under read_only"
fi
pass "process runs as non-root, with no capability, on a read-only root filesystem"

# 5b. No package manager: the runner stage removes npm, npx, corepack and yarn,
#     which the gateway never runs and whose dependencies the image scan flags.
managers="$(docker exec "$NAME" sh -c 'for m in npm npx corepack yarn yarnpkg; do command -v "$m"; done; ls -d /usr/local/lib/node_modules/npm /opt/yarn-v* 2>/dev/null' || true)"
[ -z "$managers" ] || fail "a package manager is shipped inside the image: $managers"
pass "no package manager inside the image"

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

# 8. Security headers, set by the application itself (not by a proxy).
headers="$(curl -fsS -D - -o /dev/null "http://127.0.0.1:${PORT}/login")" || fail "/login did not answer"
for expected in \
  "content-security-policy: default-src 'self'; script-src 'self' 'nonce-" \
  "frame-ancestors 'none'" \
  "x-frame-options: DENY" \
  "x-content-type-options: nosniff" \
  "referrer-policy: same-origin" \
  "permissions-policy: " \
  "strict-transport-security: max-age=31536000"; do
  grep -qiF -- "$expected" <<<"$headers" || fail "/login is missing the header part: $expected\n$headers"
done
pass "/login carries the security headers (CSP with a nonce, framing, nosniff, referrer, permissions, HSTS)"
# Pages served, the store opened: nothing tried to write outside /data and /tmp.
logs="$(docker logs "$NAME" 2>&1)" || fail "cannot read the container logs"
if grep -qE 'EROFS|read-only file system' <<<"$logs"; then
  fail "the server tried to write outside /data and /tmp:\n$logs"
fi
pass "the read-only server wrote nowhere but /data and /tmp"

# 9. Started as root on a root-owned volume (RAILWAY_RUN_UID=0): the entrypoint
#    gives /data to vaubaan and the server runs as 10001 without capabilities.
docker volume create "$VOLUME" >/dev/null
docker run --rm --user 0 --entrypoint sh -v "$VOLUME:/data" "$IMAGE" \
  -c 'chown -R 0:0 /data && touch /data/left-by-root && ln -s /usr/local/bin/vaubaan-entrypoint /data/planted-link' >/dev/null
docker run -d --name "$ROOT_NAME" --user 0 -v "$VOLUME:/data" \
  -e VAUBAAN_PUBLIC_URL=https://gateway.example.com \
  -e VAUBAAN_TRUSTED_PROXIES=127.0.0.1 \
  -e VAUBAAN_STORE_PATH=/data/gateway.db \
  -e VAUBAAN_MASTER_KEY="$MASTER_KEY" \
  -e VAUBAAN_ADMIN_EMAILS=ops@example.com \
  -e VAUBAAN_BOOTSTRAP_TOKEN="$BOOTSTRAP" \
  "$IMAGE" >/dev/null
for _ in $(seq 1 30); do
  if docker exec "$ROOT_NAME" node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" 2>/dev/null; then
    break
  fi
  if [ "$(docker inspect -f '{{.State.Running}}' "$ROOT_NAME")" != "true" ]; then
    docker logs "$ROOT_NAME" >&2 || true
    fail "the container started as root stopped before /healthz answered"
  fi
  sleep 1
done
uid="$(docker exec "$ROOT_NAME" awk '/^Uid:/{print $2}' /proc/1/status)"
[ "$uid" = "10001" ] || fail "started as root, the server runs as uid $uid, expected 10001"
caps="$(docker exec "$ROOT_NAME" awk '/^CapEff:/{print $2}' /proc/1/status)"
[ "$caps" = "0000000000000000" ] || fail "started as root, the server keeps capabilities $caps"
owner="$(docker exec "$ROOT_NAME" stat -c %u /data /data/left-by-root /data/gateway.db | sort -u)"
[ "$owner" = "10001" ] || fail "started as root, /data is not owned by 10001: $owner"
# A symbolic link planted on the volume is given away itself, never followed.
followed="$(docker exec "$ROOT_NAME" stat -c %u /usr/local/bin/vaubaan-entrypoint)"
[ "$followed" = "0" ] || fail "the entrypoint followed a link on /data: its target is owned by $followed"
pass "started as root on a root-owned volume: /data given to 10001 (links not followed), server runs as 10001 with no capability"

# 10. The v4 importer ships beside the server, refuses root, and runs through the
#     entrypoint as 10001 (the `railway ssh` form of docs/handbook/import-from-v4.md).
help="$(docker exec "$NAME" node apps/gateway/import-v4.mjs --help 2>&1)" \
  || fail "the importer does not run inside the image:\n$help"
grep -qF -- '--owner <email>' <<<"$help" || fail "the importer printed no usage:\n$help"
set +e
printf '{}' | docker exec -i -u 0 "$ROOT_NAME" node apps/gateway/import-v4.mjs --owner ops@example.com >/dev/null 2>&1
as_root=$?
printf '{}' | docker exec -i -u 0 "$ROOT_NAME" vaubaan-entrypoint node apps/gateway/import-v4.mjs --owner ops@example.com >/dev/null 2>&1
dropped=$?
set -e
[ "$as_root" -eq 77 ] || fail "the importer run as root exited $as_root, expected 77"
[ "$dropped" -eq 65 ] || fail "the importer run through the entrypoint exited $dropped, expected 65 (bundle refused)"
pass "the v4 importer ships, refuses root, and runs as 10001 through the entrypoint"
# The importer builds the root inside the image (plugin catalogs, migrations, native
# addons from the standalone tree): a valid empty bundle for an owner nobody is exits 67.
now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
bundle='{"format":"vaubaan-v4-export","version":1,"exported_at":"'"$now"'","organization":{"id":"0b6a1a3e-0000-4000-8000-000000000001","slug":"smoke","name":"Smoke"},"projects":[],"accounts":[],"bindings":[],"stripe_accounts":[],"ssh_hosts":[],"missions":[],"skipped":{"project_env_vars":0,"child_tokens":0,"bash_bindings":0,"ssh_hosts_not_exported":[]}}'
set +e
printf '%s' "$bundle" | docker exec -i "$NAME" node apps/gateway/import-v4.mjs --owner nobody@example.com >/dev/null 2>&1
configured=$?
set -e
[ "$configured" -eq 67 ] || fail "the importer's configured dry run exited $configured, expected 67 (owner unknown)"
pass "the v4 importer opens the instance inside the image (configured dry run, unknown owner refused)"

# 11. The master-key re-seal ships beside the server, refuses root, and its dry run
#     opens the store as 10001 (the procedure of docs/handbook/configuration.md).
help="$(docker exec "$NAME" node apps/gateway/reseal.mjs --help 2>&1)" \
  || fail "reseal does not run inside the image:\n$help"
grep -qF -- '--apply' <<<"$help" || fail "reseal printed no usage:\n$help"
set +e
docker exec -u 0 "$ROOT_NAME" node apps/gateway/reseal.mjs >/dev/null 2>&1
as_root=$?
dry="$(docker exec -u 0 "$ROOT_NAME" vaubaan-entrypoint node apps/gateway/reseal.mjs 2>&1)"
dropped=$?
set -e
[ "$as_root" -eq 77 ] || fail "reseal run as root exited $as_root, expected 77"
[ "$dropped" -eq 0 ] || fail "reseal's dry run through the entrypoint exited $dropped, expected 0:\n$dry"
grep -qF 'dry run' <<<"$dry" || fail "reseal's dry run printed no report:\n$dry"
pass "reseal ships, refuses root, and its dry run opens the store as 10001"

# 12. The backup ships beside the server, refuses root, and copies the store on
#     /data as 10001 with an integrity check (deploy/railway.md §6, §8 step 0).
set +e
docker exec -u 0 "$ROOT_NAME" node apps/gateway/backup.mjs >/dev/null 2>&1
as_root=$?
copied="$(docker exec -u 0 "$ROOT_NAME" vaubaan-entrypoint node apps/gateway/backup.mjs smoke-backup.sqlite 2>&1)"
backed=$?
again="$(docker exec -u 0 "$ROOT_NAME" vaubaan-entrypoint node apps/gateway/backup.mjs smoke-backup.sqlite 2>&1)"
twice=$?
set -e
[ "$as_root" -eq 77 ] || fail "backup run as root exited $as_root, expected 77"
[ "$backed" -eq 0 ] || fail "backup through the entrypoint exited $backed, expected 0:\n$copied"
grep -qF 'integrity_check: ok' <<<"$copied" || fail "backup printed no integrity check:\n$copied"
[ "$twice" -eq 73 ] || fail "a second backup to the same name exited $twice, expected 73:\n$again"
pass "backup ships, refuses root, copies the store as 10001 and never overwrites"

# 13. The restore ships beside the server: the command checks the step-12 copy and never
#     replaces a live store; a new instance restores it at first boot from its
#     configuration (docs/handbook/store.md).
SHA="$(docker exec "$ROOT_NAME" sha256sum /data/smoke-backup.sqlite | cut -d' ' -f1)"
WRONG_SHA="$(printf '0%.0s' $(seq 1 64))"
set +e
docker exec -u 0 "$ROOT_NAME" node apps/gateway/restore.mjs /data/smoke-backup.sqlite >/dev/null 2>&1
as_root=$?
dry="$(docker exec -u 0 "$ROOT_NAME" vaubaan-entrypoint node apps/gateway/restore.mjs /data/smoke-backup.sqlite --sha256 "$SHA" --dry-run 2>&1)"
dry_code=$?
live="$(docker exec -u 0 "$ROOT_NAME" vaubaan-entrypoint node apps/gateway/restore.mjs /data/smoke-backup.sqlite 2>&1)"
live_code=$?
forced="$(docker exec -u 0 "$ROOT_NAME" vaubaan-entrypoint node apps/gateway/restore.mjs /data/smoke-backup.sqlite --force 2>&1)"
forced_code=$?
plain="$(docker exec -u 0 "$ROOT_NAME" vaubaan-entrypoint node apps/gateway/restore.mjs 'http://storage.example.com/x?sig=smoke-leak' --sha256 "$SHA" 2>&1)"
plain_code=$?
set -e
[ "$as_root" -eq 77 ] || fail "restore run as root exited $as_root, expected 77"
[ "$dry_code" -eq 0 ] || fail "restore's dry run exited $dry_code, expected 0:\n$dry"
grep -qF 'integrity_check: ok' <<<"$dry" || fail "restore's dry run printed no integrity check:\n$dry"
grep -qE 'master key version 1:|holds no sealed secret' <<<"$dry" || fail "restore's dry run named no key version:\n$dry"
[ "$live_code" -eq 73 ] || fail "restore over the live store exited $live_code, expected 73:\n$live"
[ "$forced_code" -eq 75 ] || fail "a forced restore over the running gateway exited $forced_code, expected 75:\n$forced"
[ "$plain_code" -eq 64 ] || fail "restore from http exited $plain_code, expected 64:\n$plain"
if grep -qF 'smoke-leak' <<<"$plain"; then fail "restore echoed the source URL"; fi
pass "restore ships, refuses root, checks a copy as 10001, never replaces a live store, refuses http"

docker volume create "$RESTORE_VOLUME" >/dev/null
restore_env=(
  -e VAUBAAN_PUBLIC_URL=https://gateway.example.com
  -e VAUBAAN_TRUSTED_PROXIES=127.0.0.1
  -e VAUBAAN_STORE_PATH=/data/gateway.db
  -e VAUBAAN_MASTER_KEY="$MASTER_KEY"
  -e VAUBAAN_ADMIN_EMAILS=ops@example.com
  -e VAUBAAN_BOOTSTRAP_TOKEN="$BOOTSTRAP"
  -e VAUBAAN_RESTORE_FROM=/restore/smoke-backup.sqlite
)
set +e
out="$(timeout "$FAIL_FAST_TIMEOUT_SECONDS" docker run --rm -v "$VOLUME:/restore:ro" -v "$RESTORE_VOLUME:/data" \
  "${restore_env[@]}" -e VAUBAAN_RESTORE_SHA256="$WRONG_SHA" "$IMAGE" 2>&1)"
wrong_code=$?
http_out="$(timeout "$FAIL_FAST_TIMEOUT_SECONDS" docker run --rm -v "$RESTORE_VOLUME:/data" \
  "${restore_env[@]}" -e VAUBAAN_RESTORE_FROM='http://storage.example.com/x?sig=smoke-leak' \
  -e VAUBAAN_RESTORE_SHA256="$SHA" "$IMAGE" 2>&1)"
http_code=$?
set -e
[ "$wrong_code" -eq 1 ] || fail "a first boot with a wrong hash exited $wrong_code, expected 1:\n$out"
grep -qF 'restore at first boot refused (verify)' <<<"$out" || fail "the refused first boot did not say why:\n$out"
left="$(docker run --rm --entrypoint sh -v "$RESTORE_VOLUME:/data" "$IMAGE" -c 'ls -A /data')"
[ -z "$left" ] || fail "a refused first-boot restore left files on the volume: $left"
[ "$http_code" -eq "$EXIT_CONFIG_ERROR" ] || fail "an http restore source exited $http_code, expected $EXIT_CONFIG_ERROR:\n$http_out"
grep -qF 'restore.from: must use https' <<<"$http_out" || fail "the http restore source was not named:\n$http_out"
if grep -qF 'smoke-leak' <<<"$http_out"; then fail "the boot echoed the restore source URL"; fi
docker run -d --name "$RESTORE_NAME" -v "$VOLUME:/restore:ro" -v "$RESTORE_VOLUME:/data" \
  "${restore_env[@]}" -e VAUBAAN_RESTORE_SHA256="$SHA" "$IMAGE" >/dev/null
wait_healthy() {
  for _ in $(seq 1 30); do
    if docker exec "$1" node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" 2>/dev/null; then
      return 0
    fi
    if [ "$(docker inspect -f '{{.State.Running}}' "$1")" != "true" ]; then
      docker logs "$1" >&2 || true
      fail "$2"
    fi
    sleep 1
  done
  fail "$2 (no /healthz in 30 s)"
}
wait_healthy "$RESTORE_NAME" "the container restoring at first boot stopped before /healthz answered"
logs="$(docker logs "$RESTORE_NAME" 2>&1)"
grep -qF '"msg":"store restored"' <<<"$logs" || fail "the first boot logged no restore:\n$logs"
grep -qF "\"sha256\":\"$SHA\"" <<<"$logs" || fail "the restore log does not carry the copy's hash:\n$logs"
docker restart "$RESTORE_NAME" >/dev/null
wait_healthy "$RESTORE_NAME" "the restored instance did not come back after a restart"
logs="$(docker logs "$RESTORE_NAME" 2>&1)"
restored="$(grep -cF '"msg":"store restored"' <<<"$logs" || true)"
skipped="$(grep -cF 'restore.from is set but the store exists' <<<"$logs" || true)"
[ "$restored" = "1" ] || fail "the store was restored $restored times, expected once:\n$logs"
[ "$skipped" = "1" ] || fail "the restart logged the skipped restore $skipped times, expected once:\n$logs"
pass "a new instance restores the copy at first boot (wrong hash and http refused), a restart only warns"

# 14. The master key apart from the store: generated on its own volume, no warning;
#     generated beside the store, one warning naming the variable that accepts it.
BESIDE='the master key file is on the same mount as the store'
key_boot() {
  docker rm -f "$KEY_NAME" >/dev/null 2>&1 || true
  docker volume rm -f "$KEY_DATA_VOLUME" "$KEY_VOLUME" >/dev/null 2>&1 || true
  docker run -d --name "$KEY_NAME" -v "$KEY_DATA_VOLUME:/data" -v "$KEY_VOLUME:/keys" \
    -e VAUBAAN_PUBLIC_URL=https://gateway.example.com \
    -e VAUBAAN_STORE_PATH=/data/gateway.db \
    -e VAUBAAN_MASTER_KEY_FILE="$1" -e VAUBAAN_MASTER_KEY_GENERATE=1 \
    -e VAUBAAN_ADMIN_EMAILS=ops@example.com \
    -e VAUBAAN_BOOTSTRAP_TOKEN="$BOOTSTRAP" \
    -e VAUBAAN_TRUSTED_PROXIES=127.0.0.1 \
    "$IMAGE" >/dev/null
  wait_healthy "$KEY_NAME" "the container generating its key at $1 stopped before /healthz answered"
  docker logs "$KEY_NAME" 2>&1
}
logs="$(key_boot /keys/master.key)"
if grep -qF "$BESIDE" <<<"$logs"; then fail "a key on its own volume was reported beside the store:\n$logs"; fi
mode="$(docker exec "$KEY_NAME" stat -c '%a %u' /keys/master.key)"
[ "$mode" = "600 10001" ] || fail "the generated key on /keys is '$mode', expected '600 10001'"
logs="$(key_boot /data/master.key)"
[ "$(grep -cF "$BESIDE" <<<"$logs" || true)" = "1" ] || fail "a key beside the store was not reported once:\n$logs"
grep -qF 'VAUBAAN_ACCEPT_KEY_BESIDE_STORE=1' <<<"$logs" || fail "the warning does not name the variable that accepts it"
pass "a key on its own volume boots quietly; a key beside the store is reported once"

# 15. Local mode (ADR local-mode-for-an-instance-on-this-computer): the switch and one volume
#     start an instance, which generates its key and prints a setup link that opens a
#     session whose cookie has no Secure attribute.
docker run -d --name "$LOCAL_NAME" -v "$LOCAL_VOLUME:/data" -e VAUBAAN_LOCAL=true "$IMAGE" >/dev/null
wait_healthy "$LOCAL_NAME" "the local instance stopped before /healthz answered"
logs="$(docker logs "$LOCAL_NAME" 2>&1)"
token="$(grep -oE 'http://localhost:3000/admin/bootstrap#token=[A-Za-z0-9_-]{43}' <<<"$logs" | tail -1 | cut -d= -f2)"
[ -n "$token" ] || fail "the local instance printed no setup link:\n$logs"
mode="$(docker exec "$LOCAL_NAME" stat -c '%a %u' /data/master.key)"
[ "$mode" = "600 10001" ] || fail "the local instance's key is '$mode', expected '600 10001'"
cookie="$(docker exec "$LOCAL_NAME" node -e "
  fetch('http://127.0.0.1:3000/api/auth/bootstrap', {
    method: 'POST', redirect: 'manual',
    headers: { origin: 'http://localhost:3000', 'content-type': 'application/x-www-form-urlencoded' },
    body: 'token=$token',
  }).then((r) => console.log(r.headers.get('set-cookie') ?? ''))")"
grep -qE '^vbn_session=[A-Za-z0-9_-]+; Path=/; Max-Age=[0-9]+; HttpOnly; SameSite=Lax$' <<<"$cookie" ||
  fail "the setup link did not open a loopback session: '$cookie'"
pass "local mode starts with one volume, prints its setup link, and its session cookie works on http"

echo "SMOKE PASSED"
