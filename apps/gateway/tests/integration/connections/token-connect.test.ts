/**
 * A GitHub account connected with a fine-grained personal access token, end
 * to end inside the process (ADR one-place-to-authorize-services-token-first):
 * the real composition root on the `:memory:` store with the REAL encryptor,
 * the REAL GitHub plugin, and GitHub mocked by `mockFetch` (any other request
 * fails the test).
 *
 *   the token is the one way → pasted, checked at GitHub, stored sealed (the
 *   database is scanned for it) → a mission calls a tool with it → GitHub
 *   rejects the token → the account needs reconnecting → removing it asks
 *   GitHub nothing.
 */
import { createRegistry } from '@vaubaan/plugin-sdk';
import { mockFetch, type MockFetch } from '@vaubaan/plugin-sdk/testing';
import githubPlugin from '@vaubaan/plugin-github';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SESSION_COOKIE } from '../../../src/server/auth';
import { memoryStoreDeps } from '../../../src/server/compose/testing';
import { buildRoot, type GatewayRoot } from '../../../src/server/compose/root';
import { loadInstanceConfig } from '../../../src/server/config';
import { validEnv } from '../../../src/server/config/testing';
import { NOTICE_PARAM } from '../../../src/server/connections';

const PUBLIC_URL = 'https://gateway.example.com';
const PAT = 'github_pat_11AAAAAAA0PLAINTEXT_0123456789abcdefghijklmnopqrstuvwxyz';
const EXPIRES = '2027-01-15 10:30:00 UTC';

