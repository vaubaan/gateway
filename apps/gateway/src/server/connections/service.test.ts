/**
 * The connect driver, one credential kind at a time, against mocked provider
 * endpoints (`mockFetch` rejects any request no route covers, so nothing
 * here can reach a network).
 */
import { UpstreamAuthError } from '@vaubaan/shared';
import type { ConnectionContext, Resource } from '@vaubaan/plugin-sdk';
import type { MockRoute } from '@vaubaan/plugin-sdk/testing';
import { describe, expect, it } from 'vitest';

import { makeUnowned } from '../store/testing';
import { parseSecret } from './credential-codec';
import { ConnectError, type ConnectErrorCode } from './errors';
import { codeChallengeS256 } from './oauth2';
import { CONNECT_RATE_LIMIT, CONNECT_RATE_WINDOW_MS, type StartResult } from './service';
import {
  API_KEY_SPEC,
  connectionsHarness,
  fixturePlugin,
  OAUTH_SPEC,
  PUBLIC_URL,
  SSH_KEY_SPEC,
  stateOf,
  type ConnectionsHarness,
} from './testing';

const TOKEN_OK: MockRoute = {
  method: 'POST',
  url: OAUTH_SPEC.tokenUrl,
  body: { access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600, scope: 'read write' },
};

const resource = (provider: string, ref: string, extra: Partial<Resource> = {}): Resource => ({
  provider,
  ref,
  displayName: `Display ${ref}`,
  ...extra,
});

async function expectConnectError(
  promise: Promise<unknown>,
  code: ConnectErrorCode,
): Promise<ConnectError> {
  const err = await promise.catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ConnectError);
  expect((err as ConnectError).code).toBe(code);
  return err as ConnectError;
}

function redirectOf(result: StartResult): string {
  if (result.kind !== 'redirect') throw new Error('expected a redirect');
  return result.url;
}

function connectedOf(result: StartResult) {
  if (result.kind !== 'connected') throw new Error('expected a connection');
  return result;
}

async function configureOAuthApp(h: ConnectionsHarness, providerId = 'oauthco'): Promise<void> {
  await h.providerApps.save(providerId, { client_id: 'cid', client_secret: 'csecret' });
}

