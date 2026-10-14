// The lockfile gate: what a package-lock.json entry may download, and from
// where. No network, no install: parsed lockfiles only.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { checkLockfile, nameOfKey, nameOfTarball } from './lockfile-gate.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SHA = 'sha512-' + 'A'.repeat(86) + '==';

/** @param {Record<string, object>} packages */
const lockWith = (packages) => ({
  lockfileVersion: 3,
  packages: { '': { name: 'root' }, ...packages },
});
/** @param {Record<string, object>} packages */
const problemsOf = (packages) =>
  checkLockfile(lockWith(packages)).map((/** @type {{ problem: string }} */ p) => p.problem);

describe('checkLockfile', () => {
  it('passes the repository lockfile', () => {
    const lock = JSON.parse(readFileSync(join(ROOT, 'package-lock.json'), 'utf8'));
    expect(checkLockfile(lock)).toEqual([]);
  });

  it('passes registry entries, scoped and nested, workspaces and their links', () => {
    expect(
      problemsOf({
        'node_modules/js-yaml': {
          resolved: 'https://registry.npmjs.org/js-yaml/-/js-yaml-4.1.0.tgz',
          integrity: SHA,
        },
        'node_modules/a/node_modules/@scope/b': {
          resolved: 'https://registry.npmjs.org/@scope/b/-/b-1.0.0.tgz',
          integrity: SHA,
        },
        'node_modules/alias': {
          name: 'real',
          resolved: 'https://registry.npmjs.org/real/-/real-2.0.0.tgz',
          integrity: SHA,
        },
        'packages/shared': { name: '@vaubaan/shared', version: '0.0.0' },
        'node_modules/@vaubaan/shared': { resolved: 'packages/shared', link: true },
      }),
    ).toEqual([]);
  });

  it.each([
    ['another host', 'https://evil.example/js-yaml/-/js-yaml-4.1.0.tgz', /not from/],
    ['plain http', 'http://registry.npmjs.org/js-yaml/-/js-yaml-4.1.0.tgz', /not from/],
    ['a git URL', 'git+ssh://git@github.com/nodeca/js-yaml.git#abc', /not from/],
    ['a lookalike host', 'https://registry.npmjs.org.evil.example/js-yaml/-/x.tgz', /not from/],
    [
      'another package',
      'https://registry.npmjs.org/js-yam1/-/js-yam1-4.1.0.tgz',
      /downloads js-yam1/,
    ],
  ])('refuses %s', (_, resolved, problem) => {
    const problems = problemsOf({ 'node_modules/js-yaml': { resolved, integrity: SHA } });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(problem);
  });

  it('refuses an entry without its integrity, or with a weaker hash', () => {
    const resolved = 'https://registry.npmjs.org/x/-/x-1.0.0.tgz';
    expect(problemsOf({ 'node_modules/x': { resolved } })).toEqual([
      expect.stringMatching(/no sha512/),
    ]);
    expect(problemsOf({ 'node_modules/x': { resolved, integrity: 'sha1-abc=' } })).toEqual([
      expect.stringMatching(/no sha512/),
    ]);
  });

  it('refuses an entry whose origin is not recorded', () => {
    expect(problemsOf({ 'node_modules/x': { version: '1.0.0' } })).toEqual([
      expect.stringMatching(/no "resolved"/),
    ]);
  });

  it('refuses a link or a workspace outside the repository', () => {
    expect(problemsOf({ 'node_modules/x': { resolved: '../elsewhere', link: true } })).toEqual([
      expect.stringMatching(/outside the repository/),
    ]);
    expect(problemsOf({ 'node_modules/x': { resolved: '/abs/x', link: true } })).toEqual([
      expect.stringMatching(/outside the repository/),
    ]);
    expect(
      problemsOf({ 'packages/x': { resolved: 'https://registry.npmjs.org/x/-/x-1.0.0.tgz' } }),
    ).toEqual([expect.stringMatching(/workspace with a download/)]);
  });

  it('refuses a lockfile without a packages map', () => {
    expect(checkLockfile({ lockfileVersion: 1, dependencies: {} })).toEqual([
      { key: '', problem: expect.stringMatching(/lockfileVersion 2 or 3/) },
    ]);
  });
});

describe('names', () => {
  it('reads the installed name of a key and the downloaded name of a tarball', () => {
    expect(nameOfKey('node_modules/a/node_modules/@s/b')).toBe('@s/b');
    expect(nameOfKey('packages/shared')).toBeNull();
    expect(nameOfTarball('https://registry.npmjs.org/@s/b/-/b-1.0.0.tgz')).toBe('@s/b');
    expect(nameOfTarball('https://registry.npmjs.org/@s%2fb/-/b-1.0.0.tgz')).toBe('@s/b');
    expect(nameOfTarball('https://registry.npmjs.org/b.tgz')).toBeNull();
  });
});