describe('a GitHub account connected with a token', () => {
  let root: GatewayRoot;
  let github: MockFetch;
  let rejectToken: boolean;

  beforeEach(async () => {
    rejectToken = false;
    github = mockFetch([
      {
        method: 'GET',
        url: 'https://api.github.com/user',
        headers: { 'github-authentication-token-expiration': EXPIRES },
        body: { login: 'acme-bot' },
      },
      {
        method: 'GET',
        url: 'https://api.github.com/user/repos?per_page=100&page=1',
        body: [{ full_name: 'acme/app', default_branch: 'main', private: true }],
      },
      {
        method: 'GET',
        url: 'https://api.github.com/repos/acme/app/branches',
        respond: () => (rejectToken ? { message: 'Bad credentials' } : [{ name: 'main' }]),
      },
    ]);
    root = await buildRoot({
      loadConfig: () => loadInstanceConfig({ env: validEnv({ VAUBAAN_PUBLIC_URL: PUBLIC_URL }) }),
      logWrite: () => undefined,
      buildRegistry: async () => createRegistry([githubPlugin]),
      providerFetch: async (input, init) => {
        const response = await github(input, init);
        // The branch route answers 401 once the token is "revoked at GitHub".
        if (rejectToken && String(input).endsWith('/branches')) {
          return new Response(await response.text(), { status: 401 });
        }
        return response;
      },
      ...memoryStoreDeps,
    });
  });
  afterEach(async () => {
    await root.close();
  });

  async function signIn(email: string) {
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
    return { user, cookie: `${SESSION_COOKIE}=${issued.id}`, sessionId: issued.id };
  }

  function post(path: string, cookie: string, fields: Record<string, string>): Request {
    return new Request(`${PUBLIC_URL}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        origin: PUBLIC_URL,
        cookie,
      },
      body: new URLSearchParams(fields).toString(),
    });
  }

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

  async function rpc(token: string, method: string, params: Record<string, unknown>) {
    const response = await root.execution.handlers.mcp(
      new Request(`${PUBLIC_URL}/mcp`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      }),
    );
    return (await response.json()) as {
      result?: { content?: Array<{ text: string }>; tools?: Array<{ name: string }> };
      error?: { message: string; data?: Record<string, unknown> };
    };
  }

  it('connects, runs a tool with the token, then needs reconnecting', async () => {
    const alice = await signIn('alice@example.com');

    // The token is the one way: nothing to declare first.
    const offered = await root.connections.service.provider('github');
    expect(offered).toMatchObject({ kind: 'api-key', redirects: false });

    // A classic token is refused by the field's shape, before GitHub is asked.
    const classic = await root.connections.handlers.connect(
      post('/accounts/connect/github', alice.cookie, {
        'field.token': 'ghp_0123456789abcdefghijklmnopqrstuvwxyzAB',
      }),
      'github',
    );
    expect(classic.status).toBe(303);
    expect(new URL(classic.headers.get('location') ?? '', PUBLIC_URL).pathname).toBe(
      '/accounts/new/github',
    );
    expect(github.calls).toHaveLength(0);

    const connected = await root.connections.handlers.connect(
      post('/accounts/connect/github', alice.cookie, {
        name: 'GitHub bot',
        'field.token': PAT,
      }),
      'github',
    );
    expect(connected.status).toBe(303);
    const landing = new URL(connected.headers.get('location') ?? '', PUBLIC_URL);
    const notice = await root.connections.notices.take(
      alice.sessionId,
      landing.searchParams.get(NOTICE_PARAM),
    );
    expect(notice?.tone).toBe('success');
    const [connection] = await root.store.connections.list();
    expect(connection).toMatchObject({
      provider: 'github',
      displayName: 'GitHub bot',
      status: 'active',
      credentialExpiresAt: '2027-01-15T10:30:00.000Z',
    });
    expect(connection?.metadata).toMatchObject({ credential_kind: 'api-key', account: 'acme-bot' });
    expect((await root.store.connections.listResources(connection!.id)).map((r) => r.ref)).toEqual([
      'acme/app',
    ]);
    expect(databaseDump()).not.toContain(PAT);
    for (const call of github.calls) expect(call.headers.authorization).toBe(`Bearer ${PAT}`);

    // A mission on it calls a tool with the token.
    const issued = await root.missions.service.issue(alice.user, {
      name: 'Read code',
      connections: [
        {
          connection_id: connection!.id,
          resources: { scope: 'all' },
          policy: [
            {
              risk_id: 'github.read-code',
              quota: 10,
              rate_limit: { max: 100, window_seconds: 60 },
              gate: 'auto',
            },
          ],
        },
      ],
      period: { kind: 'recurring', length_seconds: 86_400 },
      expires_at: null,
    });
    if (!issued.ok) throw new Error(`issue refused: ${JSON.stringify(issued)}`);
    const key = issued.token.secret;

    const listed = await rpc(key, 'tools/list', {});
    const names = (listed.result?.tools ?? []).map((t) => t.name);
    expect(names).toContain('github__list_branches');

    const branches = await rpc(key, 'tools/call', {
      name: 'github__list_branches',
      arguments: { owner: 'acme', repo: 'app' },
    });
    expect(branches.error).toBeUndefined();
    expect(JSON.parse(branches.result?.content?.[0]?.text ?? 'null')).toEqual([{ name: 'main' }]);

    // GitHub stops accepting the token (expired or deleted there): the account needs reconnecting.
    rejectToken = true;
    const rejected = await rpc(key, 'tools/call', {
      name: 'github__list_branches',
      arguments: { owner: 'acme', repo: 'app' },
    });
    expect(JSON.stringify(rejected)).toContain('connection-unavailable');
    expect((await root.store.connections.getById(connection!.id))?.status).toBe('expired');

    // Removing it asks GitHub nothing and says where to delete the token.
    const calls = github.calls.length;
    const revoked = await root.connections.service.revoke(
      { user: alice.user, groups: [] },
      connection!.id,
    );
    expect(revoked.providerGrant).toBe('manual');
    expect(github.calls).toHaveLength(calls);
    expect(root.connections.service.providerGrantOf(revoked).grant.byHand).toMatch(
      /Fine-grained tokens/,
    );
  });
});
