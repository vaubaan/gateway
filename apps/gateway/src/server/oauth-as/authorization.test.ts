import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { OAuthClientRecord } from '../store/types';
import {
  AUTHORIZATION_CODE_TTL_MS,
  authorizationResponseUrl,
  CONSENT_TTL_MS,
  MAX_STATE_LENGTH,
} from './authorization';
import { AuthorizationPageError, AuthorizationRedirectError } from './errors';
import { digestOf } from './secrets';
import {
  LOOPBACK_REDIRECT,
  openOAuthRig,
  pkcePair,
  WEB_REDIRECT,
  type OAuthRig,
} from '../../../tests/support/oauth-as/testing';

function query(fields: Record<string, string | undefined>): URLSearchParams {
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(fields)) {
    if (value !== undefined) params.set(name, value);
  }
  return params;
}

describe('AuthorizationService', () => {
  let rig: OAuthRig;
  let client: OAuthClientRecord;
  const pkce = pkcePair();

  beforeEach(async () => {
    rig = await openOAuthRig();
    client = await rig.registerClient();
  });
  afterEach(() => rig.close());

  function request(overrides: Record<string, string | undefined> = {}): URLSearchParams {
    return query({
      response_type: 'code',
      client_id: client.clientId,
      redirect_uri: LOOPBACK_REDIRECT,
      code_challenge: pkce.challenge,
      code_challenge_method: 'S256',
      state: 'opaque-state',
      scope: 'mgmt',
      resource: rig.endpoints.resource,
      ...overrides,
    });
  }

  describe('the client and its redirect URI come first, and never redirect when wrong', () => {
    async function pageError(params: URLSearchParams): Promise<AuthorizationPageError> {
      try {
        await rig.authorization.resolveClient(params, rig.ada.id);
      } catch (err) {
        if (err instanceof AuthorizationPageError) return err;
        throw err;
      }
      throw new Error('expected a page, got a resolved client');
    }

    it('resolves a registered client with a registered redirect URI', async () => {
      const resolved = await rig.authorization.resolveClient(request(), null);
      expect(resolved.view.client.id).toBe(client.id);
      expect(resolved.view.status).toBe('approved');
      expect(resolved.redirectUri).toBe(LOOPBACK_REDIRECT);
    });

    it('accepts the loopback URI on another port, and returns the one presented', async () => {
      const presented = 'http://127.0.0.1:50999/callback';
      const resolved = await rig.authorization.resolveClient(
        request({ redirect_uri: presented }),
        null,
      );
      expect(resolved.redirectUri).toBe(presented);
    });

    it('uses the single registered URI when the request names none', async () => {
      const resolved = await rig.authorization.resolveClient(
        request({ redirect_uri: undefined }),
        null,
      );
      expect(resolved.redirectUri).toBe(LOOPBACK_REDIRECT);
    });

    it('refuses a request without a redirect URI when the client registered several', async () => {
      const several = await rig.registerClient([LOOPBACK_REDIRECT, 'http://localhost/cb']);
      const err = await pageError(
        request({ client_id: several.clientId, redirect_uri: undefined }),
      );
      expect(err.status).toBe(400);
    });

    it.each([
      ['no client_id', { client_id: undefined }],
      ['an unknown client', { client_id: 'vbn_client_unknown' }],
      ['a redirect URI the client did not register', { redirect_uri: 'https://evil.example/cb' }],
      ['a registered URI with an extra path', { redirect_uri: `${LOOPBACK_REDIRECT}/extra` }],
      ['a registered URI with an extra query', { redirect_uri: `${LOOPBACK_REDIRECT}?x=1` }],
      ['the loopback path on a network host', { redirect_uri: 'http://10.0.0.5:43210/callback' }],
    ])('answers a page, never a redirect, for %s', async (_case, overrides) => {
      const err = await pageError(request(overrides));
      expect(err.status).toBe(400);
      // The page never repeats the address it refused to trust.
      expect(err.message).not.toContain('evil.example');
    });

    it('does not resolve a metadata document client without a signed-in user', async () => {
      const params = request({ client_id: 'https://agent.example.net/client.json' });
      expect(rig.authorization.needsDocument(params)).toBe(true);
      expect(rig.authorization.needsDocument(request())).toBe(false);
      await expect(rig.authorization.resolveClient(params, null)).rejects.toBeInstanceOf(
        AuthorizationPageError,
      );
    });
  });

  describe('the rest of the request is judged once the redirect URI is trusted', () => {
    function redirectError(params: URLSearchParams): AuthorizationRedirectError {
      try {
        rig.authorization.validate(client, LOOPBACK_REDIRECT, params);
      } catch (err) {
        if (err instanceof AuthorizationRedirectError) return err;
        throw err;
      }
      throw new Error('expected the request to be refused');
    }

    it('accepts a code request with an S256 challenge', () => {
      expect(rig.authorization.validate(client, LOOPBACK_REDIRECT, request())).toEqual({
        client,
        redirectUri: LOOPBACK_REDIRECT,
        state: 'opaque-state',
        codeChallenge: pkce.challenge,
      });
    });

    it('accepts a request without scope, state or resource: one scope, one resource', () => {
      const accepted = rig.authorization.validate(
        client,
        LOOPBACK_REDIRECT,
        request({ scope: undefined, state: undefined, resource: undefined }),
      );
      expect(accepted.state).toBeNull();
    });

    it('ignores scopes it does not know as long as mgmt is asked for', () => {
      expect(() =>
        rig.authorization.validate(
          client,
          LOOPBACK_REDIRECT,
          request({ scope: 'mgmt offline_access' }),
        ),
      ).not.toThrow();
    });

    it.each([
      ['the implicit flow', { response_type: 'token' }, 'unsupported_response_type'],
      ['no response type', { response_type: undefined }, 'unsupported_response_type'],
      ['no PKCE challenge', { code_challenge: undefined }, 'invalid_request'],
      ['the plain PKCE method', { code_challenge_method: 'plain' }, 'invalid_request'],
      [
        'no PKCE method (plain by default in RFC 7636)',
        { code_challenge_method: undefined },
        'invalid_request',
      ],
      ['a challenge that is not a SHA-256', { code_challenge: 'too-short' }, 'invalid_request'],
      ['a scope without mgmt', { scope: 'admin' }, 'invalid_scope'],
      ['another resource', { resource: 'https://gateway.example.com/mcp' }, 'invalid_target'],
      ['a resource elsewhere', { resource: 'https://evil.example/mcp/manage' }, 'invalid_target'],
    ])('refuses %s', (_case, overrides, code) => {
      const err = redirectError(request(overrides));
      expect(err.code).toBe(code);
      expect(err.echoState).toBe(true);
    });

    it('refuses an oversized state and does not send it back', () => {
      const err = redirectError(request({ state: 'x'.repeat(MAX_STATE_LENGTH + 1) }));
      expect(err.code).toBe('invalid_request');
      expect(err.echoState).toBe(false);
    });

    it('refuses a second, foreign resource next to the right one', () => {
      const params = request();
      params.append('resource', 'https://evil.example/mcp/manage');
      expect(redirectError(params).code).toBe('invalid_target');
    });
  });

  describe('the consent and its answer', () => {
    async function shown(user = rig.ada): Promise<string> {
      return rig.authorization.createPending(
        user,
        rig.authorization.validate(client, LOOPBACK_REDIRECT, request()),
      );
    }

    it('an approval creates one delegation, its audit entry and a single-use code', async () => {
      const outcome = await rig.authorization.decide(rig.ada, await shown(), 'approve');
      if (outcome.outcome !== 'redirect') throw new Error(outcome.outcome);
      const location = new URL(outcome.location);
      expect(`${location.origin}${location.pathname}`).toBe(LOOPBACK_REDIRECT);
      expect(location.searchParams.get('state')).toBe('opaque-state');
      expect(location.searchParams.get('iss')).toBe(rig.endpoints.issuer);
      expect(location.searchParams.has('error')).toBe(false);
      const code = location.searchParams.get('code') ?? '';
      expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/);

      const delegations = await rig.store.delegations.listForUser(rig.ada.id);
      expect(delegations).toHaveLength(1);
      expect(delegations[0]).toMatchObject({
        id: outcome.delegationId,
        userId: rig.ada.id,
        clientId: client.id,
        scope: 'mgmt',
        status: 'active',
      });
      expect(rig.audit.admin).toEqual([
        {
          kind: 'admin',
          ts: rig.clock.now().toISOString(),
          user_id: rig.ada.id,
          act: 'delegation-granted',
          object: { type: 'delegation', id: outcome.delegationId },
          before: null,
          after: {
            client_id: client.clientId,
            client_name: client.name,
            scope: 'mgmt',
            redirect_uri: LOOPBACK_REDIRECT,
            resource: rig.endpoints.resource,
          },
          delegated_client_id: null,
        },
      ]);

      // The code is stored as a digest, bound to the redirect URI and the challenge.
      const row = await rig.store.delegations.findCode(digestOf(code));
      expect(row?.token).toMatchObject({
        delegationId: outcome.delegationId,
        redirectUri: LOOPBACK_REDIRECT,
        codeChallenge: pkce.challenge,
        codeChallengeMethod: 'S256',
        consumedAt: null,
        expiresAt: new Date(rig.clock.now().getTime() + AUTHORIZATION_CODE_TTL_MS).toISOString(),
      });
      const stored = rig.store.db.prepare('SELECT * FROM oauth_codes').all();
      expect(JSON.stringify(stored)).not.toContain(code);
      // Neither the code nor the challenge reaches the audit.
      expect(JSON.stringify(rig.audit.entries)).not.toContain(code);
    });

    it('a denial grants nothing and tells the client', async () => {
      const outcome = await rig.authorization.decide(rig.ada, await shown(), 'deny');
      if (outcome.outcome !== 'redirect') throw new Error(outcome.outcome);
      const location = new URL(outcome.location);
      expect(location.searchParams.get('error')).toBe('access_denied');
      expect(location.searchParams.get('state')).toBe('opaque-state');
      expect(location.searchParams.get('iss')).toBe(rig.endpoints.issuer);
      expect(location.searchParams.has('code')).toBe(false);
      expect(outcome.delegationId).toBeNull();
      expect(await rig.store.delegations.listForUser(rig.ada.id)).toEqual([]);
      expect(rig.audit.entries).toEqual([]);
    });

    it('a consent is answered once', async () => {
      const consentId = await shown();
      expect((await rig.authorization.decide(rig.ada, consentId, 'approve')).outcome).toBe(
        'redirect',
      );
      expect(await rig.authorization.decide(rig.ada, consentId, 'approve')).toEqual({
        outcome: 'expired',
      });
      expect(await rig.store.delegations.listForUser(rig.ada.id)).toHaveLength(1);
    });

    it('two simultaneous answers to one consent grant one delegation', async () => {
      const consentId = await shown();
      const outcomes = await Promise.all([
        rig.authorization.decide(rig.ada, consentId, 'approve'),
        rig.authorization.decide(rig.ada, consentId, 'approve'),
      ]);
      expect(outcomes.map((o) => o.outcome).sort()).toEqual(['expired', 'redirect']);
      expect(await rig.store.delegations.listForUser(rig.ada.id)).toHaveLength(1);
    });

    it('a consent shown to one user cannot be answered by another, and is spent by the attempt', async () => {
      const consentId = await shown(rig.ada);
      expect(await rig.authorization.decide(rig.bob, consentId, 'approve')).toEqual({
        outcome: 'expired',
      });
      expect(await rig.store.delegations.listForUser(rig.bob.id)).toEqual([]);
      expect(await rig.authorization.decide(rig.ada, consentId, 'approve')).toEqual({
        outcome: 'expired',
      });
      expect(await rig.store.delegations.listForUser(rig.ada.id)).toEqual([]);
    });

    it('a consent expires', async () => {
      const consentId = await shown();
      rig.clock.advance(CONSENT_TTL_MS + 1000);
      expect(await rig.authorization.decide(rig.ada, consentId, 'approve')).toEqual({
        outcome: 'expired',
      });
    });

    it.each(['', 'unknown', '../session:abc', 'a'.repeat(43)])(
      'an id that names no consent (%j) is answered as expired',
      async (consentId) => {
        expect(await rig.authorization.decide(rig.ada, consentId, 'approve')).toEqual({
          outcome: 'expired',
        });
      },
    );

    it('grants nothing when the client was disabled between the screen and the answer', async () => {
      const consentId = await shown();
      await rig.clients.decide('operator-1', client.id, 'disabled');
      rig.audit.entries.length = 0;
      expect(await rig.authorization.decide(rig.ada, consentId, 'approve')).toEqual({
        outcome: 'client-unavailable',
      });
      expect(await rig.store.delegations.listForUser(rig.ada.id)).toEqual([]);
      expect(rig.audit.entries).toEqual([]);
    });

    it('revokes the delegation and issues no code when its audit entry cannot be written', async () => {
      const consentId = await shown();
      rig.audit.write = async () => {
        throw new Error('audit store unavailable');
      };
      await expect(rig.authorization.decide(rig.ada, consentId, 'approve')).rejects.toThrow(
        'audit store unavailable',
      );
      const [delegation] = await rig.store.delegations.listForUser(rig.ada.id);
      expect(delegation?.status).toBe('revoked');
      expect(rig.store.db.prepare('SELECT * FROM oauth_codes').all()).toEqual([]);
    });

    it('revokes the delegation when its code cannot be minted: nothing stays active that no client can redeem', async () => {
      const consentId = await shown();
      rig.store.db.exec(
        `CREATE TRIGGER fault BEFORE INSERT ON oauth_codes
         BEGIN SELECT RAISE(ABORT, 'simulated store fault'); END`,
      );
      await expect(rig.authorization.decide(rig.ada, consentId, 'approve')).rejects.toThrow(
        'simulated store fault',
      );
      const delegations = await rig.store.delegations.listForUser(rig.ada.id);
      expect(delegations.map((d) => d.status)).toEqual(['revoked']);
      expect(rig.store.db.prepare('SELECT * FROM oauth_codes').all()).toEqual([]);
      // The consent is spent: the user starts again from the application.
      expect(await rig.authorization.decide(rig.ada, consentId, 'approve')).toEqual({
        outcome: 'expired',
      });
    });

    it('each approval is its own delegation: one consent, one family of tokens', async () => {
      const first = await rig.grant(rig.ada, client);
      const second = await rig.grant(rig.ada, client);
      expect(first.delegationId).not.toBe(second.delegationId);
      expect(await rig.store.delegations.listForUser(rig.ada.id)).toHaveLength(2);
    });
  });

  describe('the response sent to the client', () => {
    it('keeps the query of the registered URI and names the issuer', () => {
      const location = new URL(
        authorizationResponseUrl(
          `${WEB_REDIRECT}?tenant=acme`,
          'https://gateway.example.com',
          's',
          {
            code: 'abc',
          },
        ),
      );
      expect(Object.fromEntries(location.searchParams)).toEqual({
        tenant: 'acme',
        code: 'abc',
        state: 's',
        iss: 'https://gateway.example.com',
      });
    });

    it('never puts anything in the fragment, and omits an absent state', () => {
      const location = new URL(
        authorizationResponseUrl(WEB_REDIRECT, 'https://gateway.example.com', null, {
          error: 'access_denied',
        }),
      );
      expect(location.hash).toBe('');
      expect(location.searchParams.has('state')).toBe(false);
    });
  });
});
