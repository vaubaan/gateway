/**
 * An OAuth client the gateway registers itself at the provider (RFC 7591,
 * ADR oauth-client-registered-by-the-gateway): the registration request, how
 * the client is kept and reused, when it is registered again, and the whole
 * connect → refresh path of a service that needs nothing declared.
 */
import { mockFetch, type MockRoute } from '@vaubaan/plugin-sdk/testing';
import { describe, expect, it } from 'vitest';

import { silentLogger } from '../logging';
import { ProviderAppsService } from '../provider-apps';
import { openTestStore } from '../store/testing';
import { parseSecret } from './credential-codec';
import { ConnectError } from './errors';
import { providerFailureReason } from './failure-reason';
import { codeChallengeS256, OAuth2RegistrationError, registerClient } from './oauth2';
import {
  OAuth2ClientMissing,
  OAuth2Clients,
  REGISTERED_CLIENT_NAME,
  registeredClientKey,
} from './oauth2-clients';
import {
  connectionsHarness,
  fixturePlugin,
  OAUTH_SPEC,
  PUBLIC_URL,
  REGISTERED_OAUTH_SPEC,
  stateOf,
} from './testing';

const SPEC = REGISTERED_OAUTH_SPEC;
const REGISTER_URL = 'https://mcp.provider.example.com/register';
const CALLBACK = 'https://gateway.example.com/connections/callback/boardco';

function registered(clientId = 'client-1', secret = 'secret-1'): MockRoute {
  return {
    method: 'POST',
    url: REGISTER_URL,
    status: 201,
    body: {
      client_id: clientId,
      client_secret: secret,
      token_endpoint_auth_method: 'client_secret_post',
      redirect_uris: [CALLBACK],
    },
    times: 1,
  };
}

describe('registerClient (RFC 7591)', () => {
  it('asks for the code and refresh grants, the scopes, the one redirect URI and the auth method', async () => {
    const fetch = mockFetch([registered()]);
    const client = await registerClient(
      { registrationUrl: REGISTER_URL },
      SPEC,
      { redirectUri: CALLBACK, clientName: 'Vaubaan Gateway (gw.example)' },
      { fetch },
    );
    expect(client).toEqual({ clientId: 'client-1', clientSecret: 'secret-1' });
    expect(fetch.calls[0]?.json).toEqual({
      client_name: 'Vaubaan Gateway (gw.example)',
      redirect_uris: [CALLBACK],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'client_secret_post',
      scope: 'boards:read boards:write',
    });
  });

  it('refuses an answer without a client id, without the secret, or with another auth method', async () => {
    const cases: [unknown, RegExp][] = [
      [{ client_secret: 's' }, /without a client id/],
      [{ client_id: 'c' }, /without a client secret/],
      [
        { client_id: 'c', client_secret: 's', token_endpoint_auth_method: 'none' },
        /another authentication method/,
      ],
    ];
    for (const [body, message] of cases) {
      const fetch = mockFetch([{ url: REGISTER_URL, status: 201, body }]);
      await expect(
        registerClient(
          { registrationUrl: REGISTER_URL },
          SPEC,
          { redirectUri: CALLBACK, clientName: 'x' },
          { fetch },
        ),
      ).rejects.toThrow(message);
    }
  });

  it('keeps only the status and the protocol code of a refusal, never the provider text', async () => {
    const fetch = mockFetch([
      {
        url: REGISTER_URL,
        status: 400,
        body: { error: 'invalid_redirect_uri', error_description: 'echo: Bearer secret-token' },
      },
    ]);
    const err = await registerClient(
      { registrationUrl: REGISTER_URL },
      SPEC,
      { redirectUri: CALLBACK, clientName: 'x' },
      { fetch },
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OAuth2RegistrationError);
    expect((err as OAuth2RegistrationError).rejected).toBe(true);
    expect((err as Error).message).not.toContain('secret-token');
    expect(providerFailureReason(err)).toBe(
      'the registration endpoint answered HTTP 400 (invalid_redirect_uri)',
    );
  });
});

