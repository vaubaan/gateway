/**
 * Upstream calls of the github plugin against `mockFetch` : installation
 * token minting (JWT → token), per-call scoping, Octokit dispatch with the
 * injected fetch, `UpstreamAuthError`, the mint tool and resource discovery.
 * No test ever reaches GitHub.
 */
import { describe, expect, test } from 'vitest';
import { decodeJwt, decodeProtectedHeader } from 'jose';

import { mockFetch } from '@vaubaan/plugin-sdk/testing';

import { buildAppJwt } from '../../src/app-install.ts';
import { installationTokenFor } from '../../src/credential.ts';
import { DISCOVERY_PAGE_SIZE, MINT_PERMISSIONS } from '../../src/execute.ts';
import { githubPlugin } from '../../src/index.ts';
import {
  APP_ID,
  MINT_URL,
  TEST_PRIVATE_KEY_PEM,
  appConfig,
  appRepo,
  connectionCtx,
  executeCtx,
  libRepo,
  mintRoute,
} from './fixtures.ts';

const text = (r: { content: readonly unknown[] }) => (r.content[0] as { text: string }).text;

describe('installation token — JWT → access_tokens', () => {
  test('signs an RS256 App JWT with iss = app id and a 9-minute lifetime', async () => {
    const now = new Date('2026-10-13T10:00:00Z');
    const jwt = await buildAppJwt({ appId: APP_ID, privateKeyPem: TEST_PRIVATE_KEY_PEM }, now);
    expect(decodeProtectedHeader(jwt).alg).toBe('RS256');
    const claims = decodeJwt(jwt);
    expect(claims.iss).toBe(APP_ID);
    expect(claims.iat).toBe(Math.floor(now.getTime() / 1000) - 30);
    expect(claims.exp! - claims.iat!).toBe(9 * 60);
  });

  test('POSTs the JWT as Bearer to the installation endpoint and returns the token', async () => {
    const fetch = mockFetch([mintRoute('ghs_mint')]);
    const minted = await installationTokenFor(connectionCtx(fetch));
    expect(minted.token).toBe('ghs_mint');
    expect(minted.expiresAt.toISOString()).toBe('2026-10-13T11:00:00.000Z');
    const call = fetch.calls[0]!;
    expect(call.method).toBe('POST');
    expect(call.url).toBe(MINT_URL);
    expect(call.headers.authorization).toMatch(/^Bearer /);
    expect(decodeJwt(call.headers.authorization!.slice('Bearer '.length)).iss).toBe(APP_ID);
    expect(call.body).toBeNull();
  });

  test('scopes the token to repositories and permissions when asked', async () => {
    const fetch = mockFetch([mintRoute()]);
    await installationTokenFor(connectionCtx(fetch), {
      repositories: ['app'],
      permissions: { contents: 'read' },
    });
    expect(fetch.calls[0]!.json).toEqual({
      repositories: ['app'],
      permissions: { contents: 'read' },
    });
  });

  test('un-escapes a one-line PEM pasted with literal \\n', async () => {
    const fetch = mockFetch([mintRoute()]);
    const ctx = connectionCtx(fetch, {
      appConfig: { ...appConfig, private_key: TEST_PRIVATE_KEY_PEM.replace(/\n/g, '\\n') },
    });
    await expect(installationTokenFor(ctx)).resolves.toMatchObject({ token: 'ghs_xxx' });
  });

  test('fails naming the missing app configuration key, before any call', async () => {
    const fetch = mockFetch([]);
    await expect(
      installationTokenFor(connectionCtx(fetch, { appConfig: { app_slug: 'x' } })),
    ).rejects.toThrow(/'app_id' is missing/);
    expect(fetch.calls).toHaveLength(0);
  });

  test('refuses a credential of another kind', async () => {
    const fetch = mockFetch([]);
    const ctx = connectionCtx(fetch, {
      credential: { kind: 'api-key', fields: { token: 'ghp_x' }, metadata: {} },
    });
    await expect(installationTokenFor(ctx)).rejects.toMatchObject({
      name: 'CredentialKindMismatch',
    });
  });

  test('401 on the mint becomes UpstreamAuthError ; other failures are plain errors', async () => {
    const denied = mockFetch([
      { method: 'POST', url: MINT_URL, status: 401, body: { message: 'Bad credentials' } },
    ]);
    await expect(installationTokenFor(connectionCtx(denied))).rejects.toMatchObject({
      name: 'UpstreamAuthError',
      upstreamStatus: 401,
    });
    const missing = mockFetch([{ method: 'POST', url: MINT_URL, status: 404, body: 'Not Found' }]);
    await expect(installationTokenFor(connectionCtx(missing))).rejects.toThrow(/404/);
  });
});

