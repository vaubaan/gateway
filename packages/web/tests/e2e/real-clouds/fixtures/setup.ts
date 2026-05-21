/**
 * Playwright `test.extend(...)` fixture for E2E against real clouds.
 *
 * Provides per-spec dependencies :
 *   - `nameCtx`     — file-hash + run-uuid for `vauban-e2e-…` naming.
 *   - `env`         — typed `.env.test` view.
 *   - `admin`       — Vauban service-role helper (createUser, deleteUser…).
 *   - `gh`/`vercel`/`supabaseMgmt`/`infisical` — provider clients.
 *   - `authedAdmin` — Playwright BrowserContext logged in as a fresh
 *                    Supabase Auth admin user, with the crypto identity
 *                    unlocked via the UnlockIdentityDialog flow.
 *   - `org`         — a freshly bootstrapped organization owned by
 *                    `authedAdmin` (slug `vauban-e2e-<runUuid>`).
 *
 * Lifecycle:
 *   - The fixture is *worker-scoped* for env/admin (cheap, immutable).
 *   - User + org + crypto-key are *test-scoped* — each spec runs in
 *     full isolation, no shared mutable state.
 *   - `afterEach` cleanup tears down the org + the user via service-role.
 *     If a test crashes mid-flight, the sweeper picks the remains up.
 *
 * Spec §12.3.
 */

import { test as base, type BrowserContext, type Page } from '@playwright/test';

import { generateE2EIdentity, identityToCryptoKeyPostBody, type E2EIdentity } from './crypto';
import { loadE2EEnv, type E2EEnv } from './env';
import { makeNameContext, type NameContext } from './naming';
import { GithubClient } from './provider-clients/github';
import { VercelClient } from './provider-clients/vercel';
import { SupabaseMgmtClient } from './provider-clients/supabase';
import { InfisicalClient } from './provider-clients/infisical';
import { makeAdminClient, type VaubanAdminClient, type TestUserCreds } from './vauban-client';

export interface OrgBootstrap {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
}

export interface AuthedAdmin {
  readonly creds: TestUserCreds;
  readonly context: BrowserContext;
  readonly page: Page;
  /** Crypto identity seeded for this test user (skip the UI dialog). */
  readonly identity: E2EIdentity;
}

interface WorkerFixtures {
  env: E2EEnv;
  admin: VaubanAdminClient;
  gh: GithubClient;
  vercel: VercelClient;
  supabaseMgmt: SupabaseMgmtClient;
  infisical: InfisicalClient;
}

interface TestFixtures {
  nameCtx: NameContext;
  authedAdmin: AuthedAdmin;
  org: OrgBootstrap;
}

/**
 * Drives the sign-in form + IdentityGate password unlock so the
 * browser context has a fully usable session by the time a spec
 * starts. Spec §4.1 step 6 (UnlockIdentityDialog).
 *
 * Robust to two flows:
 *   - first login (sign-up redirected to /sign-in then /onboarding)
 *   - any subsequent login (lands on /onboarding or last visited)
 */
async function signIn(page: Page, creds: TestUserCreds): Promise<void> {
  await page.goto('/sign-in');
  await page.getByLabel(/email/i).fill(creds.email);
  await page.getByLabel(/password/i).fill(creds.password);
  await page.getByRole('button', { name: /sign in|log in/i }).click();
  // Wait for either /onboarding (no org yet) or any /orgs/* path.
  await page.waitForURL((url) => /\/onboarding|\/orgs\//.test(url.pathname), {
    timeout: 15_000,
  });
}

/**
 * POSTs the test user's crypto identity directly to
 * `/api/crm/v1/me/crypto-key` so subsequent UI/HTTP flows can treat
 * the dialog as already-dismissed. The dialog's UI is exercised
 * separately by unit tests (cf. `packages/web/tests/unit/...`).
 */
