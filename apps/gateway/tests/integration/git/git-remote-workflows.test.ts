/**
 * The defect of 2026-10-16 and its fix (ADR gateway-as-git-remote;
 * handbook threat-model): a mission holding `github.git-push` and
 * `github.feature-branch-write` but NOT `github.workflow-write-via-file`
 * pushed a commit changing `.github/workflows/` on a feature branch; the
 * gateway stored the pack at GitHub before deciding, and only GitHub's own
 * check stopped it. Now the push's own objects are inspected first: such a
 * push is refused by the permission's name and NOTHING reaches GitHub; a
 * mission holding the permission passes. Real git against
 * `git http-backend`; nothing reaches github.com.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { concatBytes, encodeCommandList } from '@vaubaan/plugin-sdk/git';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { AuditCallRecord } from '../../../src/server/store';
import { line, type IssuedMission } from '../../support/execution/testing';
import { openGitRig, REPOSITORY, type GitResult, type GitRig } from './support';

const PUSH = 'github__git_push';
const WORKFLOW_RISK = 'github.workflow-write-via-file';
const REFUSED = `permission ${WORKFLOW_RISK} is not in this mission`;

let rig: GitRig;
/** May push feature branches, may not change CI: the mission of the defect. */
let coder: IssuedMission;
/** The same, and may change CI. */
let maintainer: IssuedMission;

beforeAll(async () => {
  rig = await openGitRig();
  coder = await rig.mission({
    policy: [
      line('github.read-code'),
      line('github.git-push'),
      line('github.feature-branch-write'),
    ],
  });
  maintainer = await rig.mission({
    policy: [
      line('github.read-code'),
      line('github.git-push'),
      line('github.feature-branch-write'),
      line(WORKFLOW_RISK),
    ],
  });
}, 60_000);

afterAll(async () => {
  await rig.close();
});

function ok(result: GitResult): GitResult {
  if (result.code !== 0) throw new Error(`git failed:\n${result.stdout}\n${result.stderr}`);
  return result;
}

async function clone(m: IssuedMission): Promise<string> {
  const dir = rig.workdir();
  ok(await rig.git(dir, ['clone', '-q', rig.remote(), 'app'], m.token));
  return join(dir, 'app');
}

async function commitAll(repo: string, message: string): Promise<string> {
  ok(await rig.git(repo, ['add', '-A'], null));
  ok(await rig.git(repo, ['commit', '-q', '-m', message], null));
  return (await rig.git(repo, ['rev-parse', 'HEAD'], null)).stdout.trim();
}

async function write(repo: string, path: string, content: string): Promise<void> {
  mkdirSync(join(repo, path, '..'), { recursive: true });
  writeFileSync(join(repo, path), content);
}

/** Everything the door sent to GitHub's git endpoint that writes: receive-pack posts. */
function receivePackPosts(): number {
  return rig.host.requests.filter(
    (r) => r.host === 'git' && r.method === 'POST' && r.path.endsWith('/git-receive-pack'),
  ).length;
}

async function lastPush(m: IssuedMission): Promise<AuditCallRecord | undefined> {
  return (await rig.root.store.audit.list({ missionId: m.mission.id }))
    .filter((e): e is AuditCallRecord => e.kind === 'call' && e.tool === PUSH)
    .at(-1);
}

/**
 * `change` on a new branch `branch` cut from main, pushed by `m`: the result,
 * whether the branch exists at GitHub after, and how many receive-pack posts
 * reached GitHub.
 */
async function pushChange(
  m: IssuedMission,
  branch: string,
  change: (repo: string) => Promise<void>,
): Promise<{ result: GitResult; created: boolean; posts: number }> {
  const repo = await clone(m);
  ok(await rig.git(repo, ['checkout', '-q', '-b', branch], null));
  await change(repo);
  await commitAll(repo, branch);
  const before = receivePackPosts();
  const result = await rig.git(repo, ['push', 'origin', branch], m.token);
  return {
    result,
    created: (await rig.host.refOf(REPOSITORY, `refs/heads/${branch}`)) !== null,
    posts: receivePackPosts() - before,
  };
}

function expectRefusedBeforeUpstream(outcome: {
  result: GitResult;
  created: boolean;
  posts: number;
}): void {
  expect(outcome.result.code).not.toBe(0);
  expect(outcome.result.stderr).toContain(REFUSED);
  expect(outcome.created).toBe(false);
  // Nothing was sent: not even the pack under a temporary ref.
  expect(outcome.posts).toBe(0);
}

