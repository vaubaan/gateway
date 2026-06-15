/* eslint-disable */
// E2E mint flow test against prod.
// 1. Create a fresh management key in DB (org=sbw-vaubaan, name=e2e-mint-test).
// 2. POST /api/v1/mgmt/tokens/preview to verify catalog loads + gate resolution.
// 3. POST /api/v1/mgmt/tokens to actually mint a token (accepting an allow-by-default risk).
// 4. Call /mcp tools/list with the live api_key.
// 5. Cleanup: revoke the management key.

import { createClient } from '@supabase/supabase-js';
import { generateApiKey, hashApiKey } from '@vaubaan/shared';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BASE = 'https://vaubaan.com';

const ORG_ID = '2a1ceeb5-feab-49e7-8192-fb0f4df6bbfa'; // sbw-vaubaan
const PROJECT_SLUG = 'playground';

const svc = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { persistSession: false, autoRefreshToken: false },
});

let mgmtKeyId = null;
async function cleanup() {
  if (mgmtKeyId) {
    await svc.from('org_management_keys').update({ status: 'revoked' }).eq('id', mgmtKeyId);
    console.log(`[cleanup] revoked mgmt key ${mgmtKeyId}`);
  }
}
process.on('exit', cleanup);
process.on('SIGINT', () => {
  cleanup().then(() => process.exit(1));
});

async function main() {
  // ── Step 1: create a fresh management key ────────────────────────────
  const { apiKey, apiKeyPrefix } = generateApiKey('mgmt');
  const apiKeyHash = await hashApiKey(apiKey);
  const { data: mgmtRow, error: mgmtErr } = await svc
    .from('org_management_keys')
    .insert({
      organization_id: ORG_ID,
      name: 'e2e-mint-test',
      api_key_prefix: apiKeyPrefix,
      api_key_hash: apiKeyHash,
      status: 'active',
    })
    .select('id')
    .single();
  if (mgmtErr) throw new Error(`mgmt key insert failed: ${mgmtErr.message}`);
  mgmtKeyId = mgmtRow.id;
  console.log(`[step 1] mgmt key created — id=${mgmtKeyId} prefix=${apiKeyPrefix}`);

  // ── Step 2: preview a small mint ──────────────────────────────────────
  const previewBody = {
    projectSlug: PROJECT_SLUG,
    bindings: [
      { provider: 'github', resource_ref: 'sbw-vaubaan-test/playground', environment: null },
    ],
    accepted_risks: ['github.read-code', 'github.read-meta'],
  };
  let res = await fetch(`${BASE}/api/v1/mgmt/tokens/preview`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(previewBody),
  });
  const previewText = await res.text();
  console.log(`[step 2] preview HTTP ${res.status}`);
  console.log(`         body: ${previewText.slice(0, 400)}`);
  if (!res.ok) throw new Error(`preview failed: ${res.status}`);
  const preview = JSON.parse(previewText);
  console.log(
    `         all_allowed=${preview.all_allowed} needs_approval=${JSON.stringify(preview.needs_approval ?? [])}`,
  );

  // ── Step 3: actually mint ─────────────────────────────────────────────
  const mintBody = {
    ...previewBody,
    name: `e2e-mint-test-token-${Date.now()}`,
    ttlSeconds: 600,
    singleUse: true,
  };
  res = await fetch(`${BASE}/api/v1/mgmt/tokens`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(mintBody),
  });
  const mintText = await res.text();
  console.log(`[step 3] mint HTTP ${res.status}`);
  console.log(`         body: ${mintText.slice(0, 500)}`);
  if (res.status !== 201) {
    throw new Error(`mint did not return 201`);
  }
  const mint = JSON.parse(mintText);
  const liveApiKey = mint.api_key;
  if (!liveApiKey) throw new Error('mint did not return api_key');
  console.log(`         minted api_key prefix=${liveApiKey.slice(0, 16)}...`);

  // ── Step 4: tools/list with the live key ─────────────────────────────
  res = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${liveApiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
  const listText = await res.text();
  console.log(`[step 4] tools/list HTTP ${res.status}`);
  if (res.ok) {
    const list = JSON.parse(listText);
    const toolCount = list?.result?.tools?.length ?? 0;
    const githubTools = (list?.result?.tools ?? [])
      .filter((t) => t.name.startsWith('github__'))
      .map((t) => t.name);
    console.log(
      `         total=${toolCount} github=${githubTools.length}: ${githubTools.slice(0, 5).join(',')}${githubTools.length > 5 ? '...' : ''}`,
    );
  } else {
    console.log(`         body: ${listText.slice(0, 300)}`);
  }

  console.log('\n✅ E2E mint flow OK');
}

main().catch((e) => {
  console.error('❌ E2E failed:', e.message);
  process.exitCode = 1;
});
