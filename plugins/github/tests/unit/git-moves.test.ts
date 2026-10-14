/**
 * The moves of `github__git_push` and the review of a push against
 * `mockFetch` (ADR gateway-as-git-remote D4): create and fast-forward through
 * REST, force and delete through receive-pack with the reviewed old id as the
 * expected value (compare-and-swap), one report per ref, and the review of
 * every commit a push brings. No test reaches GitHub.
 */
import {
  concatBytes,
  encodeReportStatus,
  flushPkt,
  sideBand,
  SIDE_BAND,
  UpstreamHttpError,
} from '@vaubaan/plugin-sdk';
import { mockFetch, type MockRoute } from '@vaubaan/plugin-sdk/testing';
import { describe, expect, test } from 'vitest';

import { executeGit } from '../../src/git-moves.ts';
import { review } from '../../src/git-review.ts';
import { executeCtx, mintRoute } from './fixtures.ts';

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
      mintRoute(),
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
      mintRoute(),
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
      mintRoute(),
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
      mintRoute(),
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
  const refRoute = (sha: string): MockRoute => ({
    method: 'GET',
    url: `${API}/git/ref/heads/feature/x`,
    body: { ref: 'refs/heads/feature/x', object: { sha } },
  });

  test('a workflow change in an intermediate commit is a workflow change of the push', async () => {
    const fetch = mockFetch([
      mintRoute(),
      refRoute(OLD),
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

  test('a commit GitHub lists 300 files of cannot be reviewed', async () => {
    const many = Array.from({ length: 300 }, (_, i) => ({ filename: `f${i}` }));
    const fetch = mockFetch([
      mintRoute(),
      refRoute(OLD),
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
    ]);
    const reviewed = await review(executeCtx(fetch), 'acme/app', [
      { ref: 'refs/heads/feature/x', old: OLD, new: NEW },
    ]);
    expect(reviewed.ok).toBe(false);
    if (!reviewed.ok) expect(reviewed.reason).toContain('cannot be reviewed');
  });
});
