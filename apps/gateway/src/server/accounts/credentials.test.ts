/**
 * The credential broker: decrypted credentials for plugins and the
 * host-generic OAuth refresh (rotation, persistence, error mapping).
 */
import { UpstreamAuthError } from '@vaubaan/shared';
import type { AccountContext, CredentialSecret, OAuth2Secret } from '@vaubaan/plugin-sdk';
import type { MockRoute } from '@vaubaan/plugin-sdk/testing';
import { describe, expect, it } from 'vitest';

import { makeUnowned } from '../../../tests/support/store/testing';
import { parseSecret, serializeSecret } from './credential-codec';
import { REFRESH_SKEW_MS } from './credentials';
import { AccountUnavailableError, ProviderUnreachableError } from './errors';
import {
  API_KEY_SPEC,
  accountsHarness,
  fixturePlugin,
  OAUTH_SPEC,
  type AccountsHarness,
} from '../../../tests/support/accounts/testing';

const TOKEN_URL = OAUTH_SPEC.tokenUrl;
const RESOURCE = 'https://mcp.example.com';
const SPEC = { ...OAUTH_SPEC, resourceIndicator: RESOURCE };

function secret(overrides: Partial<OAuth2Secret> = {}): OAuth2Secret {
  return {
    kind: 'oauth2',
    accessToken: 'at-1',
    refreshToken: 'rt-1',
    expiresAt: '2026-10-13T10:00:00.000Z', // one hour after the test clock
    scopes: ['read'],
    metadata: {},
    ...overrides,
  };
}

async function seed(
  h: AccountsHarness,
  provider: string,
  credential: CredentialSecret,
): Promise<string> {
  const owner = await h.actor('owner@example.com');
  const account = await h.store.accounts.create({
    provider,
    owner: { kind: 'user', id: owner.user.id },
    displayName: provider,
    credential: serializeSecret(credential),
    credentialExpiresAt: credential.kind === 'oauth2' ? credential.expiresAt : null,
  });
  return account.id;
}

function oauthHarness(routes: readonly MockRoute[]) {
  const h = accountsHarness({
    plugins: [fixturePlugin({ id: 'oauthco', displayName: 'OAuth Co', credential: SPEC })],
    routes,
  });
  return h;
}

async function configured(h: AccountsHarness): Promise<AccountsHarness> {
  await h.seedClient('oauthco', 'cid', 'csecret');
  return h;
}

const refreshed = (n: number): MockRoute => ({
  method: 'POST',
  url: TOKEN_URL,
  times: 1,
  body: { access_token: `at-${n}`, refresh_token: `rt-${n}`, expires_in: 3600 },
});

describe('resolve', () => {
  it('hands the decrypted credential, never the client secret', async () => {
    const h = await configured(oauthHarness([]));
    const id = await seed(h, 'oauthco', secret());
    const resolved = await h.broker.resolve(id);
    expect(resolved.credential).toEqual(secret());
    expect(resolved.plugin.id).toBe('oauthco');
    expect(h.fetch.calls).toHaveLength(0);

    const ctx = h.broker.contextOf(resolved, new AbortController().signal);
    expect(JSON.stringify(ctx)).not.toContain('csecret');
  });

  it('refreshes a token about to expire, rotates the refresh token and persists both', async () => {
    const h = await configured(oauthHarness([refreshed(2), refreshed(3)]));
    const id = await seed(h, 'oauthco', secret());
    h.clock.advance(3_600_000 - REFRESH_SKEW_MS); // exactly at the skew boundary

    const resolved = await h.broker.resolve(id);
    expect(resolved.credential).toMatchObject({ accessToken: 'at-2', refreshToken: 'rt-2' });
    const call = h.fetch.calls[0]!;
    expect(Object.fromEntries(new URLSearchParams(call.body ?? ''))).toEqual({
      grant_type: 'refresh_token',
      refresh_token: 'rt-1',
      resource: RESOURCE,
    });
    expect(call.headers.authorization).toBe(
      `Basic ${Buffer.from('cid:csecret').toString('base64')}`,
    );

    // Persisted: a new broker call reads the rotated token from the store, sealed again.
    const stored = parseSecret((await h.store.accounts.getCredential(id))!);
    expect(stored).toMatchObject({ accessToken: 'at-2', refreshToken: 'rt-2' });
    const row = await h.store.accounts.getById(id);
    expect(row).toMatchObject({
      status: 'active',
      credentialExpiresAt: '2026-10-13T10:59:00.000Z',
    });
    expect(h.encryptor.sealCalls.filter((c) => c.associatedData === id)).toHaveLength(2);

    // Not expiring any more: no further call.
    await h.broker.resolve(id);
    expect(h.fetch.calls).toHaveLength(1);

    // The next refresh presents the rotated token.
    h.clock.advance(3_600_000);
    await h.broker.resolve(id);
    expect(new URLSearchParams(h.fetch.calls[1]!.body ?? '').get('refresh_token')).toBe('rt-2');
  });

  it('serves an unowned account: missions keep running (spec §2.3)', async () => {
    const h = await configured(oauthHarness([refreshed(2)]));
    const id = await seed(h, 'oauthco', secret());
    await makeUnowned(h.store, id);

    const resolved = await h.broker.resolve(id);
    expect(resolved.account.status).toBe('unowned');
    expect(resolved.credential).toEqual(secret());
    expect(h.fetch.calls).toHaveLength(0);

    // A token about to expire is refreshed and the rotated pair is persisted,
    // otherwise the single-use refresh token would be lost with the next call.
    h.clock.advance(3_600_000 - REFRESH_SKEW_MS);
    const again = await h.broker.resolve(id);
    expect(again.credential).toMatchObject({ accessToken: 'at-2', refreshToken: 'rt-2' });
    expect(parseSecret((await h.store.accounts.getCredential(id))!)).toMatchObject({
      accessToken: 'at-2',
      refreshToken: 'rt-2',
    });
    // Refreshing is not a reconnection: the account still has no owner.
    expect((await h.store.accounts.getById(id))!.status).toBe('unowned');
  });

  it('refuses an expired or a revoked account, without decrypting anything', async () => {
    const h = await configured(oauthHarness([]));
    const id = await seed(h, 'oauthco', secret());
    await h.store.accounts.markExpired(id);
    await expect(h.broker.resolve(id)).rejects.toMatchObject({
      name: 'AccountUnavailableError',
      accountStatus: 'expired',
    });
    await h.store.accounts.revoke(id);
    await expect(h.broker.resolve(id)).rejects.toMatchObject({ accountStatus: 'revoked' });
    await expect(h.broker.resolve('missing')).rejects.toBeInstanceOf(AccountUnavailableError);
  });

  it('uses a token without expiry or without refresh token as it is', async () => {
    const h = await configured(oauthHarness([]));
    const noExpiry = await seed(h, 'oauthco', secret({ expiresAt: null }));
    const noRefresh = await seed(h, 'oauthco', secret({ refreshToken: null }));
    h.clock.advance(7_200_000);
    await expect(h.broker.resolve(noExpiry)).resolves.toMatchObject({
      credential: { accessToken: 'at-1' },
    });
    await expect(h.broker.resolve(noRefresh)).resolves.toMatchObject({
      credential: { accessToken: 'at-1' },
    });
    expect(h.fetch.calls).toHaveLength(0);
  });
});

