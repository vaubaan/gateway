/**
 * Connections end to end inside the process (spec §10 "integration on an
 * ephemeral instance with embedded store"): the composition root over the
 * `:memory:` store with the REAL encryptor, a fixture plugin registry, a
 * mocked provider (`mockFetch`, which rejects any other request), and the
 * host-agnostic handlers driven with web-standard `Request`s.
 *
 *   operator registers the provider app → user connects → the connection row
 *   is encrypted (the database is scanned for every secret in clear) →
 *   resources are discovered → owner edits survive a refresh → revoke →
 *   state `revoked`.
 */
import { createRegistry, type Resource } from '@vaubaan/plugin-sdk';
import { mockFetch, type MockFetch } from '@vaubaan/plugin-sdk/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SESSION_COOKIE } from '../../../src/server/auth';
import { memoryStoreDeps } from '../../../src/server/compose/testing';
import { buildRoot, type GatewayRoot } from '../../../src/server/compose/root';
import { loadInstanceConfig } from '../../../src/server/config';
import { validEnv } from '../../../src/server/config/testing';
import { NOTICE_PARAM, parseSecret } from '../../../src/server/connections';
import {
  API_KEY_SPEC,
  fixturePlugin,
  OAUTH_SPEC,
  SSH_KEY_SPEC,
} from '../../../src/server/connections/testing';
import { providerAppKey } from '../../../src/server/provider-apps';

const PUBLIC_URL = 'https://gateway.example.com';
const OPERATOR = 'ops@example.com';
const ACCESS_TOKEN = 'access-token-PLAINTEXT-0123456789';
const REFRESH_TOKEN = 'refresh-token-PLAINTEXT-0123456789';
const CLIENT_SECRET = 'client-secret-PLAINTEXT-0123456789';
const API_KEY = 'api-key-PLAINTEXT-0123456789';

interface Session {
  readonly cookie: string;
  readonly sessionId: string;
  readonly userId: string | null;
}

