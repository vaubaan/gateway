/**
 * The Stripe secret keys (`credential.ts`) against `mockFetch` : the guide the
 * connect page shows and the check at paste.
 */
import { describe, expect, test } from 'vitest';

import { CredentialRefusal, UpstreamAuthError, type ConnectionContext } from '@vaubaan/plugin-sdk';
import { guideText, mockFetch } from '@vaubaan/plugin-sdk/testing';

import {
  STRIPE_API_BASE,
  STRIPE_KEYS_PAGE,
  stripeCredential,
  stripePlugin,
  verifyStripeKeys,
} from '../../src/index.ts';

const ACCOUNT = `${STRIPE_API_BASE}/account`;

const ctx = (
  fetch: typeof globalThis.fetch,
  fields: Record<string, string>,
): ConnectionContext => ({
  credential: { kind: 'api-key', fields, metadata: {} },
  fetch,
});

const accountAnswering = (byKey: Record<string, unknown>) =>
  mockFetch([
    {
      method: 'GET',
      url: ACCOUNT,
      respond: (call) => byKey[call.headers.authorization!.replace('Bearer ', '')],
    },
  ]);

describe('stripe keys — the guide', () => {
  test('asks for the secret key on the API keys page, and says why not a restricted one', () => {
    expect(stripePlugin.credential).toBe(stripeCredential);
    expect(stripeCredential.createUrl).toBe(STRIPE_KEYS_PAGE);
    const text = guideText(stripeCredential.guide!);
    expect(text).toMatch(/Reveal live key/);
    expect(text).toMatch(/not a restricted key/);
    expect(stripeCredential.guide!.expiry.kind).toBe('none');
  });
});

describe('stripe keys — verify at paste', () => {
  test('names the account once with the modes its keys open', async () => {
    const acme = { id: 'acct_1', settings: { dashboard: { display_name: 'Acme Inc' } } };
    const fetch = accountAnswering({ sk_test_a: acme, sk_live_b: acme });
    expect(
      await verifyStripeKeys(ctx(fetch, { test_key: 'sk_test_a', live_key: 'sk_live_b' })),
    ).toEqual({ account: 'Acme Inc (test, live)', expiresAt: null });
  });

  test('a sandbox named apart from the live account is named apart', async () => {
    const fetch = accountAnswering({
      sk_test_a: { id: 'acct_sbx', business_profile: { name: 'Acme sandbox' } },
      sk_live_b: { id: 'acct_1', business_profile: { name: 'Acme' } },
    });
    const check = await verifyStripeKeys(
      ctx(fetch, { test_key: 'sk_test_a', live_key: 'sk_live_b' }),
    );
    expect(check.account).toBe('Acme sandbox (test), Acme (live)');
  });

  test('a restricted key that may not read its account is refused with the fix', async () => {
    const fetch = mockFetch([{ method: 'GET', url: ACCOUNT, status: 403, body: {} }]);
    const check = verifyStripeKeys(ctx(fetch, { live_key: 'rk_live_x' }));
    await expect(check).rejects.toBeInstanceOf(CredentialRefusal);
    await expect(check).rejects.toThrow(/paste the secret key \(sk_live_…\)/);
  });

  test('a key in the wrong field is refused before Stripe is asked', async () => {
    const fetch = mockFetch([]);
    await expect(verifyStripeKeys(ctx(fetch, { test_key: 'sk_live_x' }))).rejects.toBeInstanceOf(
      CredentialRefusal,
    );
    expect(fetch.calls).toHaveLength(0);
  });

  test('a rejected key is an UpstreamAuthError', async () => {
    const fetch = mockFetch([{ method: 'GET', url: ACCOUNT, status: 401, body: {} }]);
    const check = verifyStripeKeys(ctx(fetch, { test_key: 'sk_test_bad' }));
    await expect(check).rejects.toBeInstanceOf(UpstreamAuthError);
    await expect(check).rejects.not.toBeInstanceOf(CredentialRefusal);
  });
});
