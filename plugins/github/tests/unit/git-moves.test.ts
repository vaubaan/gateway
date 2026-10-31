/**
 * The moves of `github__git_push` and the review of a push against
 * `mockFetch` (ADR gateway-as-git-remote D4): create and fast-forward through
 * REST, force and delete through receive-pack with the reviewed old id as the
 * expected value (compare-and-swap), one report per ref, and the review of
 * every commit a push brings. No test reaches GitHub.
 */
import { UpstreamHttpError } from '@vaubaan/plugin-sdk';
import {
  concatBytes,
  encodeAdvertisement,
  encodeReportStatus,
  flushPkt,
  sideBand,
  SIDE_BAND,
} from '@vaubaan/plugin-sdk/git';
import { mockFetch, type MockRoute } from '@vaubaan/plugin-sdk/testing';
import { describe, expect, test } from 'vitest';

import { executeGit } from '../../src/git-moves.ts';
import { review } from '../../src/git-review.ts';
import { executeCtx } from './fixtures.ts';

const OLD = 'a'.repeat(40);
const NEW = 'b'.repeat(40);
const MID = 'c'.repeat(40);
const API = 'https://api.github.com/repos/acme/app';
const RECEIVE_PACK = 'https://github.com/acme/app.git/git-receive-pack';

function update(ref: string, kind: string, old: string | null, next: string | null) {
  return { ref, old, new: next, kind, commits: 1, files: [], workflow_files: [] };
}

/** A side-band receive-pack report, as GitHub answers it. */
function reportBody(refs: readonly { ref: string; error: string | null }[]): string {
  const report = encodeReportStatus('ok', refs);
  return Buffer.from(concatBytes([...sideBand(SIDE_BAND.data, report), flushPkt()])).toString(
    'latin1',
  );
}

const text = (r: { content: readonly unknown[] }) => (r.content[0] as { text: string }).text;

describe('moves', () => {
  test('a force-push is a compare-and-swap on the reviewed old id, through receive-pack', async () => {
    const fetch = mockFetch([
      {
        method: 'POST',
        url: RECEIVE_PACK,
        respond: () => reportBody([{ ref: 'refs/heads/feature/x', error: null }]),
      },
    ]);
    const result = await executeGit(executeCtx(fetch), 'github__git_push', {
      repository: 'acme/app',
      updates: [update('refs/heads/feature/x', 'force', OLD, NEW)],
    });
    expect(JSON.parse(text(result))).toEqual({
      updates: [{ ref: 'refs/heads/feature/x', ok: true }],
    });
    const sent = fetch.calls.find((c) => c.url === RECEIVE_PACK);
    expect(sent?.body).toContain(`${OLD} ${NEW} refs/heads/feature/x`);
    // No REST write was used for the rewrite.
    expect(fetch.calls.some((c) => c.method === 'PATCH')).toBe(false);
  });

  test('a delete GitHub refuses because the ref moved is reported on that ref', async () => {
    const fetch = mockFetch([
      {
        method: 'POST',
        url: RECEIVE_PACK,
        respond: () => reportBody([{ ref: 'refs/heads/old', error: 'failed to update ref' }]),
      },
    ]);
    const result = await executeGit(executeCtx(fetch), 'github__git_push', {
      repository: 'acme/app',
      updates: [update('refs/heads/old', 'delete', OLD, null)],
    });
    expect(result.isError).toBe(true);
    const [only] = (JSON.parse(text(result)) as { updates: { ok: boolean; error: string }[] })
      .updates;
    expect(only?.ok).toBe(false);
    expect(only?.error).toContain('failed to update ref');
  });

  test('a provider failure on the second ref reports each ref on its own', async () => {
    const fetch = mockFetch([
      {
        method: 'POST',
        url: `${API}/git/refs`,
        status: 201,
        body: { ref: 'refs/heads/feature/a' },
      },
      {
        method: 'PATCH',
        url: `${API}/git/refs/heads/feature/b`,
        status: 502,
        body: { message: 'Bad gateway' },
      },
    ]);
    const result = await executeGit(executeCtx(fetch), 'github__git_push', {
      repository: 'acme/app',
      updates: [
        update('refs/heads/feature/a', 'create', null, NEW),
        update('refs/heads/feature/b', 'fast-forward', OLD, NEW),
      ],
    });
    expect(result.isError).toBe(true);
    const updates = (
      JSON.parse(text(result)) as { updates: { ref: string; ok: boolean; error?: string }[] }
    ).updates;
    expect(updates[0]).toEqual({ ref: 'refs/heads/feature/a', ok: true });
    expect(updates[1]?.ok).toBe(false);
    expect(updates[1]?.error).toContain('GitHub did not apply this update');
  });

  test('a provider failure before any ref moved fails the call', async () => {
    const fetch = mockFetch([
      { method: 'POST', url: `${API}/git/refs`, status: 503, body: { message: 'down' } },
    ]);
    await expect(
      executeGit(executeCtx(fetch), 'github__git_push', {
        repository: 'acme/app',
        updates: [update('refs/heads/feature/a', 'create', null, NEW)],
      }),
    ).rejects.toBeInstanceOf(UpstreamHttpError);
  });
});

