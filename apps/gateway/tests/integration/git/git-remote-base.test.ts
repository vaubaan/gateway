/**
 * The base a push is reviewed from (ADR gateway-as-git-remote D4 ter): a
 * repository whose default branch `main` diverged massively from `v5`, the
 * branch the agent works on — the dogfood repository's shape. A push brings
 * what no branch at GitHub holds, and only that is reviewed: a new branch
 * off `v5` with one commit, a merge of a moved `v5`, a rebase onto it. And a
 * pending push, which lives under a temporary ref and not a branch, is never
 * a base. Real git against `git http-backend`; nothing reaches github.com.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { AuditCallRecord } from '../../../src/server/store';
import type { IssuedMission } from '../../support/execution/testing';
import {
  DEVELOPER_TRUST_LEVELS,
  openGitRig,
  REPOSITORY,
  type GitResult,
  type GitRig,
} from './support';

const PUSH = 'github__git_push';
/** More files than GitHub's comparison lists. */
const MANY = 320;

let rig: GitRig;
let developer: IssuedMission;
/** A working copy that writes to the bare repository directly: what is already at GitHub. */
let upstreamWork: string;

function ok(result: GitResult): GitResult {
  if (result.code !== 0) throw new Error(`git failed:\n${result.stdout}\n${result.stderr}`);
  return result;
}

function writeMany(dir: string, prefix: string, content: string): void {
  mkdirSync(join(dir, prefix), { recursive: true });
  for (let i = 0; i < MANY; i += 1)
    writeFileSync(join(dir, prefix, `f${i}.txt`), `${content} ${i}\n`);
}

async function commitAll(repo: string, message: string): Promise<string> {
  ok(await rig.git(repo, ['add', '-A'], null));
  ok(await rig.git(repo, ['commit', '-q', '-m', message], null));
  return (await rig.git(repo, ['rev-parse', 'HEAD'], null)).stdout.trim();
}

async function commitFile(repo: string, path: string, content: string): Promise<string> {
  mkdirSync(join(repo, path, '..'), { recursive: true });
  writeFileSync(join(repo, path), content);
  return commitAll(repo, path);
}

/** `v5` moves at GitHub by MANY files and a workflow change, outside any mission. */
async function advanceV5(tag: string): Promise<string> {
  ok(await rig.git(upstreamWork, ['checkout', '-q', 'v5'], null));
  ok(await rig.git(upstreamWork, ['pull', '-q', 'origin', 'v5'], null));
  writeMany(upstreamWork, `v5-${tag}`, tag);
  writeFileSync(
    join(upstreamWork, '.github/workflows/ci.yml'),
    `name: ci-${tag}\non: push\njobs: {}\n`,
  );
  const sha = await commitAll(upstreamWork, `v5 moves (${tag})`);
  ok(await rig.git(upstreamWork, ['push', '-q', 'origin', 'v5'], null));
  return sha;
}

async function clone(): Promise<string> {
  const dir = rig.workdir();
  ok(await rig.git(dir, ['clone', '-q', rig.remote(), 'app'], developer.token));
  return join(dir, 'app');
}

async function lastPush(): Promise<AuditCallRecord | undefined> {
  return (await rig.root.store.audit.list({ missionId: developer.mission.id }))
    .filter((e): e is AuditCallRecord => e.kind === 'call' && e.tool === PUSH)
    .at(-1);
}

beforeAll(async () => {
  rig = await openGitRig();
  developer = await rig.mission({ trustLevels: DEVELOPER_TRUST_LEVELS });
  // `main` (the default branch) and `v5` diverge by more than GitHub compares,
  // a workflow included — the dogfood repository: main is v4, v5 is the work.
  const dir = rig.workdir();
  ok(await rig.git(dir, ['clone', '-q', rig.host.bare(REPOSITORY), 'up'], null));
  upstreamWork = join(dir, 'up');
  ok(await rig.git(upstreamWork, ['checkout', '-q', '-b', 'v5'], null));
  writeMany(upstreamWork, 'v5', 'v5');
  writeFileSync(
    join(upstreamWork, '.github/workflows/ci.yml'),
    'name: ci-v5\non: push\njobs: {}\n',
  );
  await commitAll(upstreamWork, 'v5 begins');
  ok(await rig.git(upstreamWork, ['push', '-q', 'origin', 'v5'], null));
  ok(await rig.git(upstreamWork, ['checkout', '-q', 'main'], null));
  writeMany(upstreamWork, 'v4', 'v4');
  await commitAll(upstreamWork, 'main goes on');
  ok(await rig.git(upstreamWork, ['push', '-q', 'origin', 'main'], null));
}, 120_000);