describe('OAuth2Clients — one registered client per instance and provider', () => {
  function clients(routes: readonly MockRoute[]) {
    const test = openTestStore();
    const fetch = mockFetch(routes);
    const plugin = fixturePlugin({ id: 'boardco', credential: SPEC });
    const providerApps = new ProviderAppsService(
      new Map(),
      test.store.config,
      // Only `hostAppConfig` is read, for a declared client.
      { require: () => ({ plugin }) } as never,
    );
    const subject = new OAuth2Clients({
      providerApps,
      config: test.store.config,
      publicUrl: PUBLIC_URL,
      fetch,
      clock: test.clock,
      logger: silentLogger,
    });
    return { subject, fetch, config: test.store.config, plugin };
  }

  it('registers on the first authorization, seals the secret, and reuses the client after', async () => {
    const { subject, fetch, config, plugin } = clients([registered()]);
    const first = await subject.forAuthorization(plugin, SPEC, CALLBACK);
    const again = await subject.forAuthorization(plugin, SPEC, CALLBACK);
    expect(first).toEqual({ clientId: 'client-1', clientSecret: 'secret-1' });
    expect(again).toEqual(first);
    expect(await subject.forTokenRequest(plugin, SPEC)).toEqual(first);
    expect(fetch.calls).toHaveLength(1);
    expect((fetch.calls[0]?.json as { client_name: string }).client_name).toBe(
      `${REGISTERED_CLIENT_NAME} (gateway.example.com)`,
    );
    expect(await config.get(registeredClientKey('boardco', 'client_id'))).toBe('client-1');
    expect(await config.get(registeredClientKey('boardco', 'redirect_uri'))).toBe(CALLBACK);
    // The secret is not a plain value of the settings.
    expect(await config.get(registeredClientKey('boardco', 'client_secret'))).toBeNull();
    expect(await config.getSecret(registeredClientKey('boardco', 'client_secret'))).toBe(
      'secret-1',
    );
  });

  it('two connections at once share one registration', async () => {
    const { subject, fetch, plugin } = clients([registered()]);
    const [a, b] = await Promise.all([
      subject.forAuthorization(plugin, SPEC, CALLBACK),
      subject.forAuthorization(plugin, SPEC, CALLBACK),
    ]);
    expect(a).toEqual(b);
    expect(fetch.calls).toHaveLength(1);
  });

  it('registers again when the callback address changed', async () => {
    const { subject, fetch, plugin } = clients([registered('client-1'), registered('client-2')]);
    await subject.forAuthorization(plugin, SPEC, CALLBACK);
    const moved = await subject.forAuthorization(
      plugin,
      SPEC,
      'https://new.example.com/connections/callback/boardco',
    );
    expect(moved.clientId).toBe('client-2');
    expect(fetch.calls).toHaveLength(2);
  });

  it('forgets a rejected client — only if it is still the current one — so the next connect registers again', async () => {
    const { subject, fetch, plugin } = clients([registered('client-1'), registered('client-2')]);
    await subject.forAuthorization(plugin, SPEC, CALLBACK);
    await subject.rejected(plugin, SPEC, 'an-older-client');
    expect((await subject.forTokenRequest(plugin, SPEC)).clientId).toBe('client-1');
    await subject.rejected(plugin, SPEC, 'client-1');
    await expect(subject.forTokenRequest(plugin, SPEC)).rejects.toBeInstanceOf(OAuth2ClientMissing);
    expect((await subject.forAuthorization(plugin, SPEC, CALLBACK)).clientId).toBe('client-2');
    expect(fetch.calls).toHaveLength(2);
  });

  it('never registers for a token request, and leaves a declared client alone', async () => {
    const { subject, fetch, plugin } = clients([]);
    await expect(subject.forTokenRequest(plugin, SPEC)).rejects.toBeInstanceOf(OAuth2ClientMissing);
    await expect(subject.forAuthorization(plugin, OAUTH_SPEC, CALLBACK)).rejects.toBeInstanceOf(
      OAuth2ClientMissing,
    );
    await subject.rejected(plugin, OAUTH_SPEC, 'cid');
    expect(fetch.calls).toHaveLength(0);
  });
});