describe('review', () => {
  /** The branch heads (only the pushed branch, at `old`) and `new`'s history: no nearer base. */
  const noOtherBranch: MockRoute[] = [
    {
      method: 'GET',
      url: 'https://github.com/acme/app.git/info/refs?service=git-upload-pack',
      respond: () =>
        Buffer.from(
          encodeAdvertisement({
            service: 'git-upload-pack',
            refs: [{ oid: OLD, name: 'refs/heads/feature/x' }],
            capabilities: [],
          }),
        ).toString('latin1'),
    },
    {
      method: 'GET',
      url: `${API}/commits?sha=${NEW}&per_page=100&page=1`,
      body: [{ sha: NEW }, { sha: MID }, { sha: OLD }],
    },
    // The default branch is a candidate base too: none reported here.
    { method: 'GET', url: API, body: {} },
  ];
  const refRoute = (sha: string): MockRoute => ({
    method: 'GET',
    url: `${API}/git/ref/heads/feature/x`,
    body: { ref: 'refs/heads/feature/x', object: { sha } },
  });

  test('a workflow change in an intermediate commit is a workflow change of the push', async () => {
    const fetch = mockFetch([
      refRoute(OLD),
      ...noOtherBranch,
      {
        method: 'GET',
        url: `${API}/compare/${OLD}...${NEW}`,
        body: {
          status: 'ahead',
          ahead_by: 2,
          total_commits: 2,
          commits: [{ sha: MID }, { sha: NEW }],
          // The tip takes the change back: the net diff shows no workflow.
          files: [{ filename: 'src/a.ts' }],
        },
      },
      {
        method: 'GET',
        url: `${API}/commits/${MID}`,
        body: { files: [{ filename: '.github/workflows/evil.yml' }] },
      },
      {
        method: 'GET',
        url: `${API}/commits/${NEW}`,
        body: { files: [{ filename: '.github/workflows/evil.yml' }, { filename: 'src/a.ts' }] },
      },
    ]);
    const reviewed = await review(executeCtx(fetch), 'acme/app', [
      { ref: 'refs/heads/feature/x', old: OLD, new: NEW },
    ]);
    expect(reviewed).toMatchObject({
      ok: true,
      updates: [
        {
          kind: 'fast-forward',
          files: ['src/a.ts'],
          workflow_files: ['.github/workflows/evil.yml'],
        },
      ],
    });
  });

  /**
   * A commit GitHub lists 300 files of (a large merge): read by its trees.
   * `MID`'s root holds `.github` = `github`; `OLD`'s holds `G_OLD`.
   */
  function largeCommit(github: string): MockRoute[] {
    const many = Array.from({ length: 300 }, (_, i) => ({ filename: `f${i}` }));
    const T_MID = '1'.repeat(40);
    const T_OLD = '2'.repeat(40);
    const G_OLD = '3'.repeat(40);
    const W_OLD = '4'.repeat(40);
    const W_MID = '5'.repeat(40);
    const tree = (sha: string, entries: { path: string; mode: string; sha: string }[]) => ({
      method: 'GET',
      url: `${API}/git/trees/${sha}`,
      body: { sha, truncated: false, tree: entries.map((e) => ({ ...e, type: 'tree' })) },
    });
    return [
      {
        method: 'GET',
        url: `${API}/compare/${OLD}...${NEW}`,
        body: {
          status: 'ahead',
          ahead_by: 2,
          total_commits: 2,
          commits: [{ sha: MID }, { sha: NEW }],
          files: [],
        },
      },
      { method: 'GET', url: `${API}/commits/${MID}`, body: { files: many } },
      { method: 'GET', url: `${API}/commits/${NEW}`, body: { files: [] } },
      {
        method: 'GET',
        url: `${API}/git/commits/${MID}`,
        body: { sha: MID, tree: { sha: T_MID }, parents: [{ sha: OLD }] },
      },
      {
        method: 'GET',
        url: `${API}/git/commits/${OLD}`,
        body: { sha: OLD, tree: { sha: T_OLD }, parents: [] },
      },
      tree(T_MID, [{ path: '.github', mode: '040000', sha: github }]),
      tree(T_OLD, [{ path: '.github', mode: '040000', sha: G_OLD }]),
      tree(G_OLD, [{ path: 'workflows', mode: '040000', sha: W_OLD }]),
      tree(github, [{ path: 'workflows', mode: '040000', sha: W_MID }]),
      tree(W_OLD, [{ path: 'ci.yml', mode: '100644', sha: '6'.repeat(40) }]),
      tree(W_MID, [{ path: 'ci.yml', mode: '100644', sha: '7'.repeat(40) }]),
    ];
  }

  test('a commit GitHub lists 300 files of is read by its trees: same workflows as its parent, none', async () => {
    const fetch = mockFetch([refRoute(OLD), ...noOtherBranch, ...largeCommit('3'.repeat(40))]);
    const reviewed = await review(executeCtx(fetch), 'acme/app', [
      { ref: 'refs/heads/feature/x', old: OLD, new: NEW },
    ]);
    expect(reviewed).toMatchObject({ ok: true, updates: [{ workflow_files: [] }] });
  });

  /** `main` at `OLD`; `NEW` one commit on top of it, on no branch yet. */
  const mainAtOld: MockRoute[] = [
    {
      method: 'GET',
      url: 'https://github.com/acme/app.git/info/refs?service=git-upload-pack',
      respond: () =>
        Buffer.from(
          encodeAdvertisement({
            service: 'git-upload-pack',
            refs: [{ oid: OLD, name: 'refs/heads/main' }],
            capabilities: [],
          }),
        ).toString('latin1'),
    },
    { method: 'GET', url: API, body: { default_branch: 'main' } },
    {
      method: 'GET',
      url: `${API}/commits?sha=${NEW}&per_page=100&page=1`,
      body: [{ sha: NEW }, { sha: OLD }],
    },
    {
      method: 'GET',
      url: new RegExp(`^${API}/compare/(${OLD}|main)\\.\\.\\.${NEW}$`),
      body: {
        status: 'ahead',
        ahead_by: 1,
        total_commits: 1,
        commits: [{ sha: NEW }],
        files: [{ filename: 'src/a.ts' }],
      },
    },
    {
      method: 'GET',
      url: `${API}/git/commits/${NEW}`,
      body: { sha: NEW, tree: { sha: '1'.repeat(40) }, parents: [{ sha: OLD }] },
    },
  ];
  const absentTag = (name: string): MockRoute => ({
    method: 'GET',
    url: `${API}/git/ref/tags/${name}`,
    status: 404,
    body: { message: 'Not Found' },
  });

  test('an annotated tag is reviewed through the commit it points at', async () => {
    const TAG = 'd'.repeat(40);
    const fetch = mockFetch([
      absentTag('v1.0.0'),
      ...mainAtOld,
      // GitHub holds no commit under the tag object's id, a tag.
      { method: 'GET', url: `${API}/git/commits/${TAG}`, status: 404, body: { message: 'no' } },
      {
        method: 'GET',
        url: `${API}/git/tags/${TAG}`,
        body: { sha: TAG, tag: 'v1.0.0', object: { sha: NEW, type: 'commit' } },
      },
    ]);
    const reviewed = await review(executeCtx(fetch), 'acme/app', [
      { ref: 'refs/tags/v1.0.0', old: null, new: TAG },
    ]);
    expect(reviewed).toEqual({
      ok: true,
      updates: [
        {
          ref: 'refs/tags/v1.0.0',
          old: null,
          // The ref is moved to the tag object, its message kept.
          new: TAG,
          kind: 'create',
          commits: 1,
          files: ['src/a.ts'],
          workflow_files: [],
        },
      ],
    });
    // Every comparison and listing names the commit, never the tag object.
    const compared = fetch.calls.filter(
      (c) => c.url.includes('/compare/') || c.url.includes('/commits?'),
    );
    expect(compared.length).toBeGreaterThan(0);
    expect(compared.every((c) => c.url.includes(NEW) && !c.url.includes(TAG))).toBe(true);
  });

  test('a lightweight tag is reviewed as the commit itself', async () => {
    const fetch = mockFetch([absentTag('v1.0.1'), ...mainAtOld]);
    const reviewed = await review(executeCtx(fetch), 'acme/app', [
      { ref: 'refs/tags/v1.0.1', old: null, new: NEW },
    ]);
    expect(reviewed).toMatchObject({
      ok: true,
      updates: [
        { ref: 'refs/tags/v1.0.1', new: NEW, kind: 'create', commits: 1, files: ['src/a.ts'] },
      ],
    });
    expect(fetch.calls.some((c) => c.url.includes('/git/tags/'))).toBe(false);
  });

  test('an annotated tag of a commit no branch reaches is refused as unrelated history', async () => {
    const TAG = 'd'.repeat(40);
    const ORPHAN = 'e'.repeat(40);
    const fetch = mockFetch([
      absentTag('v2.0.0'),
      mainAtOld[0]!,
      mainAtOld[1]!,
      { method: 'GET', url: `${API}/git/commits/${TAG}`, status: 404, body: { message: 'no' } },
      {
        method: 'GET',
        url: `${API}/git/tags/${TAG}`,
        body: { sha: TAG, object: { sha: ORPHAN, type: 'commit' } },
      },
      {
        method: 'GET',
        url: `${API}/git/commits/${ORPHAN}`,
        body: { sha: ORPHAN, tree: { sha: '1'.repeat(40) }, parents: [] },
      },
      {
        method: 'GET',
        url: `${API}/commits?sha=${ORPHAN}&per_page=100&page=1`,
        body: [{ sha: ORPHAN }],
      },
      {
        method: 'GET',
        url: `${API}/compare/main...${ORPHAN}`,
        status: 404,
        body: { message: 'No common ancestor' },
      },
    ]);
    const reviewed = await review(executeCtx(fetch), 'acme/app', [
      { ref: 'refs/tags/v2.0.0', old: null, new: TAG },
    ]);
    expect(reviewed).toEqual({
      ok: false,
      reason: 'refs/tags/v2.0.0 cannot be reviewed: it has no history in common with main',
    });
  });

  test('a tag that names no commit cannot be reviewed', async () => {
    const TAG = 'd'.repeat(40);
    const BLOB = 'f'.repeat(40);
    const fetch = mockFetch([
      absentTag('v3.0.0'),
      { method: 'GET', url: `${API}/git/commits/${TAG}`, status: 404, body: { message: 'no' } },
      {
        method: 'GET',
        url: `${API}/git/tags/${TAG}`,
        body: { sha: TAG, object: { sha: BLOB, type: 'blob' } },
      },
      { method: 'GET', url: `${API}/git/commits/${BLOB}`, status: 404, body: { message: 'no' } },
      { method: 'GET', url: `${API}/git/tags/${BLOB}`, status: 404, body: { message: 'no' } },
    ]);
    const reviewed = await review(executeCtx(fetch), 'acme/app', [
      { ref: 'refs/tags/v3.0.0', old: null, new: TAG },
    ]);
    expect(reviewed).toEqual({
      ok: false,
      reason: 'refs/tags/v3.0.0 cannot be reviewed: it does not point at a commit',
    });
  });

  test('a commit GitHub lists 300 files of, whose workflows differ from its parent’s, is a workflow change', async () => {
    const fetch = mockFetch([refRoute(OLD), ...noOtherBranch, ...largeCommit('8'.repeat(40))]);
    const reviewed = await review(executeCtx(fetch), 'acme/app', [
      { ref: 'refs/heads/feature/x', old: OLD, new: NEW },
    ]);
    expect(reviewed).toMatchObject({
      ok: true,
      updates: [{ workflow_files: ['.github/workflows/ci.yml'] }],
    });
  });
});