describe('execute — Octokit over the injected fetch', () => {
  test('mints a token scoped to the named repository, then calls the REST API with it', async () => {
    const fetch = mockFetch([
      mintRoute('ghs_call'),
      {
        method: 'GET',
        url: 'https://api.github.com/repos/acme/app/branches',
        body: [{ name: 'main' }],
      },
    ]);
    const result = await githubPlugin.execute(executeCtx(fetch), 'github__list_branches', {
      owner: 'acme',
      repo: 'app',
    });
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(text(result))).toEqual([{ name: 'main' }]);
    expect(fetch.calls[0]!.json).toEqual({ repositories: ['app'] });
    expect(fetch.calls[1]!.headers.authorization).toContain('ghs_call');
  });

  test('account-shaped tools (search) get an installation-wide token', async () => {
    const fetch = mockFetch([
      mintRoute(),
      { method: 'GET', url: /\/search\/code\?q=foo$/, body: { total_count: 0, items: [] } },
    ]);
    await githubPlugin.execute(executeCtx(fetch), 'github__search_code', { q: 'foo' });
    expect(fetch.calls[0]!.body).toBeNull();
  });

  test('a write carries the JSON body GitHub expects', async () => {
    const fetch = mockFetch([
      mintRoute(),
      {
        method: 'POST',
        url: /\/repos\/acme\/app\/pulls$/,
        status: 201,
        respond: (c) => ({ number: 7, got: c.json }),
      },
    ]);
    const result = await githubPlugin.execute(executeCtx(fetch), 'github__create_pull_request', {
      owner: 'acme',
      repo: 'app',
      title: 'T',
      head: 'feature/x',
      base: 'main',
    });
    expect(JSON.parse(text(result))).toMatchObject({
      number: 7,
      got: { title: 'T', head: 'feature/x', base: 'main', draft: false },
    });
  });

  test('401 / 403 from GitHub become UpstreamAuthError', async () => {
    const fetch = mockFetch([
      mintRoute(),
      {
        method: 'GET',
        url: /\/branches$/,
        status: 403,
        body: { message: 'Resource not accessible' },
      },
    ]);
    await expect(
      githubPlugin.execute(executeCtx(fetch), 'github__list_branches', {
        owner: 'acme',
        repo: 'app',
      }),
    ).rejects.toMatchObject({ name: 'UpstreamAuthError', upstreamStatus: 403 });
  });

  test('an unknown tool fails after the mint, as a plain error', async () => {
    const fetch = mockFetch([mintRoute()]);
    await expect(
      githubPlugin.execute(executeCtx(fetch), 'github__nonsense', { owner: 'acme', repo: 'app' }),
    ).rejects.toThrow(/Unknown GitHub MCP tool/);
  });
});

