/**
 * Smoke E2E real-clouds — verifies the harness wires together.
 *
 * Asserts:
 *  - `.env.test` is loaded and produces all required vars.
 *  - The Next.js dev server is reachable.
 *  - The Supabase Auth admin API accepts a `createUser` call.
 *  - A test user can sign in via the `/sign-in` form and the
 *    UnlockIdentityDialog flow completes.
 *  - An org can be created via the API (covers the most fragile
 *    end-to-end path of Phase 4 wave C).
 *
 * If this spec is green, the rest of the real-clouds scenarios can
 * run. Spec §12.3.
 */

import { test, expect } from './fixtures/setup';

test('harness boots, env loads, an org can be created end-to-end', async ({
  env,
  authedAdmin,
  org,
}) => {
  expect(env.baseUrl).toMatch(/^https?:\/\//);
  expect(authedAdmin.creds.email).toContain('+e2e-');
  expect(org.id).toMatch(/^[0-9a-f-]{36}$/i);
  expect(org.slug).toMatch(/^vauban-e2e-[0-9a-f]{8}$/);

  // Navigate to the org dashboard to make sure RLS lets the admin in.
  await authedAdmin.page.goto(`/orgs/${org.slug}`);
  await authedAdmin.page.waitForLoadState('networkidle');

  // No leaking creds in the dashboard URL after sign-in.
  const url = authedAdmin.page.url();
  expect(url).not.toContain(authedAdmin.creds.password);
});
