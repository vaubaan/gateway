/**
 * The inspection of a push before it leaves the gateway (ADR
 * gateway-as-git-remote): packs written by the real
 * `git pack-objects` the way `git push` writes them (every ref of the remote
 * left out), GitHub's git database served from a real bare repository. Every
 * way to change `.github/workflows/` is seen; what cannot be read counts as
 * changed. No test reaches GitHub.
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  encodeAdvertisement,
  readPackObjects,
  UPLOAD_PACK_SERVICE,
  type GitPackObjects,
  type GitRefUpdate,
} from '@vaubaan/plugin-sdk/git';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';

import { inspectPack, WORKFLOWS_UNVERIFIED } from '../../src/git-inspect.ts';
import { accountCtx, appRepo } from './fixtures.ts';

let root: string;
let home: string;
let up: string;
let work: string;

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

function gitIn(cwd: string, args: readonly string[], input?: string): string {
  return execFileSync('git', args, {
    cwd,
    env: env(),
    input,
    maxBuffer: 64 << 20,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
    .toString('utf8')
    .trim();
}
const g = (args: readonly string[], input?: string) => gitIn(work, args, input);

function write(path: string, content: string): void {
  mkdirSync(join(work, path, '..'), { recursive: true });
  writeFileSync(join(work, path), content);
}

function commitAll(message: string): string {
  g(['add', '-A']);
  g(['commit', '-q', '--allow-empty', '-m', message]);
  return g(['rev-parse', 'HEAD']);
}

/** The upstream refs, `name → oid`. */
function upstreamRefs(): Map<string, string> {
  const out = gitIn(up, ['for-each-ref', '--format=%(refname) %(objectname)']);
  return new Map(
    out
      .split('\n')
      .filter(Boolean)
      .map((l) => l.split(' ') as [string, string]),
  );
}

/** The pack `git push` would send for `rev`: what no upstream ref reaches. */
async function packFor(rev: string, options: { thin?: boolean } = {}): Promise<GitPackObjects> {
  const exclude = [...upstreamRefs().values()].map((oid) => `^${oid}`);
  const pack = execFileSync(
    'git',
    [
      'pack-objects',
      '--stdout',
      '--revs',
      '--delta-base-offset',
      '-q',
      ...(options.thin ? ['--thin'] : []),
    ],
    { cwd: work, env: env(), input: `${rev}\n${exclude.join('\n')}\n` },
  );
  return readPackObjects(new Uint8Array(pack));
}

// ── GitHub, served from the bare repository ─────────────────────────────────

const API = 'https://api.github.com/repos/acme/app';
let apiStatus: number | null = null;
let requests: string[] = [];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const githubFetch = async (input: unknown): Promise<Response> => {
  const url = String(input instanceof Request ? input.url : input);
  requests.push(url);
  if (url === `https://github.com/acme/app.git/info/refs?service=${UPLOAD_PACK_SERVICE}`) {
    const refs = [...upstreamRefs()].map(([name, oid]) => ({ name, oid }));
    return new Response(
      encodeAdvertisement({ service: UPLOAD_PACK_SERVICE, refs, capabilities: [] }),
    );
  }
  if (!url.startsWith(API)) return json({ message: 'Not Found' }, 404);
  if (apiStatus !== null) return json({ message: 'unavailable' }, apiStatus);
  const path = url.slice(API.length);
  if (path === '') return json({ default_branch: 'main' });
  const ref = /^\/git\/ref\/(.+)$/.exec(path);
  if (ref) {
    const name = `refs/${decodeURIComponent(ref[1]!)}`;
    const oid = upstreamRefs().get(name);
    return oid ? json({ ref: name, object: { sha: oid } }) : json({ message: 'Not Found' }, 404);
  }
  const db = /^\/git\/(commits|trees|tags)\/([0-9a-f]{40})$/.exec(path);
  if (!db) return json({ message: 'Not Found' }, 404);
  const sha = db[2]!;
  let type: string;
  try {
    type = gitIn(up, ['cat-file', '-t', sha]);
  } catch {
    return json({ message: 'Not Found' }, 404);
  }
  const expected = { commits: 'commit', trees: 'tree', tags: 'tag' }[db[1] as 'commits'];
  if (type !== expected) return json({ message: 'Not Found' }, 404);
  if (type === 'tree') {
    const tree = gitIn(up, ['ls-tree', sha])
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [meta = '', name = ''] = line.split('\t');
        const [mode = '', t = '', oid = ''] = meta.split(' ');
        return { path: name, mode, type: t, sha: oid };
      });
    return json({ sha, tree, truncated: false });
  }
  const header = gitIn(up, ['cat-file', '-p', sha]).split('\n\n')[0]!.split('\n');
  const field = (n: string) =>
    header.filter((l) => l.startsWith(`${n} `)).map((l) => l.slice(n.length + 1));
  if (type === 'commit') {
    return json({
      sha,
      tree: { sha: field('tree')[0] },
      parents: field('parent').map((p) => ({ sha: p })),
    });
  }
  return json({ sha, object: { sha: field('object')[0], type: field('type')[0] } });
};

