/**
 * Regression tests of the adversarial review of the git remote (2026-10-14,
 * `.vaubaan/reports/git-review/review.md`): each reproduction of a confirmed
 * finding, now holding the other way, and the signed commit the owner asked
 * about. Real git against `git http-backend`; nothing reaches github.com.
 */
import { gzipSync } from 'node:zlib';
import { execFile } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

import {
  concatBytes,
  emptyPack,
  encodeCommandList,
  flushPkt,
  pktLine,
  type RefCommand,
} from '@vaubaan/plugin-sdk/git';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { MAX_TEMPORARY_REFS_PER_MISSION } from '../../../src/server/git';
import type { AuditCallRecord } from '../../../src/server/store';
import { line, type IssuedMission } from '../../support/execution/testing';
import { isolatedGitEnv } from './fake-github-host';
import {
  DEVELOPER_TRUST_LEVELS,
  openGitRig,
  REPOSITORY,
  type GitResult,
  type GitRig,
} from './support';

const run = promisify(execFile);
const PUSH = 'github__git_push';
const FETCH = 'github__git_fetch';

let rig: GitRig;
let developer: IssuedMission;

beforeAll(async () => {
  rig = await openGitRig();
  developer = await rig.mission({ trustLevels: DEVELOPER_TRUST_LEVELS });
}, 60_000);

afterAll(async () => {
  await rig.close();
});

function ok(result: GitResult): GitResult {
  if (result.code !== 0) throw new Error(`git failed:\n${result.stdout}\n${result.stderr}`);
  return result;
}

async function clone(m: IssuedMission = developer): Promise<string> {
  const dir = rig.workdir();
  ok(await rig.git(dir, ['clone', '-q', rig.remote(), 'app'], m.token));
  return join(dir, 'app');
}

async function commit(repo: string, path: string, content: string): Promise<string> {
  mkdirSync(join(repo, path, '..'), { recursive: true });
  writeFileSync(join(repo, path), content);
  ok(await rig.git(repo, ['add', '-A'], null));
  ok(await rig.git(repo, ['commit', '-q', '-m', path], null));
  return (await rig.git(repo, ['rev-parse', 'HEAD'], null)).stdout.trim();
}

async function callsOf(m: IssuedMission, tool: string): Promise<AuditCallRecord[]> {
  return (await rig.root.store.audit.list({ missionId: m.mission.id })).filter(
    (e): e is AuditCallRecord => e.kind === 'call' && e.tool === tool,
  );
}

function receivePackPosts(): number {
  return rig.host.requests.filter(
    (r) => r.host === 'git' && r.method === 'POST' && r.path.endsWith('/git-receive-pack'),
  ).length;
}

function listBody(
  commands: readonly RefCommand[],
  capabilities: readonly string[] = ['report-status'],
  pack: Uint8Array = emptyPack(),
): Uint8Array {
  return concatBytes([encodeCommandList(commands, capabilities), pack]);
}

const basic = (m: IssuedMission) => `Basic ${Buffer.from(`m:${m.token}`).toString('base64')}`;

describe('F1 — a push its limits refuse uploads nothing', () => {
  it('budget exhausted: refused with the claim URL, no receive-pack at GitHub', async () => {
    const mission = await rig.mission({
      policy: [
        line('github.read-code'),
        line('github.git-push', 1),
        line('github.feature-branch-write'),
      ],
    });
    const repo = await clone(mission);
    ok(await rig.git(repo, ['checkout', '-q', '-b', 'feature/f1a'], null));
    await commit(repo, 'one.txt', '1');
    ok(await rig.git(repo, ['push', '-q', 'origin', 'feature/f1a'], mission.token));
    await commit(repo, 'two.txt', '2');
    const before = receivePackPosts();
    const result = await rig.git(repo, ['push', 'origin', 'feature/f1a'], mission.token);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('limit of github.git-push reached');
    expect(receivePackPosts()).toBe(before);
    expect((await callsOf(mission, PUSH)).at(-1)?.refusal_code).toBe('budget-exhausted');
  });

  it('rate limited: refused, no receive-pack at GitHub', async () => {
    const mission = await rig.mission({
      policy: [
        line('github.read-code'),
        line('github.git-push', 100, { rate_limit: { max: 1, window_seconds: 600 } }),
        line('github.feature-branch-write'),
      ],
    });
    const repo = await clone(mission);
    ok(await rig.git(repo, ['checkout', '-q', '-b', 'feature/f1b'], null));
    await commit(repo, 'one.txt', '1');
    ok(await rig.git(repo, ['push', '-q', 'origin', 'feature/f1b'], mission.token));
    await commit(repo, 'two.txt', '2');
    const before = receivePackPosts();
    const result = await rig.git(repo, ['push', 'origin', 'feature/f1b'], mission.token);
    expect(result.stderr).toContain('too many actions');
    expect(receivePackPosts()).toBe(before);
  });
});