describe('refresh', () => {
  it('runs one grant for concurrent callers (rotating refresh tokens are single use)', async () => {
    const h = await configured(oauthHarness([refreshed(2)]));
    const id = await seed(h, 'oauthco', secret());
    const results = await Promise.all([
      h.broker.refresh(id),
      h.broker.refresh(id),
      h.broker.refresh(id),
    ]);
    expect(h.fetch.calls).toHaveLength(1);
    expect(results.map((r) => (r.credential as OAuth2Secret).accessToken)).toEqual([
      'at-2',
      'at-2',
      'at-2',
    ]);
  });

  it('marks the account expired and throws UpstreamAuthError when the grant is rejected', async () => {
    const h = await configured(
      oauthHarness([
        {
          method: 'POST',
          url: TOKEN_URL,
          status: 400,
          body: { error: 'invalid_grant', error_description: 'refresh token revoked' },
        },
      ]),
    );
    const id = await seed(h, 'oauthco', secret());
    const err = await h.broker.refresh(id).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UpstreamAuthError);
    expect((err as UpstreamAuthError).upstreamStatus).toBe(400);
    expect((err as Error).message).toContain('OAuth Co rejected the credential');
    expect((err as Error).message).toContain('invalid_grant: refresh token revoked');
    expect((err as Error).message).not.toContain('csecret');
    expect((await h.store.accounts.getById(id))!.status).toBe('expired');
    // The stored credential is untouched: a reconnection replaces it.
    expect(parseSecret((await h.store.accounts.getCredential(id))!)).toEqual(secret());
  });

  it('forces a refresh on an unowned account and keeps it unowned', async () => {
    const h = await configured(oauthHarness([refreshed(2)]));
    const id = await seed(h, 'oauthco', secret());
    await makeUnowned(h.store, id);
    const resolved = await h.broker.refresh(id);
    expect(resolved.credential).toMatchObject({ accessToken: 'at-2', refreshToken: 'rt-2' });
    expect(resolved.account.status).toBe('unowned');
  });

  it('expires an unowned account whose refresh is rejected: it stops serving', async () => {
    // A serving account with a dead credential is `expired`, owned or not (handbook
    // accounts, Debug). It stays ownerless: the operator reassigns
    // an owner (`listOwnerless`), who reconnects.
    const h = await configured(
      oauthHarness([
        { method: 'POST', url: TOKEN_URL, status: 400, body: { error: 'invalid_grant' } },
      ]),
    );
    const id = await seed(h, 'oauthco', secret());
    await makeUnowned(h.store, id);
    await expect(h.broker.refresh(id)).rejects.toBeInstanceOf(UpstreamAuthError);
    expect((await h.store.accounts.getById(id))!.status).toBe('expired');
    expect(parseSecret((await h.store.accounts.getCredential(id))!)).toEqual(secret());
    await expect(h.broker.resolve(id)).rejects.toBeInstanceOf(AccountUnavailableError);
  });

  it('leaves the account active when the provider is merely unreachable', async () => {
    const h = await configured(
      oauthHarness([{ method: 'POST', url: TOKEN_URL, status: 503, body: 'try later' }]),
    );
    const id = await seed(h, 'oauthco', secret());
    await expect(h.broker.refresh(id)).rejects.toBeInstanceOf(ProviderUnreachableError);
    expect((await h.store.accounts.getById(id))!.status).toBe('active');
  });

  it('expires the account when the client it was made with is no longer registered', async () => {
    // The grant belonged to that client: nothing can refresh it, the owner reconnects.
    const h = oauthHarness([]);
    const id = await seed(h, 'oauthco', secret());
    await expect(h.broker.refresh(id)).rejects.toThrow(/reconnect it/);
    expect((await h.store.accounts.getById(id))!.status).toBe('expired');
    expect(h.fetch.calls).toHaveLength(0);
  });

  it('expires a credential that has no refresh path (api key, oauth2 without refresh token)', async () => {
    const h = accountsHarness({
      plugins: [
        fixturePlugin({ id: 'keyco', credential: API_KEY_SPEC }),
        fixturePlugin({ id: 'oauthco', credential: SPEC }),
      ],
    });
    await h.seedClient('oauthco', 'cid', 'csecret');
    const key = await seed(h, 'keyco', { kind: 'api-key', fields: { token: 't' }, metadata: {} });
    const bare = await seed(h, 'oauthco', secret({ refreshToken: null }));
    await expect(h.broker.refresh(key)).rejects.toBeInstanceOf(UpstreamAuthError);
    await expect(h.broker.refresh(bare)).rejects.toBeInstanceOf(UpstreamAuthError);
    expect((await h.store.accounts.getById(key))!.status).toBe('expired');
    expect((await h.store.accounts.getById(bare))!.status).toBe('expired');
    expect(h.fetch.calls).toHaveLength(0);
  });

  it('never resurrects an account revoked while the provider was answering', async () => {
    const h = await configured(
      oauthHarness([
        {
          method: 'POST',
          url: TOKEN_URL,
          respond: () => ({ access_token: 'at-2', refresh_token: 'rt-2', expires_in: 3600 }),
        },
      ]),
    );
    const id = await seed(h, 'oauthco', secret());
    const original = h.store.accounts.refreshCredential.bind(h.store.accounts);
    h.store.accounts.refreshCredential = async (...args) => {
      await h.store.accounts.revoke(id); // the owner revokes just before the write
      return original(...args);
    };
    await expect(h.broker.refresh(id)).rejects.toMatchObject({ accountStatus: 'revoked' });
    const row = await h.store.accounts.getById(id);
    expect(row!.status).toBe('revoked');
    expect(await h.store.accounts.getCredential(id)).toBeNull();
  });

  it('calls the plugin refresh() instead of the generic grant when the plugin declares one', async () => {
    const seen: AccountContext[] = [];
    const h = accountsHarness({
      plugins: [
        fixturePlugin({
          id: 'oauthco',
          credential: SPEC,
          refresh: async (ctx) => {
            seen.push(ctx);
            return secret({ accessToken: 'at-plugin', refreshToken: 'rt-plugin' });
          },
        }),
      ],
    });
    await h.seedClient('oauthco', 'cid', 'csecret');
    const id = await seed(h, 'oauthco', secret());
    const resolved = await h.broker.refresh(id);
    expect(resolved.credential).toMatchObject({ accessToken: 'at-plugin' });
    expect(h.fetch.calls).toHaveLength(0); // no token endpoint call by the host
    expect(JSON.stringify(seen[0])).not.toContain('csecret'); // never the client secret
    expect(parseSecret((await h.store.accounts.getCredential(id))!)).toMatchObject({
      refreshToken: 'rt-plugin',
    });
  });

  it('maps a rejecting plugin refresh() to expired, any other failure to unreachable', async () => {
    let failure: Error = new UpstreamAuthError('installation suspended', 403);
    const h = accountsHarness({
      plugins: [
        fixturePlugin({
          id: 'keyco',
          credential: API_KEY_SPEC,
          refresh: async () => {
            throw failure;
          },
        }),
      ],
    });
    const a = await seed(h, 'keyco', { kind: 'api-key', fields: { token: 't' }, metadata: {} });
    const b = await seed(h, 'keyco', { kind: 'api-key', fields: { token: 't' }, metadata: {} });

    await expect(h.broker.refresh(a)).rejects.toMatchObject({ upstreamStatus: 403 });
    expect((await h.store.accounts.getById(a))!.status).toBe('expired');

    failure = new Error('socket hang up');
    await expect(h.broker.refresh(b)).rejects.toBeInstanceOf(ProviderUnreachableError);
    expect((await h.store.accounts.getById(b))!.status).toBe('active');
  });
});