describe('oauth2 — authorization code with PKCE and a single-use state', () => {
  const discovered = [resource('oauthco', 'proj-a'), resource('oauthco', 'proj-b')];

  function harness(routes: readonly MockRoute[] = [TOKEN_OK]) {
    const seen: ConnectionContext[] = [];
    const h = connectionsHarness({
      plugins: [
        fixturePlugin({
          id: 'oauthco',
          displayName: 'OAuth Co',
          credential: OAUTH_SPEC,
          discoverResources: async (ctx) => {
            seen.push(ctx);
            return discovered;
          },
        }),
        fixturePlugin({ id: 'otherco', credential: OAUTH_SPEC }),
      ],
      routes,
    });
    return { h, seen };
  }

  it('redirects to the provider with the redirect URI on public_url, then stores the exchanged credential', async () => {
    const { h, seen } = harness();
    await configureOAuthApp(h);
    const alice = await h.actor('alice@example.com');

    const url = new URL(redirectOf(await h.service.start(alice, 'oauthco')));
    expect(`${url.origin}${url.pathname}`).toBe(OAUTH_SPEC.authorizationUrl);
    expect(url.searchParams.get('redirect_uri')).toBe(
      'https://gateway.example.com/connections/callback/oauthco',
    );
    expect(url.searchParams.get('client_id')).toBe('cid');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(h.fetch.calls).toHaveLength(0);

    const state = stateOf(url.href);
    const done = await h.service.complete(
      alice,
      'oauthco',
      new URLSearchParams({ code: 'code-1', state }),
    );

    // The verifier sent at the exchange is the one whose challenge was in the redirect.
    const exchange = new URLSearchParams(h.fetch.calls[0]!.body ?? '');
    expect(codeChallengeS256(exchange.get('code_verifier')!)).toBe(
      url.searchParams.get('code_challenge'),
    );
    expect(exchange.get('redirect_uri')).toBe(url.searchParams.get('redirect_uri'));
    expect(h.fetch.calls[0]!.headers.authorization).toBe(
      `Basic ${Buffer.from('cid:csecret').toString('base64')}`,
    );

    expect(done.connection).toMatchObject({
      provider: 'oauthco',
      status: 'active',
      displayName: 'OAuth Co',
      owner: { kind: 'user', id: alice.user.id },
      credentialExpiresAt: '2026-10-13T10:00:00.000Z',
    });
    expect(done.reconnected).toBe(false);
    expect(done.discovery).toMatchObject({ ok: true, count: 2, error: null });
    expect(parseSecret((await h.store.connections.getCredential(done.connection.id))!)).toEqual({
      kind: 'oauth2',
      accessToken: 'at-1',
      refreshToken: 'rt-1',
      expiresAt: '2026-10-13T10:00:00.000Z',
      scopes: ['read', 'write'],
      metadata: {},
    });
    // The plugin discovered with the fresh token and never saw the client secret.
    expect(seen[0]!.credential).toMatchObject({ kind: 'oauth2', accessToken: 'at-1' });
    expect(seen[0]!.appConfig).toEqual({ client_id: 'cid' });
    expect((await h.store.connections.listResources(done.connection.id)).map((r) => r.ref)).toEqual(
      ['proj-a', 'proj-b'],
    );
    expect(h.audit.admin.map((e) => [e.act, e.object.id, e.user_id])).toEqual([
      ['connection-created', done.connection.id, alice.user.id],
    ]);
  });

  it('refuses a replayed callback: the state is single use', async () => {
    const { h } = harness();
    await configureOAuthApp(h);
    const alice = await h.actor('alice@example.com');
    const state = stateOf(redirectOf(await h.service.start(alice, 'oauthco')));
    const query = new URLSearchParams({ code: 'code-1', state });

    await h.service.complete(alice, 'oauthco', query);
    await expectConnectError(h.service.complete(alice, 'oauthco', query), 'state-invalid');

    expect(h.fetch.calls).toHaveLength(1); // the token endpoint was not called again
    expect(await h.service.listFor(alice)).toHaveLength(1);
  });

  it('refuses a state that is unknown, absent, of another user or of another provider', async () => {
    const { h } = harness();
    await configureOAuthApp(h);
    await configureOAuthApp(h, 'otherco');
    const alice = await h.actor('alice@example.com');
    const mallory = await h.actor('mallory@example.com');

    await expectConnectError(
      h.service.complete(
        alice,
        'oauthco',
        new URLSearchParams({ code: 'c', state: 'x'.repeat(43) }),
      ),
      'state-invalid',
    );
    await expectConnectError(
      h.service.complete(alice, 'oauthco', new URLSearchParams({ code: 'c' })),
      'state-invalid',
    );

    // Mallory completes Alice's flow in her own session (login CSRF): refused, and burnt.
    const stolen = stateOf(redirectOf(await h.service.start(alice, 'oauthco')));
    const query = new URLSearchParams({ code: 'c', state: stolen });
    await expectConnectError(h.service.complete(mallory, 'oauthco', query), 'state-invalid');
    await expectConnectError(h.service.complete(alice, 'oauthco', query), 'state-invalid');

    // A state minted for one provider does not complete another provider's callback.
    const crossed = stateOf(redirectOf(await h.service.start(alice, 'oauthco')));
    await expectConnectError(
      h.service.complete(alice, 'otherco', new URLSearchParams({ code: 'c', state: crossed })),
      'state-invalid',
    );

    expect(h.fetch.calls).toHaveLength(0);
    expect(await h.store.connections.list()).toEqual([]);
  });

  it('refuses a foreign return URL at the start and honours one inside public_url', async () => {
    const { h } = harness();
    await configureOAuthApp(h);
    const alice = await h.actor('alice@example.com');

    for (const returnTo of [
      'https://evil.example.net/after',
      '//evil.example.net',
      '/\\evil.example.net',
    ]) {
      await expectConnectError(
        h.service.start(alice, 'oauthco', { returnTo }),
        'return-url-refused',
      );
    }

    const state = stateOf(
      redirectOf(
        await h.service.start(alice, 'oauthco', {
          returnTo: `${PUBLIC_URL.origin}/missions/new?from=connect`,
        }),
      ),
    );
    const done = await h.service.complete(
      alice,
      'oauthco',
      new URLSearchParams({ code: 'code-1', state }),
    );
    expect(done.returnTo).toBe('/missions/new?from=connect');
  });

  it('needs the company app, and reports a denial or a failed exchange with the provider wording', async () => {
    const denied = harness([
      {
        method: 'POST',
        url: OAUTH_SPEC.tokenUrl,
        status: 400,
        body: { error: 'invalid_grant', error_description: 'code already used' },
      },
    ]);
    const alice = await denied.h.actor('alice@example.com');
    await expectConnectError(denied.h.service.start(alice, 'oauthco'), 'app-not-configured');
    await configureOAuthApp(denied.h);

    const first = stateOf(redirectOf(await denied.h.service.start(alice, 'oauthco')));
    const refused = await expectConnectError(
      denied.h.service.complete(
        alice,
        'oauthco',
        new URLSearchParams({
          error: 'access_denied',
          error_description: 'user said no',
          state: first,
        }),
      ),
      'provider-denied',
    );
    expect(refused.detail).toBe('access_denied: user said no');
    // The state went with the denial.
    await expectConnectError(
      denied.h.service.complete(alice, 'oauthco', new URLSearchParams({ code: 'c', state: first })),
      'state-invalid',
    );

    const second = stateOf(redirectOf(await denied.h.service.start(alice, 'oauthco')));
    const failed = await expectConnectError(
      denied.h.service.complete(
        alice,
        'oauthco',
        new URLSearchParams({ code: 'c', state: second }),
      ),
      'token-exchange-failed',
    );
    expect(failed.detail).toContain('invalid_grant: code already used');
    expect(failed.detail).not.toContain('csecret');
    expect(await denied.h.store.connections.list()).toEqual([]);
    await expectConnectError(denied.h.service.start(alice, 'nope'), 'provider-unknown');
  });

  it('keeps the credential when the first discovery fails: the authorization code is spent', async () => {
    const h = connectionsHarness({
      plugins: [
        fixturePlugin({
          id: 'oauthco',
          credential: OAUTH_SPEC,
          discoverResources: async () => {
            throw new Error('GET /projects answered 500');
          },
        }),
      ],
      routes: [TOKEN_OK],
    });
    await configureOAuthApp(h);
    const alice = await h.actor('alice@example.com');
    const state = stateOf(redirectOf(await h.service.start(alice, 'oauthco')));
    const done = await h.service.complete(
      alice,
      'oauthco',
      new URLSearchParams({ code: 'c', state }),
    );
    expect(done.connection.status).toBe('active');
    expect(done.discovery).toMatchObject({
      ok: false,
      count: 0,
      error: 'the provider call failed (Error)',
    });
    expect((await h.service.get(alice, done.connection.id)).discovery?.ok).toBe(false);
  });

  it('rate-limits connect attempts per user', async () => {
    const { h } = harness();
    await configureOAuthApp(h);
    const alice = await h.actor('alice@example.com');
    const bob = await h.actor('bob@example.com');
    for (let i = 0; i < CONNECT_RATE_LIMIT; i += 1) await h.service.start(alice, 'oauthco');

    const limited = await expectConnectError(h.service.start(alice, 'oauthco'), 'rate-limited');
    expect(limited.retryAfterMs).toBeGreaterThan(0);
    await expectConnectError(
      h.service.complete(alice, 'oauthco', new URLSearchParams({ code: 'c', state: 's' })),
      'rate-limited',
    );
    await expect(h.service.start(bob, 'oauthco')).resolves.toMatchObject({ kind: 'redirect' });

    h.clock.advance(CONNECT_RATE_WINDOW_MS + 1);
    await expect(h.service.start(alice, 'oauthco')).resolves.toMatchObject({ kind: 'redirect' });
  });
});

