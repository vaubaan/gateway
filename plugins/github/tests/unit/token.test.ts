/**
 * The token way of connecting GitHub (`token.ts`) against `mockFetch` : the
 * check at paste, discovery through `/user/repos`, every API tool with the
 * pasted token as bearer, and `github__mint_install_token` refused.
 */
import { describe, expect, test } from 'vitest';

import { UpstreamAuthError, credentialSpecFor, unavailableToolReason } from '@vaubaan/plugin-sdk';
import { mockFetch } from '@vaubaan/plugin-sdk/testing';

import githubPlugin, {
  expiryOf,
  githubTokenCredential,
  verifyGithubToken,
} from '../../src/index.ts';
import { appRepo, connectionCtx, executeCtx } from './fixtures.ts';

const PAT = 'github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz';
const tokenCredential = { kind: 'api-key' as const, fields: { token: PAT }, metadata: {} };

describe('github token — the declaration', () => {
  test('the plugin connects through the App first, then with a fine-grained token', () => {
    expect(githubPlugin.credential.kind).toBe('app-install');
    expect(credentialSpecFor(githubPlugin, 'api-key')).toBe(githubTokenCredential);
  });

  test('only fine-grained tokens match the field', () => {
    const pattern = new RegExp(githubTokenCredential.fields[0]!.pattern!);
    expect(pattern.test(PAT)).toBe(true);
    expect(pattern.test('ghp_0123456789abcdefghijklmnopqrstuvwxyzAB')).toBe(false);
    expect(pattern.test('github_pat_short')).toBe(false);
  });

  test('mint_install_token needs the App; every other tool runs with a token', () => {
    expect(unavailableToolReason(githubPlugin, 'api-key', 'github__mint_install_token')).toMatch(
      /^needs the GitHub App/,
    );
    for (const tool of githubPlugin.tools) {
      if (tool.name === 'github__mint_install_token') continue;
      expect(unavailableToolReason(githubPlugin, 'api-key', tool.name)).toBeNull();
    }
    expect(
      unavailableToolReason(githubPlugin, 'app-install', 'github__mint_install_token'),
    ).toBeNull();
  });
});

describe('github token — verify at paste', () => {
  test('names the account and reads the expiry header', async () => {
    const fetch = mockFetch([
      {
        method: 'GET',
        url: 'https://api.github.com/user',
        headers: { 'github-authentication-token-expiration': '2026-12-31 00:00:00 UTC' },
        body: { login: 'acme-bot' },
      },
    ]);
    const check = await verifyGithubToken(connectionCtx(fetch, { credential: tokenCredential }));
    expect(check).toEqual({ account: 'acme-bot', expiresAt: '2026-12-31T00:00:00.000Z' });
    expect(fetch.calls[0]!.headers.authorization).toBe(`Bearer ${PAT}`);
  });

  test('no expiry header: the expiry is not said', async () => {
    const fetch = mockFetch([
      { method: 'GET', url: 'https://api.github.com/user', body: { login: 'acme-bot' } },
    ]);
    const check = await verifyGithubToken(connectionCtx(fetch, { credential: tokenCredential }));
    expect(check.expiresAt).toBeNull();
  });

  test('a rejected token is an UpstreamAuthError', async () => {
    const fetch = mockFetch([
      {
        method: 'GET',
        url: 'https://api.github.com/user',
        status: 401,
        body: { message: 'Bad credentials' },
      },
    ]);
    await expect(
      verifyGithubToken(connectionCtx(fetch, { credential: tokenCredential })),
    ).rejects.toBeInstanceOf(UpstreamAuthError);
  });

  test('an unreadable expiry is not guessed', () => {
    expect(expiryOf('soon')).toBeNull();
    expect(expiryOf(null)).toBeNull();
    expect(expiryOf('2027-01-15 10:30:00 UTC')).toBe('2027-01-15T10:30:00.000Z');
  });
});

describe('github token — discovery and execution', () => {
  test('resources are the repositories the token reaches', async () => {
    const fetch = mockFetch([
      {
        method: 'GET',
        url: 'https://api.github.com/user/repos?per_page=100&page=1',
        body: [
          { full_name: 'acme/app', default_branch: 'main', private: true, archived: false },
          { full_name: 'acme/lib' },
        ],
      },
    ]);
    const resources = await githubPlugin.discoverResources(
      connectionCtx(fetch, { credential: tokenCredential }),
    );
    expect(resources.map((r) => r.ref)).toEqual(['acme/app', 'acme/lib']);
    expect(fetch.calls).toHaveLength(1);
    expect(fetch.calls[0]!.headers.authorization).toBe(`Bearer ${PAT}`);
  });

  test('an API tool sends the pasted token and mints nothing', async () => {
    const fetch = mockFetch([
      {
        method: 'GET',
        url: 'https://api.github.com/repos/acme/app/branches',
        body: [{ name: 'main' }],
      },
    ]);
    const result = await githubPlugin.execute(
      executeCtx(fetch, [appRepo], { credential: tokenCredential }),
      'github__list_branches',
      { owner: 'acme', repo: 'app' },
    );
    expect(result.isError).toBeUndefined();
    expect(fetch.calls).toHaveLength(1);
    expect(fetch.calls[0]!.headers.authorization).toContain(PAT);
  });

  test('a 401 on the token is a rejected credential (the host then expires the account)', async () => {
    const fetch = mockFetch([
      {
        method: 'GET',
        url: 'https://api.github.com/repos/acme/app/branches',
        status: 401,
        body: { message: 'Bad credentials' },
      },
    ]);
    await expect(
      githubPlugin.execute(
        executeCtx(fetch, [appRepo], { credential: tokenCredential }),
        'github__list_branches',
        {
          owner: 'acme',
          repo: 'app',
        },
      ),
    ).rejects.toMatchObject({ upstreamStatus: 401 });
  });

  test('mint_install_token on a token connection is declined: it needs the App', async () => {
    const fetch = mockFetch([]);
    const result = await githubPlugin.execute(
      executeCtx(fetch, [appRepo], { credential: tokenCredential }),
      'github__mint_install_token',
      { purpose: 'clone' },
    );
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toMatch(/needs the GitHub App/);
    expect(fetch.calls).toHaveLength(0);
  });
});
