#!/usr/bin/env bash
# The plugin author's kit, packed, used outside this repository the way an author uses it
# (docs/spec/plugin-authoring.md §1; intent "Start a plugin project").
#
#   scripts/plugin-kit-smoke.sh [<work dir>]
#
# Packs @vaubaan/plugin-sdk and @vaubaan/plugin-cli as npm would publish them, installs
# both in an empty folder, runs `vaubaan-plugin init`, then in the new project
# `npm install` (the two packs in place of the registry) and the tutorial's steps: `npm run
# check`, `npm run try` (an allowed call, a refused one), `npm run build`, `keygen` and `sign`.
# Exit 0 only if every step passes. The publish workflow
# (.github/workflows/publish-plugin-kit.yml) runs it before publishing anything.
set -euo pipefail

repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
work=${1:-$(mktemp -d)}
packs="$work/packs"
mkdir -p "$packs" "$work/tools" "$work/keys"

echo "smoke: packing into $packs"
(cd "$repo" && npm pack --silent --workspace @vaubaan/plugin-sdk --workspace @vaubaan/plugin-cli \
  --pack-destination "$packs" >/dev/null)

cd "$work/tools"
npm init -y >/dev/null
npm install --silent --no-audit --no-fund "$packs"/*.tgz
./node_modules/.bin/vaubaan-plugin init "$work/acme-crm" --id acme-crm --name 'Acme CRM'

# From here, the steps of the tutorial "Your first plugin" (vaubaan.com/docs/plugins-guide/first-plugin),
# in its order: change one, change the other.
cd "$work/acme-crm"
npm install --silent --no-audit --no-fund "$packs"/*.tgz
npm run -s check
npm run -s try -- acme_crm__update_widget
npm run -s try -- acme_crm__update_widget '{"workspace":"ws-stg","widget_id":"w1","name":"x"}'
npm run -s try -- acme_crm__delete_widget '{"workspace":"ws-stg","widget_id":"w1"}' --trust trusting
if npm run -s try -- acme_crm__update_widget '{"workspace":"ws-other","widget_id":"w1","name":"x"}'; then
  echo "smoke: a resource outside the sample mission was not refused" >&2
  exit 1
fi
npm run -s build
test -s dist/plugin.tgz
./node_modules/.bin/vaubaan-plugin keygen --out "$work/keys/acme-plugins"
./node_modules/.bin/vaubaan-plugin sign dist/plugin --key "$work/keys/acme-plugins.key.pem"
test -s dist/plugin/vaubaan-manifest.json.sig.json
echo "smoke: the kit works outside the repository"