describe('a service whose client the gateway registers: connect, refresh, reconnect', () => {
  const TOKEN_URL = SPEC.tokenUrl;

  function harness(routes: readonly MockRoute[]) {
    return connectionsHarness({
      plugins: [
        fixturePlugin({
          id: 'boardco',
          displayName: 'Board Co',
          credential: SPEC,
          discoverResources: async () => [
            { provider: 'boardco', ref: 'b-1', displayName: 'Board 1' },
          ],
        }),
      ],
      routes,
    });
  }

  it('is offered at once, with nothing to declare', async () => {
    const h = harness([]);
    expect(await h.service.provider('boardco')).toMatchObject({
      kind: 'oauth2',
      redirects: true,
      registersItself: true,
      usesApp: false,
      configured: true,
      fields: [],
    });
    expect(await h.providerApps.status('boardco')).toMatchObject({ needsApp: false, fields: [] });
  });

  it('registers, redirects with PKCE and the resource, exchanges with the registered client', async () => {
    const h = harness([
      registered(),
      {
        method: 'POST',
        url: TOKEN_URL,
        body: { access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600 },
      },
    ]);
    const alice = await h.actor('alice@example.com');
    const start = await h.service.start(alice, 'boardco');
    if (start.kind !== 'redirect') throw new Error('expected a redirect');
    const url = new URL(start.url);
    expect(url.searchParams.get('client_id')).toBe('client-1');
    expect(url.searchParams.get('redirect_uri')).toBe(CALLBACK);
    expect(url.searchParams.get('resource')).toBe('https://mcp.provider.example.com/');
    expect(url.searchParams.get('scope')).toBe('boards:read boards:write');

    const done = await h.service.complete(
      alice,
      'boardco',
      new URLSearchParams({ code: 'code-1', state: stateOf(start.url) }),
    );
    const exchange = new URLSearchParams(h.fetch.calls[1]?.body ?? '');
    expect(exchange.get('client_id')).toBe('client-1');
    expect(exchange.get('client_secret')).toBe('secret-1');
    expect(exchange.get('resource')).toBe('https://mcp.provider.example.com/');
    expect(codeChallengeS256(exchange.get('code_verifier')!)).toBe(
      url.searchParams.get('code_challenge'),
    );
    expect(done.connection).toMatchObject({ provider: 'boardco', status: 'active' });
    expect(done.discovery).toMatchObject({ ok: true, count: 1 });
    expect(
      parseSecret((await h.store.connections.getCredential(done.connection.id))!),
    ).toMatchObject({ kind: 'oauth2', accessToken: 'at-1', refreshToken: 'rt-1' });
  });

  it('refreshes with the registered client, and forgets it when the provider says invalid_client', async () => {
    const h = harness([
      registered(),
      {
        method: 'POST',
        url: TOKEN_URL,
        times: 1,
        body: { access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600 },
      },
      {
        method: 'POST',
        url: TOKEN_URL,
        times: 1,
        body: { access_token: 'at-2', refresh_token: 'rt-2', expires_in: 3600 },
      },
      { method: 'POST', url: TOKEN_URL, status: 401, body: { error: 'invalid_client' } },
    ]);
    const alice = await h.actor('alice@example.com');
    const start = await h.service.start(alice, 'boardco');
    if (start.kind !== 'redirect') throw new Error('expected a redirect');
    const done = await h.service.complete(
      alice,
      'boardco',
      new URLSearchParams({ code: 'code-1', state: stateOf(start.url) }),
    );

    const refreshed = await h.broker.refresh(done.connection.id);
    expect(refreshed.credential).toMatchObject({ accessToken: 'at-2', refreshToken: 'rt-2' });
    const refresh = new URLSearchParams(h.fetch.calls[2]?.body ?? '');
    expect(refresh.get('grant_type')).toBe('refresh_token');
    expect(refresh.get('client_id')).toBe('client-1');
    expect(refresh.get('client_secret')).toBe('secret-1');

    await expect(h.broker.refresh(done.connection.id)).rejects.toThrow();
    expect((await h.store.connections.getById(done.connection.id))?.status).toBe('expired');
    expect(await h.store.config.get(registeredClientKey('boardco', 'client_id'))).toBeNull();
  });

  it('another account of the forgotten client needs reconnecting, not a retry', async () => {
    const h = harness([
      registered(),
      {
        method: 'POST',
        url: TOKEN_URL,
        times: 2,
        body: { access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600 },
      },
    ]);
    const alice = await h.actor('alice@example.com');
    const connect = async () => {
      const start = await h.service.start(alice, 'boardco');
      if (start.kind !== 'redirect') throw new Error('expected a redirect');
      return h.service.complete(
        alice,
        'boardco',
        new URLSearchParams({ code: 'c', state: stateOf(start.url) }),
      );
    };
    const first = await connect();
    const second = await connect();
    await h.clients.rejected({ id: 'boardco' }, SPEC, 'client-1');
    await expect(h.broker.refresh(second.connection.id)).rejects.toThrow(/reconnect it/);
    expect((await h.store.connections.getById(second.connection.id))?.status).toBe('expired');
    expect((await h.store.connections.getById(first.connection.id))?.status).toBe('active');
  });

  it('reports a refused registration in the gateway’s words, and stores nothing', async () => {
    const h = harness([
      {
        url: REGISTER_URL,
        status: 403,
        body: { error: 'access_denied', error_description: 'org policy' },
      },
    ]);
    const alice = await h.actor('alice@example.com');
    const err = await h.service.start(alice, 'boardco').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConnectError);
    expect((err as ConnectError).code).toBe('client-registration-failed');
    expect((err as ConnectError).detail).toBe(
      'Board Co: the registration endpoint answered HTTP 403 (access_denied)',
    );
    expect(await h.store.config.get(registeredClientKey('boardco', 'client_id'))).toBeNull();
  });

  it('an exchange refused with invalid_client forgets the client; the person starts again', async () => {
    const h = harness([
      registered('client-1'),
      { method: 'POST', url: TOKEN_URL, status: 401, body: { error: 'invalid_client' } },
      registered('client-2'),
    ]);
    const alice = await h.actor('alice@example.com');
    const start = await h.service.start(alice, 'boardco');
    if (start.kind !== 'redirect') throw new Error('expected a redirect');
    const err = await h.service
      .complete(alice, 'boardco', new URLSearchParams({ code: 'c', state: stateOf(start.url) }))
      .catch((e: unknown) => e);
    expect((err as ConnectError).code).toBe('token-exchange-failed');
    const again = await h.service.start(alice, 'boardco');
    if (again.kind !== 'redirect') throw new Error('expected a redirect');
    expect(new URL(again.url).searchParams.get('client_id')).toBe('client-2');
  });
});