describe('connections: provider app, connect, resources, revoke', () => {
  let root: GatewayRoot;
  let provider: MockFetch;
  let upstream: Resource[];

  beforeEach(async () => {
    upstream = [
      { provider: 'oauthco', ref: 'proj-a', displayName: 'Project A' },
      { provider: 'oauthco', ref: 'proj-b', displayName: 'Project B' },
    ];
    provider = mockFetch([
      {
        method: 'POST',
        url: OAUTH_SPEC.tokenUrl,
        body: {
          access_token: ACCESS_TOKEN,
          refresh_token: REFRESH_TOKEN,
          expires_in: 3600,
          scope: 'read write',
        },
      },
    ]);
    root = await buildRoot({
      loadConfig: () =>
        loadInstanceConfig({
          env: validEnv({ VAUBAAN_PUBLIC_URL: PUBLIC_URL, VAUBAAN_ADMIN_EMAILS: OPERATOR }),
        }),
      logWrite: () => undefined,
      buildRegistry: async () =>
        createRegistry([
          fixturePlugin({
            id: 'oauthco',
            displayName: 'OAuth Co',
            credential: OAUTH_SPEC,
            discoverResources: async () => upstream,
          }),
          fixturePlugin({
            id: 'keyco',
            displayName: 'Key Co',
            credential: API_KEY_SPEC,
            discoverResources: async () => [
              { provider: 'keyco', ref: 'acct:live', env: 'live', displayName: 'Acme (live)' },
            ],
          }),
          fixturePlugin({ id: 'sshco', credential: SSH_KEY_SPEC }),
        ]),
      providerFetch: provider,
      ...memoryStoreDeps,
    });
  });
  afterEach(async () => {
    await root.close();
  });

  async function signIn(email: string): Promise<Session> {
    const user = await root.store.users.upsertFromIdp({ subject: email, email });
    const issued = await root.auth.sessions.create({
      kind: 'user',
      userId: user.id,
      login: { email, groups: [] },
    });
    return { cookie: `${SESSION_COOKIE}=${issued.id}`, sessionId: issued.id, userId: user.id };
  }

  async function bootstrapSession(): Promise<Session> {
    const issued = await root.auth.sessions.create({ kind: 'bootstrap' });
    return { cookie: `${SESSION_COOKIE}=${issued.id}`, sessionId: issued.id, userId: null };
  }

  function post(
    path: string,
    session: Session | null,
    fields: Record<string, string> = {},
    origin: string | null = PUBLIC_URL,
  ): Request {
    const headers = new Headers({ 'content-type': 'application/x-www-form-urlencoded' });
    if (origin) headers.set('origin', origin);
    if (session) headers.set('cookie', session.cookie);
    return new Request(`${PUBLIC_URL}${path}`, {
      method: 'POST',
      headers,
      body: new URLSearchParams(fields).toString(),
    });
  }

  function get(pathAndQuery: string, session: Session | null): Request {
    const headers = new Headers();
    if (session) headers.set('cookie', session.cookie);
    // The process sees its internal address behind the TLS terminator.
    return new Request(`http://127.0.0.1:3000${pathAndQuery}`, { headers });
  }

  function location(res: Response): URL {
    expect(res.status).toBe(303);
    return new URL(res.headers.get('location') ?? '', PUBLIC_URL);
  }

  async function noticeOf(res: Response, session: Session) {
    return root.connections.notices.take(
      session.sessionId,
      location(res).searchParams.get(NOTICE_PARAM),
    );
  }

  async function registerOAuthApp(operator: Session): Promise<Response> {
    return root.connections.handlers.saveProviderApp(
      post('/admin/provider-apps/oauthco', operator, {
        'field.client_id': 'company-client-id',
        'field.client_secret': CLIENT_SECRET,
      }),
      'oauthco',
    );
  }

  /** Every value of every table, as text, to look for a secret stored in clear. */
  function databaseDump(): string {
    const { db } = root.store;
    const tables = db
      .prepare<
        [],
        { name: string }
      >("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all();
    const parts: string[] = [];
    for (const { name } of tables) {
      for (const row of db.prepare<[], Record<string, unknown>>(`SELECT * FROM "${name}"`).all()) {
        for (const value of Object.values(row)) {
          parts.push(Buffer.isBuffer(value) ? value.toString('latin1') : String(value));
        }
      }
    }
    return parts.join('\n');
  }

  it('runs the whole OAuth path: app registered, connection encrypted, resources curated, revoked', async () => {
    const operator = await signIn(OPERATOR);
    const alice = await signIn('alice@example.com');
    const handlers = root.connections.handlers;

    // ── Operator registers the company app ──────────────────────────────────
    expect((await registerOAuthApp(alice)).status).toBe(403); // not an operator
    expect((await registerOAuthApp({ ...operator, cookie: '' })).status).toBe(401);
    const saved = await registerOAuthApp(operator);
    expect(location(saved).pathname).toBe('/admin/provider-apps');
    expect(location(saved).hash).toBe('#oauthco');
    expect(await noticeOf(saved, operator)).toMatchObject({ tone: 'success' });
    expect(await root.providerApps.status('oauthco')).toMatchObject({
      configured: true,
      source: 'store',
      values: { client_id: 'company-client-id' },
      secretsSet: ['client_secret'],
    });
    const configAudit = (await root.store.audit.list({ kind: 'admin' })).at(-1);
    expect(configAudit).toMatchObject({
      act: 'config-changed',
      object: { type: 'instance-config', id: 'provider-app:oauthco' },
      user_id: operator.userId,
    });
    expect(JSON.stringify(configAudit)).not.toContain(CLIENT_SECRET);

    // ── User connects ───────────────────────────────────────────────────────
    const started = await handlers.connect(
      post('/connections/connect/oauthco', alice, { name: 'Staging account' }),
      'oauthco',
    );
    const authorize = location(started);
    expect(authorize.origin + authorize.pathname).toBe(OAUTH_SPEC.authorizationUrl);
    expect(authorize.searchParams.get('redirect_uri')).toBe(
      `${PUBLIC_URL}/connections/callback/oauthco`,
    );
    const state = authorize.searchParams.get('state')!;

    const callbackQuery = `/connections/callback/oauthco?code=auth-code-1&state=${state}`;
    const landed = await handlers.callback(get(callbackQuery, alice), 'oauthco');
    const target = location(landed);
    const connectionId = target.pathname.split('/').pop()!;
    expect(target.pathname).toBe(`/connections/${connectionId}`);
    // The URL carries an opaque notice id, never a message.
    expect([...target.searchParams.keys()]).toEqual([NOTICE_PARAM]);
    expect(await noticeOf(landed, alice)).toMatchObject({ tone: 'success', title: 'Connected' });
    expect(await noticeOf(landed, alice)).toBeNull(); // read once

    // The exchange used the company client, with the redirect URI on public_url.
    const exchange = provider.calls[0]!;
    expect(exchange.headers.authorization).toBe(
      `Basic ${Buffer.from(`company-client-id:${CLIENT_SECRET}`).toString('base64')}`,
    );
    expect(new URLSearchParams(exchange.body ?? '').get('redirect_uri')).toBe(
      `${PUBLIC_URL}/connections/callback/oauthco`,
    );

    // ── The connection row is encrypted ─────────────────────────────────────
    const row = root.store.db
      .prepare<
        [string],
        { credential_blob: Buffer; key_version: number; status: string; owner_user_id: string }
      >('SELECT credential_blob, key_version, status, owner_user_id FROM connections WHERE id = ?')
      .get(connectionId)!;
    expect(row).toMatchObject({ status: 'active', owner_user_id: alice.userId, key_version: 1 });
    expect(row.credential_blob[0]).toBe(0x01); // AEAD blob version byte
    expect(row.credential_blob.includes(Buffer.from(ACCESS_TOKEN))).toBe(false);
    expect(row.credential_blob.includes(Buffer.from('accessToken'))).toBe(false);
    const dump = databaseDump();
    for (const secret of [ACCESS_TOKEN, REFRESH_TOKEN, CLIENT_SECRET]) {
      expect(dump).not.toContain(secret);
    }
    expect(dump).toContain('company-client-id'); // the dump does see clear values
    // Only the instance, with the master key and the connection id, opens it.
    expect(parseSecret((await root.store.connections.getCredential(connectionId))!)).toMatchObject({
      kind: 'oauth2',
      accessToken: ACCESS_TOKEN,
      refreshToken: REFRESH_TOKEN,
    });
    await expect(
      root.encryptor.decrypt('another-connection-id', {
        keyVersion: row.key_version,
        blob: row.credential_blob,
      }),
    ).rejects.toThrow();

    // ── Resources discovered, curated by the owner ──────────────────────────
    const discovered = await root.store.connections.listResources(connectionId);
    expect(discovered.map((r) => [r.ref, r.displayName, r.env])).toEqual([
      ['proj-a', 'Project A', null],
      ['proj-b', 'Project B', null],
    ]);
    const edited = await handlers.updateResource(
      post(`/connections/${connectionId}/resources/${discovered[0]!.id}`, alice, {
        display_name: 'Main project',
        env: 'prod',
        hidden_present: '1',
      }),
      connectionId,
      discovered[0]!.id,
    );
    expect(await noticeOf(edited, alice)).toMatchObject({ title: 'Resource saved' });

    upstream = [
      { provider: 'oauthco', ref: 'proj-a', displayName: 'Project A (renamed upstream)' },
      { provider: 'oauthco', ref: 'proj-c', displayName: 'Project C' },
    ];
    const refreshed = await handlers.discover(
      post(`/connections/${connectionId}/discover`, alice),
      connectionId,
    );
    expect(await noticeOf(refreshed, alice)).toMatchObject({ title: 'Discovery refreshed' });
    const curated = await root.store.connections.listResources(connectionId);
    expect(curated.map((r) => [r.ref, r.displayName, r.env, r.staleSince !== null])).toEqual([
      ['proj-a', 'Main project', 'prod', false],
      ['proj-b', 'Project B', null, true],
      ['proj-c', 'Project C', null, false],
    ]);

    // ── Replay, strangers, cross-origin ─────────────────────────────────────
    const replay = await handlers.callback(get(callbackQuery, alice), 'oauthco');
    expect(location(replay).pathname).toBe('/connections');
    expect((await noticeOf(replay, alice))?.lines[0]).toContain('already used');
    expect(provider.calls).toHaveLength(1);
    expect(await root.store.connections.list()).toHaveLength(1);

    const bob = await signIn('bob@example.com');
    const stranger = await handlers.revoke(
      post(`/connections/${connectionId}/revoke`, bob),
      connectionId,
    );
    expect((await noticeOf(stranger, bob))?.title).toBe('Not revoked');
    const crossOrigin = await handlers.revoke(
      post(`/connections/${connectionId}/revoke`, alice, {}, 'https://evil.example.net'),
      connectionId,
    );
    expect(crossOrigin.status).toBe(403);
    expect((await root.store.connections.getById(connectionId))!.status).toBe('active');

    // ── Revoke ──────────────────────────────────────────────────────────────
    const revoked = await handlers.revoke(
      post(`/connections/${connectionId}/revoke`, alice),
      connectionId,
    );
    expect(location(revoked).pathname).toBe(`/connections/${connectionId}`);
    const after = root.store.db
      .prepare<
        [string],
        { status: string; credential_blob: Buffer | null; revoked_at: string | null }
      >('SELECT status, credential_blob, revoked_at FROM connections WHERE id = ?')
      .get(connectionId)!;
    expect(after.status).toBe('revoked');
    expect(after.credential_blob).toBeNull();
    expect(after.revoked_at).not.toBeNull();
    await expect(root.connections.credentials.resolve(connectionId)).rejects.toMatchObject({
      connectionStatus: 'revoked',
    });
    // The resources stay: missions and the audit still name them.
    expect(await root.store.connections.listResources(connectionId)).toHaveLength(3);

    expect(
      (await root.store.audit.list({ kind: 'admin' })).map((e) =>
        e.kind === 'admin' ? e.act : null,
      ),
    ).toEqual(['config-changed', 'connection-created', 'connection-revoked']);
  });

  it('stores an API key and an SSH private key encrypted, and marks plugin-set labels', async () => {
    const alice = await signIn('alice@example.com');
    const handlers = root.connections.handlers;

    const keyRes = await handlers.connect(
      post('/connections/connect/keyco', alice, {
        'field.token': API_KEY,
        'field.team_id': 'team_acme',
      }),
      'keyco',
    );
    const keyId = location(keyRes).pathname.split('/').pop()!;
    expect(await noticeOf(keyRes, alice)).toMatchObject({ tone: 'success' });
    expect(await root.store.connections.listResources(keyId)).toMatchObject([
      { ref: 'acct:live', env: 'live', envSource: 'plugin' },
    ]);

    const sshRes = await handlers.connect(
      post('/connections/connect/sshco', alice, {
        'field.host': 'vps-1.example.com',
        'field.user': 'deploy',
      }),
      'sshco',
    );
    const sshId = location(sshRes).pathname.split('/').pop()!;
    expect((await noticeOf(sshRes, alice))?.lines.join(' ')).toContain('Install the public key');
    const sshSecret = parseSecret((await root.store.connections.getCredential(sshId))!);
    if (sshSecret.kind !== 'ssh-key') throw new Error('expected an ssh-key secret');
    const privateKeyLine = sshSecret.privateKeyPem.split('\n')[2]!;

    const dump = databaseDump();
    expect(dump).not.toContain(API_KEY);
    expect(dump).not.toContain(privateKeyLine);
    expect(dump).toContain('team_acme'); // non-secret field, kept in clear for display
    expect(dump).toContain(sshSecret.publicKey); // the public key is shown to the owner

    // Editing a plugin-set label is refused; the row is unchanged.
    const live = (await root.store.connections.listResources(keyId))[0]!;
    const refused = await handlers.updateResource(
      post(`/connections/${keyId}/resources/${live.id}`, alice, { env: 'test' }),
      keyId,
      live.id,
    );
    expect((await noticeOf(refused, alice))?.lines[0]).toContain('set by the provider plugin');
    expect((await root.store.connections.getResource(live.id))!.env).toBe('live');
  });

  it('guards every entry point: session, origin, bootstrap operator, unconfigured app, foreign return URL', async () => {
    const alice = await signIn('alice@example.com');
    const bootstrap = await bootstrapSession();
    const handlers = root.connections.handlers;

    expect((await handlers.connect(post('/connections/connect/keyco', null), 'keyco')).status).toBe(
      401,
    );
    expect(
      (await handlers.connect(post('/connections/connect/keyco', alice, {}, null), 'keyco')).status,
    ).toBe(403);
    // The bootstrap operator configures the instance and owns nothing.
    expect(
      (await handlers.connect(post('/connections/connect/keyco', bootstrap), 'keyco')).status,
    ).toBe(403);
    // …but may register provider apps while the token is active.
    expect(location(await registerOAuthApp(bootstrap)).pathname).toBe('/admin/provider-apps');
    await root.providerApps.clear('oauthco');

    // The provider's redirect arriving without a session goes to sign-in.
    const anonymous = await handlers.callback(
      get('/connections/callback/oauthco?code=c&state=s', null),
      'oauthco',
    );
    expect(location(anonymous).pathname).toBe('/login');

    const unconfigured = await handlers.connect(
      post('/connections/connect/oauthco', alice),
      'oauthco',
    );
    expect(location(unconfigured).pathname).toBe('/connections/new/oauthco');
    expect((await noticeOf(unconfigured, alice))?.lines[0]).toContain('operator must register');

    await root.providerApps.save('oauthco', { client_id: 'cid', client_secret: CLIENT_SECRET });
    const foreign = await handlers.connect(
      post('/connections/connect/oauthco', alice, { return_to: 'https://evil.example.net/x' }),
      'oauthco',
    );
    expect(location(foreign).origin).toBe(PUBLIC_URL);
    expect(location(foreign).pathname).toBe('/connections/new/oauthco');
    expect((await noticeOf(foreign, alice))?.lines[0]).toContain('outside this instance');

    const unknown = await handlers.connect(post('/connections/connect/nope', alice), 'nope');
    expect(location(unknown).pathname).toBe('/connections/new');

    // A notice belongs to the session it was written for.
    const again = await handlers.connect(post('/connections/connect/nope', alice), 'nope');
    const bob = await signIn('bob@example.com');
    expect(await noticeOf(again, bob)).toBeNull();
    expect(await noticeOf(again, alice)).not.toBeNull();

    expect(await root.store.connections.list()).toEqual([]);
    expect(provider.calls).toHaveLength(0);
    // The stored client secret is sealed like any other secret.
    expect(databaseDump()).not.toContain(CLIENT_SECRET);
    expect(await root.store.config.get(providerAppKey('oauthco', 'client_secret'))).toBeNull();
  });
});