async function inspect(
  updates: readonly GitRefUpdate[],
  objects: GitPackObjects,
): Promise<readonly (readonly string[])[]> {
  const ctx = { ...accountCtx(githubFetch as never), resources: [appRepo] };
  const found = await inspectPack(ctx, 'acme/app', updates, objects);
  expect(found.map((f) => f.ref)).toEqual(updates.map((u) => u.ref));
  return found.map((f) => f.workflow_files);
}

/** Push `ref` upstream as it is in the work clone (a person, outside any mission). */
function publish(ref: string): void {
  g(['push', '-q', '--force', up, `HEAD:${ref}`]);
}

let initial: string;
let main: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'vaubaan-inspect-'));
  home = mkdtempSync(join(tmpdir(), 'vaubaan-inspect-home-'));
  up = join(root, 'up.git');
  work = join(root, 'work');
  execFileSync('git', ['init', '-q', '--bare', '--initial-branch=main', up], { env: env() });
  execFileSync('git', ['init', '-q', '--initial-branch=main', work], { env: env() });
  write('README.md', '# app\n');
  write('.github/workflows/ci.yml', 'name: ci-v1\non: push\n');
  write('.github/dependabot.yml', 'version: 2\n');
  write('docs/flow.yml', 'name: flow\non: push\n');
  initial = commitAll('initial');
  publish('refs/heads/main');
  // main moves at GitHub: its CI is fixed (v2).
  write('.github/workflows/ci.yml', 'name: ci-v2\non: push\n');
  main = commitAll('ci v2');
  publish('refs/heads/main');
  // A branch whose CI differs from main, pushed by a person.
  g(['checkout', '-q', '-b', 'other']);
  write('.github/workflows/ci.yml', 'name: ci-other\non: push\n');
  commitAll('other ci');
  publish('refs/heads/other');
  g(['checkout', '-q', 'main']);
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

beforeEach(() => {
  apiStatus = null;
  requests = [];
  g(['checkout', '-q', '-f', 'main']);
  g(['reset', '-q', '--hard', main]);
  g(['clean', '-qfdx']);
});

/** A commit on top of main with `change` applied; the update of `feature/x` from main. */
async function updateWith(change: () => void): Promise<readonly string[]> {
  change();
  const tip = commitAll('change');
  const [paths] = await inspect(
    [{ ref: 'refs/heads/feature/x', old: main, new: tip }],
    await packFor(tip),
  );
  return paths!;
}

