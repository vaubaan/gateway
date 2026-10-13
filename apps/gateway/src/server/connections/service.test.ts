/**
 * The connect driver, one credential kind at a time, against mocked provider
 * endpoints (`mockFetch` rejects any request no route covers, so nothing
 * here can reach a network).
 */
import { UpstreamAuthError } from '@vaubaan/shared';
import type { ConnectionContext, Resource } from '@vaubaan/plugin-sdk';
import type { MockRoute } from '@vaubaan/plugin-sdk/testing';
import { describe, expect, it } from 'vitest';

import { parseSecret } from './credential-codec';
import { ConnectError, type ConnectErrorCode } from './errors';
import { codeChallengeS256 } from './oauth2';
import { CONNECT_RATE_LIMIT, CONNECT_RATE_WINDOW_MS, type StartResult } from './service';
import {
  API_KEY_SPEC,
  APP_INSTALL_SPEC,
  connectionsHarness,
  fixturePlugin,
  INSTALL_TOKEN_URL,
  INSTALLATIONS_URL,
  OAUTH_SPEC,
  PUBLIC_URL,
  SSH_KEY_SPEC,
  stateOf,
  UNVERIFIED_APP_INSTALL_SPEC,
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

const INSTALL_CLIENT_SECRET = 'install-client-secret-PLAINTEXT';
const USER_TOKEN = 'ghu_user-token-PLAINTEXT-0123456789';

async function configureInstallApp(h: ConnectionsHarness, verified = true): Promise<void> {
  await h.providerApps.save('appco', {
    app_id: '4242',
    private_key: 'PEM-PRIVATE-KEY',
    app_slug: 'acme-gateway',
    ...(verified ? { client_id: 'Iv1.cid', client_secret: INSTALL_CLIENT_SECRET } : {}),
  });
}

const INSTALL_TOKEN_OK: MockRoute = {
  method: 'POST',
  url: INSTALL_TOKEN_URL,
  body: { access_token: USER_TOKEN, token_type: 'bearer', scope: '' },
};

/** The installations the user token reaches, served two per page as the spec declares. */
function installationsOf(ids: readonly number[]): MockRoute {
  return {
    method: 'GET',
    url: (url) => url.startsWith(`${INSTALLATIONS_URL}?`),
    respond: (call) => {
      const query = new URL(call.url).searchParams;
      const perPage = Number(query.get('per_page'));
      const page = Number(query.get('page'));
      return {
        total_count: ids.length,
        installations: ids
          .slice((page - 1) * perPage, page * perPage)
          .map((id) => ({ id, app_slug: 'acme-gateway' })),
      };
    },
  };
}

function refusalsOf(h: ConnectionsHarness): unknown[] {
  return h.audit.entries.filter((e) => e.kind === 'admin' && e.act === 'connection-refused');
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
      error: 'GET /projects answered 500',
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

describe('app-install — installation bound to the user who authorized it', () => {
  function harness(
    routes: readonly MockRoute[],
    discover: (ctx: ConnectionContext) => Promise<readonly Resource[]> = async () => [
      resource('appco', 'acme/app'),
    ],
  ) {
    return connectionsHarness({
      plugins: [
        fixturePlugin({ id: 'appco', credential: APP_INSTALL_SPEC, discoverResources: discover }),
      ],
      routes,
    });
  }

  async function startInstall(h: ConnectionsHarness, actor: Awaited<ReturnType<typeof h.actor>>) {
    return stateOf(redirectOf(await h.service.start(actor, 'appco')));
  }

  it('accepts an installation the authorizing user can reach, and drops the user token', async () => {
    const seen: ConnectionContext[] = [];
    // The claimed installation is on the second page of the user's list.
    const h = harness([INSTALL_TOKEN_OK, installationsOf([11, 22, 987654])], async (ctx) => {
      seen.push(ctx);
      return [resource('appco', 'acme/app')];
    });
    const alice = await h.actor('alice@example.com');
    await expectConnectError(h.service.start(alice, 'appco'), 'app-not-configured');
    await configureInstallApp(h);

    const url = new URL(
      redirectOf(await h.service.start(alice, 'appco', { displayName: 'Acme org' })),
    );
    expect(`${url.origin}${url.pathname}`).toBe(
      'https://apps.example.com/acme-gateway/installations/new',
    );
    const done = await h.service.complete(
      alice,
      'appco',
      new URLSearchParams({
        code: 'user-auth-code-1',
        installation_id: '987654',
        setup_action: 'install',
        state: stateOf(url.href),
      }),
    );
    expect(done.connection).toMatchObject({ displayName: 'Acme org', status: 'active' });
    expect(done.connection.metadata).toMatchObject({
      installation_id: '987654',
      installation_verification: 'user-authorization',
    });
    expect(parseSecret((await h.store.connections.getCredential(done.connection.id))!)).toEqual({
      kind: 'app-install',
      installationId: '987654',
      metadata: {},
    });
    expect(done.discovery?.count).toBe(1);

    // The code was exchanged with the app's OAuth client; no redirect_uri was replayed.
    const [exchange, firstPage, secondPage] = h.fetch.calls;
    expect(Object.fromEntries(new URLSearchParams(exchange!.body ?? ''))).toEqual({
      grant_type: 'authorization_code',
      code: 'user-auth-code-1',
      client_id: 'Iv1.cid',
      client_secret: INSTALL_CLIENT_SECRET,
    });
    expect(exchange!.headers.accept).toBe('application/json');
    // The list was read with the user token and the headers the spec declares, page by page.
    expect(firstPage!.url).toBe(`${INSTALLATIONS_URL}?per_page=2&page=1`);
    expect(secondPage!.url).toBe(`${INSTALLATIONS_URL}?per_page=2&page=2`);
    expect(firstPage!.headers).toMatchObject({
      authorization: `Bearer ${USER_TOKEN}`,
      'x-api-version': '2022-11-28',
    });
    expect(h.fetch.calls).toHaveLength(3);

    // The plugin mints its tokens from the private key; the client secret stays with the host.
    expect(seen[0]!.appConfig).toEqual({
      app_id: '4242',
      private_key: 'PEM-PRIVATE-KEY',
      app_slug: 'acme-gateway',
      client_id: 'Iv1.cid',
    });
    // The user token went nowhere: not to the plugin, the connection, or the audit.
    const kept = JSON.stringify([seen, done, h.audit.entries, await h.store.connections.list()]);
    expect(kept).not.toContain(USER_TOKEN);
    expect(kept).not.toContain('user-auth-code-1');
    expect(refusalsOf(h)).toEqual([]);
  });

  it('refuses an installation that is not in the user list: nothing stored, refusal audited', async () => {
    let discoveries = 0;
    const h = harness([INSTALL_TOKEN_OK, installationsOf([11, 22, 33])], async () => {
      discoveries += 1;
      return [resource('appco', 'victim/repo')];
    });
    await configureInstallApp(h);
    const mallory = await h.actor('mallory@example.com');

    // Mallory installs the app on her own account, then claims another team's installation.
    const refused = await expectConnectError(
      h.service.complete(
        mallory,
        'appco',
        new URLSearchParams({
          code: 'mallory-own-code',
          installation_id: '987654',
          state: await startInstall(h, mallory),
        }),
      ),
      'installation-not-verified',
    );
    expect(refused.status).toBe(403);
    expect(refused.detail).toContain('not among those the authorizing account can reach');
    expect(await h.store.connections.list()).toEqual([]);
    expect(discoveries).toBe(0); // the plugin never minted a token for the claimed id
    expect(refusalsOf(h)).toEqual([
      {
        kind: 'admin',
        ts: h.audit.admin.at(-1)?.ts,
        user_id: mallory.user.id,
        act: 'connection-refused',
        object: { type: 'connection', id: 'not-created:appco' },
        before: null,
        after: {
          provider: 'appco',
          reason: 'installation-not-listed',
          installation_id: '987654',
          reconnect: false,
        },
        delegated_client_id: null,
      },
    ]);
    expect(JSON.stringify(h.audit.entries)).not.toContain(USER_TOKEN);
  });

  it('refuses a callback without an authorization code before any request leaves', async () => {
    const h = harness([]);
    await configureInstallApp(h);
    const mallory = await h.actor('mallory@example.com');

    const refused = await expectConnectError(
      h.service.complete(
        mallory,
        'appco',
        new URLSearchParams({ installation_id: '987654', state: await startInstall(h, mallory) }),
      ),
      'installation-not-verified',
    );
    expect(refused.detail).toContain('no user authorization');
    const declined = await expectConnectError(
      h.service.complete(
        mallory,
        'appco',
        new URLSearchParams({
          installation_id: '987654',
          error: 'access_denied',
          state: await startInstall(h, mallory),
        }),
      ),
      'installation-not-verified',
    );
    expect(declined.detail).toContain('access_denied');
    expect(h.fetch.calls).toHaveLength(0);
    expect(await h.store.connections.list()).toEqual([]);
    expect(refusalsOf(h)).toMatchObject([
      { after: { reason: 'no-authorization-code', installation_id: '987654' } },
      { after: { reason: 'no-authorization-code' } },
    ]);
  });

  it('refuses when the provider will not exchange the code; an unreachable provider is not a refusal', async () => {
    // GitHub answers a bad code with HTTP 200 and an `error` member.
    const h = harness([
      {
        method: 'POST',
        url: INSTALL_TOKEN_URL,
        times: 1,
        body: {
          error: 'bad_verification_code',
          error_description: 'The code passed is incorrect or expired.',
        },
      },
      { method: 'POST', url: INSTALL_TOKEN_URL, times: 1, status: 503, body: 'down' },
    ]);
    await configureInstallApp(h);
    const alice = await h.actor('alice@example.com');
    const callback = async () =>
      new URLSearchParams({
        code: 'forged-code',
        installation_id: '987654',
        state: await startInstall(h, alice),
      });

    const rejected = await expectConnectError(
      h.service.complete(alice, 'appco', await callback()),
      'token-exchange-failed',
    );
    expect(rejected.detail).toContain('bad_verification_code');
    await expectConnectError(
      h.service.complete(alice, 'appco', await callback()),
      'provider-unreachable',
    );
    expect(await h.store.connections.list()).toEqual([]);
    // Only the provider's refusal is an audited refusal.
    expect(refusalsOf(h)).toMatchObject([{ after: { reason: 'authorization-code-rejected' } }]);
  });

  it('refuses when the installations list is denied, and fails closed on an answer it cannot read', async () => {
    const h = harness([
      INSTALL_TOKEN_OK,
      { method: 'GET', url: /user\/installations/, times: 1, status: 401, body: {} },
      { method: 'GET', url: /user\/installations/, times: 1, status: 500, body: 'oops' },
      { method: 'GET', url: /user\/installations/, times: 1, body: { items: [{ id: 987654 }] } },
    ]);
    await configureInstallApp(h);
    const alice = await h.actor('alice@example.com');
    const attempt = async () =>
      h.service.complete(
        alice,
        'appco',
        new URLSearchParams({
          code: 'c',
          installation_id: '987654',
          state: await startInstall(h, alice),
        }),
      );

    await expectConnectError(attempt(), 'installation-not-verified');
    await expectConnectError(attempt(), 'provider-unreachable');
    const unreadable = await expectConnectError(attempt(), 'provider-unreachable');
    expect(unreadable.detail).toContain('did not answer the declared list');
    expect(await h.store.connections.list()).toEqual([]);
    expect(refusalsOf(h)).toMatchObject([{ after: { reason: 'installations-list-rejected' } }]);
  });

  it('verifies a reconnection too, and names the connection in the refusal', async () => {
    const h = harness([INSTALL_TOKEN_OK, installationsOf([987654])]);
    await configureInstallApp(h);
    const alice = await h.actor('alice@example.com');
    const done = await h.service.complete(
      alice,
      'appco',
      new URLSearchParams({
        code: 'c1',
        installation_id: '987654',
        state: await startInstall(h, alice),
      }),
    );
    const state = stateOf(
      redirectOf(await h.service.start(alice, 'appco', { reconnectId: done.connection.id })),
    );
    await expectConnectError(
      h.service.complete(
        alice,
        'appco',
        new URLSearchParams({ code: 'c2', installation_id: '555', state }),
      ),
      'installation-not-verified',
    );
    expect(refusalsOf(h)).toMatchObject([
      {
        object: { type: 'connection', id: done.connection.id },
        after: { reason: 'installation-not-listed', installation_id: '555', reconnect: true },
      },
    ]);
    // The connection keeps the installation it was verified for.
    expect(
      parseSecret((await h.store.connections.getCredential(done.connection.id))!),
    ).toMatchObject({ installationId: '987654' });
  });

  it('refuses a replay, a missing installation id and an installation the provider rejects', async () => {
    const h = harness([INSTALL_TOKEN_OK, installationsOf([111])], async () => {
      throw new UpstreamAuthError('installation 111 is not accessible to this app', 404);
    });
    await configureInstallApp(h);
    const alice = await h.actor('alice@example.com');

    const pendingApproval = await expectConnectError(
      h.service.complete(
        alice,
        'appco',
        new URLSearchParams({
          code: 'c',
          setup_action: 'request',
          state: await startInstall(h, alice),
        }),
      ),
      'provider-denied',
    );
    expect(pendingApproval.detail).toContain('awaiting approval');

    const query = new URLSearchParams({
      code: 'c',
      installation_id: '111',
      state: await startInstall(h, alice),
    });
    const rejected = await expectConnectError(
      h.service.complete(alice, 'appco', query),
      'credential-rejected',
    );
    expect(rejected.detail).toContain('installation 111 is not accessible');
    await expectConnectError(h.service.complete(alice, 'appco', query), 'state-invalid');

    await expectConnectError(
      h.service.complete(
        alice,
        'appco',
        new URLSearchParams({
          code: 'c',
          installation_id: '1; DROP TABLE',
          state: await startInstall(h, alice),
        }),
      ),
      'provider-denied',
    );
    expect(await h.store.connections.list()).toEqual([]);
  });
});

describe('app-install — a plugin that cannot verify installations', () => {
  function harness() {
    return connectionsHarness({
      plugins: [
        fixturePlugin({
          id: 'appco',
          credential: UNVERIFIED_APP_INSTALL_SPEC,
          discoverResources: async () => [resource('appco', 'acme/app')],
        }),
      ],
    });
  }

  it('is not connectable by default: refused at start, absent from the picker', async () => {
    const h = harness();
    await configureInstallApp(h, false);
    const alice = await h.actor('alice@example.com');

    expect((await h.providerApps.status('appco')).configured).toBe(true);
    expect((await h.service.provider('appco'))?.configured).toBe(false);
    const refused = await expectConnectError(
      h.service.start(alice, 'appco'),
      'installation-unverifiable',
    );
    expect(refused.status).toBe(409);
  });

  it('connects once the operator accepts unverified installations, and records that it was not verified', async () => {
    const h = harness();
    await configureInstallApp(h, false);
    await h.providerApps.setAcceptUnverifiedInstallations('appco', true);
    const alice = await h.actor('alice@example.com');

    expect((await h.service.provider('appco'))?.configured).toBe(true);
    const state = stateOf(redirectOf(await h.service.start(alice, 'appco')));
    const done = await h.service.complete(
      alice,
      'appco',
      new URLSearchParams({ installation_id: '987654', state }),
    );
    expect(done.connection.metadata).toMatchObject({
      installation_id: '987654',
      installation_verification: 'none',
    });
    expect(h.fetch.calls).toHaveLength(0);
  });

  it('refuses the callback when the acceptance was withdrawn while the user was away', async () => {
    const h = harness();
    await configureInstallApp(h, false);
    await h.providerApps.setAcceptUnverifiedInstallations('appco', true);
    const alice = await h.actor('alice@example.com');
    const state = stateOf(redirectOf(await h.service.start(alice, 'appco')));
    await h.providerApps.setAcceptUnverifiedInstallations('appco', false);

    await expectConnectError(
      h.service.complete(alice, 'appco', new URLSearchParams({ installation_id: '987654', state })),
      'installation-unverifiable',
    );
    expect(await h.store.connections.list()).toEqual([]);
    expect(refusalsOf(h)).toMatchObject([
      { after: { reason: 'verification-not-supported', installation_id: '987654' } },
    ]);
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
    expect(rejected.detail).toBe(
      'Key Co: GET /domains answered 401: This API key is restricted to only send emails',
    );
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
        .prepare<
          [string],
          { blob: Buffer | null }
        >('SELECT credential_blob AS blob FROM connections WHERE id = ?')
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
    expect(outcome).toMatchObject({ ok: false, error: 'GET /projects answered 500' });
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
    expect(outcome.error).toContain('401 token revoked');
    expect((await h.store.connections.getById(connection.id))!.status).toBe('expired');
  });
});