describe('a mission without workflow-write-via-file: refused before any byte leaves', () => {
  it('modifying ci.yml and release.yml on a feature branch (the defect of 2026-10-16)', async () => {
    const outcome = await pushChange(coder, 'feature/ci-rewrite', async (repo) => {
      await write(repo, '.github/workflows/ci.yml', 'name: ci\non: push\njobs: { x: {} }\n');
      await write(repo, '.github/workflows/release.yml', 'name: release\non: push\n');
    });
    expectRefusedBeforeUpstream(outcome);
    const refusal = await lastPush(coder);
    expect(refusal?.decision).toBe('refused');
    expect(refusal?.risks_touched).toContain(WORKFLOW_RISK);
    const refs = Object.keys(await rig.host.refs(REPOSITORY));
    expect(refs.filter((r) => r.startsWith('refs/vaubaan/'))).toEqual([]);
  });

  it('adding a workflow', async () => {
    expectRefusedBeforeUpstream(
      await pushChange(coder, 'feature/ci-add', (repo) =>
        write(repo, '.github/workflows/new.yml', 'on: push\n'),
      ),
    );
  });

  it('deleting a workflow', async () => {
    expectRefusedBeforeUpstream(
      await pushChange(coder, 'feature/ci-delete', async (repo) => {
        rmSync(join(repo, '.github/workflows/ci.yml'));
      }),
    );
  });

  it('a revert of the workflows to an older tree', async () => {
    // main's CI moves at GitHub, outside any mission.
    const seed = rig.workdir();
    ok(await rig.git(seed, ['clone', '-q', rig.host.bare(REPOSITORY), 'w'], null));
    const work = join(seed, 'w');
    const before = (await rig.git(work, ['rev-parse', 'HEAD'], null)).stdout.trim();
    await write(work, '.github/workflows/ci.yml', 'name: ci-fixed\non: push\njobs: {}\n');
    await commitAll(work, 'ci fixed');
    ok(await rig.git(work, ['push', '-q', 'origin', 'main'], null));
    expectRefusedBeforeUpstream(
      await pushChange(coder, 'feature/ci-revert', async (repo) => {
        ok(await rig.git(repo, ['checkout', '-q', before, '--', '.github/workflows'], null));
      }),
    );
  });

  it('a garbled pack is refused as a workflow change, nothing relayed', async () => {
    const main = (await rig.host.refOf(REPOSITORY, 'refs/heads/main'))!;
    const forged = 'e'.repeat(40);
    const before = receivePackPosts();
    const answer = await rig.rawPush(
      coder.token,
      concatBytes([
        encodeCommandList(
          [{ old: null, new: forged, ref: 'refs/heads/feature/garbled' }],
          ['report-status'],
        ),
        new TextEncoder().encode(`PACK not a pack ${main}`),
      ]),
    );
    const refused = answer.refs.get('refs/heads/feature/garbled');
    expect(refused?.ok).toBe(false);
    expect(refused && !refused.ok ? refused.error : '').toContain(REFUSED);
    expect(receivePackPosts()).toBe(before);
  });

  it('GitHub failing to answer the inspection: refused, nothing relayed', async () => {
    rig.host.databaseStatus = 503;
    try {
      expectRefusedBeforeUpstream(
        await pushChange(coder, 'feature/plain-outage', (repo) =>
          write(repo, 'src/outage.ts', 'x\n'),
        ),
      );
    } finally {
      rig.host.databaseStatus = null;
    }
  });
});

describe('what the inspection lets through', () => {
  it('the same mission pushes a change outside .github/workflows/', async () => {
    const outcome = await pushChange(coder, 'feature/plain', (repo) =>
      write(repo, 'src/plain.ts', 'export const plain = 1;\n'),
    );
    expect(outcome.result.code, outcome.result.stderr).toBe(0);
    expect(outcome.created).toBe(true);
    expect([...((await lastPush(coder))?.risks_touched ?? [])].sort()).toEqual([
      'github.feature-branch-write',
      'github.git-push',
    ]);
  });

  it('a mission holding workflow-write-via-file pushes the workflow change', async () => {
    const outcome = await pushChange(maintainer, 'feature/ci-allowed', (repo) =>
      write(repo, '.github/workflows/ci.yml', 'name: ci\non: push\njobs: { y: {} }\n'),
    );
    expect(outcome.result.code, outcome.result.stderr).toBe(0);
    expect(outcome.created).toBe(true);
    const push = await lastPush(maintainer);
    expect(push?.decision).toBe('allowed');
    expect(push?.risks_touched).toContain(WORKFLOW_RISK);
  });
});
