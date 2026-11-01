/**
 * A service connected with a token pasted by hand — its one way (ADR
 * one-place-to-authorize-services-token-first): what the connect page offers,
 * the check of a pasted token, what is stored, reconnecting an account made
 * a way the plugin no longer offers, and what refresh and revocation do with
 * a token. `mockFetch` only: no provider is called.
 */
import { describe, expect, it } from 'vitest';
import type { ApiKeyCredentialSpec, CredentialCheck } from '@vaubaan/plugin-sdk';
import { CredentialRefusal, UpstreamAuthError } from '@vaubaan/shared';

import { serializeSecret } from './credential-codec';
import { ConnectError, type ConnectErrorCode } from './errors';
import {
  connectionsHarness,
  fixturePlugin,
  type ConnectionsHarness,
} from '../../../tests/support/connections/testing';

const TOKEN = 'pat_secret_0123456789';
const BY_HAND = 'Delete the token on the tokens page.';

const NO_ACCOUNT_SAID = (): Promise<CredentialCheck> =>
  Promise.resolve({ account: null, expiresAt: null });

function tokenSpec(verify = NO_ACCOUNT_SAID): ApiKeyCredentialSpec {
  return {
    kind: 'api-key',
    label: 'personal access token',
    createUrl: 'https://provider.example.com/tokens',
    fields: [{ name: 'token', label: 'Personal access token', secret: true }],
    guide: {
      steps: [{ do: 'Create a token.' }],
      reach: { what: 'Things', grant: 'All things', why: 'Each mission narrows it.' },
      permissions: [{ name: 'Things', access: 'read', tools: ['dual__list_things'] }],
      expiry: { kind: 'person-types', recommendedDays: 90 },
      docsUrl: 'https://provider.example.com/docs/tokens',
    },
    verify,
  };
}