describe('execute — github__mint_install_token', () => {
  test('purpose=clone, no repoFullName → token over every GitHub resource of the mission, contents:read', async () => {
    const fetch = mockFetch([
      {
        method: 'POST',
        url: MINT_URL,
        body: {
          token: 'ghs_scoped',
          expires_at: '2026-10-13T11:00:00Z',
          repositories: [{ id: 1, name: 'app', full_name: 'acme/app' }],
          permissions: { contents: 'read' },
        },
      },
    ]);
    const result = await githubPlugin.execute(
      executeCtx(fetch, [appRepo, libRepo]),
      'github__mint_install_token',
      { purpose: 'clone' },
    );
    expect(fetch.calls[0]!.json).toEqual({
      repositories: ['app', 'lib'],
      permissions: MINT_PERMISSIONS.clone,
    });
    expect(JSON.parse(text(result))).toEqual({
      token: 'ghs_scoped',
      expires_at: '2026-10-13T11:00:00.000Z',
      repositories: [{ id: 1, name: 'app', full_name: 'acme/app' }],
      permissions: { contents: 'read' },
    });
  });

  test('purpose=push with repoFullName → that repository only, write permission set', async () => {
    const fetch = mockFetch([mintRoute()]);
    await githubPlugin.execute(
      executeCtx(fetch, [appRepo, libRepo]),
      'github__mint_install_token',
      {
        purpose: 'push',
        repoFullName: 'acme/lib',
      },
    );
    expect(fetch.calls[0]!.json).toEqual({
      repositories: ['lib'],
      permissions: {
        contents: 'write',
        pull_requests: 'write',
        metadata: 'read',
        workflows: 'write',
      },
    });
  });

  test('refuses a repository outside the mission, an unknown purpose and a mission without repository — before any call', async () => {
    const fetch = mockFetch([]);
    const ctx = executeCtx(fetch);
    await expect(
      githubPlugin.execute(ctx, 'github__mint_install_token', {
        purpose: 'clone',
        repoFullName: 'other/repo',
      }),
    ).rejects.toThrow(/not a GitHub resource of this mission/);
    await expect(
      githubPlugin.execute(ctx, 'github__mint_install_token', { purpose: 'merge' }),
    ).rejects.toThrow(/purpose in \['clone','push'\]/);
    await expect(
      githubPlugin.execute(executeCtx(fetch, []), 'github__mint_install_token', {
        purpose: 'clone',
      }),
    ).rejects.toThrow(/touches no GitHub repository/);
    expect(fetch.calls).toHaveLength(0);
  });
});

describe('discoverResources — installation repositories, paged', () => {
  const repoDto = (i: number) => ({
    full_name: `acme/repo-${i}`,
    default_branch: 'main',
    private: i % 2 === 0,
    archived: false,
  });
  const pageUrl = (page: number) =>
    `https://api.github.com/installation/repositories?per_page=${DISCOVERY_PAGE_SIZE}&page=${page}`;

  test('maps repositories to resources with non-secret metadata', async () => {
    const fetch = mockFetch([
      mintRoute(),
      {
        method: 'GET',
        url: pageUrl(1),
        body: { total_count: 2, repositories: [repoDto(1), { full_name: 'acme/bare' }] },
      },
    ]);
    const resources = await githubPlugin.discoverResources(connectionCtx(fetch));
    expect(resources).toEqual([
      {
        provider: 'github',
        ref: 'acme/repo-1',
        displayName: 'acme/repo-1',
        metadata: { default_branch: 'main', private: false, archived: false },
      },
      { provider: 'github', ref: 'acme/bare', displayName: 'acme/bare', metadata: {} },
    ]);
    expect(fetch.calls[1]!.headers.authorization).toBe('Bearer ghs_xxx');
    expect(fetch.calls).toHaveLength(2);
  });

  test('follows pages until the total is reached', async () => {
    const first = Array.from({ length: DISCOVERY_PAGE_SIZE }, (_, i) => repoDto(i));
    const fetch = mockFetch([
      mintRoute(),
      {
        method: 'GET',
        url: pageUrl(1),
        body: { total_count: DISCOVERY_PAGE_SIZE + 1, repositories: first },
        times: 1,
      },
      {
        method: 'GET',
        url: pageUrl(2),
        body: { total_count: DISCOVERY_PAGE_SIZE + 1, repositories: [repoDto(999)] },
        times: 1,
      },
    ]);
    const resources = await githubPlugin.discoverResources(connectionCtx(fetch));
    expect(resources).toHaveLength(DISCOVERY_PAGE_SIZE + 1);
    expect(resources.at(-1)!.ref).toBe('acme/repo-999');
    expect(fetch.pending()).toEqual([]);
  });

  test('401 on the listing becomes UpstreamAuthError', async () => {
    const fetch = mockFetch([
      mintRoute(),
      { method: 'GET', url: pageUrl(1), status: 401, body: {} },
    ]);
    await expect(githubPlugin.discoverResources(connectionCtx(fetch))).rejects.toMatchObject({
      name: 'UpstreamAuthError',
      upstreamStatus: 401,
    });
  });
});
