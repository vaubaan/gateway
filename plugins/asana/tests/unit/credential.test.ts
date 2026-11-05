/**
 * The credential of the `asana` plugin : what the guide says, and the check
 * at paste against `mockFetch`.
 */
import { describe, expect, test } from 'vitest';

import { UpstreamAuthError, type ConnectionContext } from '@vaubaan/plugin-sdk';
import { guideText, mockFetch } from '@vaubaan/plugin-sdk/testing';

import { PAT_FIELD } from '../../src/identity.ts';
import { ASANA_DEVELOPER_CONSOLE, asanaCredential, verifyAsanaToken } from '../../src/index.ts';
import { TOKEN, WORKSPACE, api } from './fixtures.ts';

const ctx = (fetch: typeof globalThis.fetch): ConnectionContext => ({
  credential: { kind: 'api-key', fields: { [PAT_FIELD]: TOKEN }, metadata: {} },
  fetch,
});

const me = (data: Record<string, unknown>) => [
  { method: 'GET', url: (u: string) => u.startsWith(api('/users/me')), body: { data } },
];

describe('the Asana personal access token — the guide', () => {
  test('links the developer console, says the token has no scopes and does not expire', () => {
    expect(asanaCredential.createUrl).toBe(ASANA_DEVELOPER_CONSOLE);
    expect(asanaCredential.guide.permissions).toEqual([]);
    expect(asanaCredential.guide.reach.grant).toMatch(/no scopes/);
    expect(asanaCredential.guide.expiry.kind).toBe('none');
    expect(guideText(asanaCredential.guide)).toMatch(/Create new token/);
  });

  test('the field pattern bounds the token and nothing more (Asana: tokens are opaque)', () => {
    const pattern = new RegExp(asanaCredential.fields[0]!.pattern!);
    expect(pattern.test(TOKEN)).toBe(true);
    expect(pattern.test('2/1200000000000000/1200000000000999:abcdef0123')).toBe(true);
    expect(pattern.test('short')).toBe(false);
    expect(pattern.test('has a space in it, twenty+ chars')).toBe(false);
  });
});

describe('the Asana personal access token — verify at paste', () => {
  test('names the account, with its email when Asana gives it', async () => {
    const fetch = mockFetch(
      me({
        name: 'Ana Bot',
        email: 'ana@example.org',
        workspaces: [{ gid: WORKSPACE, name: 'Acme' }],
      }),
    );
    expect(await verifyAsanaToken(ctx(fetch))).toEqual({
      account: 'Ana Bot (ana@example.org)',
      expiresAt: null,
    });
    expect(fetch.calls[0]!.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(new URL(fetch.calls[0]!.url).searchParams.get('opt_fields')).toBe(
      'name,email,workspaces.name',
    );
  });

  test('without an email, the name alone', async () => {
    const fetch = mockFetch(me({ name: 'Ana Bot', workspaces: [{ gid: WORKSPACE }] }));
    expect(await verifyAsanaToken(ctx(fetch))).toEqual({ account: 'Ana Bot', expiresAt: null });
  });

  test('an account in no workspace is refused in our words', async () => {
    const fetch = mockFetch(me({ name: 'Ana Bot', workspaces: [] }));
    await expect(verifyAsanaToken(ctx(fetch))).rejects.toMatchObject({ name: 'CredentialRefusal' });
    await expect(verifyAsanaToken(ctx(fetch))).rejects.toThrow(/belongs to no workspace/);
  });

  test('a rejected token is an UpstreamAuthError', async () => {
    const fetch = mockFetch([{ method: 'GET', url: /\/users\/me/, status: 401 }]);
    await expect(verifyAsanaToken(ctx(fetch))).rejects.toBeInstanceOf(UpstreamAuthError);
  });
});