describe('api-key — form checked by a first discovery', () => {
  it('validates the declared fields, then stores the key and the discovered resources', async () => {
    const seen: ConnectionContext[] = [];
    const h = connectionsHarness({
      plugins: [
        fixturePlugin({
          id: 'keyco',
          displayName: 'Key Co',
          credential: API_KEY_SPEC,
          discoverResources: async (ctx) => {
            seen.push(ctx);
            return [
              resource('keyco', 'prj_1'),
              resource('other', 'foreign'),
              resource('keyco', ''),
            ];
          },
        }),
      ],
    });
    const alice = await h.actor('alice@example.com');

    const invalid = await expectConnectError(
      h.service.start(alice, 'keyco', { fields: { token: '', team_id: 'bad' } }),
      'invalid-input',
    );
    expect(invalid.detail).toBe(
      'Access token is required; Team ID does not have the expected format',
    );
    expect(seen).toHaveLength(0);

    const done = connectedOf(
      await h.service.start(alice, 'keyco', {
        displayName: '  Team   A  ',
        fields: { token: 'tok-secret-123', team_id: 'team_a' },
      }),
    );
    expect(done.connection.displayName).toBe('Team A');
    expect(seen[0]!.credential).toEqual({
      kind: 'api-key',
      fields: { token: 'tok-secret-123', team_id: 'team_a' },
      metadata: { team_id: 'team_a' },
    });
    expect(seen[0]!.appConfig).toEqual({});
    // Resources of another provider or without a ref are ignored.
    expect(done.discovery).toMatchObject({ ok: true, count: 1 });
    const view = await h.service.get(alice, done.connection.id);
    expect(view.fields).toEqual({ team_id: 'team_a' });
    expect(JSON.stringify(view)).not.toContain('tok-secret-123');
    expect(JSON.stringify(done.connection.metadata)).not.toContain('tok-secret-123');
  });

  it('stores nothing when the provider rejects the key, and shows the provider error', async () => {
    const h = connectionsHarness({
      plugins: [
        fixturePlugin({
          id: 'keyco',
          displayName: 'Key Co',
          credential: API_KEY_SPEC,
          discoverResources: async () => {
            throw new UpstreamAuthError(
              'GET /domains answered 401: This API key is restricted to only send emails',
              401,
            );
          },
        }),
      ],
    });
    const alice = await h.actor('alice@example.com');
    const rejected = await expectConnectError(
      h.service.start(alice, 'keyco', { fields: { token: 'tok-secret-123', team_id: 'team_a' } }),
      'credential-rejected',
    );
    // The provider's own text is not shown: it can echo the key (ADR
    // provider-error-text-stays-with-the-agent).
    expect(rejected.detail).toBe('Key Co: the provider rejected the credential (HTTP 401)');
    expect(rejected.detail).not.toContain('tok-secret-123');
    expect(await h.store.connections.list()).toEqual([]);
    expect(h.audit.admin).toEqual([]);
  });

  it('reports an unreachable provider as such, still storing nothing', async () => {
    const h = connectionsHarness({
      plugins: [
        fixturePlugin({
          id: 'keyco',
          credential: API_KEY_SPEC,
          discoverResources: async () => {
            throw new TypeError('fetch failed');
          },
        }),
      ],
    });
    const alice = await h.actor('alice@example.com');
    await expectConnectError(
      h.service.start(alice, 'keyco', { fields: { token: 't', team_id: 'team_a' } }),
      'provider-unreachable',
    );
    expect(await h.store.connections.list()).toEqual([]);
  });
});

