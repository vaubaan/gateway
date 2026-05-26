#!/usr/bin/env bash
# Enable the GitHub external provider on Vaubaan Core Supabase Auth,
# using credentials from a GitHub OAuth App created at github.com.
#
# Requires in .env :
#   SUPABASE_MGMT_TOKEN              # Personal Mgmt PAT (sbp_…)
#   SUPABASE_AUTH_GITHUB_CLIENT_ID
#   SUPABASE_AUTH_GITHUB_CLIENT_SECRET
#
# Doc : docs/handbook/auth-github-sso.md

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ROOT}/.env"

if [[ ! -f "${ENV_FILE}" ]]; then
  echo "fatal: ${ENV_FILE} not found" >&2
  exit 2
fi

# shellcheck disable=SC1090
set -a
. "${ENV_FILE}"
set +a

: "${SUPABASE_MGMT_TOKEN:?SUPABASE_MGMT_TOKEN is missing in .env}"
: "${SUPABASE_AUTH_GITHUB_CLIENT_ID:?SUPABASE_AUTH_GITHUB_CLIENT_ID is missing in .env}"
: "${SUPABASE_AUTH_GITHUB_CLIENT_SECRET:?SUPABASE_AUTH_GITHUB_CLIENT_SECRET is missing in .env}"

PROJECT_REF="${SUPABASE_PROJECT_REF:-ynxfyklzqdumtixkdrco}"

echo "→ Enabling GitHub provider on Supabase project ${PROJECT_REF}…"

BODY=$(cat <<JSON
{
  "external_github_enabled": true,
  "external_github_client_id": "${SUPABASE_AUTH_GITHUB_CLIENT_ID}",
  "external_github_secret": "${SUPABASE_AUTH_GITHUB_CLIENT_SECRET}"
}
JSON
)

HTTP_CODE=$(
  curl -sS -o /tmp/supabase-auth-patch.json -w "%{http_code}" \
    -X PATCH "https://api.supabase.com/v1/projects/${PROJECT_REF}/config/auth" \
    -H "Authorization: Bearer ${SUPABASE_MGMT_TOKEN}" \
    -H "Content-Type: application/json" \
    -d "${BODY}"
)

if [[ "${HTTP_CODE}" != "200" ]]; then
  echo "✗ Mgmt API responded ${HTTP_CODE}" >&2
  cat /tmp/supabase-auth-patch.json >&2
  echo >&2
  exit 1
fi

echo "✓ Mgmt API returned 200."
echo "  external_github_enabled=$(jq -r .external_github_enabled /tmp/supabase-auth-patch.json)"
echo "  external_github_client_id=$(jq -r .external_github_client_id /tmp/supabase-auth-patch.json)"
echo
echo "Next: open https://vaubaan.com/login and click 'Continue with GitHub'."
