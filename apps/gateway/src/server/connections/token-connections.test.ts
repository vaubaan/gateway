/**
 * A service that connects in two ways — the company's app and a token pasted
 * by hand (ADR token-connections-beside-the-integration-app): which way is
 * offered, the check of a pasted token, what is stored, reconnecting the
 * other way, and what refresh and revocation do with a token. `mockFetch`
 * only: no provider is called.
 */
import { describe, expect, it } from 'vitest';
import type { ApiKeyCredentialSpec, CredentialCheck } from '@vaubaan/plugin-sdk';
import { UpstreamAuthError } from '@vaubaan/shared';

import { serializeSecret } from './credential-codec';
import { ConnectError, type ConnectErrorCode } from './errors';
import { defaultMethod } from './service';
import { connectionsHarness, fixturePlugin, OAUTH_SPEC, type ConnectionsHarness } from './testing';

const REVOKE_URL = 'https://provider.example.com/oauth/revoke';
const TOKEN = 'pat_secret_0123456789';

function tokenSpec(verify?: () => Promise<CredentialCheck>): ApiKeyCredentialSpec {
  return {
    kind: 'api-key',
    label: 'personal access token',
    createUrl: 'https://provider.example.com/tokens',
    fields: [{ name: 'token', label: 'Personal access token', secret: true }],
    guide: {
      steps: ['Create a token.'],
      permissions: [{ name: 'Things', access: 'read', tools: ['dual__list_things'] }],
      recommendedExpiryDays: 90,
    },
    manualRevocation: 'Delete the token on the tokens page.',
    ...(verify ? { verify } : {}),
  };
}

function dualHarness(verify?: () => Promise<CredentialCheck>): ConnectionsHarness {
  return connectionsHarness({
    plugins: [
      fixturePlugin({
        id: 'dual',
        displayName: 'Dual',
        credential: { ...OAUTH_SPEC, revocation: { url: REVOKE_URL, format: 'token-form' } },
        alternativeCredentials: [tokenSpec(verify)],
        toolTitles: { dual__list_things: 'List things' },
        manualRevocation: 'Revoke the app in the organisation settings.',
        discoverResources: async () => [{ provider: 'dual', ref: 'space-1', displayName: 'One' }],
      }),
    ],
  });
}

async function expectConnectError(promise: Promise<unknown>, code: ConnectErrorCode) {
  const err = await promise.catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ConnectError);
  expect((err as ConnectError).code).toBe(code);
  return err as ConnectError;
}

const IN_A_YEAR = '2027-10-14T00:00:00.000Z';

