/**
 * The pack reader of the git remote (ADR git-push-inspected-before-it-leaves):
 * packs written by the real `git pack-objects`, then garbled, truncated,
 * thinned and over its limits. An object is found only under the id its
 * content hashes to; the reader never throws.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import {
  applyDelta,
  DEFAULT_PACK_READ_LIMITS,
  objectId,
  parseCommit,
  parseTag,
  parseTree,
  readPackObjects,
} from '../../src/git/pack.ts';

let dir: string;
let home: string;

function env(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: home,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'T',
    GIT_AUTHOR_EMAIL: 't@example.test',
    GIT_COMMITTER_NAME: 'T',
    GIT_COMMITTER_EMAIL: 't@example.test',
  };
}

function git(args: readonly string[], input?: string): string {
  return execFileSync('git', args, { cwd: dir, env: env(), input, maxBuffer: 64 << 20 })
    .toString('latin1')
    .trim();
}

function gitBytes(args: readonly string[], input: string): Uint8Array {
  return new Uint8Array(
    execFileSync('git', args, { cwd: dir, env: env(), input, maxBuffer: 64 << 20 }),
  );
}

function commitFiles(files: Readonly<Record<string, string>>, message: string): string {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  git(['add', '-A']);
  git(['commit', '-q', '-m', message]);
  return git(['rev-parse', 'HEAD']);
}

/** Every object `rev-list --objects` lists for `revs`, with its type. */
function objectsOf(revs: string): Map<string, string> {
  const list = git(['rev-list', '--objects', '--stdin'], revs)
    .split('\n')
    .map((l) => l.split(' ')[0]!)
    .filter(Boolean);
  const types = git(
    ['cat-file', '--batch-check=%(objectname) %(objecttype)'],
    `${list.join('\n')}\n`,
  );
  return new Map(types.split('\n').map((l) => l.split(' ') as [string, string]));
}

const many = (tag: string) =>
  Object.fromEntries(
    Array.from({ length: 200 }, (_, i) => [`src/f${i}.txt`, `${'line\n'.repeat(40)}${tag}-${i}\n`]),
  );

let base: string;
let tip: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'vaubaan-pack-'));
  home = mkdtempSync(join(tmpdir(), 'vaubaan-pack-home-'));
  git(['init', '-q', '--initial-branch=main', '.']);
  base = commitFiles({ ...many('a'), '.github/workflows/ci.yml': 'name: ci\n' }, 'base');
  commitFiles({ 'src/f1.txt': `${'line\n'.repeat(40)}changed\n` }, 'second');
  tip = commitFiles({ '.github/workflows/ci.yml': 'name: ci2\n' }, 'tip');
  git(['tag', '-a', 'v1', '-m', 'release']);
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

