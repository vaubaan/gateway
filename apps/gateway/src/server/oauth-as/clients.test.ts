import { afterEach, describe, expect, it } from 'vitest';

import {
  DOCUMENT_FETCHES_PER_WINDOW,
  registrationResponse,
  UNNAMED_CLIENT,
  UNUSED_CLIENT_RETENTION_MS,
} from './clients';
import { ClientDocumentError, type FetchedDocument } from './client-metadata-document';
import { OAuthProtocolError } from './errors';
import { CLIENT_ID_PREFIX, CLIENT_SECRET_PREFIX, digestOf } from './secrets';
import {
  LOOPBACK_REDIRECT,
  openOAuthRig,
  WEB_REDIRECT,
  type OAuthRig,
} from '../../../tests/support/oauth-as/testing';

const DOCUMENT_URL = 'https://agent.example.net/oauth/client.json';

async function refusal(run: () => Promise<unknown>): Promise<OAuthProtocolError> {
  try {
    await run();
  } catch (err) {
    if (err instanceof OAuthProtocolError) return err;
    throw err;
  }
  throw new Error('expected the registration to be refused');
}

describe('ClientRegistry', () => {
  let rig: OAuthRig;
  afterEach(() => rig.close());

  describe('dynamic registration', () => {
    it('registers a public client and returns its RFC 7591 description, with no secret', async () => {
      rig = await openOAuthRig();
      const registered = await rig.clients.register({
        client_name: 'Claude Code',
        redirect_uris: [LOOPBACK_REDIRECT],
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        client_uri: 'https://agent.example.net',
      });
      expect(registered.clientSecret).toBeNull();
      expect(registered.client).toMatchObject({
        name: 'Claude Code',
        registration: 'dynamic',
        tokenEndpointAuthMethod: 'none',
        clientSecretHash: null,
        redirectUris: [LOOPBACK_REDIRECT],
        clientUri: 'https://agent.example.net/',
      });
      expect(registered.client.clientId.startsWith(CLIENT_ID_PREFIX)).toBe(true);
      expect(registrationResponse(registered)).toEqual({
        client_id: registered.client.clientId,
        client_id_issued_at: Math.floor(rig.clock.now().getTime() / 1000),
        client_name: 'Claude Code',
        redirect_uris: [LOOPBACK_REDIRECT],
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        scope: 'mgmt',
        client_uri: 'https://agent.example.net/',
      });
    });

    it('issues a secret to a confidential client, once, and stores its digest only', async () => {
      rig = await openOAuthRig();
      // RFC 7591 §2: no method means client_secret_basic.
      const registered = await rig.clients.register({ redirect_uris: [WEB_REDIRECT] });
      expect(registered.client.tokenEndpointAuthMethod).toBe('client_secret_basic');
      const secret = registered.clientSecret ?? '';
      expect(secret.startsWith(CLIENT_SECRET_PREFIX)).toBe(true);
      expect(registered.client.clientSecretHash).toBe(digestOf(secret));
      expect(registrationResponse(registered)).toMatchObject({
        client_secret: secret,
        client_secret_expires_at: 0,
      });
      const row = rig.store.db
        .prepare<[string], Record<string, unknown>>('SELECT * FROM oauth_clients WHERE id = ?')
        .get(registered.client.id);
      expect(JSON.stringify(row)).not.toContain(secret);
    });

    it('gives a client that names nothing a neutral name, and cleans the one it gives', async () => {
      rig = await openOAuthRig();
      const unnamed = await rig.clients.register({
        redirect_uris: [LOOPBACK_REDIRECT],
        token_endpoint_auth_method: 'none',
      });
      expect(unnamed.client.name).toBe(UNNAMED_CLIENT);
      const noisy = await rig.clients.register({
        client_name: `  Agent${String.fromCharCode(0x202e)}\n  X `,
        redirect_uris: [LOOPBACK_REDIRECT],
        token_endpoint_auth_method: 'none',
        client_uri: 'javascript:alert(1)',
      });
      expect(noisy.client.name).toBe('Agent X');
      expect(noisy.client.clientUri).toBeNull();
    });

    it('ignores what a registration cannot decide: the scope is always mgmt', async () => {
      rig = await openOAuthRig();
      const registered = await rig.clients.register({
        redirect_uris: [LOOPBACK_REDIRECT],
        token_endpoint_auth_method: 'none',
        scope: 'admin everything',
        client_id: 'chosen-by-the-client',
        client_secret: 'chosen-by-the-client',
      });
      expect(registered.client.clientId).not.toBe('chosen-by-the-client');
      expect(registered.clientSecret).toBeNull();
      expect(registrationResponse(registered).scope).toBe('mgmt');
    });

    it.each([
      ['no redirect URI', {}, 'invalid_redirect_uri'],
      ['an empty list', { redirect_uris: [] }, 'invalid_redirect_uri'],
      [
        'a plain-http redirect URI',
        { redirect_uris: ['http://agent.example.net/cb'] },
        'invalid_redirect_uri',
      ],
      [
        'a javascript redirect URI',
        { redirect_uris: ['javascript:alert(1)'] },
        'invalid_redirect_uri',
      ],
      [
        'a redirect URI with a fragment',
        { redirect_uris: [`${WEB_REDIRECT}#x`] },
        'invalid_redirect_uri',
      ],
      [
        'one bad URI among good ones',
        { redirect_uris: [LOOPBACK_REDIRECT, 'file:///etc/passwd'] },
        'invalid_redirect_uri',
      ],
      [
        'too many redirect URIs',
        { redirect_uris: Array.from({ length: 11 }, (_, i) => `http://127.0.0.1/cb${i}`) },
        'invalid_redirect_uri',
      ],
      [
        'redirect URIs that are not a list',
        { redirect_uris: LOOPBACK_REDIRECT },
        'invalid_client_metadata',
      ],
      [
        'an unknown authentication method',
        { redirect_uris: [LOOPBACK_REDIRECT], token_endpoint_auth_method: 'private_key_jwt' },
        'invalid_client_metadata',
      ],
      [
        'the implicit grant',
        { redirect_uris: [LOOPBACK_REDIRECT], grant_types: ['implicit'] },
        'invalid_client_metadata',
      ],
      [
        'the client-credentials grant',
        {
          redirect_uris: [LOOPBACK_REDIRECT],
          grant_types: ['authorization_code', 'client_credentials'],
        },
        'invalid_client_metadata',
      ],
      [
        'refresh without the code grant',
        { redirect_uris: [LOOPBACK_REDIRECT], grant_types: ['refresh_token'] },
        'invalid_client_metadata',
      ],
      [
        'the token response type',
        { redirect_uris: [LOOPBACK_REDIRECT], response_types: ['token'] },
        'invalid_client_metadata',
      ],
    ])('refuses %s', async (_case, metadata, code) => {
      rig = await openOAuthRig();
      expect((await refusal(() => rig.clients.register(metadata))).code).toBe(code);
      expect(await rig.clients.list()).toEqual([]);
    });

    it.each([
      ['a string', 'client'],
      ['an array', []],
      ['null', null],
      ['a number', 7],
    ])('refuses a body that is %s', async (_case, body) => {
      rig = await openOAuthRig();
      expect((await refusal(() => rig.clients.register(body))).code).toBe(
        'invalid_client_metadata',
      );
    });

    it('forgets the undecided clients nobody used for a month, at the next registration', async () => {
      rig = await openOAuthRig();
      const stale = await rig.registerClient();
      const used = await rig.registerClient();
      await rig.grant(rig.ada, used);
      rig.clock.advance(UNUSED_CLIENT_RETENTION_MS + 1000);
      await rig.registerClient();
      expect(await rig.clients.get(stale.id)).toBeNull();
      expect(await rig.clients.get(used.id)).not.toBeNull();
    });
  });

  describe('registration policy', () => {
    it('operator-approved: a loopback-only client is usable at once, any other waits', async () => {
      rig = await openOAuthRig();
      const loopback = await rig.clients.register({
        redirect_uris: [LOOPBACK_REDIRECT, 'http://localhost/cb'],
        token_endpoint_auth_method: 'none',
      });
      expect(loopback.status).toBe('approved');
      expect(rig.clients.view(loopback.client)).toMatchObject({
        status: 'approved',
        decidedBy: 'policy',
        loopbackOnly: true,
      });
      for (const redirectUris of [
        [WEB_REDIRECT],
        ['cursor://agent/callback'],
        [LOOPBACK_REDIRECT, WEB_REDIRECT],
      ]) {
        const other = await rig.clients.register({
          redirect_uris: redirectUris,
          token_endpoint_auth_method: 'none',
        });
        expect(other.status).toBe('pending');
        expect(rig.clients.view(other.client).loopbackOnly).toBe(false);
      }
    });

    it('operator-approved without the loopback exception: every client waits', async () => {
      rig = await openOAuthRig({ registration: { autoApproveLoopback: false } });
      expect((await rig.clients.register({ redirect_uris: [LOOPBACK_REDIRECT] })).status).toBe(
        'pending',
      );
    });

    it('open: every client is usable at once', async () => {
      rig = await openOAuthRig({ registration: { policy: 'open' } });
      expect((await rig.clients.register({ redirect_uris: [WEB_REDIRECT] })).status).toBe(
        'approved',
      );
    });

    it('closed: nothing registers', async () => {
      rig = await openOAuthRig({ registration: { policy: 'closed' } });
      const err = await refusal(() => rig.clients.register({ redirect_uris: [LOOPBACK_REDIRECT] }));
      expect(err).toMatchObject({ code: 'access_denied', status: 403 });
      expect(await rig.clients.list()).toEqual([]);
    });

    it('is evaluated at every use, never stored: tightening it applies to existing clients', async () => {
      rig = await openOAuthRig({ registration: { policy: 'open' } });
      const client = await rig.registerClient([WEB_REDIRECT]);
      expect(rig.clients.statusOf(client)).toBe('approved');
      const stored = rig.store.db
        .prepare<[string], { operator_decision: string | null }>(
          'SELECT operator_decision FROM oauth_clients WHERE id = ?',
        )
        .get(client.id);
      expect(stored?.operator_decision).toBeNull();

      // The same row under a stricter configuration.
      const strict = await openOAuthRig();
      expect(strict.clients.statusOf(client)).toBe('pending');
      await strict.close();
    });
  });

  describe('operator decisions', () => {
    it('approving a waiting client makes it usable and leaves an entry', async () => {
      rig = await openOAuthRig();
      const client = await rig.registerClient([WEB_REDIRECT], 'Web agent');
      const decided = await rig.clients.decide('operator-1', client.id, 'approved');
      expect(decided?.revoked).toEqual([]);
      expect(rig.clients.view(decided!.client)).toMatchObject({
        status: 'approved',
        decidedBy: 'operator',
      });
      expect(rig.audit.admin).toMatchObject([
        {
          user_id: 'operator-1',
          act: 'oauth-client-approved',
          object: { type: 'oauth-client', id: client.id },
          before: { status: 'pending' },
          after: {
            status: 'approved',
            client_id: client.clientId,
            client_name: 'Web agent',
            redirect_uris: [WEB_REDIRECT],
          },
        },
      ]);
    });

    it('disabling a client revokes every delegation it holds, each with its own entry', async () => {
      rig = await openOAuthRig();
      const client = await rig.registerClient();
      const other = await rig.registerClient();
      const ada = await rig.issue(rig.ada, client);
      const bob = await rig.issue(rig.bob, client);
      const untouched = await rig.issue(rig.ada, other);
      rig.audit.entries.length = 0;

      const decided = await rig.clients.decide('operator-1', client.id, 'disabled');
      expect(decided?.revoked.map((d) => d.id).sort()).toEqual(
        [ada.delegationId, bob.delegationId].sort(),
      );
      expect(rig.clients.statusOf(decided!.client)).toBe('disabled');
      expect(await rig.verifier.resolve(ada.tokens.access_token)).toBeNull();
      expect(await rig.verifier.resolve(bob.tokens.access_token)).toBeNull();
      expect(await rig.verifier.resolve(untouched.tokens.access_token)).not.toBeNull();
      for (const id of [ada.delegationId, bob.delegationId]) {
        expect(await rig.store.delegations.getById(id)).toMatchObject({
          status: 'revoked',
          revokeReason: 'operator',
        });
      }

      const acts = rig.audit.admin.map((entry) => [entry.act, entry.object.id]);
      expect(acts).toHaveLength(3);
      expect(acts).toContainEqual(['oauth-client-disabled', client.id]);
      expect(acts).toContainEqual(['delegation-revoked', ada.delegationId]);
      expect(acts).toContainEqual(['delegation-revoked', bob.delegationId]);
      const disabled = rig.audit.admin.find((entry) => entry.act === 'oauth-client-disabled');
      expect(disabled?.after).toMatchObject({ status: 'disabled', delegations_revoked: 2 });
      const revoked = rig.audit.admin.find((entry) => entry.object.id === bob.delegationId);
      expect(revoked).toMatchObject({
        user_id: 'operator-1',
        after: { reason: 'operator', delegating_user_id: rig.bob.id, client_id: client.clientId },
      });
    });

    it('disabling interrupted by a store fault changes nothing: the client is not disabled, its delegations live, nothing is audited', async () => {
      rig = await openOAuthRig();
      const client = await rig.registerClient();
      const ada = await rig.issue(rig.ada, client);
      const bob = await rig.issue(rig.bob, client);
      rig.audit.entries.length = 0;
      rig.store.db.exec(
        `CREATE TRIGGER fault BEFORE UPDATE ON oauth_refresh_tokens
         BEGIN SELECT RAISE(ABORT, 'simulated store fault'); END`,
      );

      await expect(rig.clients.decide('operator-1', client.id, 'disabled')).rejects.toThrow(
        'simulated store fault',
      );
      const after = await rig.clients.get(client.id);
      expect(after?.operatorDecision).toBeNull();
      expect(rig.clients.statusOf(after!)).toBe('approved');
      for (const held of [ada, bob]) {
        expect(await rig.store.delegations.getById(held.delegationId)).toMatchObject({
          status: 'active',
        });
        expect(await rig.verifier.resolve(held.tokens.access_token)).not.toBeNull();
      }
      expect(rig.audit.entries).toEqual([]);

      // Once the store is back, the same decision goes through whole.
      rig.store.db.exec('DROP TRIGGER fault');
      const decided = await rig.clients.decide('operator-1', client.id, 'disabled');
      expect(decided?.revoked).toHaveLength(2);
      expect(rig.audit.admin.map((entry) => entry.act).sort()).toEqual([
        'delegation-revoked',
        'delegation-revoked',
        'oauth-client-disabled',
      ]);
    });

    it('a disabled client stays disabled whatever the policy says', async () => {
      rig = await openOAuthRig({ registration: { policy: 'open' } });
      const client = await rig.registerClient();
      const decided = await rig.clients.decide('operator-1', client.id, 'disabled');
      expect(rig.clients.view(decided!.client)).toMatchObject({
        status: 'disabled',
        decidedBy: 'operator',
      });
    });

    it('answers null for a client that does not exist, and writes nothing', async () => {
      rig = await openOAuthRig();
      expect(await rig.clients.decide('operator-1', 'missing', 'approved')).toBeNull();
      expect(rig.audit.entries).toEqual([]);
    });
  });

  describe('metadata documents', () => {
    const DOCUMENT = {
      client_id: DOCUMENT_URL,
      client_name: 'Documented agent',
      redirect_uris: ['http://127.0.0.1/callback'],
      token_endpoint_auth_method: 'none',
    };

    function fetcherOf(document: unknown, cacheControl: string | null = 'max-age=600') {
      const calls: string[] = [];
      const state = { document };
      const fetchDocument = async (url: URL): Promise<FetchedDocument> => {
        calls.push(url.href);
        return {
          status: 200,
          contentType: 'application/json',
          cacheControl,
          body: JSON.stringify(state.document),
        };
      };
      return { calls, state, fetchDocument };
    }

    it('are refused unless the operator enabled them', async () => {
      const { fetchDocument, calls } = fetcherOf(DOCUMENT);
      rig = await openOAuthRig({ fetchDocument });
      await expect(rig.clients.resolveDocumentClient(DOCUMENT_URL, rig.ada.id)).rejects.toThrow(
        ClientDocumentError,
      );
      expect(calls).toEqual([]);
    });

    it('register the client its document describes, as a public client', async () => {
      const { fetchDocument, calls } = fetcherOf(DOCUMENT);
      rig = await openOAuthRig({ registration: { metadataDocuments: true }, fetchDocument });
      const client = await rig.clients.resolveDocumentClient(DOCUMENT_URL, rig.ada.id);
      expect(client).toMatchObject({
        clientId: DOCUMENT_URL,
        name: 'Documented agent',
        registration: 'metadata-document',
        tokenEndpointAuthMethod: 'none',
        clientSecretHash: null,
        redirectUris: ['http://127.0.0.1/callback'],
      });
      expect(rig.clients.statusOf(client)).toBe('approved');
      expect(calls).toEqual([DOCUMENT_URL]);
    });

    it('reuse a fresh document and fetch an expired one again', async () => {
      const { fetchDocument, calls, state } = fetcherOf(DOCUMENT);
      rig = await openOAuthRig({ registration: { metadataDocuments: true }, fetchDocument });
      const first = await rig.clients.resolveDocumentClient(DOCUMENT_URL, rig.ada.id);
      rig.clock.advance(599_000);
      await rig.clients.resolveDocumentClient(DOCUMENT_URL, rig.ada.id);
      expect(calls).toHaveLength(1);

      state.document = { ...DOCUMENT, client_name: 'Renamed agent' };
      rig.clock.advance(2000);
      const again = await rig.clients.resolveDocumentClient(DOCUMENT_URL, rig.ada.id);
      expect(calls).toHaveLength(2);
      expect(again).toMatchObject({ id: first.id, name: 'Renamed agent' });
    });

    it('put a loopback client back in the queue when its document adds a server', async () => {
      const { fetchDocument, state } = fetcherOf(DOCUMENT);
      rig = await openOAuthRig({ registration: { metadataDocuments: true }, fetchDocument });
      const client = await rig.clients.resolveDocumentClient(DOCUMENT_URL, rig.ada.id);
      expect(rig.clients.statusOf(client)).toBe('approved');
      state.document = { ...DOCUMENT, redirect_uris: [...DOCUMENT.redirect_uris, WEB_REDIRECT] };
      rig.clock.advance(601_000);
      const changed = await rig.clients.resolveDocumentClient(DOCUMENT_URL, rig.ada.id);
      expect(rig.clients.statusOf(changed)).toBe('pending');
    });

    it('fail closed when the document cannot be read, even for a known client', async () => {
      const { fetchDocument, state } = fetcherOf(DOCUMENT);
      rig = await openOAuthRig({ registration: { metadataDocuments: true }, fetchDocument });
      await rig.clients.resolveDocumentClient(DOCUMENT_URL, rig.ada.id);
      state.document = { ...DOCUMENT, client_id: 'https://evil.example/client.json' };
      rig.clock.advance(601_000);
      await expect(rig.clients.resolveDocumentClient(DOCUMENT_URL, rig.ada.id)).rejects.toThrow(
        /another client_id/,
      );
    });

    it('never fetch an identifier that is not a canonical document URL', async () => {
      const { fetchDocument, calls } = fetcherOf(DOCUMENT);
      rig = await openOAuthRig({ registration: { metadataDocuments: true }, fetchDocument });
      for (const id of [
        'https://127.0.0.1/client.json',
        'https://agent.example.net/',
        'https://agent.example.net:8443/client.json',
        'https://intranet/client.json',
      ]) {
        await expect(rig.clients.resolveDocumentClient(id, rig.ada.id)).rejects.toThrow(
          ClientDocumentError,
        );
      }
      expect(calls).toEqual([]);
    });

    it('do not register a new client when registration is closed', async () => {
      const { fetchDocument, calls } = fetcherOf(DOCUMENT);
      rig = await openOAuthRig({
        registration: { metadataDocuments: true, policy: 'closed' },
        fetchDocument,
      });
      await expect(rig.clients.resolveDocumentClient(DOCUMENT_URL, rig.ada.id)).rejects.toThrow(
        /closed/,
      );
      expect(calls).toEqual([]);
    });

    it('limit how many documents one user makes the instance fetch', async () => {
      const { fetchDocument, calls } = fetcherOf(DOCUMENT, 'no-store');
      rig = await openOAuthRig({ registration: { metadataDocuments: true }, fetchDocument });
      for (let i = 0; i < DOCUMENT_FETCHES_PER_WINDOW; i += 1) {
        const url = `https://agent.example.net/c/${i}.json`;
        // Each document names another client than its URL: fetched, then refused.
        await expect(rig.clients.resolveDocumentClient(url, rig.ada.id)).rejects.toThrow(
          ClientDocumentError,
        );
      }
      expect(calls).toHaveLength(DOCUMENT_FETCHES_PER_WINDOW);
      await expect(
        rig.clients.resolveDocumentClient('https://agent.example.net/c/last.json', rig.ada.id),
      ).rejects.toThrow(/too many/);
      expect(calls).toHaveLength(DOCUMENT_FETCHES_PER_WINDOW);
      // Another user has their own window.
      await expect(
        rig.clients.resolveDocumentClient(DOCUMENT_URL, rig.bob.id),
      ).resolves.toBeTruthy();
    });
  });
});
