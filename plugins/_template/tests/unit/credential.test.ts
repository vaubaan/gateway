/**
 * The credential of a plugin (`credential.ts`) : its guide says what the
 * connect page shows, and its check at paste runs against `mockFetch`.
 */
import { describe, expect, test } from 'vitest';

import { UpstreamAuthError, type AccountContext } from '@vaubaan/plugin-sdk';
import { guideText, mockFetch } from '@vaubaan/plugin-sdk/testing';

import { TEMPLATE_API_BASE } from '../../src/execute.ts';
import { API_KEY_FIELD } from '../../src/identity.ts';
import { TEMPLATE_KEYS_PAGE, templateCredential, verifyTemplateKey } from '../../src/index.ts';

const ctx = (fetch: typeof globalThis.fetch): AccountContext => ({
  credential: { kind: 'api-key', fields: { [API_KEY_FIELD]: 'k-123' }, metadata: {} },
  fetch,
});

describe('the template key — the guide', () => {
  test('links the key page itself and asks for the widest grant', () => {
    expect(templateCredential.createUrl).toBe(TEMPLATE_KEYS_PAGE);
    expect(templateCredential.guide.reach.grant).toMatch(/^All workspaces/);
    expect(guideText(templateCredential.guide)).toMatch(/tick every permission below/);
  });
});

describe('the template key — verify at paste', () => {
  test('names the account the key acts as', async () => {
    const fetch = mockFetch([
      { method: 'GET', url: `${TEMPLATE_API_BASE}/me`, body: { name: 'acme-bot' } },
    ]);
    expect(await verifyTemplateKey(ctx(fetch))).toEqual({ account: 'acme-bot', expiresAt: null });
    expect(fetch.calls[0]!.headers.authorization).toBe('Bearer k-123');
  });

  test('a rejected key is an UpstreamAuthError', async () => {
    const fetch = mockFetch([{ method: 'GET', url: `${TEMPLATE_API_BASE}/me`, status: 401 }]);
    await expect(verifyTemplateKey(ctx(fetch))).rejects.toBeInstanceOf(UpstreamAuthError);
  });
});