afterAll(async () => {
  await rig.close();
});

describe('a new branch is reviewed from the branch it was built on', () => {
  it('one commit on top of v5: allowed, one commit reviewed, no workflow', async () => {
    const repo = await clone();
    ok(await rig.git(repo, ['checkout', '-q', '-b', 'feature/probe', 'origin/v5'], null));
    const sha = await commitFile(repo, 'probe.txt', 'probe\n');
    const result = await rig.git(repo, ['push', 'origin', 'feature/probe'], developer.token);
    expect(result.stderr).not.toContain('too large to review');
    expect(result.code, result.stderr).toBe(0);
    expect(await rig.host.refOf(REPOSITORY, 'refs/heads/feature/probe')).toBe(sha);
    expect([...((await lastPush())?.risks_touched ?? [])].sort()).toEqual([
      'github.feature-branch-write',
      'github.git-push',
    ]);
  });

  it('a workflow change of its own still asks first', async () => {
    const repo = await clone();
    ok(await rig.git(repo, ['checkout', '-q', '-b', 'feature/own-ci', 'origin/v5'], null));
    await commitFile(repo, '.github/workflows/mine.yml', 'name: mine\non: push\njobs: {}\n');
    const result = await rig.git(repo, ['push', 'origin', 'feature/own-ci'], developer.token);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('approval required');
    expect((await lastPush())?.risks_touched).toContain('github.workflow-write-via-file');
  });
});

describe('an update is reviewed for what no branch holds', () => {
  it('a merge of a moved v5 into a feature branch: allowed, v5’s own changes not asked again', async () => {
    const repo = await clone();
    ok(await rig.git(repo, ['checkout', '-q', '-b', 'feature/merge', 'origin/v5'], null));
    await commitFile(repo, 'merge-1.txt', '1\n');
    ok(await rig.git(repo, ['push', '-q', 'origin', 'feature/merge'], developer.token));
    await advanceV5('merge');
    ok(await rig.git(repo, ['fetch', '-q', 'origin'], developer.token));
    ok(await rig.git(repo, ['merge', '-q', '--no-edit', 'origin/v5'], null));
    const merged = (await rig.git(repo, ['rev-parse', 'HEAD'], null)).stdout.trim();
    const result = await rig.git(repo, ['push', 'origin', 'feature/merge'], developer.token);
    expect(result.code, result.stderr).toBe(0);
    expect(await rig.host.refOf(REPOSITORY, 'refs/heads/feature/merge')).toBe(merged);
    expect((await lastPush())?.risks_touched).not.toContain('github.workflow-write-via-file');
  });

  it('a rebase onto a moved v5 is a force-push that asks first, not a refusal for its size', async () => {
    const repo = await clone();
    ok(await rig.git(repo, ['checkout', '-q', '-b', 'feature/rebase', 'origin/v5'], null));
    await commitFile(repo, 'rebase-1.txt', '1\n');
    ok(await rig.git(repo, ['push', '-q', 'origin', 'feature/rebase'], developer.token));
    await advanceV5('rebase');
    ok(await rig.git(repo, ['fetch', '-q', 'origin'], developer.token));
    ok(await rig.git(repo, ['rebase', '-q', 'origin/v5'], null));
    const result = await rig.git(repo, ['push', '-f', 'origin', 'feature/rebase'], developer.token);
    expect(result.stderr).not.toContain('too large to review');
    expect(result.stderr).toContain('approval required');
    const push = await lastPush();
    expect(push?.risks_touched).toContain('github.force-push');
    expect(push?.risks_touched).not.toContain('github.workflow-write-via-file');
  });
});

describe('a pending push is never a base', () => {
  it('a branch built on a push still waiting for approval asks for the same workflow change', async () => {
    const repo = await clone();
    ok(await rig.git(repo, ['checkout', '-q', '-b', 'feature/pending', 'origin/v5'], null));
    await commitFile(repo, '.github/workflows/hidden.yml', 'name: hidden\non: push\njobs: {}\n');
    expect(
      (await rig.git(repo, ['push', 'origin', 'feature/pending'], developer.token)).stderr,
    ).toContain('approval required');
    // Its commits are at GitHub under a temporary ref only: not a branch.
    ok(await rig.git(repo, ['checkout', '-q', '-b', 'feature/on-pending'], null));
    await commitFile(repo, 'innocent.txt', 'x\n');
    const result = await rig.git(repo, ['push', 'origin', 'feature/on-pending'], developer.token);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('approval required');
    expect((await lastPush())?.risks_touched).toContain('github.workflow-write-via-file');
  });
});
