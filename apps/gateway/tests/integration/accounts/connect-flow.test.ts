/**
 * Accounts end to end inside the process (spec §10 "integration on an
 * ephemeral instance with embedded store"): the composition root over the
 * `:memory:` store with the REAL encryptor, a fixture plugin registry, a
 * mocked service (`mockFetch`, which rejects any other request), and the
 * host-agnostic handlers driven with web-standard `Request`s.
 *
 *   the gateway registers its OAuth client → user connects → the account
 *   row and the client secret are encrypted (the database is scanned for every secret in clear) →
 *   resources are discovered → owner edits survive a refresh → revoke →
 *   state `revoked`.
 */
import { createRegistry, type Resource } from '@vaubaan/plugin-sdk';
import { mockFetch, type MockFetch } from '@vaubaan/plugin-sdk/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SESSION_COOKIE } from '../../../src/server/auth';
import { memoryStoreDeps } from '../../support/compose/testing';
import { buildRoot, type GatewayRoot } from '../../../src/server/compose/root';
import { loadInstanceConfig } from '../../../src/server/config';
import { validEnv } from '../../support/config/testing';
import { NOTICE_PARAM, parseSecret } from '../../../src/server/accounts';
import {
  API_KEY_SPEC,
  fixturePlugin,
  OAUTH_SPEC,
  SSH_KEY_SPEC,
} from '../../support/accounts/testing';
import { registeredClientKey } from '../../../src/server/accounts/oauth2-clients';
import { agePastStaleGrace } from '../../support/store/testing';

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