describe('readPackObjects', () => {
  test('a full pack with offset deltas: every commit, tree and tag under the id git gives it', async () => {
    const pack = gitBytes(
      ['pack-objects', '--stdout', '--revs', '--delta-base-offset', '-q'],
      'v1\n',
    );
    const objects = await readPackObjects(pack);
    expect(objects.complete).toBe(true);
    const expected = objectsOf('v1\n');
    expected.set(git(['rev-parse', 'v1']), 'tag');
    for (const [oid, type] of expected) {
      if (type === 'blob') expect(objects.get(oid)).toBeUndefined();
      else expect(objects.get(oid)?.type, `${type} ${oid}`).toBe(type);
    }
    const commit = parseCommit(objects.get(tip)!.body);
    expect(commit?.tree).toBe(git(['rev-parse', `${tip}^{tree}`]));
    expect(commit?.parents).toEqual([git(['rev-parse', `${tip}~1`])]);
    expect(parseTag(objects.get(git(['rev-parse', 'v1']))!.body)).toEqual({
      object: tip,
      type: 'commit',
    });
  });

  test('a pack with ref deltas (no offset deltas): every commit and tree resolved', async () => {
    const pack = gitBytes(['pack-objects', '--stdout', '--revs', '-q'], `${tip}\n`);
    const objects = await readPackObjects(pack);
    // Blob chains by ref are not followed (their bodies are never kept): only blobs.
    for (const [oid, type] of objectsOf(`${tip}\n`)) {
      if (type !== 'blob') expect(objects.get(oid)?.type, `${type} ${oid}`).toBe(type);
    }
  });

  test('a thin pack: what deltas against a left-out object is missing, and the read is incomplete', async () => {
    const pack = gitBytes(
      ['pack-objects', '--stdout', '--revs', '--thin', '--delta-base-offset', '-q'],
      `${tip}~1\n^${base}\n`,
    );
    const objects = await readPackObjects(pack);
    expect(objects.get(git(['rev-parse', `${tip}~1`]))?.type).toBe('commit');
    // `src` (200 entries, one changed) is a delta against the left-out one.
    expect(objects.get(git(['rev-parse', `${tip}~1:src`]))).toBeUndefined();
    expect(objects.complete).toBe(false);
  });

  test('an empty body is an empty, complete pack', async () => {
    const objects = await readPackObjects(new Uint8Array(0));
    expect(objects.size).toBe(0);
    expect(objects.complete).toBe(true);
  });

  test('garbled, truncated or foreign bytes never throw and never yield a wrong object', async () => {
    const pack = gitBytes(['pack-objects', '--stdout', '--revs', '-q'], `${tip}\n`);
    const truncated = pack.subarray(0, Math.floor(pack.length / 2));
    const flipped = pack.slice();
    for (let i = 40; i < flipped.length; i += 97) flipped[i] = flipped[i]! ^ 0x5a;
    const foreign = new TextEncoder().encode('this is not a pack at all, not even close');
    for (const bytes of [truncated, flipped, foreign, pack.subarray(0, 11)]) {
      const objects = await readPackObjects(bytes);
      expect(objects.complete).toBe(false);
      // Whatever was read is authentic: its id is the hash of its content.
      for (const oid of objectsOf(`${tip}\n`).keys()) {
        const o = objects.get(oid);
        if (o) expect(objectId(o.type, o.body)).toBe(oid);
      }
    }
  });

  test('over a limit the read stops, incomplete, without throwing', async () => {
    const pack = gitBytes(['pack-objects', '--stdout', '--revs', '-q'], `${tip}\n`);
    for (const limits of [
      { ...DEFAULT_PACK_READ_LIMITS, maxObjectBytes: 64 },
      { ...DEFAULT_PACK_READ_LIMITS, maxInflatedBytes: 1024 },
      { ...DEFAULT_PACK_READ_LIMITS, maxKeptBytes: 512 },
      { ...DEFAULT_PACK_READ_LIMITS, maxObjects: 3 },
    ]) {
      const objects = await readPackObjects(pack, limits);
      expect(objects.complete).toBe(false);
    }
  });

  test('an object that inflates beyond its declared size is refused (no zip bomb)', async () => {
    const pack = gitBytes(['pack-objects', '--stdout', '--revs', '-q'], `${tip}\n`);
    // The first entry's header: declare a size of 1 for whatever follows.
    const lying = pack.slice();
    lying[12] = (lying[12]! & 0x70) | 0x01;
    const objects = await readPackObjects(lying);
    expect(objects.complete).toBe(false);
  });
});

describe('object bodies', () => {
  test('parseTree reads modes, names and ids; a malformed tree is null', () => {
    const tree = git(['rev-parse', `${tip}^{tree}`]);
    const body = new Uint8Array(
      execFileSync('git', ['cat-file', 'tree', tree], { cwd: dir, env: env() }),
    );
    const entries = parseTree(body)!;
    expect(entries.find((e) => e.name === '.github')).toMatchObject({ mode: '40000' });
    expect(entries.find((e) => e.name === 'src')?.oid).toBe(git(['rev-parse', `${tip}:src`]));
    expect(parseTree(body.subarray(0, body.length - 3))).toBeNull();
    expect(parseCommit(new TextEncoder().encode('not a commit'))).toBeNull();
    expect(parseTag(new TextEncoder().encode('object x'))).toBeNull();
  });

  test('applyDelta refuses a delta that reads outside its base or writes past its size', () => {
    const baseBytes = new TextEncoder().encode('hello world');
    // source size 11, target size 5, copy offset 0 size 5.
    const ok = new Uint8Array([11, 5, 0x91, 0, 5]);
    expect(new TextDecoder().decode(applyDelta(baseBytes, ok))).toBe('hello');
    expect(() => applyDelta(baseBytes, new Uint8Array([11, 5, 0x91, 9, 5]))).toThrow();
    expect(() => applyDelta(baseBytes, new Uint8Array([10, 5, 0x91, 0, 5]))).toThrow();
    expect(() => applyDelta(baseBytes, new Uint8Array([11, 2, 3, 0x61, 0x62, 0x63]))).toThrow();
    expect(() => applyDelta(baseBytes, new Uint8Array([11, 1, 0]))).toThrow();
  });
});