describe('an update: the tip against the ref it moves', () => {
  test('a change outside .github/workflows/ is no workflow change', async () => {
    expect(await updateWith(() => write('src/a.ts', 'x\n'))).toEqual([]);
    expect(await updateWith(() => write('.github/dependabot.yml', 'version: 3\n'))).toEqual([]);
  });

  test('modify, add, delete', async () => {
    expect(await updateWith(() => write('.github/workflows/ci.yml', 'name: evil\n'))).toEqual([
      '.github/workflows/ci.yml',
    ]);
    g(['reset', '-q', '--hard', main]);
    expect(await updateWith(() => write('.github/workflows/new.yaml', 'on: push\n'))).toEqual([
      '.github/workflows/new.yaml',
    ]);
    g(['reset', '-q', '--hard', main]);
    expect(await updateWith(() => g(['rm', '-q', '.github/workflows/ci.yml']))).toEqual([
      '.github/workflows/ci.yml',
    ]);
  });

  test('a rename into and out of .github/workflows/', async () => {
    expect(
      await updateWith(() =>
        renameSync(join(work, 'docs/flow.yml'), join(work, '.github/workflows/flow.yml')),
      ),
    ).toEqual(['.github/workflows/flow.yml']);
    g(['reset', '-q', '--hard', main]);
    expect(
      await updateWith(() =>
        renameSync(join(work, '.github/workflows/ci.yml'), join(work, 'docs/ci.yml')),
      ),
    ).toEqual(['.github/workflows/ci.yml']);
  });

  test('a mode change', async () => {
    expect(
      await updateWith(() => chmodSync(join(work, '.github/workflows/ci.yml'), 0o755)),
    ).toEqual(['.github/workflows/ci.yml']);
  });

  test('a directory in another case is guarded too', async () => {
    expect(await updateWith(() => write('.GitHub/Workflows/x.yml', 'on: push\n'))).toEqual([
      '.GitHub/Workflows/x.yml',
    ]);
  });

  test('a revert to an old workflows tree is seen', async () => {
    const paths = await updateWith(() => {
      g(['checkout', '-q', initial, '--', '.github/workflows']);
    });
    expect(paths).toEqual(['.github/workflows/ci.yml']);
  });

  test('a revert whose old workflows tree the pack leaves out (it exists at GitHub) is seen', async () => {
    g(['checkout', '-q', initial, '--', '.github/workflows']);
    const tip = commitAll('revert');
    const old = g(['rev-parse', `${initial}:.github/workflows`]);
    expect(g(['rev-parse', `${tip}:.github/workflows`])).toBe(old);
    // A pack of the commit, its root and `.github` only, as a client may send it.
    const own = [tip, `${tip}^{tree}`, `${tip}:.github`].map((r) => g(['rev-parse', r]));
    const pack = execFileSync('git', ['pack-objects', '--stdout', '-q'], {
      cwd: work,
      env: env(),
      input: `${own.join('\n')}\n`,
    });
    const objects = await readPackObjects(new Uint8Array(pack));
    expect(objects.get(old)).toBeUndefined();
    expect(objects.get(tip)?.type).toBe('commit');
    expect(await inspect([{ ref: 'refs/heads/feature/x', old: main, new: tip }], objects)).toEqual([
      ['.github/workflows/ci.yml'],
    ]);
  });

  test('a merge whose tip runs what a current branch head runs is not a change', async () => {
    const paths = await updateWith(() => {
      g(['merge', '-q', '--no-edit', '-X', 'theirs', 'other']);
    });
    expect(paths).toEqual([]);
  });

  test('the same tree taken from an older commit that is no branch head is a change', async () => {
    // A merge with the first commit, whose workflows are the old ones — first parent the old one.
    const tree = g(['write-tree']);
    g(['checkout', '-q', initial, '--', '.github/workflows']);
    const reverted = g(['write-tree']);
    expect(reverted).not.toBe(tree);
    const merge = g(['commit-tree', reverted, '-p', initial, '-p', main, '-m', 'merge'], '');
    const [paths] = await inspect(
      [{ ref: 'refs/heads/feature/x', old: main, new: merge }],
      await packFor(merge),
    );
    expect(paths).toEqual(['.github/workflows/ci.yml']);
  });

  test('a deletion changes nothing it runs', async () => {
    const [paths] = await inspect(
      [{ ref: 'refs/heads/feature/x', old: main, new: null }],
      await readPackObjects(new Uint8Array(0)),
    );
    expect(paths).toEqual([]);
  });
});