describe('ssh-key — key pair generated by the instance', () => {
  it('seals the private key, shows the public key and defers discovery', async () => {
    let discoveries = 0;
    const h = connectionsHarness({
      plugins: [
        fixturePlugin({
          id: 'sshco',
          credential: SSH_KEY_SPEC,
          discoverResources: async (ctx) => {
            discoveries += 1;
            const secret = ctx.credential;
            if (secret.kind !== 'ssh-key') throw new Error('wrong kind');
            return [resource('sshco', secret.fields.host!)];
          },
        }),
      ],
    });
    const alice = await h.actor('alice@example.com');
    await expectConnectError(
      h.service.start(alice, 'sshco', { fields: { host: 'Bad Host', user: 'deploy' } }),
      'invalid-input',
    );

    const done = connectedOf(
      await h.service.start(alice, 'sshco', {
        fields: { host: 'vps-1.example.com', user: 'deploy' },
      }),
    );
    expect(discoveries).toBe(0);
    expect(done.discovery).toBeNull();

    const view = await h.service.get(alice, done.connection.id);
    expect(view.publicKey).toMatch(/^ssh-ed25519 [A-Za-z0-9+/=]+ vaubaan-gateway$/);
    expect(view.fields).toEqual({ host: 'vps-1.example.com', user: 'deploy' });
    const secret = parseSecret((await h.store.connections.getCredential(done.connection.id))!);
    if (secret.kind !== 'ssh-key') throw new Error('expected an ssh-key secret');
    expect(secret.publicKey).toBe(view.publicKey);
    expect(secret.privateKeyPem).toContain('OPENSSH PRIVATE KEY');
    expect(JSON.stringify(view)).not.toContain(secret.privateKeyPem.split('\n')[1]);

    // Once the key is installed, the owner refreshes discovery.
    expect(await h.service.discover(alice, done.connection.id)).toMatchObject({
      ok: true,
      count: 1,
    });
    expect((await h.service.get(alice, done.connection.id)).resources.map((r) => r.ref)).toEqual([
      'vps-1.example.com',
    ]);
  });
});

