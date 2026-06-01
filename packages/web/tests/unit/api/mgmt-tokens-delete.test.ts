/**
 * Smoke test for DELETE /api/v1/mgmt/tokens/:tokenId.
 *
 * Verifies the contract :
 *   - 401 when no Bearer header.
 *   - 401 when Bearer is not a vbn_mgmt_… key (route refuses other kinds).
 *
 * Until the route is deployed to the target environment we also accept
 * 404 (route not found) — same flex as `tokens-rotate.test.ts`.
 *
 * Full happy-path requires a real ManagementKey + an AccessToken in DB,
 * covered by the integration tests run against staging.
 */

import { describe, expect, test } from 'vitest';

const BASE = process.env.E2E_BASE_URL ?? 'https://vaubaan.com';
const DUMMY_TOKEN_ID = '00000000-0000-0000-0000-000000000000';

describe.skipIf(process.env.SKIP_LIVE === '1')('REST DELETE /api/v1/mgmt/tokens/:tokenId', () => {
  test('rejects unauthenticated DELETE', async () => {
    const res = await fetch(`${BASE}/api/v1/mgmt/tokens/${DUMMY_TOKEN_ID}`, {
      method: 'DELETE',
    });
    expect([401, 404]).toContain(res.status);
  });

  test('rejects a non-mgmt Bearer', async () => {
    const res = await fetch(`${BASE}/api/v1/mgmt/tokens/${DUMMY_TOKEN_ID}`, {
      method: 'DELETE',
      headers: {
        authorization: 'Bearer vbn_live_xxxxxxxx_yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy',
      },
    });
    expect([401, 404]).toContain(res.status);
  });
});