describe('accounts: registered client, connect, resources, revoke', () => {
  let root: GatewayRoot;
  let service: MockFetch;
  let upstream: Resource[];
  let logLines: string[];

  beforeEach(async () => {
    logLines = [];
    upstream = [
      { service: 'oauthco', ref: 'proj-a', displayName: 'Project A' },
      { service: 'oauthco', ref: 'proj-b', displayName: 'Project B' },
    ];
    service = mockFetch([
      {
        method: 'POST',
        url: OAUTH_SPEC.clientRegistration.registrationUrl,
        status: 201,
        body: {
          client_id: 'company-client-id',
          client_secret: CLIENT_SECRET,
          token_endpoint_auth_method: 'client_secret_basic',
          redirect_uris: [`${PUBLIC_URL}/connections/callback/oauthco`],
        },
        times: 1,
      },
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
      logWrite: (_level, line) => logLines.push(line),
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
              { service: 'keyco', ref: 'acct:live', env: 'live', displayName: 'Acme (live)' },
            ],
          }),
          fixturePlugin({ id: 'sshco', credential: SSH_KEY_SPEC }),
        ]),
      serviceFetch: service,
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
    return root.accounts.notices.take(
      session.sessionId,
      location(res).searchParams.get(NOTICE_PARAM),
    );
  }

  /** Every value of every table, as text, to look for a secret stored in clear. */
  function databaseDump(): string {
    const { db } = root.store;
    const tables = db
      .prepare<[], { name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
      )
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

  it('runs the whole OAuth path: client registered, account encrypted, resources curated, revoked', async () => {
    const alice = await signIn('alice@example.com');
    const handlers = root.accounts.handlers;

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
    const accountId = target.pathname.split('/').pop()!;
    expect(target.pathname).toBe(`/accounts/${accountId}`);
    // The URL carries an opaque notice id, never a message.
    expect([...target.searchParams.keys()]).toEqual([NOTICE_PARAM]);
    expect(await noticeOf(landed, alice)).toMatchObject({ tone: 'success', title: 'Connected' });
    expect(await noticeOf(landed, alice)).toBeNull(); // read once

    // The gateway registered its client first, then exchanged with it, the redirect URI on public_url.
    expect(service.calls[0]!.url).toBe(OAUTH_SPEC.clientRegistration.registrationUrl);
    const exchange = service.calls[1]!;
    expect(exchange.headers.authorization).toBe(
      `Basic ${Buffer.from(`company-client-id:${CLIENT_SECRET}`).toString('base64')}`,
    );
    expect(new URLSearchParams(exchange.body ?? '').get('redirect_uri')).toBe(
      `${PUBLIC_URL}/connections/callback/oauthco`,
    );

    // ── The account row is encrypted ─────────────────────────────────────
    const row = root.store.db
      .prepare<
        [string],
        { credential_blob: Buffer; key_version: number; status: string; owner_user_id: string }
      >('SELECT credential_blob, key_version, status, owner_user_id FROM accounts WHERE id = ?')
      .get(accountId)!;
    expect(row).toMatchObject({ status: 'active', owner_user_id: alice.userId, key_version: 1 });
    expect(row.credential_blob[0]).toBe(0x01); // AEAD blob version byte
    expect(row.credential_blob.includes(Buffer.from(ACCESS_TOKEN))).toBe(false);
    expect(row.credential_blob.includes(Buffer.from('accessToken'))).toBe(false);
    const dump = databaseDump();
    for (const secret of [ACCESS_TOKEN, REFRESH_TOKEN, CLIENT_SECRET]) {
      expect(dump).not.toContain(secret);
    }
    // The registered client's secret is sealed like any other secret.
    expect(await root.store.config.get(registeredClientKey('oauthco', 'client_secret'))).toBeNull();
    expect(await root.store.config.getSecret(registeredClientKey('oauthco', 'client_secret'))).toBe(
      CLIENT_SECRET,
    );
    expect(dump).toContain('company-client-id'); // the dump does see clear values
    // Only the instance, with the master key and the account id, opens it.
    expect(parseSecret((await root.store.accounts.getCredential(accountId))!)).toMatchObject({
      kind: 'oauth2',
      accessToken: ACCESS_TOKEN,
      refreshToken: REFRESH_TOKEN,
    });
    await expect(
      root.encryptor.decrypt('another-account-id', {
        keyVersion: row.key_version,
        blob: row.credential_blob,
      }),
    ).rejects.toThrow();

    // ── Resources discovered, curated by the owner ──────────────────────────
    const discovered = await root.store.accounts.listResources(accountId);
    expect(discovered.map((r) => [r.ref, r.displayName, r.env])).toEqual([
      ['proj-a', 'Project A', null],
      ['proj-b', 'Project B', null],
    ]);
    const edited = await handlers.updateResource(
      post(`/accounts/${accountId}/resources/${discovered[0]!.id}`, alice, {
        display_name: 'Main project',
        env: 'prod',
        hidden_present: '1',
      }),
      accountId,
      discovered[0]!.id,
    );
    expect(await noticeOf(edited, alice)).toMatchObject({ title: 'Resource saved' });

    upstream = [
      { service: 'oauthco', ref: 'proj-a', displayName: 'Project A (renamed upstream)' },
      { service: 'oauthco', ref: 'proj-c', displayName: 'Project C' },
    ];
    agePastStaleGrace(root.store, accountId); // proj-b was seen long ago
    const refreshed = await handlers.discover(
      post(`/accounts/${accountId}/discover`, alice),
      accountId,
    );
    expect(await noticeOf(refreshed, alice)).toMatchObject({ title: 'Refreshed' });
    const curated = await root.store.accounts.listResources(accountId);
    expect(curated.map((r) => [r.ref, r.displayName, r.env, r.staleSince !== null])).toEqual([
      ['proj-a', 'Main project', 'prod', false],
      ['proj-b', 'Project B', null, true],
      ['proj-c', 'Project C', null, false],
    ]);

    // ── Replay, strangers, cross-origin ─────────────────────────────────────
    const replay = await handlers.callback(get(callbackQuery, alice), 'oauthco');
    expect(location(replay).pathname).toBe('/accounts');
    expect((await noticeOf(replay, alice))?.lines[0]).toContain('already used');
    expect(service.calls).toHaveLength(2); // the registration and the one exchange
    expect(await root.store.accounts.list()).toHaveLength(1);

    const bob = await signIn('bob@example.com');
    const stranger = await handlers.revoke(post(`/accounts/${accountId}/revoke`, bob), accountId);
    expect((await noticeOf(stranger, bob))?.title).toBe('Not disconnected');
    const crossOrigin = await handlers.revoke(
      post(`/accounts/${accountId}/revoke`, alice, {}, 'https://evil.example.net'),
      accountId,
    );
    expect(crossOrigin.status).toBe(403);
    expect((await root.store.accounts.getById(accountId))!.status).toBe('active');

    // ── Revoke ──────────────────────────────────────────────────────────────
    const revoked = await handlers.revoke(post(`/accounts/${accountId}/revoke`, alice), accountId);
    expect(location(revoked).pathname).toBe(`/accounts/${accountId}`);
    // This service documents no revocation endpoint: the person is told, as a warning,
    // that the access still stands there and is theirs to remove.
    const told = await noticeOf(revoked, alice);
    expect(told).toMatchObject({ tone: 'warning', title: 'Account disconnected' });
    expect(told?.lines[1]).toMatch(/^Still granted at .+\. The gateway did not withdraw /);
    const after = root.store.db
      .prepare<
        [string],
        { status: string; credential_blob: Buffer | null; revoked_at: string | null }
      >('SELECT status, credential_blob, revoked_at FROM accounts WHERE id = ?')
      .get(accountId)!;
    expect(after.status).toBe('revoked');
    expect(after.credential_blob).toBeNull();
    expect(after.revoked_at).not.toBeNull();
    await expect(root.accounts.credentials.resolve(accountId)).rejects.toMatchObject({
      accountStatus: 'revoked',
    });
    // The resources stay: missions and the audit still name them.
    expect(await root.store.accounts.listResources(accountId)).toHaveLength(3);

    expect(
      (await root.store.audit.list({ kind: 'admin' })).map((e) =>
        e.kind === 'admin' ? e.act : null,
      ),
    ).toEqual([
      // The boot applied the configuration's admin rule while the store named nobody.
      'administrators-seeded',
      'account-created',
      'resource-edited',
      'resources-discovered',
      'account-revoked',
    ]);
  });

  it('a refused form comes back as it was typed — never the secret — with the field in error named', async () => {
    const alice = await signIn('alice@example.com');
    const refused = await root.accounts.handlers.connect(
      post('/accounts/connect/keyco', alice, {
        name: 'Acme sandbox',
        'field.token': API_KEY,
        'field.team_id': 'not a team id',
        return_to: '/missions/new',
      }),
      'keyco',
    );
    // Back on the same form, and still on the way to where the person came from.
    const back = location(refused);
    expect(back.pathname).toBe('/accounts/new/keyco');
    expect(back.searchParams.get('return_to')).toBe('/missions/new');
    const notice = await noticeOf(refused, alice);
    expect(notice).toMatchObject({ tone: 'danger', title: 'Not connected' });
    expect(notice?.form).toEqual({
      name: 'Acme sandbox',
      values: { team_id: 'not a team id' },
      invalid: { team_id: 'format' },
    });
    // The key was typed; it is in nothing that is kept between the two requests.
    expect(JSON.stringify(notice)).not.toContain(API_KEY);
    expect(await root.store.accounts.list()).toEqual([]);
  });

  it('stores an API key and an SSH private key encrypted, and marks plugin-set labels', async () => {
    const alice = await signIn('alice@example.com');
    const handlers = root.accounts.handlers;

    const keyRes = await handlers.connect(
      post('/accounts/connect/keyco', alice, {
        'field.token': API_KEY,
        'field.team_id': 'team_acme',
      }),
      'keyco',
    );
    const keyId = location(keyRes).pathname.split('/').pop()!;
    expect(await noticeOf(keyRes, alice)).toMatchObject({ tone: 'success' });
    expect(await root.store.accounts.listResources(keyId)).toMatchObject([
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
    const sshSecret = parseSecret((await root.store.accounts.getCredential(sshId))!);
    if (sshSecret.kind !== 'ssh-key') throw new Error('expected an ssh-key secret');
    const privateKeyLine = sshSecret.privateKeyPem.split('\n')[2]!;

    const dump = databaseDump();
    expect(dump).not.toContain(API_KEY);
    expect(dump).not.toContain(privateKeyLine);
    expect(dump).toContain('team_acme'); // non-secret field, kept in clear for display
    expect(dump).toContain(sshSecret.publicKey); // the public key is shown to the owner

    // Editing a plugin-set label is refused; the row is unchanged.
    const live = (await root.store.accounts.listResources(keyId))[0]!;
    const refused = await handlers.updateResource(
      post(`/accounts/${keyId}/resources/${live.id}`, alice, { env: 'test' }),
      keyId,
      live.id,
    );
    expect((await noticeOf(refused, alice))?.lines[0]).toContain('set by the service');
    expect((await root.store.accounts.getResource(live.id))!.env).toBe('live');
  });

  it('guards every entry point: session, origin, bootstrap operator, foreign return URL', async () => {
    const alice = await signIn('alice@example.com');
    const bootstrap = await bootstrapSession();
    const handlers = root.accounts.handlers;

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

    // The service's redirect arriving without a session goes to sign-in.
    const anonymous = await handlers.callback(
      get('/connections/callback/oauthco?code=c&state=s', null),
      'oauthco',
    );
    expect(location(anonymous).pathname).toBe('/login');

    const foreign = await handlers.connect(
      post('/accounts/connect/oauthco', alice, { return_to: 'https://evil.example.net/x' }),
      'oauthco',
    );
    expect(location(foreign).origin).toBe(PUBLIC_URL);
    expect(location(foreign).pathname).toBe('/accounts/new/oauthco');
    expect((await noticeOf(foreign, alice))?.lines[0]).toContain('outside this gateway');

    const unknown = await handlers.connect(post('/accounts/connect/nope', alice), 'nope');
    expect(location(unknown).pathname).toBe('/accounts/new');

    // A notice belongs to the session it was written for.
    const again = await handlers.connect(post('/accounts/connect/nope', alice), 'nope');
    const bob = await signIn('bob@example.com');
    expect(await noticeOf(again, bob)).toBeNull();
    expect(await noticeOf(again, alice)).not.toBeNull();

    expect(await root.store.accounts.list()).toEqual([]);
    expect(service.calls).toHaveLength(0);
  });
});
