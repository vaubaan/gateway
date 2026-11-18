// The sign-off check: which commits of a pull request lack a Developer
// Certificate of Origin line. Pure functions first, then the script against a
// throw-away repository (git is a prerequisite of the repository, the network
// is not used).
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

import { isSignedOff, parseLog, unsignedCommits } from './dco-check.mjs';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'dco-check.mjs');

describe('isSignedOff', () => {
  it.each([
    ['a sign-off line', 'feat: x\n\nbody\n\nSigned-off-by: Ada Lovelace <ada@example.com>\n'],
    [
      'a sign-off among other trailers',
      'fix: y\n\nSigned-off-by: A B <a@b.example>\nCo-Authored-By: C <c@d.example>',
    ],
    ['a bot', 'chore(deps): z\n\nSigned-off-by: dependabot[bot] <support@github.com>'],
  ])('accepts %s', (_, message) => {
    expect(isSignedOff(message)).toBe(true);
  });

  it.each([
    ['no trailer', 'feat: x\n\nbody\n'],
    ['only a co-author', 'feat: x\n\nCo-Authored-By: C <c@d.example>'],
    ['no address', 'feat: x\n\nSigned-off-by: Ada Lovelace'],
    ['no name', 'feat: x\n\nSigned-off-by: <ada@example.com>'],
    ['an address without @', 'feat: x\n\nSigned-off-by: Ada <ada>'],
    ['the words inside a sentence', 'feat: x\n\nThis is not Signed-off-by: Ada <ada@example.com>'],
    ['another case', 'feat: x\n\nsigned-off-by: Ada <ada@example.com>'],
  ])('refuses %s', (_, message) => {
    expect(isSignedOff(message)).toBe(false);
  });
});

describe('parseLog and unsignedCommits', () => {
  it('splits records and keeps the unsigned ones in order', () => {
    const log =
      'aaa\x1ffeat: one\x1ffeat: one\n\nSigned-off-by: A <a@b.example>\n\x1e\n' +
      'bbb\x1ffix: two\x1ffix: two\n\x1e\n' +
      'ccc\x1fdocs: three\x1fdocs: three\n\x1e\n';
    const commits = parseLog(log);
    expect(commits.map((c) => c.sha)).toEqual(['aaa', 'bbb', 'ccc']);
    expect(unsignedCommits(commits).map((c) => c.subject)).toEqual(['fix: two', 'docs: three']);
  });

  it('reads an empty range as no commit', () => {
    expect(parseLog('')).toEqual([]);
  });
});

describe('the script', () => {
  const repo = mkdtempSync(join(tmpdir(), 'vaubaan-dco-'));
  afterAll(() => rmSync(repo, { recursive: true, force: true }));

  const git = (/** @type {string[]} */ ...args) =>
    execFileSync(
      'git',
      [
        '-C',
        repo,
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.com',
        '-c',
        'commit.gpgsign=false',
        ...args,
      ],
      { encoding: 'utf8' },
    ).trim();
  const commit = (/** @type {string} */ name, /** @type {string[]} */ ...flags) => {
    writeFileSync(join(repo, name), name);
    git('add', name);
    git('commit', '-q', ...flags, '-m', `feat: ${name}`);
    return git('rev-parse', 'HEAD');
  };
  const run = (/** @type {string[]} */ ...args) =>
    spawnSync(process.execPath, [SCRIPT, ...args], { cwd: repo, encoding: 'utf8' });

  git('init', '-q');
  const base = commit('base');

  it('passes when every commit is signed off, and ignores merges', () => {
    commit('signed', '-s');
    git('checkout', '-q', '-b', 'side', base);
    commit('side', '-s');
    git('checkout', '-q', '-');
    git('merge', '-q', '--no-ff', '-m', 'Merge side', 'side');
    const result = run(base, 'HEAD');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('2 commits, all signed off');
  });

  it('fails naming the unsigned commit', () => {
    const unsigned = commit('unsigned');
    const result = run(base, 'HEAD');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(unsigned.slice(0, 12));
    expect(result.stderr).toContain('1 of 3 commits');
  });

  it('checks nothing without a base', () => {
    for (const args of [[], ['0000000000000000000000000000000000000000', 'HEAD']]) {
      const result = run(...args);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('no base commit');
    }
  });
});

describe('the CI job', () => {
  it('runs the check on every pull request against its base, and on every push to main', () => {
    const workflow = readFileSync(join(dirname(SCRIPT), '../.github/workflows/ci.yml'), 'utf8');
    expect(workflow).toContain('node scripts/dco-check.mjs "$BASE" HEAD');
    expect(workflow).toContain(
      "BASE: ${{ github.event_name == 'pull_request' && github.event.pull_request.base.sha || github.event.before }}",
    );
  });
});
