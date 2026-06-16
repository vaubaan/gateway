/* eslint-disable */
// E2E mint flow test against prod — unified-tokens edition.
// 1. Create a fresh root token (scope='org') in DB for the test org.
// 2. POST /api/v1/tokens/preview to verify catalog loads + gate resolution.
// 3. POST /api/v1/tokens/mint to actually mint a child token.
// 4. Call /mcp tools/list with the child api_key.
// 5. Cleanup: cascade-delete root token (children dropped via FK).

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

let rootTokenId = null;
async function cleanup() {
  if (rootTokenId) {
    // Cascade-deletes any minted children via the parent_id FK.
    await svc.from('tokens').delete().eq('id', rootTokenId);
    console.log(`[cleanup] deleted root token ${rootTokenId} (cascade)`);
  }
}
process.on('exit', cleanup);
process.on('SIGINT', () => {
  cleanup().then(() => process.exit(1));
});

async function main() {
  // ── Step 1: create a fresh root token (scope='org', parent_id=NULL) ──
  const { apiKey, apiKeyPrefix } = generateApiKey('live');
  const apiKeyHash = await hashApiKey(apiKey);
  const { data: rootRow, error: rootErr } = await svc
    .from('tokens')
    .insert({
      organization_id: ORG_ID,
      parent_id: null,
      scope: 'org',
      project_id: null,
      name: `e2e-root-${Date.now()}`,
      api_key_prefix: apiKeyPrefix,
      api_key_hash: apiKeyHash,
      status: 'active',
      accepted_risks: [],
      denied_risks: [],
      depth: 0,
      delegation_chain: [],
    })
    .select('id')
    .single();
  if (rootErr) throw new Error(`root token insert failed: ${rootErr.message}`);
  rootTokenId = rootRow.id;
  console.log(`[step 1] root token created — id=${rootTokenId} prefix=${apiKeyPrefix}`);

  // ── Step 2: preview a small mint ──────────────────────────────────────
  const previewBody = {
    projectSlug: PROJECT_SLUG,
    bindings: [{ provider: 'github', resource_ref: 'sbw-vaubaan-test/playground', env: null }],
    accepted_risks: ['github.read-code', 'github.read-meta'],
  };
  let res = await fetch(`${BASE}/api/v1/tokens/preview`, {
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
    `         ok=${preview.ok} not_acceptable=${JSON.stringify(preview.not_acceptable ?? [])} not_inherited=${JSON.stringify(preview.not_inherited ?? [])}`,
  );

  // ── Step 3: actually mint a child ─────────────────────────────────────
  const mintBody = {
    name: `e2e-child-${Date.now()}`,
    scope: 'project',
    projectSlug: PROJECT_SLUG,
    bindings: previewBody.bindings,
    accepted_risks: previewBody.accepted_risks,
    ttlSeconds: 600,
    singleUse: true,
  };
  res = await fetch(`${BASE}/api/v1/tokens/mint`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(mintBody),
  });
  const mintText = await res.text();
  console.log(`[step 3] mint HTTP ${res.status}`);
  console.log(`         body: ${mintText.slice(0, 600)}`);
  if (res.status !== 201) {
    throw new Error(`mint did not return 201`);
  }
  const mint = JSON.parse(mintText);
  const childApiKey = mint.api_key;
  if (!childApiKey) throw new Error('mint did not return api_key');
  console.log(`         minted child api_key prefix=${childApiKey.slice(0, 16)}...`);
  console.log(
    `         delegation_chain length=${(mint.token?.delegation_chain ?? []).length} depth=${mint.token?.depth}`,
  );

  // ── Step 4: tools/list with the child key ────────────────────────────
  res = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${childApiKey}`, 'Content-Type': 'application/json' },
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

  console.log('\n✅ E2E unified-tokens mint flow OK');
}

main().catch((e) => {
  console.error('❌ E2E failed:', e.message);
  process.exitCode = 1;
});
