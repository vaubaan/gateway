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
 *
 * And the `app-install` path: an installation is connected only when the
 * provider confirms the authorizing user can reach it; the user token used
 * for that check is in no table and no log line.
 */
import { createRegistry, type Resource } from '@vaubaan/plugin-sdk';
import { mockFetch, type MockFetch } from '@vaubaan/plugin-sdk/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SESSION_COOKIE } from '../../../src/server/auth';
import { memoryStoreDeps } from '../../../src/server/compose/testing';
import { buildRoot, type GatewayRoot } from '../../../src/server/compose/root';
import { loadInstanceConfig } from '../../../src/server/config';
import { validEnv } from '../../../src/server/config/testing';
import { NOTICE_PARAM, parseSecret } from '../../../src/server/connections';
import {
  API_KEY_SPEC,
  APP_INSTALL_SPEC,
  fixturePlugin,
  INSTALL_TOKEN_URL,
  INSTALLATIONS_URL,
  OAUTH_SPEC,
  SSH_KEY_SPEC,
  UNVERIFIED_APP_INSTALL_SPEC,
} from '../../../src/server/connections/testing';
import { providerAppKey } from '../../../src/server/provider-apps';

const PUBLIC_URL = 'https://gateway.example.com';
const OPERATOR = 'ops@example.com';
const ACCESS_TOKEN = 'access-token-PLAINTEXT-0123456789';
const REFRESH_TOKEN = 'refresh-token-PLAINTEXT-0123456789';
const CLIENT_SECRET = 'client-secret-PLAINTEXT-0123456789';
const API_KEY = 'api-key-PLAINTEXT-0123456789';
const USER_TOKEN = 'ghu_user-token-PLAINTEXT-0123456789';
const USER_AUTH_CODE = 'user-auth-code-PLAINTEXT-0123456789';
const INSTALL_CLIENT_SECRET = 'install-client-secret-PLAINTEXT-0123456789';
const PRIVATE_KEY = 'app-private-key-PLAINTEXT-0123456789';
/** The installations the mocked provider says the authorizing user can reach. */
const REACHABLE_INSTALLATIONS = [1001, 1002, 1003];

interface Session {
  readonly cookie: string;
  readonly sessionId: string;
  readonly userId: string | null;
}