describe('two ways to connect one service', () => {
  it('without a company app, the token is the way offered; with one, the app comes first', async () => {
    const h = dualHarness();
    const bare = await h.service.provider('dual');
    expect(bare?.configured).toBe(true);
    expect(bare?.kind).toBe('api-key');
    expect(bare?.methods.map((m) => [m.kind, m.usesApp, m.configured])).toEqual([
      ['oauth2', true, false],
      ['api-key', false, true],
    ]);
    const token = bare!.methods[1]!;
    expect(token.label).toBe('personal access token');
    expect(token.guide?.permissions).toEqual([
      {
        name: 'Things',
        access: 'read',
        tools: [{ name: 'dual__list_things', title: 'List things' }],
      },
    ]);

    await h.providerApps.save('dual', { client_id: 'cid', client_secret: 'csecret' });
    const withApp = await h.service.provider('dual');
    expect(withApp?.kind).toBe('oauth2');
    expect(defaultMethod(withApp!).kind).toBe('oauth2');
    expect(withApp?.methods.every((m) => m.configured)).toBe(true);
  });

  it('a pasted token is checked first; who it acts as and its expiry are kept, never the token', async () => {
    const h = dualHarness(async () => ({ account: 'bot-account', expiresAt: IN_A_YEAR }));
    const alice = await h.actor('alice@example.com');
    const done = await h.service.start(alice, 'dual', {
      method: 'api-key',
      fields: { token: TOKEN },
    });
    if (done.kind !== 'connected') throw new Error('expected a connection');
    expect(done.connection.credentialExpiresAt).toBe(IN_A_YEAR);
    expect(done.connection.metadata).toMatchObject({
      credential_kind: 'api-key',
      account: 'bot-account',
      expires_at: IN_A_YEAR,
    });
    expect(done.discovery).toMatchObject({ ok: true, count: 1 });
    const view = await h.service.get(alice, done.connection.id);
    expect(view.credentialKind).toBe('api-key');
    expect(view.tokenAccount).toBe('bot-account');
    expect(view.tokenExpiresAt).toBe(IN_A_YEAR);
    expect(view.providerGrant).toEqual({
      withdrawnByGateway: false,
      byHand: 'Delete the token on the tokens page.',
    });
    expect(JSON.stringify(view)).not.toContain(TOKEN);
  });

  it('a token the provider rejects, or one already expired, stores nothing', async () => {
    const rejected = dualHarness(async () => {
      throw new UpstreamAuthError('Bad credentials', 401);
    });
    const alice = await rejected.actor('alice@example.com');
    const err = await expectConnectError(
      rejected.service.start(alice, 'dual', { method: 'api-key', fields: { token: TOKEN } }),
      'credential-rejected',
    );
    expect(err.detail).toBe('Dual: the provider rejected the credential (HTTP 401)');
    expect(await rejected.store.connections.list()).toHaveLength(0);

    const expired = dualHarness(async () => ({ account: 'x', expiresAt: '2020-01-01T00:00:00Z' }));
    const bob = await expired.actor('bob@example.com');
    const late = await expectConnectError(
      expired.service.start(bob, 'dual', { method: 'api-key', fields: { token: TOKEN } }),
      'credential-rejected',
    );
    expect(late.detail).toContain('expired on 2020-01-01');
    expect(await expired.store.connections.list()).toHaveLength(0);
  });

  it('a way the plugin does not declare is refused', async () => {
    const h = dualHarness();
    const alice = await h.actor('alice@example.com');
    await expectConnectError(
      h.service.start(alice, 'dual', { method: 'ssh-key' }),
      'invalid-input',
    );
    await expectConnectError(
      h.service.start(alice, 'dual', { method: 'nonsense' }),
      'invalid-input',
    );
  });

  it('the app way still needs the app: chosen explicitly without one, it is refused', async () => {
    const h = dualHarness();
    const alice = await h.actor('alice@example.com');
    await expectConnectError(
      h.service.start(alice, 'dual', { method: 'oauth2' }),
      'app-not-configured',
    );
  });

  it('an account made through the app keeps working and is reconnected with a token, same id', async () => {
    const h = dualHarness(async () => ({ account: 'bot', expiresAt: null }));
    const alice = await h.actor('alice@example.com');
    const existing = await h.store.connections.create({
      provider: 'dual',
      owner: { kind: 'user', id: alice.user.id },
      displayName: 'Dual',
      credential: serializeSecret({
        kind: 'oauth2',
        accessToken: 'at',
        refreshToken: 'rt',
        expiresAt: null,
        scopes: [],
        metadata: {},
      }),
      credentialExpiresAt: null,
      metadata: { credential_kind: 'oauth2', installation_id: 'stale-fact' },
    });
    const before = await h.service.get(alice, existing.id);
    expect(before.credentialKind).toBe('oauth2');
    expect(before.tokenAccount).toBeNull();
    expect(before.providerGrant.withdrawnByGateway).toBe(true);

    const again = await h.service.start(alice, 'dual', {
      method: 'api-key',
      reconnectId: existing.id,
      fields: { token: TOKEN },
    });
    if (again.kind !== 'connected') throw new Error('expected a connection');
    expect(again.connection.id).toBe(existing.id);
    expect(again.reconnected).toBe(true);
    expect(again.connection.metadata).toMatchObject({ credential_kind: 'api-key', account: 'bot' });
    expect(again.connection.metadata).not.toHaveProperty('installation_id');
  });

  it('a rejected token cannot be refreshed: the account needs reconnecting', async () => {
    const h = dualHarness();
    await h.providerApps.save('dual', { client_id: 'cid', client_secret: 'csecret' });
    const alice = await h.actor('alice@example.com');
    const done = await h.service.start(alice, 'dual', {
      method: 'api-key',
      fields: { token: TOKEN },
    });
    if (done.kind !== 'connected') throw new Error('expected a connection');
    // The plugin's OAuth spec refreshes, but a pasted token has no refresh path.
    await expect(h.broker.refresh(done.connection.id)).rejects.toBeInstanceOf(UpstreamAuthError);
    expect((await h.store.connections.getById(done.connection.id))?.status).toBe('expired');
    expect(h.fetch.calls).toHaveLength(0);
  });

  it('revoking a token account asks the provider nothing and says where to delete it', async () => {
    const h = dualHarness();
    const alice = await h.actor('alice@example.com');
    const done = await h.service.start(alice, 'dual', {
      method: 'api-key',
      fields: { token: TOKEN },
    });
    if (done.kind !== 'connected') throw new Error('expected a connection');
    const revoked = await h.service.revoke(alice, done.connection.id);
    expect(revoked.providerGrant).toBe('manual');
    expect(h.fetch.calls).toHaveLength(0);
    expect(h.service.providerGrantOf(revoked).grant.byHand).toBe(
      'Delete the token on the tokens page.',
    );
  });
});