async function seedCryptoKey(
  context: BrowserContext,
  baseUrl: string,
  identity: E2EIdentity,
): Promise<void> {
  const body = identityToCryptoKeyPostBody(identity);
  const res = await context.request.post(`${baseUrl}/api/crm/v1/me/crypto-key`, {
    data: body,
  });
  if (res.status() !== 201 && res.status() !== 200) {
    // 409 conflict (already exists) — re-derive flow is also fine
    // because we generate a fresh identity per test user.
    const text = await res.text();
    if (res.status() !== 409) {
      throw new Error(`seedCryptoKey failed: ${res.status()} ${text}`);
    }
  }
}

/**
 * Calls POST /api/crm/v1/orgs through the user's session.
 * Cookies come from the BrowserContext after `signInAndUnlock`.
 */
async function createOrgViaApi(
  context: BrowserContext,
  baseUrl: string,
  slug: string,
  name: string,
): Promise<OrgBootstrap> {
  const res = await context.request.post(`${baseUrl}/api/crm/v1/orgs`, {
    data: { slug, name },
  });
  if (res.status() !== 201) {
    const body = await res.text();
    throw new Error(`createOrgViaApi failed: ${res.status()} ${body}`);
  }
  const body = (await res.json()) as { org: OrgBootstrap };
  return body.org;
}

/* eslint-disable no-empty-pattern -- Playwright fixtures require a
   destructuring pattern even when no dep is read. */
export const test = base.extend<TestFixtures, WorkerFixtures>({
  env: [
    async ({}, use): Promise<void> => {
      await use(loadE2EEnv());
    },
    { scope: 'worker' },
  ],

  nameCtx: async ({}, use, testInfo): Promise<void> => {
    await use(makeNameContext(testInfo.file));
  },

  admin: [
    async ({}, use): Promise<void> => {
      await use(makeAdminClient());
    },
    { scope: 'worker' },
  ],

  gh: [
    async ({ env }, use): Promise<void> => {
      await use(new GithubClient(env.github.adminToken, env.github.org));
    },
    { scope: 'worker' },
  ],

  vercel: [
    async ({ env }, use): Promise<void> => {
      await use(new VercelClient(env.vercel.teamToken, env.vercel.teamId));
    },
    { scope: 'worker' },
  ],

  supabaseMgmt: [
    async ({ env }, use): Promise<void> => {
      await use(new SupabaseMgmtClient(env.supabaseMgmt.token, env.supabaseMgmt.orgSlug));
    },
    { scope: 'worker' },
  ],

  infisical: [
    async ({ env }, use): Promise<void> => {
      await use(new InfisicalClient(env.infisical.url, env.infisical.login, env.infisical.pwd));
    },
    { scope: 'worker' },
  ],

  authedAdmin: async ({ browser, admin, env, nameCtx }, use): Promise<void> => {
    const creds = await admin.createTestUser({ runUuid: nameCtx.runUuid, suffix: 'admin' });
    const identity = await generateE2EIdentity(creds.password);
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await signIn(page, creds);
      await seedCryptoKey(context, env.baseUrl, identity);
      await use({ creds, context, page, identity });
    } finally {
      await context.close().catch(() => undefined);
      await admin.deleteTestUser(creds.userId).catch(() => undefined);
    }
  },

  org: async ({ authedAdmin, env, nameCtx, admin }, use): Promise<void> => {
    // Org slug fits the `[a-z0-9](-?[a-z0-9])*` regex (cf. migration 1000).
    const slug = `vauban-e2e-${nameCtx.runUuid}`;
    const name = `vauban-e2e ${nameCtx.runUuid}`;
    const org = await createOrgViaApi(authedAdmin.context, env.baseUrl, slug, name);
    try {
      await use(org);
    } finally {
      await admin.deleteOrg(org.id).catch(() => undefined);
    }
  },
});

/* eslint-enable no-empty-pattern */

export { expect } from '@playwright/test';