describe('a create: the tip against the default branch and the heads it builds on', () => {
  test('a new branch from main without workflow change; with one', async () => {
    write('src/b.ts', 'b\n');
    const plain = commitAll('plain');
    expect(
      await inspect(
        [{ ref: 'refs/heads/feature/new', old: null, new: plain }],
        await packFor(plain),
      ),
    ).toEqual([[]]);
    write('.github/workflows/ci.yml', 'name: evil\n');
    const evil = commitAll('evil');
    expect(
      await inspect([{ ref: 'refs/heads/feature/new', old: null, new: evil }], await packFor(evil)),
    ).toEqual([['.github/workflows/ci.yml']]);
  });

  test('a new branch on top of another branch head runs what that head runs: no change', async () => {
    g(['checkout', '-q', '-B', 'feature/on-other', 'other']);
    write('src/c.ts', 'c\n');
    const tip = commitAll('on other');
    expect(
      await inspect(
        [{ ref: 'refs/heads/feature/on-other', old: null, new: tip }],
        await packFor(tip),
      ),
    ).toEqual([[]]);
  });

  test('a new branch at an old commit, carried by no head and differing from main: a change', async () => {
    const [paths] = await inspect(
      [{ ref: 'refs/heads/feature/old', old: null, new: initial }],
      await readPackObjects(new Uint8Array(0)),
    );
    expect(paths).toEqual(['.github/workflows/ci.yml']);
  });

  test('an annotated tag at main is no change; one at a commit changing CI is', async () => {
    g(['tag', '-f', '-a', 'v1', '-m', 'v1', main]);
    const v1 = g(['rev-parse', 'v1']);
    expect(await inspect([{ ref: 'refs/tags/v1', old: null, new: v1 }], await packFor(v1))).toEqual(
      [[]],
    );
    write('.github/workflows/release.yml', 'on: push\n');
    commitAll('release');
    g(['tag', '-f', '-a', 'v2', '-m', 'v2']);
    const v2 = g(['rev-parse', 'v2']);
    expect(await inspect([{ ref: 'refs/tags/v2', old: null, new: v2 }], await packFor(v2))).toEqual(
      [['.github/workflows/release.yml']],
    );
  });

  test('every ref of a push is inspected', async () => {
    write('src/d.ts', 'd\n');
    const plain = commitAll('plain');
    write('.github/workflows/d.yml', 'on: push\n');
    const evil = commitAll('evil');
    const found = await inspect(
      [
        { ref: 'refs/heads/feature/a', old: null, new: plain },
        { ref: 'refs/heads/feature/b', old: null, new: evil },
      ],
      await packFor(evil),
    );
    expect(found).toEqual([[], ['.github/workflows/d.yml']]);
  });
});

describe('fail closed', () => {
  test('a garbled pack: the new commit is unknown, so it counts as changed', async () => {
    write('src/e.ts', 'e\n');
    const tip = commitAll('plain');
    const garbled = await readPackObjects(new TextEncoder().encode('PACK garbage'));
    expect(await inspect([{ ref: 'refs/heads/feature/x', old: main, new: tip }], garbled)).toEqual([
      [WORKFLOWS_UNVERIFIED],
    ]);
  });

  test('a thin pack whose trees are deltas against left-out objects counts as changed', async () => {
    for (let i = 0; i < 300; i += 1) write(`many/f${i}.txt`, `${'line\n'.repeat(20)}${i}\n`);
    commitAll('many files');
    publish('refs/heads/many');
    write('many/f1.txt', 'changed\n');
    const tip = commitAll('one more');
    const thin = await packFor(tip, { thin: true });
    expect(thin.get(g(['rev-parse', `${tip}:many`]))).toBeUndefined();
    const many = g(['rev-parse', 'HEAD~1']);
    expect(await inspect([{ ref: 'refs/heads/many', old: many, new: tip }], thin)).toEqual([
      [WORKFLOWS_UNVERIFIED],
    ]);
    // The same push without --thin (what the door asks for) is read in full.
    expect(
      await inspect([{ ref: 'refs/heads/many', old: many, new: tip }], await packFor(tip)),
    ).toEqual([[]]);
    gitIn(up, ['update-ref', '-d', 'refs/heads/many']);
  });

  test('GitHub failing: counts as changed, never as a plain push', async () => {
    write('src/f.ts', 'f\n');
    const tip = commitAll('plain');
    const objects = await packFor(tip);
    apiStatus = 500;
    expect(await inspect([{ ref: 'refs/heads/feature/x', old: main, new: tip }], objects)).toEqual([
      [WORKFLOWS_UNVERIFIED],
    ]);
  });

  test('a claimed old id GitHub does not hold leaves nothing to compare with: changed', async () => {
    write('.github/workflows/ci.yml', 'name: g\n');
    const tip = commitAll('ci');
    expect(
      await inspect(
        [{ ref: 'refs/heads/feature/x', old: 'f'.repeat(40), new: tip }],
        await packFor(tip),
      ),
    ).toEqual([[WORKFLOWS_UNVERIFIED]]);
  });
});
