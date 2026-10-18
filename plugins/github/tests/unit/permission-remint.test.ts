/**
 * A permission granted on the App is seen at the next call, and a push the
 * installation's token cannot carry is declined by name before its pack
 * leaves (frictions of 2026-10-16: a cached grant lived 50 minutes; a
 * workflow-touching push left before GitHub refused it).
 *
 * - API tools: a cached grant that lacks what the call needs, or a GitHub 403
 *   "Resource not accessible by integration", is minted afresh once and the
 *   call sent once more; refused again, the call is declined by name.
 * - `admitPush`: the push token against what the inspection found, a cached
 *   grant minted afresh once when it falls short.
 * - The ref moves: a move GitHub refuses for a permission is retried once
 *   with a token minted afresh.
 *
 * No test reaches GitHub.
 */
import type { UpstreamCredentialCache } from '@vaubaan/plugin-sdk';
import {
  concatBytes,
  encodeReportStatus,
  flushPkt,
  sideBand,
  SIDE_BAND,
} from '@vaubaan/plugin-sdk';
import { mockFetch, refusalText, type MockRoute } from '@vaubaan/plugin-sdk/testing';
import { describe, expect, test } from 'vitest';

import { admitPush } from '../../src/git-credential.ts';
import { executeGit } from '../../src/git-moves.ts';
import { githubPlugin } from '../../src/index.ts';
import { isMissingPermissionRefusal } from '../../src/permission-check.ts';
import { MINT_URL, executeCtx } from './fixtures.ts';

const API = 'https://api.github.com/repos/acme/app';
const RECEIVE_PACK = 'https://github.com/acme/app.git/git-receive-pack';
const OLD = 'a'.repeat(40);
const NEW = 'b'.repeat(40);
const repo = { owner: 'acme', repo: 'app' };
const INTEGRATION = { message: 'Resource not accessible by integration' };

const text = (r: { content: readonly unknown[] }) => (r.content[0] as { text: string }).text;

/** The host's connection-scoped cache, in memory. */
function memoryCache(): UpstreamCredentialCache & { readonly keys: () => string[] } {
  const entries = new Map<string, unknown>();
  return {
    get: <T>(key: string) => Promise.resolve((entries.get(key) as T | undefined) ?? null),
    set: <T>(key: string, value: T) => {
      entries.set(key, value);
      return Promise.resolve();
    },
    keys: () => [...entries.keys()],
  };
}

/** One answer of the token mint, valid for an hour, reporting `permissions`. */
function mint(token: string, permissions: Record<string, string>, times = 1): MockRoute {
  return {
    method: 'POST',
    url: MINT_URL,
    times,
    status: 201,
    body: {
      token,
      expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      permissions,
    },
  };
}

/** GitHub refusing a token asking for a permission the installation lacks. */
function notHeld(times = 1): MockRoute {
  return {
    method: 'POST',
    url: MINT_URL,
    times,
    status: 422,
    body: { message: 'The permissions requested are not granted to this installation.' },
  };
}

const mints = (fetch: ReturnType<typeof mockFetch>) =>
  fetch.calls.filter((c) => c.url === MINT_URL).length;

describe('isMissingPermissionRefusal — the family of GitHub refusals for a missing permission', () => {
  test.each([
    [403, 'Resource not accessible by integration', true],
    [
      null,
      'refusing to allow a GitHub App to create or update workflow `.github/workflows/ci.yml` without `workflows` permission',
      true,
    ],
    [403, 'API rate limit exceeded for installation ID 1', false],
    [403, 'Resource not accessible', false],
    [404, 'Resource not accessible by integration', false],
  ])('%s %j → %s', (status, message, expected) => {
    expect(isMissingPermissionRefusal(status, message)).toBe(expected);
  });
});

