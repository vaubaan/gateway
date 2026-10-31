/**
 * The git remote against a hostile client (spec §4.1 ter; ADR
 * gateway-as-git-remote D4): every ref of a multi-ref push is decided (cf.
 * CVE-2025-54583, a proxy that checked only the first), the client's old ids
 * are claims checked against GitHub, ref names with tricks, duplicates,
 * capabilities the door does not implement, malformed or truncated requests,
 * a client that goes away mid-pack. Real git where git can send it; raw
 * requests where only a hostile client would.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  concatBytes,
  emptyPack,
  encodeCommandList,
  flushPkt,
  pktLine,
  type RefCommand,
} from '@vaubaan/plugin-sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { AuditCallRecord } from '../../../src/server/store';
import type { IssuedMission } from '../../../src/server/execution/testing';
import {
  DEVELOPER_TRUST_LEVELS,
  openGitRig,
  REPOSITORY,
  type GitResult,
  type GitRig,
} from './support';

const PUSH = 'github__git_push';

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

async function clone(): Promise<string> {
  const dir = rig.workdir();
  ok(await rig.git(dir, ['clone', '-q', rig.remote(), 'app'], developer.token));
  return join(dir, 'app');
}

async function commit(repo: string, path: string, content: string): Promise<string> {
  mkdirSync(join(repo, path, '..'), { recursive: true });
  writeFileSync(join(repo, path), content);
  ok(await rig.git(repo, ['add', '-A'], null));
  ok(await rig.git(repo, ['commit', '-q', '-m', path], null));
  return (await rig.git(repo, ['rev-parse', 'HEAD'], null)).stdout.trim();
}

async function pushes(): Promise<AuditCallRecord[]> {
  return (await rig.root.store.audit.list({ missionId: developer.mission.id })).filter(
    (e): e is AuditCallRecord => e.kind === 'call' && e.tool === PUSH,
  );
}

async function temporaryRefs(): Promise<string[]> {
  return Object.keys(await rig.host.refs(REPOSITORY)).filter((r) => r.startsWith('refs/vaubaan/'));
}

function listBody(
  commands: readonly RefCommand[],
  capabilities: readonly string[] = ['report-status'],
  pack: Uint8Array = emptyPack(),
): Uint8Array {
  return concatBytes([encodeCommandList(commands, capabilities), pack]);
}

describe('multi-ref pushes: every ref is decided', () => {
  it('a feature branch pushed together with main: the whole push is refused, nothing moves', async () => {
    const repo = await clone();
    const main = await rig.host.refOf(REPOSITORY, 'refs/heads/main');
    ok(await rig.git(repo, ['checkout', '-q', '-b', 'feature/m1'], null));
    await commit(repo, 'm1.txt', 'm1');
    ok(await rig.git(repo, ['checkout', '-q', 'main'], null));
    await commit(repo, 'main.txt', 'main');
    // main second: a proxy that looks at the first ref only would let it through.
    const result = await rig.git(repo, ['push', 'origin', 'feature/m1', 'main'], developer.token);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('[remote rejected] feature/m1 -> feature/m1');
    expect(result.stderr).toContain('[remote rejected] main -> main');
    expect(result.stderr).toContain('github.merge-protected');
    expect(await rig.host.refOf(REPOSITORY, 'refs/heads/main')).toBe(main);
    expect(await rig.host.refOf(REPOSITORY, 'refs/heads/feature/m1')).toBeNull();
    expect(await temporaryRefs()).toEqual([]);
  });

  it('two feature branches in one push: one decision, one audit entry, both move', async () => {
    const repo = await clone();
    ok(await rig.git(repo, ['checkout', '-q', '-b', 'feature/m2'], null));
    const m2 = await commit(repo, 'm2.txt', 'm2');
    ok(await rig.git(repo, ['checkout', '-q', '-b', 'feature/m3'], null));
    const m3 = await commit(repo, 'm3.txt', 'm3');
    const before = (await pushes()).length;
    ok(await rig.git(repo, ['push', 'origin', 'feature/m2', 'feature/m3'], developer.token));
    expect(await rig.host.refOf(REPOSITORY, 'refs/heads/feature/m2')).toBe(m2);
    expect(await rig.host.refOf(REPOSITORY, 'refs/heads/feature/m3')).toBe(m3);
    expect((await pushes()).length).toBe(before + 1);
  });

  it('a tag the mission may not push, second in the list, refuses the branch with it', async () => {
    const repo = await clone();
    ok(await rig.git(repo, ['checkout', '-q', '-b', 'feature/m4'], null));
    await commit(repo, 'm4.txt', 'm4');
    ok(await rig.git(repo, ['tag', 'v0.0.4'], null));
    const result = await rig.git(repo, ['push', 'origin', 'feature/m4', 'v0.0.4'], developer.token);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('github.tag-write');
    expect(await rig.host.refOf(REPOSITORY, 'refs/heads/feature/m4')).toBeNull();
  });
});

describe('what the door does not implement is refused, never ignored', () => {
  it('git itself refuses --atomic and push options: they are not advertised', async () => {
    const repo = await clone();
    ok(await rig.git(repo, ['checkout', '-q', '-b', 'feature/atomic'], null));
    await commit(repo, 'a.txt', 'a');
    const atomic = await rig.git(
      repo,
      ['push', '--atomic', 'origin', 'feature/atomic'],
      developer.token,
    );
    expect(atomic.code).not.toBe(0);
    expect(atomic.stderr).toMatch(/does not support --atomic/);
    const options = await rig.git(
      repo,
      ['push', '-o', 'ci.skip', 'origin', 'feature/atomic'],
      developer.token,
    );
    expect(options.code).not.toBe(0);
    expect(options.stderr).toMatch(/does not support push options/);
  });

  it.each([
    ['atomic'],
    ['push-options'],
    ['report-status-v2'],
    ['object-format=sha256'],
    ['x-new'],
  ])('a raw push asking for %s is refused', async (capability) => {
    const main = (await rig.host.refOf(REPOSITORY, 'refs/heads/main'))!;
    const answer = await rig.rawPush(
      developer.token,
      listBody(
        [{ old: null, new: main, ref: 'refs/heads/feature/cap' }],
        ['report-status', capability],
      ),
    );
    expect(answer.err).toContain('is not supported by this git remote');
    expect(await rig.host.refOf(REPOSITORY, 'refs/heads/feature/cap')).toBeNull();
  });
});

describe('ref names and lists a hostile client sends', () => {
  it.each([
    'refs/heads/../main',
    'refs/heads/a..b',
    'refs/heads/x.lock',
    'refs/heads/@{-1}',
    'refs/heads/a/.hidden',
    'refs/heads//double',
    'refs/heads/trailing.',
    'refs/heads/sp ace',
    'refs/heads/ctl\u0001',
    'refs/heads/star*',
    'HEAD',
    'refs/remotes/origin/main',
    'refs/vaubaan/m/n/0',
    'refs/heads/refs/heads/main',
  ])('%s is never created', async (ref) => {
    const main = (await rig.host.refOf(REPOSITORY, 'refs/heads/main'))!;
    const answer = await rig.rawPush(developer.token, listBody([{ old: null, new: main, ref }]));
    expect(answer.refs.get(ref)?.ok ?? false).toBe(false);
    expect(Object.keys(await rig.host.refs(REPOSITORY))).not.toContain(ref);
    expect(await temporaryRefs()).toEqual([]);
  });

  it('the same ref twice is refused', async () => {
    const main = (await rig.host.refOf(REPOSITORY, 'refs/heads/main'))!;
    const answer = await rig.rawPush(
      developer.token,
      listBody([
        { old: null, new: main, ref: 'refs/heads/feature/dup' },
        { old: null, new: main, ref: 'refs/heads/feature/dup' },
      ]),
    );
    expect(answer.err).toContain('is updated twice in one push');
  });

  it('more refs than a push may carry is refused', async () => {
    const main = (await rig.host.refOf(REPOSITORY, 'refs/heads/main'))!;
    const commands = Array.from({ length: 51 }, (_, i) => ({
      old: null,
      new: main,
      ref: `refs/heads/feature/n${i}`,
    }));
    const answer = await rig.rawPush(developer.token, listBody(commands));
    expect(answer.err).toContain('at most 50 refs');
  });

  it.each([
    ['a list that never ends', pktLine(`${'0'.repeat(40)} ${'a'.repeat(40)} refs/heads/x`)],
    ['a stream cut inside a pkt-line', new TextEncoder().encode('00a0abc')],
    ['an impossible pkt-line length', new TextEncoder().encode('ffff')],
    ['a length that is not hex', new TextEncoder().encode('zz00')],
    // `0000` alone is git's credential probe (answered empty, not a call); with a pack after it, a push without commands.
    ['no command at all', concatBytes([flushPkt(), emptyPack()])],
  ])('%s is answered with an error line and audited', async (_name, body) => {
    const before = (await pushes()).length;
    const answer = await rig.rawPush(developer.token, body);
    expect(answer.err).toMatch(/could not be read/);
    const after = await pushes();
    expect(after.length).toBe(before + 1);
    expect(after.at(-1)).toMatchObject({ decision: 'refused' });
  });
});

describe("the client's old ids are claims", () => {
  it('a push that claims a later old id to hide a workflow change is refused as stale', async () => {
    const repo = await clone();
    ok(await rig.git(repo, ['checkout', '-q', '-b', 'feature/lie'], null));
    const base = await commit(repo, 'lie.txt', 'base');
    ok(await rig.git(repo, ['push', '-q', 'origin', 'feature/lie'], developer.token));
    // W changes a workflow (approval in `developer`); N comes after it.
    const w = await commit(repo, '.github/workflows/ci.yml', 'name: evil\non: push\njobs: {}\n');
    const n = await commit(repo, 'after.txt', 'after');
    const pack = await rig.packOf(repo, [n, `^${base}`]);
    // The truth is `base`; the client claims `w`, so that w..n holds no workflow file.
    const answer = await rig.rawPush(
      developer.token,
      listBody([{ old: w, new: n, ref: 'refs/heads/feature/lie' }], ['report-status'], pack),
    );
    expect(answer.refs.get('refs/heads/feature/lie')).toMatchObject({ ok: false });
    const error = (answer.refs.get('refs/heads/feature/lie') as { error: string }).error;
    expect(error).toContain('stale info');
    expect(await rig.host.refOf(REPOSITORY, 'refs/heads/feature/lie')).toBe(base);
    expect(await temporaryRefs()).toEqual([]);
  });

  it('a create of a ref that already exists is refused as stale', async () => {
    const main = (await rig.host.refOf(REPOSITORY, 'refs/heads/main'))!;
    const answer = await rig.rawPush(
      developer.token,
      listBody([{ old: null, new: main, ref: 'refs/heads/feature/m2' }]),
    );
    const status = answer.refs.get('refs/heads/feature/m2');
    expect(status).toMatchObject({ ok: false });
    expect((status as { error: string }).error).toContain('already exists');
  });
});

describe('temporary refs are cleaned up on every path', () => {
  it('a client that goes away in the middle of the pack leaves nothing at GitHub', async () => {
    const repo = await clone();
    ok(await rig.git(repo, ['checkout', '-q', '-b', 'feature/gone'], null));
    const base = (await rig.git(repo, ['rev-parse', 'main'], null)).stdout.trim();
    const sha = await commit(repo, 'gone.txt', 'x'.repeat(10_000));
    const pack = await rig.packOf(repo, [sha, `^${base}`]);
    const head = encodeCommandList(
      [{ old: null, new: sha, ref: 'refs/heads/feature/gone' }],
      ['report-status'],
    );
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent === 0) controller.enqueue(head);
        else if (sent === 1) controller.enqueue(pack.slice(0, Math.floor(pack.length / 2)));
        else controller.error(new Error('the client hung up'));
        sent += 1;
      },
    });
    const response = await rig.root.git.handle(
      new Request(`${rig.remote()}/git-receive-pack`, {
        method: 'POST',
        headers: {
          authorization: `Basic ${Buffer.from(`m:${developer.token}`).toString('base64')}`,
          'content-type': 'application/x-git-receive-pack-request',
        },
        body,
        duplex: 'half',
      } as RequestInit),
    );
    await response.arrayBuffer().catch(() => undefined);
    expect(await rig.host.refOf(REPOSITORY, 'refs/heads/feature/gone')).toBeNull();
    expect(await temporaryRefs()).toEqual([]);
    expect(await rig.root.store.pendingRefs.listFor(developer.mission.id, REPOSITORY)).toEqual([]);
  });

  it('a temporary ref whose push never finished is swept once its deadline passed', async () => {
    const main = (await rig.host.refOf(REPOSITORY, 'refs/heads/main'))!;
    const stray = `refs/vaubaan/${'de'.repeat(16)}`;
    await rig.host.git(REPOSITORY, ['update-ref', stray, main]);
    await rig.root.store.pendingRefs.add([
      {
        ref: stray,
        targetRef: 'refs/heads/feature/stray',
        connectionId: rig.github.id,
        repository: REPOSITORY,
        missionId: developer.mission.id,
        objectId: main,
        expiresAt: '2020-01-01T00:00:00.000Z',
      },
    ]);
    expect(await rig.root.git.sweeper.runOnce()).toBe(1);
    expect(await rig.host.refOf(REPOSITORY, stray)).toBeNull();
  });
});

describe('fetch with every protocol version', () => {
  it.each(['0', '1', '2'])('clones with protocol.version=%s', async (version) => {
    const dir = rig.workdir();
    ok(
      await rig.git(dir, ['clone', '-q', rig.remote(), 'app'], developer.token, {
        'protocol.version': version,
      }),
    );
    expect((await rig.git(join(dir, 'app'), ['log', '--oneline', '-1'], null)).code).toBe(0);
  });
});