describe('F2 — temporary refs', () => {
  it('a ref GitHub refuses to delete keeps its row; the sweeper does not block on it', async () => {
    const main = (await rig.host.refOf(REPOSITORY, 'refs/heads/main'))!;
    const repo = await clone();
    ok(await rig.git(repo, ['checkout', '-q', '-b', 'feature/f2a'], null));
    const other = await commit(repo, 'f2a.txt', 'x');
    ok(await rig.git(repo, ['push', '-q', 'origin', 'feature/f2a'], developer.token));
    // The ref points at `main`, the row claims `other`: GitHub refuses the swap.
    const stray = `refs/vaubaan/${'ab'.repeat(16)}`;
    await rig.host.git(REPOSITORY, ['update-ref', stray, main]);
    await rig.root.store.pendingRefs.add([
      {
        ref: stray,
        targetRef: 'refs/heads/feature/f2a',
        accountId: rig.github.id,
        repository: REPOSITORY,
        missionId: developer.mission.id,
        objectId: other,
        expiresAt: '2020-01-01T00:00:00.000Z',
      },
    ]);
    expect(await rig.root.git.sweeper.runOnce()).toBe(0);
    expect(await rig.host.refOf(REPOSITORY, stray)).toBe(main);
    const [row] = (
      await rig.root.store.pendingRefs.listFor(developer.mission.id, REPOSITORY)
    ).filter((r) => r.ref === stray);
    // Postponed to the back of the queue, not dropped.
    expect(Date.parse(row!.expiresAt)).toBeGreaterThan(Date.now());
    await rig.host.git(REPOSITORY, ['update-ref', '-d', stray]);
    await rig.root.store.pendingRefs.remove([stray]);
  });

  it('a later push to the same ref supersedes the one waiting for approval', async () => {
    const mission = await rig.mission({
      policy: [
        line('github.read-code'),
        line('github.git-push'),
        line('github.feature-branch-write', 100, { gate: 'approval' }),
      ],
    });
    const repo = await clone(mission);
    ok(await rig.git(repo, ['checkout', '-q', '-b', 'feature/f2c'], null));
    await commit(repo, 'first.txt', '1');
    expect(
      (await rig.git(repo, ['push', 'origin', 'feature/f2c'], mission.token)).stderr,
    ).toContain('approval required');
    const [first] = await rig.root.store.pendingRefs.listFor(mission.mission.id, REPOSITORY);
    const second = await commit(repo, 'second.txt', '2');
    expect(
      (await rig.git(repo, ['push', 'origin', 'feature/f2c'], mission.token)).stderr,
    ).toContain('approval required');
    const rows = await rig.root.store.pendingRefs.listFor(mission.mission.id, REPOSITORY);
    expect(rows.map((r) => r.objectId)).toEqual([second]);
    expect(await rig.host.refOf(REPOSITORY, first!.ref)).toBeNull();
  });

  it(`a mission holds at most ${MAX_TEMPORARY_REFS_PER_MISSION} temporary refs`, async () => {
    const mission = await rig.mission({ trustLevels: DEVELOPER_TRUST_LEVELS });
    const main = (await rig.host.refOf(REPOSITORY, 'refs/heads/main'))!;
    const far = new Date(Date.now() + 3_600_000).toISOString();
    const held = Array.from({ length: MAX_TEMPORARY_REFS_PER_MISSION }, (_, i) => ({
      ref: `refs/vaubaan/${String(i).padStart(32, '0')}`,
      targetRef: `refs/heads/feature/held-${i}`,
      accountId: rig.github.id,
      repository: REPOSITORY,
      missionId: mission.mission.id,
      objectId: main,
      expiresAt: far,
    }));
    await rig.root.store.pendingRefs.add(held);
    const repo = await clone(mission);
    ok(await rig.git(repo, ['checkout', '-q', '-b', 'feature/f2d'], null));
    await commit(repo, 'f2d.txt', 'x');
    const before = receivePackPosts();
    const result = await rig.git(repo, ['push', 'origin', 'feature/f2d'], mission.token);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain(
      `already holds ${MAX_TEMPORARY_REFS_PER_MISSION} temporary refs`,
    );
    expect(receivePackPosts()).toBe(before);
    await rig.root.store.pendingRefs.remove(held.map((r) => r.ref));
  });
});

