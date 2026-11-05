/**
 * The credential (`credential.ts`): what the guide says, and the check at
 * paste against `mockFetch`.
 */
import { describe, expect, test } from 'vitest';

import { UpstreamAuthError, type ConnectionContext } from '@vaubaan/plugin-sdk';
import { guideText, mockFetch } from '@vaubaan/plugin-sdk/testing';

import { AXONAUT_API_BASE } from '../../src/execute.ts';
import { API_KEY_FIELD } from '../../src/identity.ts';
import { AXONAUT_SIGN_IN_PAGE, axonautCredential, verifyAxonautKey } from '../../src/index.ts';

const KEY = 'axk-0123456789abcdef';
const ctx = (fetch: typeof globalThis.fetch): ConnectionContext => ({
  credential: { kind: 'api-key', fields: { [API_KEY_FIELD]: KEY }, metadata: {} },
  fetch,
});
const me = (overrides: Record<string, unknown> = {}) => ({
  id: 58962,
  email: 'claire@acme.fr',
  fullname: 'Claire Rousseau',
  user_api_key: KEY,
  account: [{ id: 4242, company_name: 'Acme SAS' }],
  ...overrides,
});

describe('the Axonaut key — the guide', () => {
  test('names the menu path, the whole account as the grant, and no expiry', () => {
    expect(axonautCredential.createUrl).toBe(AXONAUT_SIGN_IN_PAGE);
    expect(guideText(axonautCredential.guide)).toMatch(/Settings \(Paramètres\), then API/);
    expect(axonautCredential.guide.reach.grant).toMatch(/^The whole Axonaut account/);
    expect(axonautCredential.guide.permissions).toEqual([]);
    expect(axonautCredential.guide.expiry).toMatchObject({ kind: 'none' });
  });

  test('the field refuses a value with a space and accepts a printable key', () => {
    const pattern = new RegExp(axonautCredential.fields[0]!.pattern!);
    expect(pattern.test(KEY)).toBe(true);
    expect(pattern.test('two words')).toBe(false);
    expect(pattern.test('short')).toBe(false);
  });
});

describe('the Axonaut key — verify at paste', () => {
  test('names the user and the account the key acts as, never the key', async () => {
    const fetch = mockFetch([{ method: 'GET', url: `${AXONAUT_API_BASE}/me`, body: me() }]);
    const check = await verifyAxonautKey(ctx(fetch));
    expect(check).toEqual({ account: 'Claire Rousseau · Acme SAS', expiresAt: null });
    expect(JSON.stringify(check)).not.toContain(KEY);
    expect(fetch.calls[0]!.headers.userapikey).toBe(KEY);
  });

  test('a user without a name is named by its e-mail address', async () => {
    const fetch = mockFetch([
      { method: 'GET', url: `${AXONAUT_API_BASE}/me`, body: me({ fullname: '' }) },
    ]);
    expect((await verifyAxonautKey(ctx(fetch))).account).toBe('claire@acme.fr · Acme SAS');
  });

  test('a key that opens no account is refused in the plugin’s words', async () => {
    const fetch = mockFetch([
      { method: 'GET', url: `${AXONAUT_API_BASE}/me`, body: me({ account: null }) },
    ]);
    await expect(verifyAxonautKey(ctx(fetch))).rejects.toMatchObject({
      name: 'CredentialRefusal',
      message: 'This Axonaut key opens no company account.',
    });
  });

  test('a rejected key is an UpstreamAuthError', async () => {
    const fetch = mockFetch([{ method: 'GET', url: `${AXONAUT_API_BASE}/me`, status: 401 }]);
    await expect(verifyAxonautKey(ctx(fetch))).rejects.toBeInstanceOf(UpstreamAuthError);
  });
});
