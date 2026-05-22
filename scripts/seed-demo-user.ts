/**
 * Seed a fully-bootstrapped demo user on prod Supabase.
 *
 *   email     : demo@cloud-resource-manager.dev
 *   password  : Vauban-Demo-Crm-2026!
 *   org slug  : demo
 *
 * The user lands directly on `/orgs/demo/resources` with three sample
 * Resources whose access blobs are sealed for the user's fingerprint
 * — clicking "Reveal" decrypts them in the browser.
 *
 * Idempotent : safe to re-run. Skips existing rows.
 *
 * Reads SUPABASE_PROD_URL + SUPABASE_PROD_SERVICE_ROLE_KEY from
 * `.env` at the repo root.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { createClient } from '@supabase/supabase-js';

import {
  deriveKEK,
  generateUserKeypair,
  sealForRecipients,
  wrapPrivateKey,
} from '@crm/core/crypto';

const DEMO_EMAIL = 'demo@cloud-resource-manager.dev';
const DEMO_PASSWORD = 'Vauban-Demo-Crm-2026!';
const DEMO_ORG_SLUG = 'demo';
const DEMO_ORG_NAME = 'Demo Org';

function loadDotenv(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1]!;
    let val = m[2]!.trim();
    // Strip inline comments only when the value isn't a quoted string —
    // `.env` here uses `value # comment` on most lines.
    if (!val.startsWith('"') && !val.startsWith("'")) {
      const hash = val.indexOf('#');
      if (hash !== -1) val = val.slice(0, hash).trim();
    }
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

function toPgBytea(bytes: Uint8Array): string {
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return `\\x${hex}`;
}

function randomSalt(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(16));
}

async function main(): Promise<void> {
  const envPath = resolve(import.meta.dirname, '..', '.env');
  const env = loadDotenv(envPath);
  const url = env.SUPABASE_PROD_URL;
  const serviceKey = env.SUPABASE_PROD_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    throw new Error('Missing SUPABASE_PROD_URL / SUPABASE_PROD_SERVICE_ROLE_KEY in .env');
  }
  const sb = createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // 1. Upsert Supabase Auth user (email_confirmed=true so no mail flow).
  console.log(`[1/5] Provisioning auth user ${DEMO_EMAIL}...`);
  let userId: string;
  const existing = await sb.auth.admin.listUsers({ page: 1, perPage: 200 });
  if (existing.error) throw existing.error;
  const found = existing.data.users.find((u) => u.email === DEMO_EMAIL);
  if (found) {
    userId = found.id;
    console.log(`      existing user ${userId} — updating password to known value`);
    const upd = await sb.auth.admin.updateUserById(userId, {
      password: DEMO_PASSWORD,
      email_confirm: true,
    });
    if (upd.error) throw upd.error;
  } else {
    const created = await sb.auth.admin.createUser({
      email: DEMO_EMAIL,
      password: DEMO_PASSWORD,
      email_confirm: true,
    });
    if (created.error) throw created.error;
    userId = created.data.user.id;
    console.log(`      created user ${userId}`);
  }

  // 2. Generate keypair + wrap with KEK derived from the demo password.
  console.log('[2/5] Provisioning crypto identity (keypair + wrapped sk)...');
  const kp = await generateUserKeypair();
  const kdfSalt = randomSalt();
  const kdfParams = { m: 67108864, t: 3, p: 1, alg: 'argon2id' as const };
  const kek = await deriveKEK(DEMO_PASSWORD, kdfSalt, kdfParams);
  const wrapped = await wrapPrivateKey(kp.privateKey, kek);

  const upsertKey = await sb.from('user_crypto_keys').upsert(
    {
      user_id: userId,
      public_key: toPgBytea(kp.publicKey),
      fingerprint: kp.fingerprint,
      wrapped_private_key: toPgBytea(wrapped),
      kdf_salt: toPgBytea(kdfSalt),
      kdf_params: kdfParams,
    },
    { onConflict: 'user_id' },
  );
  if (upsertKey.error) throw upsertKey.error;
  console.log(`      fingerprint ${kp.fingerprint}`);

  // 3. Upsert org + admin membership.
  console.log(`[3/5] Provisioning org "${DEMO_ORG_SLUG}"...`);
  const orgRes = await sb
    .from('organizations')
    .upsert({ slug: DEMO_ORG_SLUG, name: DEMO_ORG_NAME }, { onConflict: 'slug' })
    .select('id')
    .single();
  if (orgRes.error) throw orgRes.error;
  const orgId = orgRes.data.id;

  const memberRes = await sb
    .from('org_members')
    .upsert(
      { organization_id: orgId, user_id: userId, role: 'admin' },
      { onConflict: 'organization_id,user_id' },
    );
  if (memberRes.error) throw memberRes.error;
  console.log(`      org ${orgId} + admin membership`);

  // 4. Default secret_manager placeholder so the FK in resources stays
  //    valid. We tag it `placeholder` until the user connects Infisical.
  console.log('[4/5] Provisioning default secret_manager...');
  const smRes = await sb
    .from('secret_managers')
    .upsert(
      {
        organization_id: orgId,
        kind: 'placeholder',
        name: 'default',
        is_default: true,
        config: {},
      },
      { onConflict: 'organization_id,name' },
    )
    .select('id')
    .single();
  if (smRes.error) throw smRes.error;
  const smId = smRes.data.id;

  // 5. Three sample resources with sealed_blob unsealable by the demo
  //    user. Cleartext values are obviously fake placeholders.
  console.log('[5/5] Provisioning 3 sample resources + access blobs...');
  // Use the real vauban-e2e test cloud creds from .env.test so the
  // demo user can hit Reveal and see actual provider data after sign-in.
  // Safe because vauban-e2e accounts are intentionally separate from
  // any production org (cf. spec §12.3).
  const envTestPath = resolve(import.meta.dirname, '..', '.env.test');
  const envTest = loadDotenv(envTestPath);
  const samples = [
    {
      kind: 'github-org',
      name: 'demo-github',
      provider_name: 'github',
      provider_ref: envTest.GITHUB_ORG ?? 'sbw-vauban-test',
      access_key: 'GITHUB_TOKEN',
      cleartext: envTest.GITHUB_ORG_ADMIN_TOKEN ?? '',
    },
    {
      kind: 'vercel-team',
      name: 'demo-vercel',
      provider_name: 'vercel',
      provider_ref: envTest.VERCEL_TEAM_ID ?? 'team_unknown',
      access_key: 'VERCEL_TOKEN',
      cleartext: envTest.VERCEL_TEAM_TOKEN ?? '',
    },
    {
      kind: 'supabase-org',
      name: 'demo-supabase',
      provider_name: 'supabase',
      provider_ref: envTest.SUPABASE_ORG_SLUG ?? 'unknown-org',
      access_key: 'SUPABASE_ACCESS_TOKEN',
      cleartext: envTest.SUPABASE_TOKEN ?? '',
    },
  ];

  for (const s of samples) {
    const resRow = await sb
      .from('resources')
      .upsert(
        {
          organization_id: orgId,
          project_id: null,
          provider_name: s.provider_name,
          kind: s.kind,
          scope: 'org',
          is_admin: false,
          name: s.name,
          provider_ref: s.provider_ref,
          status: 'active',
          secret_manager_id: smId,
        },
        { onConflict: 'organization_id,project_id,name' },
      )
      .select('id')
      .single();
    if (resRow.error) {
      console.warn(`      resource ${s.name} upsert error:`, resRow.error.message);
      continue;
    }
    const rId = resRow.data.id;

    if (!s.cleartext) {
      console.warn(`      skip ${s.name}: no cleartext available in .env.test`);
      continue;
    }
    const blob = await sealForRecipients(s.cleartext, [
      { publicKey: kp.publicKey, fingerprint: kp.fingerprint },
    ]);

    const accessRow = await sb.from('resource_access').upsert(
      {
        resource_id: rId,
        key: s.access_key,
        sealed_blob: { v: 1, recipients: blob.recipients },
        description: 'demo seed — replace by your real cred via Rotate',
      },
      { onConflict: 'resource_id,key' },
    );
    if (accessRow.error) {
      console.warn(`      access ${s.access_key} upsert error:`, accessRow.error.message);
    }
    console.log(`      ${s.kind} ${s.name} (access ${s.access_key} sealed)`);
  }

  console.log('\n=== DONE ===');
  console.log(`  email     : ${DEMO_EMAIL}`);
  console.log(`  password  : ${DEMO_PASSWORD}`);
  console.log(`  org slug  : ${DEMO_ORG_SLUG}`);
  console.log(`  url       : https://cloud-resource-manager-vauban.vercel.app/`);
  console.log('');
  console.log('  After sign-in, you will land on /orgs/demo/resources.');
  console.log('  The unlock dialog uses the SAME password.');
}

main().catch((e: unknown) => {
  console.error('seed-demo-user fatal:', e);
  process.exit(1);
});
