/**
 * The authorization server over HTTP (spec §4.1 bis, §6): what each endpoint
 * answers, to whom, with which headers — on the real composition root, the
 * `:memory:` store and the simulated IdP. The flow as an MCP client plays it
 * is in `mcp-client-flow.test.ts`; the services' rules (PKCE, single use,
 * rotation, replay, policy) are unit-tested beside the code.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SESSION_COOKIE } from '../../../src/server/auth';
import {
  MAX_REQUEST_BYTES,
  REGISTRATIONS_PER_INSTANCE,
  REGISTRATIONS_PER_WINDOW,
  TOKEN_REQUESTS_PER_CLIENT,
  TOKEN_REQUESTS_PER_WINDOW,
} from '../../../src/server/oauth-as';
import { pkcePair } from '../../../src/server/oauth-as/testing';
import type { FetchedDocument } from '../../../src/server/oauth-as';
import {
  ADA,
  authorizationUrl,
  bearer,
  BOB,
  consentIdOf,
  delegate,
  EXECUTION_URL,
  LOOPBACK_REDIRECT,
  MANAGEMENT_URL,
  openInstance,
  OPS,
  PUBLIC_CLIENT_METADATA,
  PUBLIC_URL,
  register,
  tokenRequest,
  toolsList,
  WEB_REDIRECT,
  type Instance,
} from './support';

const FOREIGN_ORIGIN = 'https://evil.example';

interface OAuthErrorBody {
  readonly error: string;
  readonly error_description?: string;
}

async function oauthError(response: Response): Promise<OAuthErrorBody> {
  return (await response.json()) as OAuthErrorBody;
}

describe('authorization server over HTTP', () => {
  let instance: Instance;

  afterEach(() => instance.close());

  describe('discovery documents', () => {
    beforeEach(async () => {
      instance = await openInstance();
    });

    it.each([
      ['/.well-known/oauth-authorization-server', 'issuer', PUBLIC_URL],
      ['/.well-known/oauth-protected-resource/mcp/manage', 'resource', MANAGEMENT_URL],
      ['/.well-known/oauth-protected-resource', 'resource', EXECUTION_URL],
    ])('%s is public JSON, readable from any origin', async (path, field, value) => {
      const response = await instance.fetch(`${PUBLIC_URL}${path}`, {
        headers: { origin: FOREIGN_ORIGIN },
      });
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe('application/json');
      expect(response.headers.get('access-control-allow-origin')).toBe('*');
      expect(((await response.json()) as Record<string, unknown>)[field]).toBe(value);

      const head = await instance.fetch(`${PUBLIC_URL}${path}`, { method: 'HEAD' });
      expect(head.status).toBe(200);
      expect(await head.text()).toBe('');

      const preflight = await instance.fetch(`${PUBLIC_URL}${path}`, {
        method: 'OPTIONS',
        headers: {
          origin: FOREIGN_ORIGIN,
          'access-control-request-headers': 'mcp-protocol-version',
        },
      });
      expect(preflight.status).toBe(204);
      expect(preflight.headers.get('access-control-allow-headers')).toBe('mcp-protocol-version');

      const post = await instance.fetch(`${PUBLIC_URL}${path}`, { method: 'POST' });
      expect(post.status).toBe(405);
    });

    it('the path-less resource document is the execution door’s: no authorization server, the bearer goes in the header', async () => {
      const response = await instance.fetch(`${PUBLIC_URL}/.well-known/oauth-protected-resource`);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(await response.json()).toEqual({
        resource: EXECUTION_URL,
        authorization_servers: [],
        bearer_methods_supported: ['header'],
      });
    });

    it('point at each other: the resource names the issuer the server metadata declares', async () => {
      const resource = (await (
        await instance.fetch(`${PUBLIC_URL}/.well-known/oauth-protected-resource/mcp/manage`)
      ).json()) as { authorization_servers: string[] };
      const server = (await (
        await instance.fetch(`${PUBLIC_URL}/.well-known/oauth-authorization-server`)
      ).json()) as Record<string, string>;
      expect(resource.authorization_servers).toEqual([server.issuer]);
      for (const endpoint of [
        'authorization_endpoint',
        'token_endpoint',
        'registration_endpoint',
        'revocation_endpoint',
      ]) {
        expect(server[endpoint]?.startsWith(`${PUBLIC_URL}/oauth/`)).toBe(true);
      }
    });
  });

  describe('POST /oauth/register', () => {
    beforeEach(async () => {
      instance = await openInstance({ env: { VAUBAAN_TRUSTED_PROXIES: '10.0.0.1' } });
    });

    const post = (body: string, headers: Record<string, string> = {}): Promise<Response> =>
      instance.fetch(`${PUBLIC_URL}/oauth/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body,
      });

    it('answers 201 with the client, uncacheable, to any origin and whatever cookie rides along', async () => {
      const browser = instance.browser();
      await browser.signIn(OPS);
      const response = await post(JSON.stringify(PUBLIC_CLIENT_METADATA), {
        origin: FOREIGN_ORIGIN,
        cookie: `${SESSION_COOKIE}=${browser.cookies.get(SESSION_COOKIE) ?? ''}`,
      });
      expect(response.status).toBe(201);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.get('access-control-allow-origin')).toBe('*');
      const body = (await response.json()) as Record<string, unknown>;
      expect(body).toMatchObject({
        client_name: 'Scripted MCP client',
        redirect_uris: [LOOPBACK_REDIRECT],
        token_endpoint_auth_method: 'none',
        scope: 'mgmt',
      });
      expect(body).not.toHaveProperty('client_secret');
      // The operator's cookie approved nothing: the client is decided by the policy alone.
      const [view] = await instance.root.oauth.clients.list();
      expect(view).toMatchObject({ status: 'approved', decidedBy: 'policy' });
    });

    it.each([
      [
        'a form body',
        'client_name=x',
        { 'content-type': 'application/x-www-form-urlencoded' },
        400,
        'invalid_client_metadata',
      ],
      ['invalid JSON', '{nope', {}, 400, 'invalid_client_metadata'],
      ['no redirect URI', '{}', {}, 400, 'invalid_redirect_uri'],
      [
        'an oversized body',
        JSON.stringify({ pad: 'x'.repeat(MAX_REQUEST_BYTES) }),
        {},
        413,
        'invalid_request',
      ],
    ])('refuses %s', async (_case, body, headers, status, code) => {
      const response = await post(body, headers);
      expect(response.status).toBe(status);
      expect((await oauthError(response)).error).toBe(code);
      expect(await instance.root.oauth.clients.list()).toEqual([]);
    });

    it('answers a preflight and refuses GET', async () => {
      const preflight = await instance.fetch(`${PUBLIC_URL}/oauth/register`, {
        method: 'OPTIONS',
        headers: { origin: FOREIGN_ORIGIN, 'access-control-request-headers': 'content-type' },
      });
      expect(preflight.status).toBe(204);
      expect(preflight.headers.get('access-control-allow-methods')).toBe('POST, OPTIONS');
      const get = await instance.fetch(`${PUBLIC_URL}/oauth/register`);
      expect(get.status).toBe(405);
    });

    it('is rate-limited per client address', async () => {
      const from = (ip: string) => ({ 'x-forwarded-for': `${ip}, 10.0.0.1` });
      for (let i = 0; i < REGISTRATIONS_PER_WINDOW; i += 1) {
        expect(
          (await post(JSON.stringify(PUBLIC_CLIENT_METADATA), from('203.0.113.9'))).status,
        ).toBe(201);
      }
      const limited = await post(JSON.stringify(PUBLIC_CLIENT_METADATA), from('203.0.113.9'));
      expect(limited.status).toBe(429);
      expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
      expect((await oauthError(limited)).error).toBe('slow_down');
      // Another address is not held back by the first.
      expect(
        (await post(JSON.stringify(PUBLIC_CLIENT_METADATA), from('203.0.113.10'))).status,
      ).toBe(201);
      expect(await instance.root.oauth.clients.list()).toHaveLength(REGISTRATIONS_PER_WINDOW + 1);
    });
  });

  describe('POST /oauth/register, the whole instance', () => {
    it('accepts a bounded number of registrations per hour, whatever the addresses', async () => {
      instance = await openInstance({ env: { VAUBAAN_TRUSTED_PROXIES: '10.0.0.1' } });
      const post = (index: number): Promise<Response> =>
        instance.fetch(`${PUBLIC_URL}/oauth/register`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            // A new address every few requests: no per-address window ever fills.
            'x-forwarded-for': `198.51.100.${Math.floor(index / 10)}, 10.0.0.1`,
          },
          body: JSON.stringify(PUBLIC_CLIENT_METADATA),
        });
      for (let i = 0; i < REGISTRATIONS_PER_INSTANCE; i += 1) {
        expect((await post(i)).status, `registration ${i}`).toBe(201);
      }
      const limited = await post(REGISTRATIONS_PER_INSTANCE);
      expect(limited.status).toBe(429);
      expect((await oauthError(limited)).error).toBe('slow_down');
      expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
      expect(await instance.root.oauth.clients.list()).toHaveLength(REGISTRATIONS_PER_INSTANCE);
    });
  });

  describe('registration policy over HTTP', () => {
    it('closed: registration answers 403 and the metadata advertises no registration endpoint', async () => {
      instance = await openInstance({
        env: { VAUBAAN_OAUTH_CLIENT_REGISTRATION_POLICY: 'closed' },
      });
      const response = await instance.fetch(`${PUBLIC_URL}/oauth/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(PUBLIC_CLIENT_METADATA),
      });
      expect(response.status).toBe(403);
      expect((await oauthError(response)).error).toBe('access_denied');
      const metadata = (await (
        await instance.fetch(`${PUBLIC_URL}/.well-known/oauth-authorization-server`)
      ).json()) as Record<string, unknown>;
      expect(metadata).not.toHaveProperty('registration_endpoint');
    });

    it('operator-approved: a client that redirects to a server waits, the user is told, an operator approves', async () => {
      instance = await openInstance();
      const client = await register(instance, {
        ...PUBLIC_CLIENT_METADATA,
        client_name: 'Hosted agent',
        redirect_uris: [WEB_REDIRECT],
      });
      const pkce = pkcePair();
      const url = authorizationUrl(client.client_id, pkce, { redirect_uri: WEB_REDIRECT });
      const browser = instance.browser();

      const waiting = await browser.navigate(url.href, ADA);
      expect(waiting.status).toBe(403);
      const text = await waiting.text();
      expect(text).toContain('Waiting for an operator');
      expect(text).toContain('Hosted agent');
      expect(text).toContain(client.client_id);
      expect(text).not.toContain('name="decision"');
      // Not approved: the token endpoint gives it nothing either.
      const token = await tokenRequest(instance, {
        grant_type: 'refresh_token',
        client_id: client.client_id,
        refresh_token: 'x',
      });
      expect((await oauthError(token)).error).toBe('unauthorized_client');

      // A user who is not an operator cannot approve it.
      const row = await instance.root.store.delegations.getClientByClientId(client.client_id);
      const byUser = await browser.post(`/admin/oauth-clients/${row?.id ?? ''}`, {
        action: 'approve',
      });
      expect(byUser.status).toBe(403);

      const operator = instance.browser();
      const ops = await operator.signIn(OPS);
      const approved = await operator.post(`/admin/oauth-clients/${row?.id ?? ''}`, {
        action: 'approve',
      });
      expect(approved.status).toBe(303);
      expect(approved.headers.get('location')).toBe('/admin/oauth-clients?decided=approved');
      const entry = (
        await instance.root.store.audit.search({
          scope: {
            missionCreatorUserId: null,
            missionMemberUserId: null,
            connectionOwners: [],
            allAdmin: true,
            allCalls: false,
          },
          limit: 10,
        })
      ).find((e) => e.kind === 'admin' && e.act === 'oauth-client-approved');
      expect(entry).toMatchObject({
        user_id: ops.id,
        object: { type: 'oauth-client', id: row?.id },
      });

      const consent = await browser.navigate(url.href, ADA);
      expect(consent.status).toBe(200);
      const html = await consent.text();
      expect(html).toContain('A server on the network');
      expect(html).toContain('agent.example.net');
    });

    it('an operator disables a client: its delegations die at once and it cannot ask again', async () => {
      instance = await openInstance();
      const browser = instance.browser();
      const delegated = await delegate(instance, ADA, browser);
      const row = await instance.root.store.delegations.getClientByClientId(delegated.clientId);
      const operator = instance.browser();
      await operator.signIn(OPS);

      const disabled = await operator.post(`/admin/oauth-clients/${row?.id ?? ''}`, {
        action: 'disable',
      });
      expect(disabled.headers.get('location')).toBe('/admin/oauth-clients?decided=disabled');
      const door = await toolsList(instance, MANAGEMENT_URL, bearer(delegated.tokens.access_token));
      expect(door.status).toBe(401);
      const refresh = await tokenRequest(instance, {
        grant_type: 'refresh_token',
        client_id: delegated.clientId,
        refresh_token: delegated.tokens.refresh_token,
      });
      expect((await oauthError(refresh)).error).toBe('unauthorized_client');
      const again = await browser.navigate(authorizationUrl(delegated.clientId, pkcePair()).href);
      expect(again.status).toBe(403);
      expect(await again.text()).toContain('Application disabled');

      // The user finds the revocation in their own audit, in the operator's name.
      const mine = await instance.root.store.audit.search({
        scope: {
          missionCreatorUserId: delegated.user.id,
          missionMemberUserId: null,
          connectionOwners: [],
          allAdmin: false,
          allCalls: false,
        },
        limit: 10,
      });
      expect(
        mine.filter((e) => e.kind === 'admin').map((e) => e.kind === 'admin' && e.act),
      ).toEqual(['delegation-revoked', 'delegation-granted']);

      const unknown = await operator.post('/admin/oauth-clients/no-such-client', {
        action: 'approve',
      });
      expect(unknown.headers.get('location')).toBe('/admin/oauth-clients?problem=not-found');
      const invalid = await operator.post(`/admin/oauth-clients/${row?.id ?? ''}`, {
        action: 'delete',
      });
      expect(invalid.status).toBe(400);
    });

    it('the door reads the client’s status at every call: a client that is no longer approved is refused although its delegation and its token are live', async () => {
      instance = await openInstance();
      const delegated = await delegate(instance);
      const door = () => toolsList(instance, MANAGEMENT_URL, bearer(delegated.tokens.access_token));
      expect((await door()).status).toBe(200);

      // The decision alone, without the revocation the registry performs with it.
      const row = await instance.root.store.delegations.getClientByClientId(delegated.clientId);
      await instance.root.store.delegations.decideClient(row?.id ?? '', 'disabled', 'operator-1');
      expect(await instance.root.store.delegations.getById(delegated.delegationId)).toMatchObject({
        status: 'active',
      });

      const refused = await door();
      expect(refused.status).toBe(401);
      expect(refused.headers.get('www-authenticate')).toContain('error="invalid_token"');
      // The execution door does not know the token either: it is nobody's credential now.
      expect(
        (await toolsList(instance, EXECUTION_URL, bearer(delegated.tokens.access_token))).status,
      ).toBeGreaterThanOrEqual(400);

      await instance.root.store.delegations.decideClient(row?.id ?? '', 'approved', 'operator-1');
      expect((await door()).status).toBe(200);
    });
  });

  describe('GET /oauth/authorize', () => {
    let clientId: string;
    const pkce = pkcePair();

    beforeEach(async () => {
      instance = await openInstance();
      clientId = (await register(instance)).client_id;
    });

    it('sends a visitor with no session to the sign-in, and back to the very same request', async () => {
      const url = authorizationUrl(clientId, pkce);
      const response = await instance.browser().get(url.href);
      expect(response.status).toBe(303);
      const location = new URL(response.headers.get('location') ?? '', PUBLIC_URL);
      expect(location.pathname).toBe('/auth/login');
      expect(location.searchParams.get('return_to')).toBe(`/oauth/authorize${url.search}`);
      expect(response.headers.get('cache-control')).toBe('no-store');
    });

    it('shows the consent screen once signed in, and keeps what it showed on the server', async () => {
      const browser = instance.browser();
      const page = await browser.navigate(authorizationUrl(clientId, pkce).href, ADA);
      expect(page.status).toBe(200);
      expect(page.headers.get('x-frame-options')).toBe('DENY');
      expect(page.headers.get('cache-control')).toBe('no-store');
      const html = await page.text();
      expect(html).toContain('Scripted MCP client');
      expect(html).toContain('ada@example.com');
      // The page carries an opaque id; the request's parameters stay on the server.
      expect(html).not.toContain(pkce.challenge);
      expect(html).not.toContain('client-state');
      const consentId = consentIdOf(html);
      const rows = instance.root.store.db
        .prepare<[], { id: string; value_json: string }>('SELECT id, value_json FROM web_sessions')
        .all();
      // Stored under a digest of its key, like every other record of the port.
      expect(rows.some((row) => row.id.includes(consentId))).toBe(false);
      expect(rows.some((row) => row.value_json.includes(pkce.challenge))).toBe(true);
    });

    it.each([
      ['an unknown client', { client_id: 'vbn_client_unknown' }],
      ['no client', { client_id: null }],
      ['a redirect URI that is not registered', { redirect_uri: 'https://evil.example/cb' }],
      ['a registered URI with something appended', { redirect_uri: `${LOOPBACK_REDIRECT}/x` }],
    ])('answers a page and never redirects for %s, signed in or not', async (_case, overrides) => {
      const url = authorizationUrl(clientId, pkce, overrides).href;
      const signedIn = instance.browser();
      await signedIn.signIn(ADA);
      for (const browser of [instance.browser(), signedIn]) {
        const response = await browser.get(url);
        expect(response.status).toBe(400);
        expect(response.headers.get('location')).toBeNull();
        expect(response.headers.get('content-type')).toContain('text/html');
        expect(await response.text()).not.toContain('evil.example');
      }
    });

    const BROKEN: [string, Record<string, string | null>, string][] = [
      ['no PKCE challenge', { code_challenge: null }, 'invalid_request'],
      ['the plain PKCE method', { code_challenge_method: 'plain' }, 'invalid_request'],
      ['the implicit flow', { response_type: 'token' }, 'unsupported_response_type'],
      ['another scope', { scope: 'admin' }, 'invalid_scope'],
      ['the execution door as resource', { resource: `${PUBLIC_URL}/mcp` }, 'invalid_target'],
    ];

    it.each(BROKEN)(
      'returns %s to the client through its redirect URI, once a user is signed in',
      async (_case, overrides, code) => {
        const browser = instance.browser();
        await browser.signIn(ADA);
        const response = await browser.get(authorizationUrl(clientId, pkce, overrides).href);
        expect(response.status).toBe(303);
        const location = new URL(response.headers.get('location') ?? '');
        expect(`${location.origin}${location.pathname}`).toBe(LOOPBACK_REDIRECT);
        expect(location.searchParams.get('error')).toBe(code);
        expect(location.searchParams.get('state')).toBe('client-state');
        expect(location.searchParams.get('iss')).toBe(PUBLIC_URL);
        expect(location.searchParams.has('code')).toBe(false);
        expect(location.hash).toBe('');
        expect(response.headers.get('referrer-policy')).toBe('no-referrer');
      },
    );

    it.each(BROKEN)(
      'sends nobody to the redirect URI for %s before a sign-in',
      async (_case, overrides) => {
        const response = await instance
          .browser()
          .get(authorizationUrl(clientId, pkce, overrides).href);
        expect(response.status).toBe(303);
        const location = new URL(response.headers.get('location') ?? '', PUBLIC_URL);
        expect(location.origin).toBe(PUBLIC_URL);
        expect(location.pathname).toBe('/auth/login');
      },
    );

    it('is not a redirector for a client that waits for an operator, signed in or not', async () => {
      const waiting = await register(instance, {
        ...PUBLIC_CLIENT_METADATA,
        redirect_uris: [WEB_REDIRECT],
      });
      // A request broken on purpose: the error would travel to the redirect URI.
      const url = authorizationUrl(waiting.client_id, pkce, {
        redirect_uri: WEB_REDIRECT,
        response_type: null,
      }).href;
      const anonymous = await instance.browser().get(url);
      expect(new URL(anonymous.headers.get('location') ?? '', PUBLIC_URL).origin).toBe(PUBLIC_URL);
      const signedIn = instance.browser();
      await signedIn.signIn(ADA);
      const response = await signedIn.get(url);
      expect(response.status).toBe(403);
      expect(response.headers.get('location')).toBeNull();
      expect(await response.text()).toContain('Waiting for an operator');
    });

    it('refuses the bootstrap operator: a delegation is given by a user', async () => {
      const browser = instance.browser();
      await browser.signInAsBootstrap();
      const response = await browser.get(authorizationUrl(clientId, pkce).href);
      expect(response.status).toBe(403);
      expect(await response.text()).toContain('Sign in as a user');
    });

    it('answers GET only', async () => {
      const response = await instance.fetch(authorizationUrl(clientId, pkce), { method: 'POST' });
      expect(response.status).toBe(405);
    });
  });

  describe('POST /oauth/authorize/decision', () => {
    let clientId: string;

    beforeEach(async () => {
      instance = await openInstance();
      clientId = (await register(instance)).client_id;
    });

    it('redirects to the client with a code, uncacheable and without a referrer, once', async () => {
      const browser = instance.browser();
      const page = await browser.navigate(authorizationUrl(clientId, pkcePair()).href, ADA);
      const consentId = consentIdOf(await page.text());
      const fields = { consent: consentId, decision: 'approve' };

      const response = await browser.post('/oauth/authorize/decision', fields);
      expect(response.status).toBe(303);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.get('referrer-policy')).toBe('no-referrer');
      const location = new URL(response.headers.get('location') ?? '');
      expect(location.searchParams.get('code')).toMatch(/^[A-Za-z0-9_-]{43}$/);

      const again = await browser.post('/oauth/authorize/decision', fields);
      expect(again.status).toBe(400);
      expect(again.headers.get('location')).toBeNull();
      expect(await again.text()).toContain('This request expired');
    });

    it('a failure while the delegation is recorded is a page, logged, and nothing is granted', async () => {
      const browser = instance.browser();
      const page = await browser.navigate(authorizationUrl(clientId, pkcePair()).href, ADA);
      instance.root.store.db.exec(
        `CREATE TRIGGER fault BEFORE INSERT ON oauth_codes
         BEGIN SELECT RAISE(ABORT, 'simulated store fault'); END`,
      );
      const response = await browser.answerConsent(page, 'approve');
      expect(response.status).toBe(500);
      expect(response.headers.get('location')).toBeNull();
      expect(response.headers.get('content-type')).toContain('text/html');
      const html = await response.text();
      expect(html).toContain('Nothing was granted');
      expect(html).not.toContain('simulated store fault');
      expect(instance.logs.join('\n')).toContain('consent decision failed unexpectedly');
      const delegations = await instance.root.store.delegations.listForClient(
        (await instance.root.store.delegations.getClientByClientId(clientId))?.id ?? '',
      );
      expect(delegations.map((d) => d.status)).toEqual(['revoked']);
    });

    it('cannot be answered from another user’s session', async () => {
      const ada = instance.browser();
      const page = await ada.navigate(authorizationUrl(clientId, pkcePair()).href, ADA);
      const consentId = consentIdOf(await page.text());
      const bob = instance.browser();
      const bobUser = await bob.signIn(BOB);

      const response = await bob.post('/oauth/authorize/decision', {
        consent: consentId,
        decision: 'approve',
      });
      expect(response.status).toBe(400);
      expect(await instance.root.store.delegations.listForUser(bobUser.id)).toEqual([]);
    });

    it('refuses an answer that is not a yes or a no, and a body that is not a form', async () => {
      const browser = instance.browser();
      const page = await browser.navigate(authorizationUrl(clientId, pkcePair()).href, ADA);
      const consentId = consentIdOf(await page.text());
      const odd = await browser.post('/oauth/authorize/decision', {
        consent: consentId,
        decision: 'always',
      });
      expect(odd.status).toBe(400);
      const cookie = `${SESSION_COOKIE}=${browser.cookies.get(SESSION_COOKIE) ?? ''}`;
      const notAForm = await instance.fetch(`${PUBLIC_URL}/oauth/authorize/decision`, {
        method: 'POST',
        headers: { cookie, origin: PUBLIC_URL, 'content-type': 'application/json' },
        body: '{}',
      });
      expect(notAForm.status).toBe(400);
      // The consent is still there for the real answer.
      const real = await browser.post('/oauth/authorize/decision', {
        consent: consentId,
        decision: 'deny',
      });
      expect(new URL(real.headers.get('location') ?? '').searchParams.get('error')).toBe(
        'access_denied',
      );
    });
  });

  describe('POST /oauth/token', () => {
    beforeEach(async () => {
      instance = await openInstance({ env: { VAUBAAN_TRUSTED_PROXIES: '10.0.0.1' } });
    });

    it('answers tokens as uncacheable JSON, with no session and from any origin', async () => {
      const client = await register(instance);
      const pkce = pkcePair();
      const callback = await instance.browser().authorize(authorizationUrl(client.client_id, pkce));
      const response = await tokenRequest(
        instance,
        {
          grant_type: 'authorization_code',
          client_id: client.client_id,
          code: callback.searchParams.get('code') ?? '',
          code_verifier: pkce.verifier,
          redirect_uri: LOOPBACK_REDIRECT,
          resource: MANAGEMENT_URL,
        },
        { origin: FOREIGN_ORIGIN },
      );
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe('application/json');
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.get('pragma')).toBe('no-cache');
      expect(response.headers.get('access-control-allow-origin')).toBe('*');
      expect(Object.keys((await response.json()) as object).sort()).toEqual([
        'access_token',
        'expires_in',
        'refresh_token',
        'scope',
        'token_type',
      ]);
    });

    it('a session cookie authenticates nothing here', async () => {
      const browser = instance.browser();
      const delegated = await delegate(instance, ADA, browser);
      const cookie = `${SESSION_COOKIE}=${browser.cookies.get(SESSION_COOKIE) ?? ''}`;
      // Ada's own session, and nothing a token request needs: refused like anyone's.
      const noGrant = await tokenRequest(
        instance,
        { grant_type: 'refresh_token', client_id: delegated.clientId },
        { cookie },
      );
      expect(noGrant.status).toBe(400);
      const noClient = await tokenRequest(instance, { grant_type: 'refresh_token' }, { cookie });
      expect((await oauthError(noClient)).error).toBe('invalid_request');
    });

    it.each([
      ['a JSON body', { 'content-type': 'application/json' }, '{}', 400, 'invalid_request'],
      ['no client', {}, 'grant_type=refresh_token&refresh_token=x', 400, 'invalid_request'],
      [
        'an unknown client',
        {},
        'grant_type=refresh_token&refresh_token=x&client_id=nope',
        401,
        'invalid_client',
      ],
      [
        'a repeated parameter',
        {},
        'grant_type=refresh_token&grant_type=authorization_code&client_id=x',
        400,
        'invalid_request',
      ],
      [
        'an oversized body',
        {},
        `client_id=${'x'.repeat(MAX_REQUEST_BYTES)}`,
        413,
        'invalid_request',
      ],
    ])('refuses %s', async (_case, headers, body, status, code) => {
      const response = await instance.fetch(`${PUBLIC_URL}/oauth/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
        body,
      });
      expect(response.status).toBe(status);
      expect((await oauthError(response)).error).toBe(code);
      expect(response.headers.get('cache-control')).toBe('no-store');
    });

    it.each([
      ['no grant type', {}, 'invalid_request'],
      [
        'the password grant',
        { grant_type: 'password', username: 'ada', password: 'x' },
        'unsupported_grant_type',
      ],
      [
        'the client-credentials grant',
        { grant_type: 'client_credentials' },
        'unsupported_grant_type',
      ],
      [
        'the device grant',
        { grant_type: 'urn:ietf:params:oauth:grant-type:device_code' },
        'unsupported_grant_type',
      ],
    ])('refuses %s', async (_case, fields, code) => {
      const client = await register(instance);
      const response = await tokenRequest(instance, { client_id: client.client_id, ...fields });
      expect(response.status).toBe(400);
      expect((await oauthError(response)).error).toBe(code);
    });

    it('challenges with Basic when Basic credentials are refused', async () => {
      const response = await tokenRequest(
        instance,
        { grant_type: 'refresh_token', refresh_token: 'x' },
        { authorization: `Basic ${Buffer.from('nope:secret').toString('base64')}` },
      );
      expect(response.status).toBe(401);
      expect(response.headers.get('www-authenticate')).toBe('Basic realm="oauth"');
    });

    it('serves a confidential client that authenticates with its secret, and nobody without it', async () => {
      const open = await openInstance({
        env: { VAUBAAN_OAUTH_CLIENT_REGISTRATION_POLICY: 'open' },
      });
      try {
        const client = await register(open, {
          client_name: 'Hosted agent',
          redirect_uris: [WEB_REDIRECT],
          token_endpoint_auth_method: 'client_secret_basic',
        });
        const secret = client.client_secret ?? '';
        expect(secret).toMatch(/^vbn_dcs_/);
        const basic = (value: string) => ({
          authorization: `Basic ${Buffer.from(`${client.client_id}:${value}`).toString('base64')}`,
        });
        const exchange = async (headers: Record<string, string>, fields = {}) => {
          const pkce = pkcePair();
          const callback = await open
            .browser()
            .authorize(authorizationUrl(client.client_id, pkce, { redirect_uri: WEB_REDIRECT }));
          return tokenRequest(
            open,
            {
              grant_type: 'authorization_code',
              code: callback.searchParams.get('code') ?? '',
              code_verifier: pkce.verifier,
              redirect_uri: WEB_REDIRECT,
              ...fields,
            },
            headers,
          );
        };
        expect((await exchange(basic(secret))).status).toBe(200);
        expect(
          (await exchange({}, { client_id: client.client_id, client_secret: secret })).status,
        ).toBe(200);
        const without = await exchange({}, { client_id: client.client_id });
        expect(without.status).toBe(401);
        expect((await oauthError(without)).error).toBe('invalid_client');
        expect((await exchange(basic(`${secret}x`))).status).toBe(401);
        expect(JSON.stringify(open.logs)).not.toContain(secret);
      } finally {
        await open.close();
      }
    });

    it('two renewals with the same refresh token, moments apart, both succeed (reuse window)', async () => {
      const delegated = await delegate(instance);
      const refresh = () =>
        tokenRequest(instance, {
          grant_type: 'refresh_token',
          client_id: delegated.clientId,
          refresh_token: delegated.tokens.refresh_token,
        });
      const [first, second] = await Promise.all([refresh(), refresh()]);
      expect([first.status, second.status]).toEqual([200, 200]);
      const pairs = [
        (await first.json()) as { access_token: string; refresh_token: string },
        (await second.json()) as { access_token: string; refresh_token: string },
      ];
      expect(pairs[0]?.refresh_token).not.toBe(pairs[1]?.refresh_token);
      for (const pair of pairs) {
        expect((await toolsList(instance, MANAGEMENT_URL, bearer(pair.access_token))).status).toBe(
          200,
        );
      }
      const [view] = await instance.root.oauth.delegations.listFor(delegated.user);
      expect(view?.state).toBe('active');
      // A third presentation is no longer the token rotated last: the family ends.
      expect((await refresh()).status).toBe(400);
      const [after] = await instance.root.oauth.delegations.listFor(delegated.user);
      expect(after).toMatchObject({
        state: 'revoked',
        delegation: { revokeReason: 'refresh-token-replay' },
      });
    });

    it('a replayed refresh token ends the delegation: invalid_grant, an audit entry, a closed door', async () => {
      const delegated = await delegate(instance);
      const refresh = (token: string) =>
        tokenRequest(instance, {
          grant_type: 'refresh_token',
          client_id: delegated.clientId,
          refresh_token: token,
        });
      const renewed = await refresh(delegated.tokens.refresh_token);
      expect(renewed.status).toBe(200);
      const next = (await renewed.json()) as { access_token: string; refresh_token: string };
      expect((await toolsList(instance, MANAGEMENT_URL, bearer(next.access_token))).status).toBe(
        200,
      );

      // A second renewal: the first refresh token is now two generations old,
      // outside what the reuse window tolerates.
      expect((await refresh(next.refresh_token)).status).toBe(200);

      const replay = await refresh(delegated.tokens.refresh_token);
      expect(replay.status).toBe(400);
      const body = await oauthError(replay);
      expect(body.error).toBe('invalid_grant');
      expect(JSON.stringify(body)).not.toContain(delegated.tokens.refresh_token);

      expect((await toolsList(instance, MANAGEMENT_URL, bearer(next.access_token))).status).toBe(
        401,
      );
      expect((await refresh(next.refresh_token)).status).toBe(400);
      const audit = await instance.root.store.audit.search({
        scope: {
          missionCreatorUserId: delegated.user.id,
          missionMemberUserId: null,
          connectionOwners: [],
          allAdmin: false,
          allCalls: false,
        },
        limit: 10,
      });
      expect(audit[0]).toMatchObject({
        kind: 'admin',
        act: 'delegation-revoked',
        user_id: delegated.user.id,
        object: { type: 'delegation', id: delegated.delegationId },
        after: { status: 'revoked', reason: 'refresh-token-replay', client_id: delegated.clientId },
        delegated_client_id: delegated.clientId,
      });
      const [view] = await instance.root.oauth.delegations.listFor(delegated.user);
      expect(view).toMatchObject({
        state: 'revoked',
        delegation: { revokeReason: 'refresh-token-replay' },
      });
    });

    it('is rate-limited per client address', async () => {
      const from = (ip: string) => ({ 'x-forwarded-for': `${ip}, 10.0.0.1` });
      const attempt = (ip: string) =>
        tokenRequest(
          instance,
          { grant_type: 'refresh_token', client_id: 'nope', refresh_token: 'x' },
          from(ip),
        );
      for (let i = 0; i < TOKEN_REQUESTS_PER_WINDOW; i += 1) {
        expect((await attempt('203.0.113.9')).status).toBe(401);
      }
      const limited = await attempt('203.0.113.9');
      expect(limited.status).toBe(429);
      expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
      expect((await attempt('203.0.113.10')).status).toBe(401);
    });

    it('a public client’s budget cannot be spent by somebody who only knows its id', async () => {
      const delegated = await delegate(instance);
      const from = (index: number) => ({
        'x-forwarded-for': `198.51.100.${Math.floor(index / 50)}, 10.0.0.1`,
      });
      // More junk than any per-client or per-delegation limit, from several addresses.
      for (let i = 0; i < TOKEN_REQUESTS_PER_CLIENT + 30; i += 1) {
        const junk = await tokenRequest(
          instance,
          {
            grant_type: 'refresh_token',
            client_id: delegated.clientId,
            refresh_token: `vbn_drt_${'A'.repeat(43)}`,
          },
          from(i),
        );
        expect(junk.status, `request ${i}`).toBe(400);
      }
      const renewal = await tokenRequest(
        instance,
        {
          grant_type: 'refresh_token',
          client_id: delegated.clientId,
          refresh_token: delegated.tokens.refresh_token,
        },
        { 'x-forwarded-for': '203.0.113.200, 10.0.0.1' },
      );
      expect(renewal.status).toBe(200);
    });

    it('a confidential client is limited per client once its secret matched; a wrong secret spends nothing of it', async () => {
      const open = await openInstance({
        env: {
          VAUBAAN_OAUTH_CLIENT_REGISTRATION_POLICY: 'open',
          VAUBAAN_TRUSTED_PROXIES: '10.0.0.1',
        },
      });
      try {
        const client = await register(open, {
          client_name: 'Hosted agent',
          redirect_uris: [WEB_REDIRECT],
          token_endpoint_auth_method: 'client_secret_post',
        });
        const attempt = (index: number, secret: string): Promise<Response> =>
          tokenRequest(
            open,
            {
              grant_type: 'refresh_token',
              client_id: client.client_id,
              client_secret: secret,
              refresh_token: `vbn_drt_${'A'.repeat(43)}`,
            },
            { 'x-forwarded-for': `198.51.100.${Math.floor(index / 50)}, 10.0.0.1` },
          );
        // Whoever does not hold the secret is stopped at authentication, before the budget.
        for (let i = 0; i < TOKEN_REQUESTS_PER_CLIENT + 10; i += 1) {
          expect((await attempt(i, 'vbn_dcs_wrong')).status, `wrong secret ${i}`).toBe(401);
        }
        const secret = client.client_secret ?? '';
        const offset = TOKEN_REQUESTS_PER_CLIENT + 50;
        for (let i = 0; i < TOKEN_REQUESTS_PER_CLIENT; i += 1) {
          expect((await attempt(offset + i, secret)).status, `authenticated ${i}`).toBe(400);
        }
        const limited = await attempt(offset + TOKEN_REQUESTS_PER_CLIENT + 50, secret);
        expect(limited.status).toBe(429);
        expect((await oauthError(limited)).error).toBe('slow_down');
        expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
      } finally {
        await open.close();
      }
    });

    it('answers a preflight and refuses GET', async () => {
      const preflight = await instance.fetch(`${PUBLIC_URL}/oauth/token`, {
        method: 'OPTIONS',
        headers: { origin: FOREIGN_ORIGIN },
      });
      expect(preflight.status).toBe(204);
      const get = await instance.fetch(`${PUBLIC_URL}/oauth/token`);
      expect(get.status).toBe(405);
      expect(get.headers.get('allow')).toBe('POST, OPTIONS');
    });
  });

  describe('POST /oauth/revoke', () => {
    beforeEach(async () => {
      instance = await openInstance();
    });

    const revoke = (fields: Record<string, string>): Promise<Response> =>
      instance.fetch(`${PUBLIC_URL}/oauth/revoke`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(fields).toString(),
      });

    it('answers 200 whether or not the token existed, and the revoked token is dead', async () => {
      const delegated = await delegate(instance);
      const unknown = await revoke({ client_id: delegated.clientId, token: 'unknown' });
      expect(unknown.status).toBe(200);
      expect(await unknown.text()).toBe('');

      const done = await revoke({
        client_id: delegated.clientId,
        token: delegated.tokens.refresh_token,
        token_type_hint: 'refresh_token',
      });
      expect(done.status).toBe(200);
      expect(
        (await toolsList(instance, MANAGEMENT_URL, bearer(delegated.tokens.access_token))).status,
      ).toBe(401);
      expect(
        (await instance.root.store.delegations.getById(delegated.delegationId))?.revokeReason,
      ).toBe('client');
    });

    it('requires a known client and a token', async () => {
      const delegated = await delegate(instance);
      const noClient = await revoke({ client_id: 'nope', token: delegated.tokens.refresh_token });
      expect(noClient.status).toBe(401);
      const noToken = await revoke({ client_id: delegated.clientId });
      expect(noToken.status).toBe(400);
      expect(
        (await toolsList(instance, MANAGEMENT_URL, bearer(delegated.tokens.access_token))).status,
      ).toBe(200);
    });
  });

  describe('POST /settings/connected-apps/:id/revoke', () => {
    beforeEach(async () => {
      instance = await openInstance();
    });

    it('ends the delegation in one request and says so on the page it returns to', async () => {
      const browser = instance.browser();
      const delegated = await delegate(instance, ADA, browser);
      const response = await browser.post(
        `/settings/connected-apps/${delegated.delegationId}/revoke`,
        {},
      );
      expect(response.status).toBe(303);
      expect(response.headers.get('location')).toBe('/settings/connected-apps?revoked=1');
      expect(
        (await toolsList(instance, MANAGEMENT_URL, bearer(delegated.tokens.access_token))).status,
      ).toBe(401);
    });

    it('does not let a user revoke another user’s delegation', async () => {
      const delegated = await delegate(instance, ADA);
      const bob = instance.browser();
      await bob.signIn(BOB);
      const response = await bob.post(
        `/settings/connected-apps/${delegated.delegationId}/revoke`,
        {},
      );
      expect(response.headers.get('location')).toBe('/settings/connected-apps?problem=not-found');
      expect(
        (await toolsList(instance, MANAGEMENT_URL, bearer(delegated.tokens.access_token))).status,
      ).toBe(200);
    });
  });

  describe('client id metadata documents', () => {
    const DOCUMENT_URL = 'https://agent.example.net/oauth/client.json';

    it('are fetched only for a signed-in user, then behave like any public client', async () => {
      const fetched: string[] = [];
      instance = await openInstance({
        env: { VAUBAAN_OAUTH_CLIENT_REGISTRATION_METADATA_DOCUMENTS: 'true' },
        deps: {
          clientDocumentFetch: async (url): Promise<FetchedDocument> => {
            fetched.push(url.href);
            return {
              status: 200,
              contentType: 'application/json',
              cacheControl: 'max-age=600',
              body: JSON.stringify({
                client_id: DOCUMENT_URL,
                client_name: 'Documented agent',
                redirect_uris: ['http://127.0.0.1/callback'],
                token_endpoint_auth_method: 'none',
              }),
            };
          },
        },
      });
      const metadata = (await (
        await instance.fetch(`${PUBLIC_URL}/.well-known/oauth-authorization-server`)
      ).json()) as Record<string, unknown>;
      expect(metadata.client_id_metadata_document_supported).toBe(true);

      const pkce = pkcePair();
      const url = authorizationUrl(DOCUMENT_URL, pkce);
      const browser = instance.browser();
      const anonymous = await browser.get(url.href);
      expect(new URL(anonymous.headers.get('location') ?? '', PUBLIC_URL).pathname).toBe(
        '/auth/login',
      );
      // Nobody is signed in yet: nothing was fetched.
      expect(fetched).toEqual([]);

      const callback = await browser.authorize(url);
      expect(fetched).toEqual([DOCUMENT_URL]);
      const response = await tokenRequest(instance, {
        grant_type: 'authorization_code',
        client_id: DOCUMENT_URL,
        code: callback.searchParams.get('code') ?? '',
        code_verifier: pkce.verifier,
        redirect_uri: LOOPBACK_REDIRECT,
      });
      expect(response.status).toBe(200);
      // The token endpoint never fetches: it only knows clients already resolved.
      expect(fetched).toEqual([DOCUMENT_URL]);
    });

    it('are unknown clients while the operator has not enabled them', async () => {
      instance = await openInstance();
      const browser = instance.browser();
      await browser.signIn(ADA);
      const response = await browser.get(authorizationUrl(DOCUMENT_URL, pkcePair()).href);
      expect(response.status).toBe(400);
      expect(response.headers.get('location')).toBeNull();
    });
  });

  describe('logs', () => {
    it('never contain a code, a token or a PKCE verifier, whatever happened', async () => {
      instance = await openInstance();
      const client = await register(instance);
      const pkce = pkcePair();
      const callback = await instance.browser().authorize(authorizationUrl(client.client_id, pkce));
      const code = callback.searchParams.get('code') ?? '';
      const exchange = () =>
        tokenRequest(instance, {
          grant_type: 'authorization_code',
          client_id: client.client_id,
          code,
          code_verifier: pkce.verifier,
          redirect_uri: LOOPBACK_REDIRECT,
        });
      const tokens = (await (await exchange()).json()) as {
        access_token: string;
        refresh_token: string;
      };
      // A code replay, a refresh, a refresh replay, a wrong door: every refusal path logs.
      await exchange();
      const refresh = () =>
        tokenRequest(instance, {
          grant_type: 'refresh_token',
          client_id: client.client_id,
          refresh_token: tokens.refresh_token,
        });
      await refresh();
      await toolsList(instance, `${PUBLIC_URL}/mcp`, bearer(tokens.access_token));
      await toolsList(instance, MANAGEMENT_URL, bearer(tokens.access_token));

      const logs = instance.logs.join('');
      expect(logs).toContain('delegation revoked');
      expect(logs).toContain('authorization-code-replay');
      for (const secret of [code, tokens.access_token, tokens.refresh_token, pkce.verifier]) {
        expect(secret.length).toBeGreaterThan(20);
        expect(logs).not.toContain(secret);
        expect(logs).not.toContain(secret.slice(-20));
      }
    });
  });
});
