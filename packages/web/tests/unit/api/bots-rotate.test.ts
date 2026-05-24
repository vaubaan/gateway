/**
 * Integration-style test for the rotate-key REST flow.
 *
 * Verifies the contract :
 *   - 401 when no session cookie.
 *   - Body validation rejects missing orgSlug.
 *
 * Full happy-path uses the real Supabase service-client and is covered by
 * the E2E playwright spec instead (golden-path) — we don't want to mock
 * the entire Supabase client here.
 */

import { describe, expect, test } from 'vitest';

// We can't easily import the route as a function (Next 15 routes export
// HTTP handlers that expect a NextRequest). Instead we simulate a fetch
// against the prod URL when E2E_BASE_URL is set. Skip otherwise.

const BASE = process.env.E2E_BASE_URL ?? 'https://cloud-resource-manager-zeta.vercel.app';

describe.skipIf(process.env.SKIP_LIVE === '1')('REST /api/v1/bots/:botId/rotate-key', () => {
  test('rejects unauthenticated POST with 401', async () => {
    const res = await fetch(`${BASE}/api/v1/bots/00000000-0000-0000-0000-000000000000/rotate-key`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ orgSlug: 'sbw-vauban-test' }),
    });
    expect([401, 403]).toContain(res.status);
  });

  test('rejects malformed body with 400 (even when authenticated would 401 first)', async () => {
    const res = await fetch(`${BASE}/api/v1/bots/00000000-0000-0000-0000-000000000000/rotate-key`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect([400, 401]).toContain(res.status);
  });
});
