/**
 * Upstream calls of the github plugin against `mockFetch` : Octokit dispatch
 * with the injected fetch and the account's token as bearer,
 * `UpstreamAuthError`, and resource discovery. No test ever reaches GitHub.
 */
import { describe, expect, test } from 'vitest';

import { UpstreamProtocolError } from '@vaubaan/plugin-sdk';
import { mockFetch, refusalText } from '@vaubaan/plugin-sdk/testing';

import { DISCOVERY_PAGE_SIZE } from '../../src/execute.ts';
import { TOOL, githubPlugin } from '../../src/index.ts';
import { PAT, accountCtx, executeCtx } from './fixtures.ts';

const text = (r: { content: readonly unknown[] }) => (r.content[0] as { text: string }).text;

describe('execute — Octokit over the injected fetch', () => {
  test('calls the REST API with the account token as bearer', async () => {
    const fetch = mockFetch([
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
    expect(fetch.calls).toHaveLength(1);
    expect(fetch.calls[0]!.headers.authorization).toBe(`token ${PAT}`);
  });

  test('account-shaped tools (search) send the same token', async () => {
    const fetch = mockFetch([
      { method: 'GET', url: /\/search\/code\?q=foo$/, body: { total_count: 0, items: [] } },
    ]);
    await githubPlugin.execute(executeCtx(fetch), 'github__search_code', { q: 'foo' });
    expect(fetch.calls[0]!.headers.authorization).toBe(`token ${PAT}`);
  });

  test('a write carries the JSON body GitHub expects', async () => {
    const fetch = mockFetch([
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

  test('an unknown tool fails as a plain error, before any call', async () => {
    const fetch = mockFetch([]);
    expect(
      await refusalText(
        githubPlugin.execute(executeCtx(fetch), 'github__nonsense', { owner: 'acme', repo: 'app' }),
      ),
    ).toMatch("github__nonsense: unknown github tool 'github__nonsense'");
    expect(fetch.calls).toHaveLength(0);
  });
});

describe('execute — rules and release tools', () => {
  const repo = { owner: 'acme', repo: 'app' };

  test('update_branch_protection PUTs the protection settings of the branch', async () => {
    const fetch = mockFetch([
      {
        method: 'PUT',
        url: 'https://api.github.com/repos/acme/app/branches/main/protection',
        body: { url: 'p' },
      },
    ]);
    const result = await githubPlugin.execute(
      executeCtx(fetch),
      'github__update_branch_protection',
      {
        ...repo,
        branch: 'main',
        required_status_checks: { strict: true, contexts: ['ci'] },
        enforce_admins: true,
        required_pull_request_reviews: { required_approving_review_count: 1 },
        restrictions: null,
      },
    );
    expect(JSON.parse(text(result))).toEqual({ url: 'p' });
    expect(fetch.calls[0]!.json).toMatchObject({
      required_status_checks: { strict: true, contexts: ['ci'] },
      enforce_admins: true,
      required_pull_request_reviews: { required_approving_review_count: 1 },
      restrictions: null,
    });
  });

  test('list_releases / list_tags / create_release / delete_release', async () => {
    const fetch = mockFetch([
      {
        method: 'GET',
        url: 'https://api.github.com/repos/acme/app/releases',
        body: [{ tag_name: 'v1' }],
      },
      { method: 'GET', url: 'https://api.github.com/repos/acme/app/tags', body: [{ name: 'v1' }] },
      {
        method: 'POST',
        url: 'https://api.github.com/repos/acme/app/releases',
        status: 201,
        body: { id: 999, tag_name: 'v2' },
      },
      {
        method: 'DELETE',
        url: 'https://api.github.com/repos/acme/app/releases/999',
        status: 204,
      },
    ]);
    const ctx = executeCtx(fetch);
    const call = async (tool: string, args: Record<string, unknown>) =>
      JSON.parse(text(await githubPlugin.execute(ctx, tool, { ...repo, ...args }))) as unknown;

    expect(await call('github__list_releases', {})).toEqual([{ tag_name: 'v1' }]);
    expect(await call('github__list_tags', {})).toEqual([{ name: 'v1' }]);
    expect(await call('github__create_release', { tag_name: 'v2', name: 'Two' })).toEqual({
      id: 999,
      tag_name: 'v2',
    });
    const created = fetch.calls.find((c) => c.method === 'POST' && c.url.endsWith('/releases'));
    expect(created!.json).toMatchObject({ tag_name: 'v2', name: 'Two' });
    expect(await call('github__delete_release', { release_id: 999 })).toEqual({
      deleted: true,
      release_id: 999,
    });
  });

  test('add_labels POSTs the trimmed names and answers the names the issue now carries', async () => {
    const fetch = mockFetch([
      {
        method: 'POST',
        url: 'https://api.github.com/repos/acme/app/issues/7/labels',
        body: [
          { id: 1, name: 'bug', color: 'd73a4a', url: 'https://api.github.com/x/1', default: true },
          {
            id: 2,
            name: 'e2e',
            color: 'ededed',
            url: 'https://api.github.com/x/2',
            default: false,
          },
        ],
      },
    ]);
    const result = await githubPlugin.execute(executeCtx(fetch), 'github__add_labels', {
      owner: 'acme',
      repo: 'app',
      issue_number: 7,
      labels: [' e2e '],
    });
    expect(JSON.parse(text(result))).toEqual({ labels: ['bug', 'e2e'] });
    expect(fetch.calls[0]!.json).toEqual({ labels: ['e2e'] });
  });
});

describe('execute — merge_pull_request is bound to the declared base', () => {
  const repo = { owner: 'acme', repo: 'app' };
  const pullUrl = 'https://api.github.com/repos/acme/app/pulls/7';
  const pullRoute = (baseRef: unknown) => ({
    method: 'GET',
    url: pullUrl,
    body: { number: 7, base: { ref: baseRef } },
  });
  const mergeRoute = {
    method: 'PUT',
    url: `${pullUrl}/merge`,
    body: { merged: true, sha: 'abc' },
  };
  const merges = (fetch: { calls: readonly { method: string; json: unknown }[] }) =>
    fetch.calls.filter((c) => c.method === 'PUT');

  test('reads the pull request, then merges when its base is the declared one', async () => {
    const fetch = mockFetch([pullRoute('feature/x'), mergeRoute]);
    const result = await githubPlugin.execute(executeCtx(fetch), 'github__merge_pull_request', {
      ...repo,
      pull_number: 7,
      base: 'feature/x',
      merge_method: 'squash',
    });
    expect(JSON.parse(text(result))).toEqual({ merged: true, sha: 'abc' });
    expect(fetch.calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `GET ${pullUrl}`,
      `PUT ${pullUrl}/merge`,
    ]);
    expect(merges(fetch)[0]!.json).toMatchObject({ merge_method: 'squash' });
  });

  test('refuses, without merging, a pull request whose real base is not the declared one', async () => {
    // Classified on `feature/x` (no `merge-protected`), while GitHub would merge into `main`.
    const fetch = mockFetch([pullRoute('main'), mergeRoute]);
    expect(
      await refusalText(
        githubPlugin.execute(executeCtx(fetch), 'github__merge_pull_request', {
          ...repo,
          pull_number: 7,
          base: 'feature/x',
        }),
      ),
    ).toMatch(
      "github__merge_pull_request: pull request #7 targets 'main', not the declared base 'feature/x'. Call again with base 'main'.",
    );
    expect(merges(fetch)).toEqual([]);
  });

  test('without a declared base the pull request must target main, the branch the call was classified on', async () => {
    const refused = mockFetch([pullRoute('develop'), mergeRoute]);
    expect(
      await refusalText(
        githubPlugin.execute(executeCtx(refused), 'github__merge_pull_request', {
          ...repo,
          pull_number: 7,
        }),
      ),
    ).toMatch(/targets 'develop', not the declared base 'main'/);
    expect(merges(refused)).toEqual([]);

    const merged = mockFetch([pullRoute('main'), mergeRoute]);
    await githubPlugin.execute(executeCtx(merged), 'github__merge_pull_request', {
      ...repo,
      pull_number: 7,
    });
    expect(merges(merged)).toHaveLength(1);
  });

  test('refuses when GitHub returns no base branch for the pull request', async () => {
    const fetch = mockFetch([pullRoute(undefined), mergeRoute]);
    await expect(
      githubPlugin.execute(executeCtx(fetch), 'github__merge_pull_request', {
        ...repo,
        pull_number: 7,
        base: 'main',
      }),
    ).rejects.toThrow(/could not read the base branch of pull request #7/);
    // GitHub's answer is not what its API says : its failure, not the executor's.
    await expect(
      githubPlugin.execute(executeCtx(mockFetch([pullRoute(undefined)])), TOOL.mergePullRequest, {
        ...repo,
        pull_number: 7,
        base: 'main',
      }),
    ).rejects.toBeInstanceOf(UpstreamProtocolError);
    expect(merges(fetch)).toEqual([]);
  });
});

describe('execute — create_branch from the default branch', () => {
  test('a default branch GitHub answers that is not a branch name is its failure, nothing created', async () => {
    const fetch = mockFetch([
      {
        method: 'GET',
        url: 'https://api.github.com/repos/acme/app',
        body: { default_branch: 'refs/heads/main' },
      },
    ]);
    await expect(
      githubPlugin.execute(executeCtx(fetch), TOOL.createBranch, {
        owner: 'acme',
        repo: 'app',
        branch: 'feature/x',
      }),
    ).rejects.toBeInstanceOf(UpstreamProtocolError);
    expect(fetch.calls).toHaveLength(1);
  });
});

describe('execute — push_files reads `files` like the classifier', () => {
  test('refuses a malformed entry before any call', async () => {
    const fetch = mockFetch([]);
    expect(
      await refusalText(
        githubPlugin.execute(executeCtx(fetch), 'github__push_files', {
          owner: 'acme',
          repo: 'app',
          branch: 'feature/x',
          message: 'm',
          files: [{ path: 'a.ts', content: '1' }, { path: 5 }],
        }),
      ),
    ).toMatch(
      "github__push_files requires 'files' to be a non-empty array of { path, content } strings",
    );
    expect(fetch.calls).toHaveLength(0);
  });
});

describe('discoverResources — the repositories the token reaches, paged', () => {
  const repoDto = (i: number) => ({
    full_name: `acme/repo-${i}`,
    default_branch: 'main',
    private: i % 2 === 0,
    archived: false,
  });
  const pageUrl = (page: number) =>
    `https://api.github.com/user/repos?per_page=${DISCOVERY_PAGE_SIZE}&page=${page}`;

  test('maps repositories to resources with non-secret metadata', async () => {
    const fetch = mockFetch([
      { method: 'GET', url: pageUrl(1), body: [repoDto(1), { full_name: 'acme/bare' }] },
    ]);
    const resources = await githubPlugin.discoverResources(accountCtx(fetch));
    expect(resources).toEqual([
      {
        service: 'github',
        ref: 'acme/repo-1',
        displayName: 'acme/repo-1',
        metadata: { default_branch: 'main', private: false, archived: false },
        // Public, under a fine-grained token: its grant cannot be read, listed hidden.
        hiddenByDefault: true,
      },
      { service: 'github', ref: 'acme/bare', displayName: 'acme/bare', metadata: {} },
    ]);
    expect(fetch.calls[0]!.headers.authorization).toBe(`Bearer ${PAT}`);
    expect(fetch.calls).toHaveLength(1);
  });

  // Recorded shapes of `/user/repos` items (docs.github.com/en/rest/repos/repos): `private`
  // and the `permissions` object of the authenticated user's role on the repository.
  const listed = (fullName: string, isPrivate: boolean, push: boolean) => ({
    full_name: fullName,
    default_branch: 'main',
    private: isPrivate,
    archived: false,
    permissions: { admin: push, maintain: push, push, triage: true, pull: true },
  });
  const hiddenOf = (resources: readonly { ref: string; hiddenByDefault?: boolean }[]) =>
    Object.fromEntries(resources.map((r) => [r.ref, r.hiddenByDefault === true]));

  test('a fine-grained token: every public repository is listed hidden, a private one never', async () => {
    const fetch = mockFetch([
      {
        method: 'GET',
        url: pageUrl(1),
        body: [
          listed('acme/granted', true, true),
          listed('acme/site', false, true),
          listed('octo/docs', false, false),
        ],
      },
    ]);
    expect(hiddenOf(await githubPlugin.discoverResources(accountCtx(fetch)))).toEqual({
      'acme/granted': false,
      'acme/site': true,
      'octo/docs': true,
    });
  });

  test('a classic token: only a public repository the user cannot push to is listed hidden', async () => {
    const classic = {
      kind: 'api-key',
      fields: { token: 'ghp_0123456789abcdefghijklmnopqrstuvwxyz' },
      metadata: {},
    } as const;
    const fetch = mockFetch([
      {
        method: 'GET',
        url: pageUrl(1),
        body: [
          listed('acme/private', true, false),
          listed('acme/site', false, true),
          listed('octo/docs', false, false),
          { full_name: 'octo/unknown', private: false },
        ],
      },
    ]);
    expect(
      hiddenOf(await githubPlugin.discoverResources(accountCtx(fetch, { credential: classic }))),
    ).toEqual({
      'acme/private': false,
      'acme/site': false,
      'octo/docs': true,
      'octo/unknown': false,
    });
  });

  test('follows pages until a short one', async () => {
    const first = Array.from({ length: DISCOVERY_PAGE_SIZE }, (_, i) => repoDto(i));
    const fetch = mockFetch([
      { method: 'GET', url: pageUrl(1), body: first, times: 1 },
      { method: 'GET', url: pageUrl(2), body: [repoDto(999)], times: 1 },
    ]);
    const resources = await githubPlugin.discoverResources(accountCtx(fetch));
    expect(resources).toHaveLength(DISCOVERY_PAGE_SIZE + 1);
    expect(resources.at(-1)!.ref).toBe('acme/repo-999');
    expect(fetch.pending()).toEqual([]);
  });

  test('a repository whose name is not owner/repo is left out ; metadata of another type is not said', async () => {
    const fetch = mockFetch([
      {
        method: 'GET',
        url: pageUrl(1),
        body: [
          { full_name: 'acme/app', default_branch: 7, private: 'yes' },
          { full_name: 'no-slash' },
          'acme/not-an-object',
        ],
      },
    ]);
    expect(await githubPlugin.discoverResources(accountCtx(fetch))).toEqual([
      { service: 'github', ref: 'acme/app', displayName: 'acme/app', metadata: {} },
    ]);
  });

  test('an answer that is not a list is GitHub failing, not an account without repositories', async () => {
    const fetch = mockFetch([{ method: 'GET', url: pageUrl(1), body: { message: 'moved' } }]);
    await expect(githubPlugin.discoverResources(accountCtx(fetch))).rejects.toBeInstanceOf(
      UpstreamProtocolError,
    );
  });

  test('401 on the listing becomes UpstreamAuthError', async () => {
    const fetch = mockFetch([{ method: 'GET', url: pageUrl(1), status: 401, body: {} }]);
    await expect(githubPlugin.discoverResources(accountCtx(fetch))).rejects.toMatchObject({
      name: 'UpstreamAuthError',
      upstreamStatus: 401,
    });
  });
});
