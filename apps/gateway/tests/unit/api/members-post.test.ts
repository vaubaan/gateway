/**
 * Smoke tests for POST /api/v1/members.
 *
 * Tests that don't need a DB:
 *   - 401 / 403 when no session cookie.
 *   - 400 when body is invalid.
 *
 * Tests that need a live DB (skipped in CI with SKIP_LIVE=1):
 *   - 409 when user is already a member of the org.
 *
 * Happy-path cases (also need live DB — document only):
 *   - Existing global user, not yet a member → 200 { invited: false }
 *   - New email → 200 { invited: true }
 */

import { describe, expect, test } from 'vitest';

const BASE = process.env.E2E_BASE_URL ?? 'https://vaubaan.com';

describe('REST POST /api/v1/members — no auth', () => {
  test('rejects unauthenticated request', async () => {
    const res = await fetch(`${BASE}/api/v1/members`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orgSlug: 'test-org', email: 'test@example.com' }),
    });
    expect([401, 403]).toContain(res.status);
  });
});

describe('REST POST /api/v1/members — validation', () => {
  test('returns 400 for missing orgSlug', async () => {
    const res = await fetch(`${BASE}/api/v1/members`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'test@example.com' }),
    });
    expect(res.status).toBe(400);
  });

  test('returns 400 for invalid email', async () => {
    const res = await fetch(`${BASE}/api/v1/members`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orgSlug: 'test-org', email: 'not-an-email' }),
    });
    expect(res.status).toBe(400);
  });

  test('returns 400 for missing body fields', async () => {
    const res = await fetch(`${BASE}/api/v1/members`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });
});

// These tests require a real DB and a valid session. Run them against staging
// with SKIP_LIVE unset. In CI, set SKIP_LIVE=1 to skip.
describe.skipIf(process.env.SKIP_LIVE === '1')('REST POST /api/v1/members — live DB', () => {
  test('returns 409 when user is already a member of the org', async () => {
    // Prerequisites:
    //   - AUTH_COOKIE must be a valid session cookie for an org member.
    //   - EXISTING_MEMBER_EMAIL must be an email already in org_members for that org.
    //   - ORG_SLUG must be the org's slug.
    const cookie = process.env.AUTH_COOKIE ?? '';
    const email = process.env.EXISTING_MEMBER_EMAIL ?? '';
    const orgSlug = process.env.ORG_SLUG ?? '';

    const res = await fetch(`${BASE}/api/v1/members`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie,
      },
      body: JSON.stringify({ orgSlug, email }),
    });
    expect(res.status).toBe(409);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe('User is already a member of this organization.');
  });

  // Happy-path cases (require live DB + invite-capable Supabase project):
  //
  // test('existing global user, not yet a member → 200 { invited: false }', ...)
  //   POST with email of a user that exists in auth.users but is not in org_members
  //   → expect 200, body.invited === false
  //
  // test('new email → 200 { invited: true }', ...)
  //   POST with a fresh email not in auth.users
  //   → expect 200, body.invited === true
});
