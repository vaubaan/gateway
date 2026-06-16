#!/usr/bin/env tsx
/**
 * Seed a fake customer org in Vaubaan Core for E2E demos.
 *
 * Customer = `sbw-vaubaan`. Reads its 3 cloud creds from `.env.test`
 * and registers them as if the customer had clicked through the OAuth/install
 * flows for each provider (paste-token mode).
 *
 * Idempotent : reuses existing org / project / access_token rows when they
 * exist ; rotates the api_key on every run and prints it.
 *
 * Requires the test user `test@vaubaan.com` to exist in auth.users (seeded
 * manually via the Supabase Admin API on 2026-05-23).
 *
 * Usage : tsx scripts/seed-test-customer.ts
 */

import { Client } from 'pg';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { generateApiKey, hashApiKey } from '../packages/shared/src/api-key.ts';
import { encryptProviderSecret } from '../packages/web/src/lib/crypto/provider-secrets.ts';

interface EnvTest {
  GITHUB_ORG: string;
  GITHUB_ORG_ADMIN_TOKEN: string;
  VERCEL_TEAM_ID: string;
  VERCEL_TEAM_TOKEN: string;
  SUPABASE_TOKEN: string;
  SUPABASE_PROJECT_REF: string;
}

function readEnvTest(): EnvTest {
  const raw = readFileSync(resolve(import.meta.dirname, '../.env.test'), 'utf8');
  const env: Record<string, string> = {};
  for (const line of raw.split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.+)$/);
    if (m) env[m[1]!] = m[2]!.trim();
  }
  return env as unknown as EnvTest;
}

const CUSTOMER_USER_EMAIL = 'test@vaubaan.com';
const PROJECT_REF_VERCEL = 'prj_BFmSakD8ITliRqDgaIFChxZJFNZD';

function readCoreEnv(): { projectRef: string; dbPassword: string } {
  const raw = readFileSync(resolve(import.meta.dirname, '../.env'), 'utf8');
  const env: Record<string, string> = {};
  for (const line of raw.split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.+?)(?:\s+#.*)?$/);
    if (m) env[m[1]!] = m[2]!.trim();
  }
  const projectRef = env.SUPABASE_CORE_PROJECT_REF;
  const dbPassword = env.VAUBAAN_CORE_DB_PASSWORD;
  if (!projectRef) throw new Error('SUPABASE_CORE_PROJECT_REF missing in /.env');
  if (!dbPassword) throw new Error('VAUBAAN_CORE_DB_PASSWORD missing in /.env');
  return { projectRef, dbPassword };
}

