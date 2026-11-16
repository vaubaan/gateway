/**
 * The fine-grained token of GitHub (`credential.ts`) against `mockFetch` :
 * the check at paste, discovery of the account's one repository (and the
 * former `/user/repos` listing of an account without one), every API tool
 * with the pasted token as bearer.
 */
import { describe, expect, test } from 'vitest';

import { CredentialRefusal, UpstreamAuthError, UpstreamProtocolError } from '@vaubaan/plugin-sdk';
import { mockFetch } from '@vaubaan/plugin-sdk/testing';

import githubPlugin, {
  expiryOf,
  GITHUB_REPOSITORY_FIELD,
  githubCredential,
  verifyGithubToken,
} from '../../src/index.ts';
import {
  PAT,
  appRepo,
  accountCtx,
  executeCtx,
  repoCredential,
  tokenCredential,
} from './fixtures.ts';

const APP_REPO_URL = 'https://api.github.com/repos/acme/app';

describe('github token — the declaration', () => {
  test('the plugin connects with a fine-grained token, the one way', () => {
    expect(githubPlugin.credential).toBe(githubCredential);
    expect(githubCredential.kind).toBe('api-key');
  });

  test('only fine-grained tokens match the field', () => {
    const pattern = new RegExp(githubCredential.fields[0]!.pattern!);
    expect(pattern.test(PAT)).toBe(true);
    expect(pattern.test('ghp_0123456789abcdefghijklmnopqrstuvwxyzAB')).toBe(false);
    expect(pattern.test('github_pat_short')).toBe(false);
  });

  test('the form names the one repository of the account, owner/repo', () => {
    const field = githubCredential.fields.find((f) => f.name === GITHUB_REPOSITORY_FIELD)!;
    expect(field.secret).toBe(false);
    expect(field.required).not.toBe(false);
    const pattern = new RegExp(field.pattern!);
    expect(pattern.test('acme/app')).toBe(true);
    expect(pattern.test('acme-org/my.repo_2')).toBe(true);
    for (const wrong of ['acme', 'acme/', '/app', 'acme/app/x', 'https://github.com/acme/app']) {
      expect(pattern.test(wrong)).toBe(false);
    }
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
    const check = await verifyGithubToken(accountCtx(fetch, { credential: tokenCredential }));
    expect(check).toEqual({ account: 'acme-bot', expiresAt: '2026-12-31T00:00:00.000Z' });
    expect(fetch.calls[0]!.headers.authorization).toBe(`Bearer ${PAT}`);
  });

  test('no expiry header: the expiry is not said', async () => {
    const fetch = mockFetch([
      { method: 'GET', url: 'https://api.github.com/user', body: { login: 'acme-bot' } },
    ]);
    const check = await verifyGithubToken(accountCtx(fetch, { credential: tokenCredential }));
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
      verifyGithubToken(accountCtx(fetch, { credential: tokenCredential })),
    ).rejects.toBeInstanceOf(UpstreamAuthError);
  });

  test('a token GitHub forbids (403) is an UpstreamAuthError too', async () => {
    const fetch = mockFetch([
      { method: 'GET', url: 'https://api.github.com/user', status: 403, body: { message: 'no' } },
    ]);
    await expect(
      verifyGithubToken(accountCtx(fetch, { credential: tokenCredential })),
    ).rejects.toBeInstanceOf(UpstreamAuthError);
  });

  test('an answer that is not a JSON object is GitHub failing', async () => {
    for (const body of ['<html>maintenance</html>', [{ login: 'acme-bot' }]]) {
      const fetch = mockFetch([{ method: 'GET', url: 'https://api.github.com/user', body }]);
      await expect(
        verifyGithubToken(accountCtx(fetch, { credential: tokenCredential })),
      ).rejects.toBeInstanceOf(UpstreamProtocolError);
    }
  });

  test('with a repository: the token must open it', async () => {
    const fetch = mockFetch([
      { method: 'GET', url: 'https://api.github.com/user', body: { login: 'acme-bot' } },
      { method: 'GET', url: APP_REPO_URL, body: { full_name: 'acme/app', private: true } },
    ]);
    const check = await verifyGithubToken(accountCtx(fetch, { credential: repoCredential }));
    expect(check.account).toBe('acme-bot');
    expect(fetch.calls.map((c) => c.url)).toEqual(['https://api.github.com/user', APP_REPO_URL]);
    expect(fetch.calls[1]!.headers.authorization).toBe(`Bearer ${PAT}`);
  });

  test('a repository the token does not open (404) is refused with what to change', async () => {
    const fetch = mockFetch([
      { method: 'GET', url: 'https://api.github.com/user', body: { login: 'acme-bot' } },
      { method: 'GET', url: APP_REPO_URL, status: 404, body: { message: 'Not Found' } },
    ]);
    const check = verifyGithubToken(accountCtx(fetch, { credential: repoCredential }));
    await expect(check).rejects.toBeInstanceOf(CredentialRefusal);
    await expect(check).rejects.toThrow(/does not open the repository acme\/app/);
  });

  test('an unreadable expiry is not guessed', () => {
    expect(expiryOf('soon')).toBeNull();
    expect(expiryOf(null)).toBeNull();
    expect(expiryOf('2027-01-15 10:30:00 UTC')).toBe('2027-01-15T10:30:00.000Z');
  });
});

describe('github token — discovery and execution', () => {
  test("the resource is the one repository of the account, in GitHub's spelling, never hidden", async () => {
    const fetch = mockFetch([
      {
        method: 'GET',
        url: APP_REPO_URL,
        // A public repository, spelled by GitHub: the owner named it, it is not hidden.
        body: { full_name: 'Acme/App', default_branch: 'trunk', private: false, archived: false },
      },
    ]);
    const resources = await githubPlugin.discoverResources(
      accountCtx(fetch, { credential: repoCredential }),
    );
    expect(resources).toEqual([
      {
        service: 'github',
        ref: 'Acme/App',
        displayName: 'Acme/App',
        metadata: { default_branch: 'trunk', private: false, archived: false },
        hiddenByDefault: false,
      },
    ]);
    expect(fetch.calls).toHaveLength(1);
    expect(fetch.calls[0]!.headers.authorization).toBe(`Bearer ${PAT}`);
  });

  test('a repository gone since the paste (404) is refused, not an empty account', async () => {
    const fetch = mockFetch([
      { method: 'GET', url: APP_REPO_URL, status: 404, body: { message: 'Not Found' } },
    ]);
    await expect(
      githubPlugin.discoverResources(accountCtx(fetch, { credential: repoCredential })),
    ).rejects.toBeInstanceOf(CredentialRefusal);
  });

  test('an account without a repository keeps the repositories the token reaches', async () => {
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
      accountCtx(fetch, { credential: tokenCredential }),
    );
    expect(resources.map((r) => r.ref)).toEqual(['acme/app', 'acme/lib']);
    expect(fetch.calls).toHaveLength(1);
    expect(fetch.calls[0]!.headers.authorization).toBe(`Bearer ${PAT}`);
  });

  test('an API tool sends the pasted token', async () => {
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
});