function dualHarness(verify = NO_ACCOUNT_SAID): ConnectionsHarness {
  return connectionsHarness({
    plugins: [
      fixturePlugin({
        id: 'dual',
        displayName: 'Dual',
        credential: tokenSpec(verify),
        toolTitles: { dual__list_things: 'List things' },
        manualRevocation: BY_HAND,
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

describe('a service connected with a pasted token', () => {
  it('is offered at once, with the guide the plugin declares', async () => {
    const h = dualHarness();
    const provider = await h.service.provider('dual');
    expect(provider).toMatchObject({
      kind: 'api-key',
      redirects: false,
      label: 'personal access token',
      createUrl: 'https://provider.example.com/tokens',
    });
    expect(provider?.guide?.permissions).toEqual([
      {
        name: 'Things',
        access: 'read',
        tools: [{ name: 'dual__list_things', title: 'List things' }],
      },
    ]);
  });

  it('a pasted token is checked first; who it acts as and its expiry are kept, never the token', async () => {
    const h = dualHarness(async () => ({ account: 'bot-account', expiresAt: IN_A_YEAR }));
    const alice = await h.actor('alice@example.com');
    const done = await h.service.start(alice, 'dual', { fields: { token: TOKEN } });
    if (done.kind !== 'connected') throw new Error('expected a connection');
    expect(done.connection.credentialExpiresAt).toBe(IN_A_YEAR);
    expect(done.connection.metadata).toMatchObject({
      credential_kind: 'api-key',
      account: 'bot-account',
      expires_at: IN_A_YEAR,
    });
    expect(done.discovery).toMatchObject({ ok: true, count: 1 });
    const view = await h.service.get(alice, done.connection.id);
    expect(view.credential_kind).toBe('api-key');
    expect(view.token_account).toBe('bot-account');
    expect(view.token_expires_at).toBe(IN_A_YEAR);
    expect(view.provider_grant).toEqual({ withdrawnByGateway: false, byHand: BY_HAND });
    expect(JSON.stringify(view)).not.toContain(TOKEN);
  });

  it('a token the provider rejects, or one already expired, stores nothing', async () => {
    const rejected = dualHarness(async () => {
      throw new UpstreamAuthError('Bad credentials', 401);
    });
    const alice = await rejected.actor('alice@example.com');
    const err = await expectConnectError(
      rejected.service.start(alice, 'dual', { fields: { token: TOKEN } }),
      'credential-rejected',
    );
    // The plugin's sentence names the fix: kept at connect time, with its status.
    expect(err.detail).toBe('Dual: Bad credentials (HTTP 401)');
    expect(await rejected.store.connections.list()).toHaveLength(0);

    const expired = dualHarness(async () => ({ account: 'x', expiresAt: '2020-01-01T00:00:00Z' }));
    const bob = await expired.actor('bob@example.com');
    const late = await expectConnectError(
      expired.service.start(bob, 'dual', { fields: { token: TOKEN } }),
      'credential-rejected',
    );
    expect(late.detail).toContain('expired on 2020-01-01');
    expect(await expired.store.connections.list()).toHaveLength(0);
  });

  it("a refusal the plugin wrote reaches the page in the plugin's words, with the credential masked", async () => {
    const sentence = 'the token lacks the scope Things: write; create it again with that scope';
    const refused = dualHarness(async () => {
      throw new CredentialRefusal(sentence, 403);
    });
    const alice = await refused.actor('alice@example.com');
    const err = await expectConnectError(
      refused.service.start(alice, 'dual', { fields: { token: TOKEN } }),
      'credential-rejected',
    );
    expect(err.detail).toBe(`Dual: ${sentence}`);

    const quoted = dualHarness(async () => {
      throw new UpstreamAuthError(`403: {"scopes":[],"token":"${TOKEN}"}`, 403);
    });
    const bob = await quoted.actor('bob@example.com');
    const hidden = await expectConnectError(
      quoted.service.start(bob, 'dual', { fields: { token: TOKEN } }),
      'credential-rejected',
    );
    // A rejection keeps its sentence at connect time, every value of the pasted token masked.
    expect(hidden.detail).toBe('Dual: 403: {"scopes":[],"token":"[credential]"} (HTTP 403)');
    expect(hidden.detail).not.toContain(TOKEN);

    const named = dualHarness(async () => {
      throw new UpstreamAuthError(
        'Dual refused the sign-in of bot: the app password is wrong or was revoked',
        401,
      );
    });
    const carol = await named.actor('carol@example.com');
    const said = await expectConnectError(
      named.service.start(carol, 'dual', { fields: { token: TOKEN } }),
      'credential-rejected',
    );
    expect(said.detail).toBe(
      'Dual: Dual refused the sign-in of bot: the app password is wrong or was revoked (HTTP 401)',
    );
  });

  it('a token the service lists the permissions of: the account names the ones it lacks', async () => {
    const h = dualHarness(async () => ({
      account: 'bot-account',
      expiresAt: IN_A_YEAR,
      granted: ['Other', '  Other  ', 42 as unknown as string],
    }));
    const alice = await h.actor('alice@example.com');
    const done = await h.service.start(alice, 'dual', { fields: { token: TOKEN } });
    if (done.kind !== 'connected') throw new Error('expected a connection');
    expect(done.connection.metadata).toMatchObject({ granted: ['Other'] });
    const view = await h.service.get(alice, done.connection.id);
    expect(view.token_lacks).toEqual([
      { name: 'Things', access: 'read', tools: ['dual__list_things'] },
    ]);

    const holds = dualHarness(async () => ({
      account: null,
      expiresAt: null,
      granted: ['things'],
    }));
    const bob = await holds.actor('bob@example.com');
    const all = await holds.service.start(bob, 'dual', { fields: { token: TOKEN } });
    if (all.kind !== 'connected') throw new Error('expected a connection');
    expect((await holds.service.get(bob, all.connection.id)).token_lacks).toEqual([]);

    // A service that cannot say leaves it unknown: nothing is guessed.
    const silent = dualHarness(async () => ({ account: null, expiresAt: null }));
    const carol = await silent.actor('carol@example.com');
    const unknown = await silent.service.start(carol, 'dual', { fields: { token: TOKEN } });
    if (unknown.kind !== 'connected') throw new Error('expected a connection');
    expect((await silent.service.get(carol, unknown.connection.id)).token_lacks).toBeNull();
  });

  it('an account made a way the plugin no longer offers is reconnected with a token, same id', async () => {
    // The OAuth apps of Supabase and Railway, the GitHub App : their accounts carry
    // a kind the plugin no longer declares, and reconnect the way it now offers.
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
    expect(before.credential_kind).toBe('oauth2');
    expect(before.token_account).toBeNull();
    // The gateway withdraws nothing for a way it no longer runs: the person does, by hand.
    expect(before.provider_grant).toEqual({ withdrawnByGateway: false, byHand: BY_HAND });

    const again = await h.service.start(alice, 'dual', {
      reconnectId: existing.id,
      fields: { token: TOKEN },
    });
    if (again.kind !== 'connected') throw new Error('expected a connection');
    expect(again.connection.id).toBe(existing.id);
    expect(again.reconnected).toBe(true);
    expect(again.connection.metadata).toMatchObject({ credential_kind: 'api-key', account: 'bot' });
    expect(again.connection.metadata).not.toHaveProperty('installation_id');
  });

  it('an account made a way the plugin no longer offers discovers nothing and says to reconnect, the plugin never called', async () => {
    // A Gmail account connected by OAuth before Gmail moved to an app password (ADR
    // gmail-over-imap-with-an-app-password): the stored oauth2 secret is not what the
    // plugin reads (`expectCredentialKind` would throw CredentialKindMismatch).
    let discoveries = 0;
    const h = connectionsHarness({
      plugins: [
        fixturePlugin({
          id: 'dual',
          displayName: 'Dual',
          credential: tokenSpec(),
          discoverResources: async () => {
            discoveries += 1;
            return [];
          },
        }),
      ],
    });
    const alice = await h.actor('alice@example.com');
    const existing = await h.store.connections.create({
      provider: 'dual',
      owner: { kind: 'user', id: alice.user.id },
      displayName: 'Dual (OAuth)',
      credential: serializeSecret({
        kind: 'oauth2',
        accessToken: 'at',
        refreshToken: 'rt',
        expiresAt: '2026-01-01T00:00:00.000Z',
        scopes: [],
        metadata: {},
      }),
      credentialExpiresAt: null,
      metadata: { credential_kind: 'oauth2' },
    });
    const view = await h.service.get(alice, existing.id);
    expect(view).toMatchObject({ credential_kind: 'oauth2', way_retired: true });

    const reason =
      'this account was connected a way Dual no longer offers on this gateway (oauth2); its owner reconnects it from Accounts.';
    expect(await h.service.discover(alice, existing.id)).toMatchObject({
      ok: false,
      count: 0,
      error: reason,
    });
    expect(
      await h.service.discoverAfterCall(existing.id, { tool: 'dual__list_things', missionId: 'm' }),
    ).toMatchObject({ record: { ok: false, error: reason }, added: 0 });
    expect(discoveries).toBe(0);
    expect(h.fetch.calls).toHaveLength(0);
    // Nothing is withdrawn at the provider for a way the gateway no longer runs.
    expect((await h.service.revoke(alice, existing.id)).providerGrant).toBe('manual');

    // An account made the plugin's way is not retired.
    const done = await h.service.start(alice, 'dual', { fields: { token: TOKEN } });
    if (done.kind !== 'connected') throw new Error('expected a connection');
    expect((await h.service.get(alice, done.connection.id)).way_retired).toBe(false);
  });

  it('an `app-install` account (the GitHub App of earlier builds) is reconnected with a token, its stored blob never read', async () => {
    // The kind the contract no longer knows since the GitHub App was removed: its sealed
    // blob does not decode (`parseSecret` refuses it), and Reconnect must not need it.
    const h = dualHarness(async () => ({ account: 'bot', expiresAt: null }));
    const alice = await h.actor('alice@example.com');
    const existing = await h.store.connections.create({
      provider: 'dual',
      owner: { kind: 'user', id: alice.user.id },
      displayName: 'Dual (app)',
      credential: '{"kind":"app-install","installationId":"1","metadata":{}}',
      credentialExpiresAt: null,
      metadata: { credential_kind: 'app-install', installation_id: '1' },
    });
    expect((await h.service.get(alice, existing.id)).credential_kind).toBe('app-install');

    const again = await h.service.start(alice, 'dual', {
      reconnectId: existing.id,
      fields: { token: TOKEN },
    });
    if (again.kind !== 'connected') throw new Error('expected a connection');
    expect(again.connection.id).toBe(existing.id);
    expect(again.reconnected).toBe(true);
    expect(again.connection.status).toBe('active');
    expect(again.connection.metadata).toMatchObject({ credential_kind: 'api-key', account: 'bot' });
    expect(again.connection.metadata).not.toHaveProperty('installation_id');
  });

  it('a rejected token cannot be refreshed: the account needs reconnecting', async () => {
    const h = dualHarness();
    const alice = await h.actor('alice@example.com');
    const done = await h.service.start(alice, 'dual', { fields: { token: TOKEN } });
    if (done.kind !== 'connected') throw new Error('expected a connection');
    await expect(h.broker.refresh(done.connection.id)).rejects.toBeInstanceOf(UpstreamAuthError);
    expect((await h.store.connections.getById(done.connection.id))?.status).toBe('expired');
    expect(h.fetch.calls).toHaveLength(0);
  });

  it('revoking a token account asks the provider nothing and says where to delete it', async () => {
    const h = dualHarness();
    const alice = await h.actor('alice@example.com');
    const done = await h.service.start(alice, 'dual', { fields: { token: TOKEN } });
    if (done.kind !== 'connected') throw new Error('expected a connection');
    const revoked = await h.service.revoke(alice, done.connection.id);
    expect(revoked.providerGrant).toBe('manual');
    expect(h.fetch.calls).toHaveLength(0);
    expect(h.service.providerGrantOf(revoked).grant.byHand).toBe(BY_HAND);
  });
});