async function main() {
  const env = readEnvTest();
  const core = readCoreEnv();
  // Supabase pooler uses self-signed certs ; we trust on first connect since the
  // host is hard-coded below.
  const client = new Client({
    host: 'aws-1-eu-west-3.pooler.supabase.com',
    port: 5432,
    database: 'postgres',
    user: `postgres.${core.projectRef}`,
    password: core.dbPassword,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();

  try {
    // Resolve the customer's auth.users row by email — survives DB resets.
    const userRes = await client.query(`select id from auth.users where email = $1`, [
      CUSTOMER_USER_EMAIL,
    ]);
    const userRow = (userRes.rows as { id: string }[])[0];
    if (!userRow) {
      throw new Error(
        `${CUSTOMER_USER_EMAIL} not found in auth.users — create via the Supabase Admin API first.`,
      );
    }
    const CUSTOMER_USER_ID = userRow.id;
    console.log('customer user:', CUSTOMER_USER_ID, CUSTOMER_USER_EMAIL);

    // 1) Customer org — Vaubaan-Core-side label. The GitHub org behind the
    // binding is still `sbw-vauban-test` (the user has not migrated repos to
    // the new GitHub org `sbw-vaubaan` yet — needs a new fine-grained PAT).
    const orgSlug = 'sbw-vaubaan';
    const orgName = 'sbw-vaubaan (fake customer)';
    const orgRes = await client.query(
      `insert into organizations (name, slug, owner_id)
       values ($1, $2, $3)
       on conflict (slug) do update set name = excluded.name, owner_id = excluded.owner_id
       returning id`,
      [orgName, orgSlug, CUSTOMER_USER_ID],
    );
    const orgId = (orgRes.rows[0] as { id: string }).id;
    console.log('org:', orgId, orgSlug, '(owner: test@vaubaan.com)');

    // The enforce_owner_is_member trigger inserts the owner into org_members,
    // so no explicit org_members insert is needed. Idempotent on re-runs.

    // 3) ProviderAdmin × 3 — paste-token mode (no installation_id).
    // Tokens are encrypted at rest via app-level libsodium AEAD per-org keys
    // (cf. per-org-encryption-app-level ADR).
    const insertAdmin = async (
      provider: 'github' | 'vercel' | 'supabase',
      pat: string,
      teamId: string | null,
    ) => {
      const encrypted = await encryptProviderSecret(orgId, pat);
      await client.query(
        `insert into provider_admins
           (organization_id, provider, status, access_token_encrypted, team_id, connected_by_user_id)
         values ($1, $2, 'connected', $3, $4, $5)
         on conflict (organization_id, provider) do update set
           status = 'connected',
           access_token_encrypted = excluded.access_token_encrypted,
           team_id = excluded.team_id,
           connected_by_user_id = excluded.connected_by_user_id`,
        [orgId, provider, encrypted, teamId, CUSTOMER_USER_ID],
      );
      console.log(`provider_admin: ${provider} (paste-token, ${pat.length} chars)`);
    };
    await insertAdmin('github', env.GITHUB_ORG_ADMIN_TOKEN, null);
    await insertAdmin('vercel', env.VERCEL_TEAM_TOKEN, env.VERCEL_TEAM_ID);
    await insertAdmin('supabase', env.SUPABASE_TOKEN, null);

    // 4) Project
    const projRes = await client.query(
      `insert into projects (organization_id, name, slug, created_by)
       values ($1, 'Playground', 'playground', $2)
       on conflict (organization_id, slug) do update set name = excluded.name
       returning id`,
      [orgId, CUSTOMER_USER_ID],
    );
    const projectId = (projRes.rows[0] as { id: string }).id;
    console.log('project:', projectId, 'playground');

    // 5) ProviderBinding × 3
    const insertBinding = async (
      provider: 'github' | 'vercel' | 'supabase',
      resourceRef: string,
      displayName: string,
    ) => {
      await client.query(
        `insert into provider_bindings (project_id, provider, resource_ref, display_name)
         values ($1, $2, $3, $4)
         on conflict (project_id, provider) do update set
           resource_ref = excluded.resource_ref,
           display_name = excluded.display_name`,
        [projectId, provider, resourceRef, displayName],
      );
      console.log(`binding: ${provider} → ${resourceRef}`);
    };
    // Real GitHub identifier for the binding — the FAKE CUSTOMER org
    // (sbw-vaubaan-test), NOT the Vaubaan Core org (sbw-vaubaan).
    // env.GITHUB_ORG comes from .env.test and resolves to sbw-vaubaan-test.
    // Don't confuse with the Core PAT in .env which is scoped to sbw-vaubaan.
    await insertBinding('github', `${env.GITHUB_ORG}/playground`, `${env.GITHUB_ORG}/playground`);
    await insertBinding('vercel', PROJECT_REF_VERCEL, 'project-i4ddj');
    await insertBinding('supabase', env.SUPABASE_PROJECT_REF, 'playground');

    // 6) Access token — rotate api_key on each run.
    const builtinRoles = await client.query(
      `select id, name from roles
       where is_builtin = true
         and name in ('github:developer','vercel:viewer','supabase:reader')
       order by name`,
    );
    const roleIds = (builtinRoles.rows as { id: string; name: string }[]).map((r) => r.id);
    console.log(
      'roles found:',
      (builtinRoles.rows as { name: string }[]).map((r) => r.name).join(', '),
    );

    const { apiKey, apiKeyPrefix } = generateApiKey('test');
    const apiKeyHash = await hashApiKey(apiKey);
    const tokenRes = await client.query(
      `insert into access_tokens (project_id, name, api_key_prefix, api_key_hash, status, created_by)
       values ($1, 'demo-token', $2, $3, 'active', $4)
       on conflict (project_id, name) do update set
         api_key_prefix = excluded.api_key_prefix,
         api_key_hash = excluded.api_key_hash,
         status = 'active'
       returning id`,
      [projectId, apiKeyPrefix, apiKeyHash, CUSTOMER_USER_ID],
    );
    const tokenId = (tokenRes.rows[0] as { id: string }).id;
    // Wipe old role assignments and re-attach.
    await client.query(`delete from access_token_roles where access_token_id = $1`, [tokenId]);
    for (const roleId of roleIds) {
      await client.query(
        `insert into access_token_roles (access_token_id, role_id) values ($1, $2)
         on conflict do nothing`,
        [tokenId, roleId],
      );
    }
    console.log('access_token:', tokenId, 'demo-token with', roleIds.length, 'roles');

    console.log('\n========================================');
    console.log('TEST CUSTOMER SEEDED — copy the api_key:');
    console.log('========================================');
    console.log('Org slug   :', orgSlug);
    console.log('Project    : playground');
    console.log('Token name : demo-token');
    console.log('Roles      : github:developer, vercel:viewer, supabase:reader');
    console.log('API key    :', apiKey);
    console.log('========================================\n');
  } finally {
    await client.end();
  }
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
