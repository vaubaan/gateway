/**
 * The dogfood refusal of 2026-10-16 (ADR gateway-as-git-remote D4 ter): a new
 * branch cut from `main` after `v5` was merged into it, pushed once `main` had
 * moved on. The nearest branch heads in its history, by commit date, were old
 * `v5` work branches — each comparison bringing the 1762-file merge commit,
 * which the per-commit review refused ("changes 300 or more files and cannot
 * be reviewed") — while the default branch brought one commit. The default
 * branch is now always a candidate base: only the new commit is reviewed.
 * Real git against `git http-backend`; nothing reaches github.com.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { AuditCallRecord } from '../../../src/server/store';
import type { IssuedMission } from '../../../src/server/execution/testing';
import { openGitRig, REPOSITORY, type GitResult, type GitRig } from './support';

const PUSH = 'github__git_push';
/** The merge brings more files than a commit may list to be reviewed (300). */
const MANY = 320;

let rig: GitRig;
let developer: IssuedMission;
let upstreamWork: string;
/** `main` just after the merge of `v5`: where the agent cuts its branch. */
let mergedMain: string;

function ok(result: GitResult): GitResult {
  if (result.code !== 0) throw new Error(`git failed:\n${result.stdout}\n${result.stderr}`);
  return result;
}

function write(dir: string, path: string, content: string): void {
  mkdirSync(join(dir, path, '..'), { recursive: true });
  writeFileSync(join(dir, path), content);
}

async function commitAll(repo: string, message: string): Promise<string> {
  ok(await rig.git(repo, ['add', '-A'], null));
  ok(await rig.git(repo, ['commit', '-q', '-m', message], null));
  return (await rig.git(repo, ['rev-parse', 'HEAD'], null)).stdout.trim();
}

const up = (args: string[]) => rig.git(upstreamWork, args, null);

beforeAll(async () => {
  rig = await openGitRig();
  developer = await rig.mission({ preset: 'developer' });
  const dir = rig.workdir();
  ok(await rig.git(dir, ['clone', '-q', rig.host.bare(REPOSITORY), 'up'], null));
  upstreamWork = join(dir, 'up');
  // `v5` adds many files; two work branches on it stay at GitHub after it.
  ok(await up(['checkout', '-q', '-b', 'v5']));
  for (let i = 0; i < MANY; i += 1) write(upstreamWork, `v5/f${i}.txt`, `v5 ${i}\n`);
  await commitAll(upstreamWork, 'v5 begins');
  for (const branch of ['fix/v5-sec-1', 'fix/v5-sec-2']) {
    ok(await up(['checkout', '-q', '-b', branch, 'v5']));
    write(upstreamWork, `${branch}.txt`, branch);
    await commitAll(upstreamWork, branch);
    ok(await up(['checkout', '-q', 'v5']));
    ok(await up(['merge', '-q', '--no-ff', '--no-edit', branch]));
    ok(await up(['push', '-q', 'origin', branch]));
  }
  ok(await up(['push', '-q', 'origin', 'v5']));
  // `main` goes on a little, then `v5` is merged into it: 320+ files against its first parent.
  ok(await up(['checkout', '-q', 'main']));
  write(upstreamWork, 'v4.txt', 'v4\n');
  await commitAll(upstreamWork, 'main goes on');
  ok(await up(['merge', '-q', '--no-ff', '--no-edit', 'v5']));
  mergedMain = (await up(['rev-parse', 'HEAD'])).stdout.trim();
  ok(await up(['push', '-q', 'origin', 'main']));
}, 120_000);

afterAll(async () => {
  await rig.close();
});

describe('a new branch on top of a large merge already at GitHub', () => {
  it('is reviewed on its own commit only, even once main has moved on', async () => {
    const dir = rig.workdir();
    ok(await rig.git(dir, ['clone', '-q', rig.remote(), 'app'], developer.token));
    const repo = join(dir, 'app');
    ok(await rig.git(repo, ['checkout', '-q', '-b', 'fix/after-merge', mergedMain], null));
    write(repo, 'src/fix.ts', 'export const fix = 1;\n');
    const sha = await commitAll(repo, 'fix');
    // main moves at GitHub: the agent's base is no branch head any more.
    write(upstreamWork, 'later.txt', 'later\n');
    await commitAll(upstreamWork, 'main moves');
    ok(await up(['push', '-q', 'origin', 'main']));

    const result = await rig.git(repo, ['push', 'origin', 'fix/after-merge'], developer.token);
    expect(result.stderr).not.toContain('cannot be reviewed');
    expect(result.code, result.stderr).toBe(0);
    expect(await rig.host.refOf(REPOSITORY, 'refs/heads/fix/after-merge')).toBe(sha);
    const push = (await rig.root.store.audit.list({ missionId: developer.mission.id }))
      .filter((e): e is AuditCallRecord => e.kind === 'call' && e.tool === PUSH)
      .at(-1);
    expect(push?.decision).toBe('allowed');
    expect([...(push?.risks_touched ?? [])].sort()).toEqual([
      'github.feature-branch-write',
      'github.git-push',
    ]);
  });
});