describe('F3 / F4 — the command list is judged whole', () => {
  it('a capability on the second command line is refused, not dropped', async () => {
    const main = (await rig.host.refOf(REPOSITORY, 'refs/heads/main'))!;
    const answer = await rig.rawPush(
      developer.token,
      concatBytes([
        pktLine(`${'0'.repeat(40)} ${main} refs/heads/feature/f3a\0report-status`),
        pktLine(`${'0'.repeat(40)} ${main} refs/heads/feature/f3b\0atomic push-options`),
        flushPkt(),
        emptyPack(),
      ]),
    );
    expect(answer.err).toContain("the capability 'atomic' is not supported");
    expect(await rig.host.refOf(REPOSITORY, 'refs/heads/feature/f3a')).toBeNull();
  });

  it('a push without report-status is refused with an error line, not an empty 200', async () => {
    const main = (await rig.host.refOf(REPOSITORY, 'refs/heads/main'))!;
    const answer = await rig.rawPush(
      developer.token,
      listBody([{ old: main, new: main, ref: 'refs/heads/main' }], []),
    );
    expect(answer.err).toContain('requires the report-status capability');
  });
});

describe('F5 — temporary refs are not listed to fetches', () => {
  it('another mission lists no refs/vaubaan/* (v2 and v0), and the names carry no mission id', async () => {
    const a = await rig.mission({
      policy: [
        line('github.read-code'),
        line('github.git-push'),
        line('github.feature-branch-write', 100, { gate: 'approval' }),
      ],
    });
    const b = await rig.mission({ policy: [line('github.read-code')] });
    const repo = await clone(a);
    ok(await rig.git(repo, ['checkout', '-q', '-b', 'feature/f5'], null));
    await commit(repo, 'pending.txt', 'pending');
    expect((await rig.git(repo, ['push', 'origin', 'feature/f5'], a.token)).stderr).toContain(
      'approval required',
    );
    const pending = await rig.root.store.pendingRefs.listFor(a.mission.id, REPOSITORY);
    expect(pending).toHaveLength(1);
    expect(pending[0]!.ref).toMatch(/^refs\/vaubaan\/[0-9a-f]{32}$/);
    expect(pending[0]!.ref).not.toContain(a.mission.id);
    expect(await rig.host.refOf(REPOSITORY, pending[0]!.ref)).not.toBeNull();
    const dir = rig.workdir();
    for (const version of ['2', '0']) {
      const ls = ok(
        await rig.git(dir, ['ls-remote', rig.remote()], b.token, { 'protocol.version': version }),
      );
      expect(ls.stdout).toContain('refs/heads/main');
      expect(ls.stdout).not.toContain('refs/vaubaan/');
    }
  });
});

describe('F6 — a mission that cannot push gets no push advertisement', () => {
  it('read-only: 403 naming the permission, and no write token minted', async () => {
    const ro = await rig.mission({ policy: [line('github.read-code')] });
    const before = rig.host.minted.length;
    const res = await fetch(`${rig.remote()}/info/refs?service=git-receive-pack`, {
      headers: { authorization: basic(ro) },
    });
    expect(res.status).toBe(403);
    expect(await res.text()).toContain('permission github.git-push is not in this mission');
    expect(rig.host.minted.slice(before).some((m) => m.permissions?.contents === 'write')).toBe(
      false,
    );
  });
});

describe('F7 — every commit of the range is reviewed', () => {
  it('a workflow added then taken back inside one push asks for approval', async () => {
    const repo = await clone();
    ok(await rig.git(repo, ['checkout', '-q', '-b', 'feature/f7'], null));
    const original = 'name: ci\non: push\njobs: {}\n';
    await commit(repo, '.github/workflows/ci.yml', 'name: evil\non: push\njobs: { x: {} }\n');
    await commit(repo, '.github/workflows/ci.yml', original);
    await commit(repo, 'noise.txt', 'n');
    const result = await rig.git(repo, ['push', 'origin', 'feature/f7'], developer.token);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('approval required');
    const last = (await callsOf(developer, PUSH)).at(-1);
    expect(last?.risks_touched).toContain('github.workflow-write-via-file');
  });
});