describe('connections: provider app, connect, resources, revoke', () => {
  let root: GatewayRoot;
  let provider: MockFetch;
  let upstream: Resource[];
  let logLines: string[];

  beforeEach(async () => {
    logLines = [];
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
      {
        method: 'POST',
        url: INSTALL_TOKEN_URL,
        body: { access_token: USER_TOKEN, token_type: 'bearer' },
      },
      {
        method: 'GET',
        url: (url) => url.startsWith(`${INSTALLATIONS_URL}?`),
        respond: (call) => {
          const query = new URL(call.url).searchParams;
          const perPage = Number(query.get('per_page'));
          const page = Number(query.get('page'));
          return {
            installations: REACHABLE_INSTALLATIONS.slice((page - 1) * perPage, page * perPage).map(
              (id) => ({ id }),
            ),
          };
        },
      },
    ]);
    root = await buildRoot({
      loadConfig: () =>
        loadInstanceConfig({
          env: validEnv({ VAUBAAN_PUBLIC_URL: PUBLIC_URL, VAUBAAN_ADMIN_EMAILS: OPERATOR }),
        }),
      logWrite: (_level, line) => logLines.push(line),
      buildRegistry: async () =>
        createRegistry([
          fixturePlugin({
            id: 'appco',
            displayName: 'App Co',
            credential: APP_INSTALL_SPEC,
            discoverResources: async () => [
              { provider: 'appco', ref: 'acme/app', displayName: 'acme/app' },
            ],
          }),
          fixturePlugin({
            id: 'oldappco',
            displayName: 'Old App Co',
            credential: UNVERIFIED_APP_INSTALL_SPEC,
          }),
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
    const user = await root.store.users.upsertFromIdp({
      issuer: 'http://idp.test',
      subject: email,
      email,
    });
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
      post('/accounts/connect/oauthco', alice, { name: 'Staging account' }),
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
    expect(target.pathname).toBe(`/accounts/${connectionId}`);
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
      post(`/accounts/${connectionId}/resources/${discovered[0]!.id}`, alice, {
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
      post(`/accounts/${connectionId}/discover`, alice),
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
    expect(location(replay).pathname).toBe('/accounts');
    expect((await noticeOf(replay, alice))?.lines[0]).toContain('already used');
    expect(provider.calls).toHaveLength(1);
    expect(await root.store.connections.list()).toHaveLength(1);

    const bob = await signIn('bob@example.com');
    const stranger = await handlers.revoke(
      post(`/accounts/${connectionId}/revoke`, bob),
      connectionId,
    );
    expect((await noticeOf(stranger, bob))?.title).toBe('Not revoked');
    const crossOrigin = await handlers.revoke(
      post(`/accounts/${connectionId}/revoke`, alice, {}, 'https://evil.example.net'),
      connectionId,
    );
    expect(crossOrigin.status).toBe(403);
    expect((await root.store.connections.getById(connectionId))!.status).toBe('active');

    // ── Revoke ──────────────────────────────────────────────────────────────
    const revoked = await handlers.revoke(
      post(`/accounts/${connectionId}/revoke`, alice),
      connectionId,
    );
    expect(location(revoked).pathname).toBe(`/accounts/${connectionId}`);
    // This provider documents no revocation endpoint: the person is told, as a warning,
    // that the access still stands there and is theirs to remove.
    const told = await noticeOf(revoked, alice);
    expect(told).toMatchObject({ tone: 'warning', title: 'Connection revoked' });
    expect(told?.lines[1]).toMatch(/^Remove the access at .+ by hand\. /);
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
    ).toEqual([
      'config-changed',
      'connection-created',
      'resource-edited',
      'resources-discovered',
      'connection-revoked',
    ]);
  });

  it('stores an API key and an SSH private key encrypted, and marks plugin-set labels', async () => {
    const alice = await signIn('alice@example.com');
    const handlers = root.connections.handlers;

    const keyRes = await handlers.connect(
      post('/accounts/connect/keyco', alice, {
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
      post('/accounts/connect/sshco', alice, {
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
      post(`/accounts/${keyId}/resources/${live.id}`, alice, { env: 'test' }),
      keyId,
      live.id,
    );
    expect((await noticeOf(refused, alice))?.lines[0]).toContain('set by the provider plugin');
    expect((await root.store.connections.getResource(live.id))!.env).toBe('live');
  });

  it('binds an installation to the user who authorized it; the user token is in no table and no log', async () => {
    const operator = await signIn(OPERATOR);
    const alice = await signIn('alice@example.com');
    const mallory = await signIn('mallory@example.com');
    const handlers = root.connections.handlers;

    const saved = await handlers.saveProviderApp(
      post('/admin/provider-apps/appco', operator, {
        'field.app_id': '4242',
        'field.private_key': PRIVATE_KEY,
        'field.app_slug': 'acme-gateway',
        'field.client_id': 'Iv1.company-app',
        'field.client_secret': INSTALL_CLIENT_SECRET,
      }),
      'appco',
    );
    expect(await noticeOf(saved, operator)).toMatchObject({ tone: 'success' });

    async function install(session: Session, query: Record<string, string>): Promise<Response> {
      const started = await handlers.connect(post('/accounts/connect/appco', session), 'appco');
      const state = location(started).searchParams.get('state')!;
      const search = new URLSearchParams({ ...query, state }).toString();
      return handlers.callback(get(`/connections/callback/appco?${search}`, session), 'appco');
    }

    // ── An insider claims an installation their GitHub account cannot reach ──
    const stolen = await install(mallory, { code: USER_AUTH_CODE, installation_id: '9999' });
    expect(location(stolen).pathname).toBe('/accounts');
    const stolenNotice = await noticeOf(stolen, mallory);
    expect(stolenNotice).toMatchObject({ tone: 'danger', title: 'Not connected' });
    expect(stolenNotice?.lines[0]).toContain('did not confirm that your account has access');

    // ── …or replays the callback shape without any authorization code ───────
    const noCode = await install(mallory, { installation_id: '1003' });
    expect((await noticeOf(noCode, mallory))?.lines.join(' ')).toContain('no user authorization');

    expect(await root.store.connections.list()).toEqual([]);
    const refusals = (await root.store.audit.list({ kind: 'admin' })).filter(
      (e) => e.kind === 'admin' && e.act === 'connection-refused',
    );
    expect(refusals).toMatchObject([
      {
        user_id: mallory.userId,
        object: { type: 'connection', id: 'not-created:appco' },
        after: { provider: 'appco', reason: 'installation-not-listed', installation_id: '9999' },
      },
      {
        user_id: mallory.userId,
        after: { reason: 'no-authorization-code', installation_id: '1003' },
      },
    ]);

    // ── The person who can reach the installation connects it ───────────────
    const landed = await install(alice, {
      code: USER_AUTH_CODE,
      installation_id: '1003',
      setup_action: 'install',
    });
    const connectionId = location(landed).pathname.split('/').pop()!;
    expect(await noticeOf(landed, alice)).toMatchObject({ tone: 'success', title: 'Connected' });
    const connection = (await root.store.connections.getById(connectionId))!;
    expect(connection).toMatchObject({ status: 'active', provider: 'appco' });
    expect(connection.owner).toEqual({ kind: 'user', id: alice.userId });
    expect(connection.metadata).toMatchObject({
      installation_id: '1003',
      installation_verification: 'user-authorization',
    });
    expect(await root.store.connections.listResources(connectionId)).toHaveLength(1);

    // ── The user token, the code and the secrets are nowhere at rest ────────
    const dump = databaseDump();
    for (const secret of [USER_TOKEN, USER_AUTH_CODE, INSTALL_CLIENT_SECRET, PRIVATE_KEY]) {
      expect(dump).not.toContain(secret);
    }
    expect(dump).toContain('Iv1.company-app'); // the dump does see clear values
    expect(dump).toContain('connection-refused');
    const logs = logLines.join('\n');
    expect(logs).toContain('connection refused'); // the log did record the attempts
    for (const secret of [USER_TOKEN, USER_AUTH_CODE, INSTALL_CLIENT_SECRET, PRIVATE_KEY]) {
      expect(logs).not.toContain(secret);
    }
    // The token did reach the provider — and only the provider.
    expect(
      provider.calls.filter((c) => c.headers.authorization === `Bearer ${USER_TOKEN}`).length,
    ).toBeGreaterThan(0);
  });

  it('refuses a plugin that cannot verify installations until the operator accepts it, audited', async () => {
    const operator = await signIn(OPERATOR);
    const alice = await signIn('alice@example.com');
    const handlers = root.connections.handlers;
    await root.providerApps.save('oldappco', {
      app_id: '7',
      private_key: PRIVATE_KEY,
      app_slug: 'old-app',
    });

    const refused = await handlers.connect(post('/accounts/connect/oldappco', alice), 'oldappco');
    expect(location(refused).pathname).toBe('/accounts/new/oldappco');
    expect((await noticeOf(refused, alice))?.lines[0]).toContain(
      'cannot prove who performed an installation',
    );

    // Only an operator decides, and not for a provider that verifies.
    const flag = (session: Session, providerId: string, action: string) =>
      handlers.saveProviderApp(
        post(`/admin/provider-apps/${providerId}`, session, { action }),
        providerId,
      );
    expect((await flag(alice, 'oldappco', 'accept-unverified')).status).toBe(403);
    const pointless = await flag(operator, 'appco', 'accept-unverified');
    expect((await noticeOf(pointless, operator))?.lines[0]).toContain(
      'verifies every installation',
    );

    const accepted = await flag(operator, 'oldappco', 'accept-unverified');
    expect(await noticeOf(accepted, operator)).toMatchObject({ tone: 'warning' });
    expect(await root.providerApps.installVerification('oldappco')).toBe('unverified-accepted');
    expect((await root.store.audit.list({ kind: 'admin' })).at(-1)).toMatchObject({
      act: 'config-changed',
      object: { type: 'instance-config', id: 'provider-app:oldappco' },
      before: { install_verification: 'unverified-refused' },
      after: { install_verification: 'unverified-accepted' },
    });

    const started = await handlers.connect(post('/accounts/connect/oldappco', alice), 'oldappco');
    const state = location(started).searchParams.get('state')!;
    const landed = await handlers.callback(
      get(`/connections/callback/oldappco?installation_id=55&state=${state}`, alice),
      'oldappco',
    );
    expect(await noticeOf(landed, alice)).toMatchObject({ title: 'Connected' });

    const withdrawn = await flag(operator, 'oldappco', 'refuse-unverified');
    expect(await noticeOf(withdrawn, operator)).toMatchObject({ tone: 'success' });
    expect(await root.providerApps.installVerification('oldappco')).toBe('unverified-refused');
  });

  it('guards every entry point: session, origin, bootstrap operator, unconfigured app, foreign return URL', async () => {
    const alice = await signIn('alice@example.com');
    const bootstrap = await bootstrapSession();
    const handlers = root.connections.handlers;

    expect((await handlers.connect(post('/accounts/connect/keyco', null), 'keyco')).status).toBe(
      401,
    );
    expect(
      (await handlers.connect(post('/accounts/connect/keyco', alice, {}, null), 'keyco')).status,
    ).toBe(403);
    // The bootstrap operator configures the instance and owns nothing.
    expect(
      (await handlers.connect(post('/accounts/connect/keyco', bootstrap), 'keyco')).status,
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
      post('/accounts/connect/oauthco', alice),
      'oauthco',
    );
    expect(location(unconfigured).pathname).toBe('/accounts/new/oauthco');
    expect((await noticeOf(unconfigured, alice))?.lines[0]).toContain('operator must register');

    await root.providerApps.save('oauthco', { client_id: 'cid', client_secret: CLIENT_SECRET });
    const foreign = await handlers.connect(
      post('/accounts/connect/oauthco', alice, { return_to: 'https://evil.example.net/x' }),
      'oauthco',
    );
    expect(location(foreign).origin).toBe(PUBLIC_URL);
    expect(location(foreign).pathname).toBe('/accounts/new/oauthco');
    expect((await noticeOf(foreign, alice))?.lines[0]).toContain('outside this instance');

    const unknown = await handlers.connect(post('/accounts/connect/nope', alice), 'nope');
    expect(location(unknown).pathname).toBe('/accounts/new');

    // A notice belongs to the session it was written for.
    const again = await handlers.connect(post('/accounts/connect/nope', alice), 'nope');
    const bob = await signIn('bob@example.com');
    expect(await noticeOf(again, bob)).toBeNull();
    expect(await noticeOf(again, alice)).not.toBeNull();

    expect(await root.store.connections.list()).toEqual([]);
    expect(provider.calls).toHaveLength(0);
    // The stored client secret is sealed like any other secret.
    expect(databaseDump()).not.toContain(CLIENT_SECRET);
    expect(await root.store.config.get(providerAppKey('oauthco', 'client_secret'))).toBeNull();
  });

  it('reports an unknown provider as unknown, and a failure to read the app settings as a failure', async () => {
    const operator = await signIn(OPERATOR);
    const handlers = root.connections.handlers;
    const adminEntries = async () => (await root.store.audit.list({ kind: 'admin' })).length;
    const before = await adminEntries();

    const unknown = await handlers.saveProviderApp(
      post('/admin/provider-apps/nope', operator, { 'field.client_id': 'x' }),
      'nope',
    );
    expect(location(unknown).pathname).toBe('/admin/provider-apps');
    expect(await noticeOf(unknown, operator)).toMatchObject({
      tone: 'danger',
      title: 'Not saved',
      lines: ['This provider is not available on this instance.'],
    });

    // The store failing is not "provider unknown": the error reaches the caller.
    const status = vi
      .spyOn(root.providerApps, 'status')
      .mockRejectedValueOnce(new Error('store unavailable'));
    await expect(
      handlers.saveProviderApp(
        post('/admin/provider-apps/oauthco', operator, {
          'field.client_id': 'company-client-id',
          'field.client_secret': CLIENT_SECRET,
        }),
        'oauthco',
      ),
    ).rejects.toThrow('store unavailable');
    status.mockRestore();

    expect((await root.providerApps.status('oauthco')).configured).toBe(false);
    expect(await adminEntries()).toBe(before);
  });
});