describe('ownership, reconnection, revocation', () => {
  function harness() {
    return connectionsHarness({
      plugins: [
        fixturePlugin({ id: 'keyco', displayName: 'Key Co', credential: API_KEY_SPEC }),
        fixturePlugin({ id: 'gmailco', credential: API_KEY_SPEC, experimental: true }),
      ],
    });
  }
  const fields = { token: 'tok-1', team_id: 'team_a' };

  it('lists a connection for its owner only; a stranger gets not-found everywhere', async () => {
    const h = harness();
    const alice = await h.actor('alice@example.com');
    const bob = await h.actor('bob@example.com');
    const { connection } = connectedOf(await h.service.start(alice, 'keyco', { fields }));

    expect((await h.service.listFor(alice)).map((v) => v.connection.id)).toEqual([connection.id]);
    expect(await h.service.listFor(bob)).toEqual([]);
    await expectConnectError(h.service.get(bob, connection.id), 'not-found');
    await expectConnectError(h.service.revoke(bob, connection.id), 'not-found');
    await expectConnectError(h.service.discover(bob, connection.id), 'not-found');
    await expectConnectError(
      h.service.start(bob, 'keyco', { fields, reconnectId: connection.id }),
      'not-found',
    );
    await expectConnectError(h.service.get(alice, 'no-such-connection'), 'not-found');
  });

  it('treats every current member of an owner group as an owner', async () => {
    const h = harness();
    const alice = await h.actor('alice@example.com', ['platform']);
    const carol = await h.actor('carol@example.com', ['platform']);
    const dave = await h.actor('dave@example.com');
    const { connection } = connectedOf(await h.service.start(alice, 'keyco', { fields }));
    await h.store.connections.transferOwner(connection.id, {
      kind: 'group',
      id: alice.groups[0]!.id,
    });

    const view = (await h.service.listFor(carol))[0]!;
    expect(view.connection.id).toBe(connection.id);
    expect(view.ownerLabel).toBe('group platform');
    await expectConnectError(h.service.get(dave, connection.id), 'not-found');
  });

  it('surfaces the experimental flag of a plugin on the picker and on its connections', async () => {
    const h = harness();
    const alice = await h.actor('alice@example.com');
    const providers = await h.service.providers();
    expect(providers.map((p) => [p.id, p.experimental, p.configured, p.kind])).toEqual([
      ['keyco', false, true, 'api-key'],
      ['gmailco', true, true, 'api-key'],
    ]);
    const { connection } = connectedOf(await h.service.start(alice, 'gmailco', { fields }));
    expect((await h.service.get(alice, connection.id)).experimental).toBe(true);
    expect(await h.service.provider('nope')).toBeNull();
  });

  it('reconnects an expired connection in place and refuses a revoked or foreign-provider one', async () => {
    const h = harness();
    const alice = await h.actor('alice@example.com');
    const { connection } = connectedOf(
      await h.service.start(alice, 'keyco', { displayName: 'Team A', fields }),
    );
    await h.store.connections.markExpired(connection.id);

    await expectConnectError(
      h.service.start(alice, 'gmailco', { fields, reconnectId: connection.id }),
      'provider-mismatch',
    );
    const again = connectedOf(
      await h.service.start(alice, 'keyco', {
        fields: { token: 'tok-2', team_id: 'team_a' },
        reconnectId: connection.id,
      }),
    );
    expect(again.reconnected).toBe(true);
    expect(again.connection).toMatchObject({
      id: connection.id,
      status: 'active',
      displayName: 'Team A',
    });
    expect(await h.store.connections.getCredential(connection.id)).toContain('tok-2');
    expect(h.audit.admin.map((e) => e.act)).toEqual([
      'connection-created',
      'connection-reconnected',
    ]);

    await h.service.revoke(alice, connection.id);
    await expectConnectError(
      h.service.start(alice, 'keyco', { fields, reconnectId: connection.id }),
      'connection-revoked',
    );
  });

  it('refuses to reconnect an unowned connection until an owner is reassigned (spec §2.3)', async () => {
    const h = harness();
    const alice = await h.actor('alice@example.com');
    const { connection } = connectedOf(await h.service.start(alice, 'keyco', { fields }));
    // The owner group lost its last member, the connection became `unowned`, and a member
    // joined afterwards: owning it again does not make it reconnectable, the operator
    // reassigns first.
    const group = await makeUnowned(h.store, connection.id);
    await h.store.groups.addMember(group.id, alice.user.id);
    const member = { ...alice, groups: [group] };

    await expectConnectError(
      h.service.start(member, 'keyco', {
        fields: { token: 'tok-2', team_id: 'team_a' },
        reconnectId: connection.id,
      }),
      'connection-unowned',
    );
    expect((await h.store.connections.getById(connection.id))!.status).toBe('unowned');
    expect(await h.store.connections.getCredential(connection.id)).not.toContain('tok-2');
    expect(h.audit.admin.map((e) => e.act)).toEqual(['connection-created']);
  });

  it('revokes terminally: status revoked, credential erased, audited once', async () => {
    const h = harness();
    const alice = await h.actor('alice@example.com');
    const { connection } = connectedOf(await h.service.start(alice, 'keyco', { fields }));

    const revoked = await h.service.revoke(alice, connection.id);
    expect(revoked.status).toBe('revoked');
    expect(revoked.revokedAt).not.toBeNull();
    expect(await h.store.connections.getCredential(connection.id)).toBeNull();
    expect(
      h.store.db
        .prepare<[string], { blob: Buffer | null }>(
          'SELECT credential_blob AS blob FROM connections WHERE id = ?',
        )
        .get(connection.id)?.blob,
    ).toBeNull();

    expect((await h.service.revoke(alice, connection.id)).status).toBe('revoked');
    expect(h.audit.admin.map((e) => e.act)).toEqual(['connection-created', 'connection-revoked']);
    await expectConnectError(h.service.discover(alice, connection.id), 'connection-revoked');
  });
});