describe('F8 — a v2 request head names exactly one command', () => {
  const v2 = (lines: string[], args: string[]) =>
    concatBytes([
      ...lines.map((l) => pktLine(`${l}\n`)),
      new TextEncoder().encode('0001'),
      ...args.map((a) => pktLine(`${a}\n`)),
      flushPkt(),
    ]);
  const post = (body: Uint8Array<ArrayBuffer>) =>
    fetch(`${rig.remote()}/git-upload-pack`, {
      method: 'POST',
      headers: {
        authorization: basic(developer),
        'content-type': 'application/x-git-upload-pack-request',
        'git-protocol': 'version=2',
      },
      body,
    });

  it('two commands are refused with an error line, and audited', async () => {
    const before = (await callsOf(developer, FETCH)).length;
    const main = (await rig.host.refOf(REPOSITORY, 'refs/heads/main'))!;
    const answer = await post(
      v2(['command=ls-refs', 'command=fetch', 'object-format=sha1'], [`want ${main}`, 'done']),
    );
    const text = Buffer.from(await answer.arrayBuffer()).toString('latin1');
    expect(text).toContain(
      'ERR this fetch could not be read: the request names more than one command',
    );
    expect(text).not.toContain('PACK');
    expect((await callsOf(developer, FETCH)).length).toBe(before + 1);
  });

  it('a gzip-compressed ls-refs is read like any other: without temporary refs', async () => {
    const answer = await fetch(`${rig.remote()}/git-upload-pack`, {
      method: 'POST',
      headers: {
        authorization: basic(developer),
        'content-type': 'application/x-git-upload-pack-request',
        'content-encoding': 'gzip',
        'git-protocol': 'version=2',
      },
      body: gzipSync(v2(['command=ls-refs', 'object-format=sha1'], ['peel'])),
    });
    const text = Buffer.from(await answer.arrayBuffer()).toString('latin1');
    expect(text).toContain('refs/heads/main');
    expect(text).not.toContain('refs/vaubaan/');
  });

  it('ls-refs with its capabilities first is a free listing, without temporary refs', async () => {
    const before = (await callsOf(developer, FETCH)).length;
    const answer = await post(v2(['object-format=sha1', 'command=ls-refs'], ['peel']));
    const text = Buffer.from(await answer.arrayBuffer()).toString('latin1');
    expect(text).toContain('refs/heads/main');
    expect(text).not.toContain('refs/vaubaan/');
    expect((await callsOf(developer, FETCH)).length).toBe(before);
  });
});

describe('a signed commit crosses the remote byte for byte', () => {
  it('an SSH-signed commit arrives at GitHub with its signature intact', async () => {
    const repo = await clone();
    const keyDir = rig.workdir();
    const key = join(keyDir, 'id_ed25519');
    await run(
      'ssh-keygen',
      ['-q', '-t', 'ed25519', '-N', '', '-C', 'agent@example.com', '-f', key],
      {
        env: isolatedGitEnv(keyDir),
      },
    );
    const signing = { 'gpg.format': 'ssh', 'user.signingkey': `${key}.pub` };
    ok(await rig.git(repo, ['checkout', '-q', '-b', 'feature/signed'], null));
    writeFileSync(join(repo, 'signed.txt'), 'signed\n');
    ok(await rig.git(repo, ['add', '-A'], null));
    ok(await rig.git(repo, ['commit', '-q', '-S', '-m', 'signed'], null, signing));
    const sha = (await rig.git(repo, ['rev-parse', 'HEAD'], null)).stdout.trim();
    const local = (await rig.git(repo, ['cat-file', 'commit', sha], null)).stdout;
    expect(local).toContain('-----BEGIN SSH SIGNATURE-----');
    ok(await rig.git(repo, ['push', '-q', 'origin', 'feature/signed'], developer.token));
    expect(await rig.host.refOf(REPOSITORY, 'refs/heads/feature/signed')).toBe(sha);
    // Same id, same bytes: nothing was rewritten on the way.
    expect(await rig.host.git(REPOSITORY, ['cat-file', 'commit', sha])).toBe(local.trimEnd());
    // Its temporary ref is gone (others in this file wait for approvals on purpose).
    const refs = await rig.host.refs(REPOSITORY);
    expect(
      Object.entries(refs).filter(([name, oid]) => name.startsWith('refs/vaubaan/') && oid === sha),
    ).toEqual([]);
  });
});