describe('API tools — a stale cached grant is minted afresh once', () => {
  test('a cached grant lacking what the call needs is minted afresh before anything is sent', async () => {
    const cache = memoryCache();
    const fetch = mockFetch([
      mint('ghs_old', { metadata: 'read', contents: 'read' }),
      mint('ghs_new', { metadata: 'read', contents: 'write' }),
      { method: 'GET', url: `${API}/branches`, body: [] },
      { method: 'GET', url: /\/git\/ref\/heads%2Fmain$/, body: { object: { sha: OLD } } },
      {
        method: 'POST',
        url: `${API}/git/refs`,
        status: 201,
        body: { ref: 'refs/heads/feature/x' },
      },
    ]);
    const ctx = executeCtx(fetch, undefined, { credentialCache: cache });
    await githubPlugin.execute(ctx, 'github__list_branches', repo);
    const result = await githubPlugin.execute(ctx, 'github__create_branch', {
      ...repo,
      branch: 'feature/x',
      from_branch: 'main',
    });
    expect(result.isError).toBeUndefined();
    expect(mints(fetch)).toBe(2);
    const created = fetch.calls.find((c) => c.method === 'POST' && c.url === `${API}/git/refs`);
    expect(created?.headers.authorization).toBe('token ghs_new');
  });

  test('a 403 "not accessible by integration" on a cached grant: minted afresh, sent once more', async () => {
    const cache = memoryCache();
    const fetch = mockFetch([
      mint('ghs_old', { metadata: 'read', contents: 'read', actions: 'read' }),
      mint('ghs_new', { metadata: 'read', contents: 'read', actions: 'read' }),
      { method: 'GET', url: `${API}/branches`, body: [] },
      { method: 'GET', url: `${API}/actions/workflows`, times: 1, status: 403, body: INTEGRATION },
      { method: 'GET', url: `${API}/actions/workflows`, body: { total_count: 0, workflows: [] } },
    ]);
    const ctx = executeCtx(fetch, undefined, { credentialCache: cache });
    await githubPlugin.execute(ctx, 'github__list_branches', repo);
    const result = await githubPlugin.execute(ctx, 'github__list_workflows', repo);
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(text(result))).toEqual({ total_count: 0, workflows: [] });
    expect(mints(fetch)).toBe(2);
  });

  test('refused again after the fresh mint: declined by the permission’s name, nothing more sent', async () => {
    const cache = memoryCache();
    const fetch = mockFetch([
      mint('ghs_old', { metadata: 'read', contents: 'read', actions: 'read' }, 2),
      { method: 'GET', url: `${API}/branches`, body: [] },
      { method: 'GET', url: `${API}/actions/workflows`, status: 403, body: INTEGRATION },
    ]);
    const ctx = executeCtx(fetch, undefined, { credentialCache: cache });
    await githubPlugin.execute(ctx, 'github__list_branches', repo);
    const refusal = await refusalText(githubPlugin.execute(ctx, 'github__list_workflows', repo));
    expect(refusal).toContain('github__list_workflows was refused by GitHub');
    expect(refusal).toContain('Resource not accessible by integration');
    expect(refusal).toContain('Actions (actions: read');
    expect(mints(fetch)).toBe(2);
    expect(fetch.calls.filter((c) => c.url.endsWith('/actions/workflows'))).toHaveLength(2);
  });

  test('a grant minted for this very call is not minted again: the refusal is final', async () => {
    const fetch = mockFetch([
      mint('ghs_x', { metadata: 'read', contents: 'read', actions: 'read' }),
      { method: 'GET', url: `${API}/actions/workflows`, status: 403, body: INTEGRATION },
    ]);
    const refusal = await refusalText(
      githubPlugin.execute(executeCtx(fetch), 'github__list_workflows', repo),
    );
    expect(refusal).toContain('was refused by GitHub');
    expect(mints(fetch)).toBe(1);
  });

  test('another 403 (a rate limit) is not a permission: no fresh mint, UpstreamAuthError', async () => {
    const cache = memoryCache();
    const fetch = mockFetch([
      mint('ghs_old', { metadata: 'read', contents: 'read' }),
      { method: 'GET', url: `${API}/branches`, times: 1, body: [] },
      {
        method: 'GET',
        url: `${API}/branches`,
        status: 403,
        body: { message: 'API rate limit exceeded for installation' },
      },
    ]);
    const ctx = executeCtx(fetch, undefined, { credentialCache: cache });
    await githubPlugin.execute(ctx, 'github__list_branches', repo);
    await expect(githubPlugin.execute(ctx, 'github__list_branches', repo)).rejects.toMatchObject({
      name: 'UpstreamAuthError',
      upstreamStatus: 403,
    });
    expect(mints(fetch)).toBe(1);
  });
});

describe('admitPush — the push token against what the inspection found', () => {
  const code = [{ ref: 'refs/heads/feature/x', workflow_files: [] }];
  const workflow = [{ ref: 'refs/heads/feature/x', workflow_files: ['.github/workflows/ci.yml'] }];

  test('an installation without workflows: code admitted, a workflow change declined by name', async () => {
    const cache = memoryCache();
    const fetch = mockFetch([
      // contents + workflows refused, contents alone minted — each time.
      notHeld(),
      mint('ghs_code', { contents: 'write', metadata: 'read' }),
      notHeld(),
      mint('ghs_code2', { contents: 'write', metadata: 'read' }),
    ]);
    const ctx = executeCtx(fetch, undefined, { credentialCache: cache });
    expect(await admitPush(ctx, 'acme/app', code)).toBeNull();
    const refusal = await admitPush(ctx, 'acme/app', workflow);
    expect(refusal).toContain(
      'github__git_push needs the GitHub App permission Workflows (workflows: write',
    );
    // The cached grant fell short: minted afresh once (422 then the fallback).
    expect(mints(fetch)).toBe(4);
  });

  test('a permission granted since the grant was cached is seen at once', async () => {
    const cache = memoryCache();
    const fetch = mockFetch([
      notHeld(),
      mint('ghs_code', { contents: 'write', metadata: 'read' }),
      mint('ghs_ci', { contents: 'write', metadata: 'read', workflows: 'write' }),
    ]);
    const ctx = executeCtx(fetch, undefined, { credentialCache: cache });
    expect(await admitPush(ctx, 'acme/app', code)).toBeNull();
    expect(await admitPush(ctx, 'acme/app', workflow)).toBeNull();
    expect(mints(fetch)).toBe(3);
    // The new grant replaced the old one in the cache.
    const [entry] = cache.keys();
    expect(entry).toBe('git-token:app:write');
    expect(await cache.get<{ token: string }>('git-token:app:write')).toMatchObject({
      token: 'ghs_ci',
    });
  });

  test('a grant minted just now is not minted again', async () => {
    const fetch = mockFetch([notHeld(), mint('ghs_code', { contents: 'write', metadata: 'read' })]);
    const refusal = await admitPush(executeCtx(fetch), 'acme/app', workflow);
    expect(refusal).toContain('Workflows');
    expect(mints(fetch)).toBe(2);
  });
});

