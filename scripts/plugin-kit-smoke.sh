#!/usr/bin/env bash
# The plugin author's kit, packed, used outside this repository the way an author uses it
# (docs/spec/plugin-authoring.md §1; intent "Start a plugin project").
#
#   scripts/plugin-kit-smoke.sh [<work dir>]
#
# Packs @vaubaan/plugin-sdk and @vaubaan/plugin-cli as npm would publish them, installs
# both in an empty folder, runs `vaubaan-plugin init`, then in the new project
# `npm install` (the two packs in place of the registry), `npm run check`, `npm run try`
# and `npm run build`. Exit 0 only if every step passes. The publish workflow
# (.github/workflows/publish-plugin-kit.yml) runs it before publishing anything.
set -euo pipefail

repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
work=${1:-$(mktemp -d)}
packs="$work/packs"
mkdir -p "$packs" "$work/tools"

echo "smoke: packing into $packs"
(cd "$repo" && npm pack --silent --workspace @vaubaan/plugin-sdk --workspace @vaubaan/plugin-cli \
  --pack-destination "$packs" >/dev/null)

cd "$work/tools"
npm init -y >/dev/null
npm install --silent --no-audit --no-fund "$packs"/*.tgz
./node_modules/.bin/vaubaan-plugin init "$work/acme-crm" --id acme-crm --name 'Acme CRM'

cd "$work/acme-crm"
npm install --silent --no-audit --no-fund "$packs"/*.tgz
npm run -s check
npm run -s try -- acme_crm__update_widget
npm run -s build
test -s dist/plugin.tgz
echo "smoke: the kit works outside the repository"