describe('resources — discovery merge and owner edits', () => {
  function harness() {
    const state = {
      resources: [] as Resource[],
      failWith: null as Error | null,
      calls: 0,
    };
    const h = connectionsHarness({
      plugins: [
        fixturePlugin({
          id: 'keyco',
          credential: API_KEY_SPEC,
          envs: ['staging', 'prod'],
          discoverResources: async () => {
            state.calls += 1;
            if (state.failWith) throw state.failWith;
            return state.resources;
          },
        }),
      ],
    });
    return { h, state };
  }
  const fields = { token: 'tok-1', team_id: 'team_a' };

  it('keeps the owner label, name, hidden flag and list settings across re-discovery', async () => {
    const { h, state } = harness();
    const alice = await h.actor('alice@example.com');
    state.resources = [
      resource('keyco', 'mail.acme.com', {
        metadata: { kind: 'domain', domain_id: 'd_1', status: 'pending', internal_domains: [] },
      }),
      resource('keyco', 'proj-b'),
    ];
    const { connection } = connectedOf(await h.service.start(alice, 'keyco', { fields }));
    const [domain, project] = await h.store.connections.listResources(connection.id);

    await h.service.updateResource(alice, connection.id, domain!.id, {
      displayName: 'Transactional mail',
      env: 'Prod',
      hidden: false,
      metadata: { internal_domains: 'acme.com, Acme.io' },
    });
    await h.service.updateResource(alice, connection.id, project!.id, { hidden: true });

    // Upstream: the domain got verified and renamed, a third resource appeared.
    state.resources = [
      resource('keyco', 'mail.acme.com', {
        displayName: 'mail.acme.com (verified)',
        metadata: { kind: 'domain', domain_id: 'd_1', status: 'verified', internal_domains: [] },
      }),
      resource('keyco', 'proj-b', { displayName: 'Project B renamed upstream' }),
      resource('keyco', 'proj-c'),
    ];
    expect(await h.service.discover(alice, connection.id)).toMatchObject({ ok: true, count: 3 });

    const after = (await h.service.get(alice, connection.id)).resources;
    expect(after.map((r) => r.ref)).toEqual(['mail.acme.com', 'proj-b', 'proj-c']);
    expect(after[0]).toMatchObject({
      id: domain!.id,
      displayName: 'Transactional mail', // owner edit kept
      displayNameEdited: true,
      env: 'prod', // owner label kept
      envSource: 'owner',
      hidden: false,
      staleSince: null,
      metadata: {
        kind: 'domain',
        domain_id: 'd_1',
        status: 'verified', // provider fact refreshed
        internal_domains: ['acme.com', 'acme.io'], // owner setting kept
      },
      ownerMetadata: { internal_domains: ['acme.com', 'acme.io'] },
    });
    expect(after[1]).toMatchObject({
      id: project!.id,
      displayName: 'Project B renamed upstream', // never renamed by the owner: follows discovery
      hidden: true,
    });
  });

  it('marks a vanished resource stale instead of deleting it, and clears the mark when it returns', async () => {
    const { h, state } = harness();
    const alice = await h.actor('alice@example.com');
    state.resources = [resource('keyco', 'proj-a'), resource('keyco', 'proj-b')];
    const { connection } = connectedOf(await h.service.start(alice, 'keyco', { fields }));
    const a = (await h.store.connections.listResources(connection.id))[0]!;
    await h.service.updateResource(alice, connection.id, a.id, { env: 'staging' });

    state.resources = [resource('keyco', 'proj-b')];
    h.clock.advance(60_000);
    await h.service.discover(alice, connection.id);
    let rows = await h.store.connections.listResources(connection.id);
    expect(rows.map((r) => [r.ref, r.staleSince, r.env])).toEqual([
      ['proj-a', '2026-10-13T09:01:00.000Z', 'staging'],
      ['proj-b', null, null],
    ]);
    expect(rows[0]!.id).toBe(a.id);

    // A later discovery that still misses it keeps the first stale date.
    h.clock.advance(60_000);
    await h.service.discover(alice, connection.id);
    rows = await h.store.connections.listResources(connection.id);
    expect(rows[0]!.staleSince).toBe('2026-10-13T09:01:00.000Z');

    state.resources = [resource('keyco', 'proj-a'), resource('keyco', 'proj-b')];
    await h.service.discover(alice, connection.id);
    rows = await h.store.connections.listResources(connection.id);
    expect(rows[0]).toMatchObject({ id: a.id, staleSince: null, env: 'staging' });
  });

  it('makes a plugin-set environment read-only and keeps it in step with the plugin', async () => {
    const { h, state } = harness();
    const alice = await h.actor('alice@example.com');
    state.resources = [
      resource('keyco', 'acct_1:test', { env: 'test' }),
      resource('keyco', 'acct_1:live', { env: 'live' }),
      resource('keyco', 'odd', { env: 'Not A Label!' }),
    ];
    const { connection } = connectedOf(await h.service.start(alice, 'keyco', { fields }));
    const rows = await h.store.connections.listResources(connection.id);
    expect(rows.map((r) => [r.ref, r.env, r.envSource])).toEqual([
      ['acct_1:live', 'live', 'plugin'],
      ['acct_1:test', 'test', 'plugin'],
      ['odd', null, 'owner'], // an invalid plugin label is dropped; the owner decides
    ]);

    const live = rows[0]!;
    await expectConnectError(
      h.service.updateResource(alice, connection.id, live.id, { env: 'staging' }),
      'label-read-only',
    );
    // Submitting the unchanged label with other edits is not a violation.
    await h.service.updateResource(alice, connection.id, live.id, {
      env: 'live',
      displayName: 'Live account',
    });

    await h.service.discover(alice, connection.id);
    expect((await h.store.connections.getResource(live.id))!).toMatchObject({
      env: 'live',
      envSource: 'plugin',
      displayName: 'Live account',
    });
  });

  it('sets a default environment among the catalog labels, audited, that unlabelled resources carry', async () => {
    const { h, state } = harness();
    const alice = await h.actor('alice@example.com');
    const bob = await h.actor('bob@example.com');
    state.resources = [
      resource('keyco', 'acct:live', { env: 'live' }),
      resource('keyco', 'app-a'),
      resource('keyco', 'app-b'),
    ];
    const { connection } = connectedOf(await h.service.start(alice, 'keyco', { fields }));
    expect((await h.service.get(alice, connection.id)).defaultEnvChoices).toEqual([
      'staging',
      'prod',
    ]);

    // Only a label the catalog knows; only by the owner.
    await expectConnectError(
      h.service.setDefaultEnv(alice, connection.id, 'preview'),
      'invalid-input',
    );
    await expectConnectError(
      h.service.setDefaultEnv(alice, connection.id, 'Not!'),
      'invalid-input',
    );
    await expectConnectError(h.service.setDefaultEnv(bob, connection.id, 'staging'), 'not-found');

    const updated = await h.service.setDefaultEnv(alice, connection.id, ' Staging ');
    expect(updated.defaultEnv).toBe('staging');
    const detail = await h.service.get(alice, connection.id);
    expect(detail.resources.map((r) => [r.ref, r.env, r.envSource])).toEqual([
      ['acct:live', 'live', 'plugin'], // a plugin label is never overridden
      ['app-a', 'staging', 'connection-default'],
      ['app-b', 'staging', 'connection-default'],
    ]);
    const entries = h.audit.admin.filter((e) => e.act === 'connection-default-env-set');
    expect(entries).toEqual([
      expect.objectContaining({
        user_id: alice.user.id,
        object: { type: 'connection', id: connection.id },
        before: { default_env: null },
        after: { default_env: 'staging' },
      }),
    ]);
    // The same value again writes nothing.
    await h.service.setDefaultEnv(alice, connection.id, 'staging');
    expect(h.audit.admin.filter((e) => e.act === 'connection-default-env-set')).toHaveLength(1);

    // The owner pins the default's label on one resource: it becomes the resource's own,
    // and it stays when the default changes.
    const a = detail.resources[1]!;
    await h.service.updateResource(alice, connection.id, a.id, { env: 'staging' });
    expect(await h.store.connections.getResource(a.id)).toMatchObject({
      env: 'staging',
      envSource: 'owner',
    });
    expect(h.audit.admin.at(-1)).toMatchObject({
      act: 'resource-edited',
      before: { env: null },
      after: { env: 'staging' },
    });
    await h.service.setDefaultEnv(alice, connection.id, 'prod');
    const rows = await h.store.connections.listResources(connection.id);
    expect(rows.map((r) => [r.ref, r.env, r.envSource])).toEqual([
      ['acct:live', 'live', 'plugin'],
      ['app-a', 'staging', 'owner'],
      ['app-b', 'prod', 'connection-default'],
    ]);

    // Blank clears it; a revoked connection takes no default.
    await h.service.setDefaultEnv(alice, connection.id, '');
    expect((await h.store.connections.getResource(rows[2]!.id))?.env).toBeNull();
    await h.service.revoke(alice, connection.id);
    await expectConnectError(
      h.service.setDefaultEnv(alice, connection.id, 'staging'),
      'connection-revoked',
    );
  });

  it('validates owner edits before writing any of them', async () => {
    const { h, state } = harness();
    const alice = await h.actor('alice@example.com');
    state.resources = [
      resource('keyco', 'r1', { metadata: { domain_id: 'd_1', allowlist_domains: [] } }),
    ];
    const first = connectedOf(await h.service.start(alice, 'keyco', { fields }));
    const second = connectedOf(await h.service.start(alice, 'keyco', { fields }));
    const r1 = (await h.store.connections.listResources(first.connection.id))[0]!;

    await expectConnectError(
      h.service.updateResource(alice, first.connection.id, r1.id, {
        displayName: 'Renamed',
        env: 'Not Valid',
      }),
      'invalid-input',
    );
    await expectConnectError(
      h.service.updateResource(alice, first.connection.id, r1.id, {
        displayName: 'Renamed',
        metadata: { domain_id: 'd_2' },
      }),
      'invalid-input',
    );
    expect((await h.store.connections.getResource(r1.id))!.displayName).toBe('Display r1');

    // A resource is edited through its own connection only.
    await expectConnectError(
      h.service.updateResource(alice, second.connection.id, r1.id, { hidden: true }),
      'not-found',
    );

    // A blank name hands the name back to discovery.
    await h.service.updateResource(alice, first.connection.id, r1.id, { displayName: 'Renamed' });
    await h.service.updateResource(alice, first.connection.id, r1.id, { displayName: ' ' });
    expect((await h.store.connections.getResource(r1.id))!.displayNameEdited).toBe(false);
  });

  it('records a failed refresh without touching the known resources', async () => {
    const { h, state } = harness();
    const alice = await h.actor('alice@example.com');
    state.resources = [resource('keyco', 'proj-a')];
    const { connection } = connectedOf(await h.service.start(alice, 'keyco', { fields }));

    state.failWith = new Error('GET /projects answered 500');
    const outcome = await h.service.discover(alice, connection.id);
    expect(outcome).toMatchObject({ ok: false, error: 'the provider call failed (Error)' });
    const detail = await h.service.get(alice, connection.id);
    expect(detail.connection.status).toBe('active');
    expect(detail.resources.map((r) => [r.ref, r.staleSince])).toEqual([['proj-a', null]]);
    expect(detail.discovery).toMatchObject({ ok: false });
  });

  it('expires the connection when the provider rejects a credential that cannot be refreshed', async () => {
    const { h, state } = harness();
    const alice = await h.actor('alice@example.com');
    state.resources = [resource('keyco', 'proj-a')];
    const { connection } = connectedOf(await h.service.start(alice, 'keyco', { fields }));

    state.failWith = new UpstreamAuthError('401 token revoked', 401);
    const outcome = await h.service.discover(alice, connection.id);
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toBe('the provider rejected the credential (HTTP 401)');
    expect((await h.store.connections.getById(connection.id))!.status).toBe('expired');
  });
});