describe('ref moves — a move GitHub refuses for a permission is tried once more', () => {
  /**
   * A context whose push grant was minted and cached earlier in the push
   * (by `admitPush`, as the host asks before the store).
   */
  async function primed(fetch: ReturnType<typeof mockFetch>) {
    const ctx = executeCtx(fetch, undefined, { credentialCache: memoryCache() });
    expect(await admitPush(ctx, 'acme/app', [])).toBeNull();
    return ctx;
  }

  function update(ref: string, kind: string, old: string | null, next: string | null) {
    return { ref, old, new: next, kind, commits: 1, files: [], workflow_files: [] };
  }

  test('a fast-forward refused "not accessible by integration" moves with a token minted afresh', async () => {
    const fetch = mockFetch([
      mint('ghs_old', { contents: 'write', metadata: 'read' }),
      mint('ghs_new', { contents: 'write', metadata: 'read' }),
      {
        method: 'PATCH',
        url: `${API}/git/refs/heads/feature/x`,
        times: 1,
        status: 403,
        body: INTEGRATION,
      },
      { method: 'PATCH', url: `${API}/git/refs/heads/feature/x`, body: { ref: 'x' } },
    ]);
    const result = await executeGit(await primed(fetch), 'github__git_push', {
      repository: 'acme/app',
      updates: [update('refs/heads/feature/x', 'fast-forward', OLD, NEW)],
    });
    expect(JSON.parse(text(result))).toEqual({
      updates: [{ ref: 'refs/heads/feature/x', ok: true }],
    });
    const patches = fetch.calls.filter((c) => c.method === 'PATCH');
    expect(patches.map((c) => c.headers.authorization)).toEqual([
      'Bearer ghs_old',
      'Bearer ghs_new',
    ]);
  });

  test('refused again: the ref’s error names the permission', async () => {
    const fetch = mockFetch([
      mint('ghs_old', { contents: 'write', metadata: 'read' }, 2),
      { method: 'PATCH', url: `${API}/git/refs/heads/feature/x`, status: 403, body: INTEGRATION },
    ]);
    const result = await executeGit(await primed(fetch), 'github__git_push', {
      repository: 'acme/app',
      updates: [update('refs/heads/feature/x', 'fast-forward', OLD, NEW)],
    });
    expect(result.isError).toBe(true);
    const [only] = (JSON.parse(text(result)) as { updates: { error: string }[] }).updates;
    expect(only?.error).toContain('github__git_push was refused by GitHub');
    expect(only?.error).toContain('Contents (contents: write');
    expect(fetch.calls.filter((c) => c.method === 'PATCH')).toHaveLength(2);
  });

  test('a force-push refused "without workflows permission" is sent once more with a fresh token', async () => {
    const report = (error: string | null) =>
      Buffer.from(
        concatBytes([
          ...sideBand(
            SIDE_BAND.data,
            encodeReportStatus('ok', [{ ref: 'refs/heads/feature/x', error }]),
          ),
          flushPkt(),
        ]),
      ).toString('latin1');
    const fetch = mockFetch([
      mint('ghs_old', { contents: 'write', metadata: 'read' }),
      mint('ghs_new', { contents: 'write', metadata: 'read', workflows: 'write' }),
      {
        method: 'POST',
        url: RECEIVE_PACK,
        times: 1,
        respond: () =>
          report(
            'refusing to allow a GitHub App to create or update workflow `.github/workflows/ci.yml` without `workflows` permission',
          ),
      },
      { method: 'POST', url: RECEIVE_PACK, respond: () => report(null) },
    ]);
    const result = await executeGit(await primed(fetch), 'github__git_push', {
      repository: 'acme/app',
      updates: [update('refs/heads/feature/x', 'force', OLD, NEW)],
    });
    expect(JSON.parse(text(result))).toEqual({
      updates: [{ ref: 'refs/heads/feature/x', ok: true }],
    });
    expect(mints(fetch)).toBe(2);
  });
});
