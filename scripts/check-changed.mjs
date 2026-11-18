#!/usr/bin/env node
/**
 * `npm run check:changed`: the local check of a change, before it is pushed to
 * main. Only what the change can break, against the merge base with
 * `origin/main` (or the commit given as the first argument), working tree
 * included; the full suite runs on GitHub on every push to main
 * (.github/workflows/ci.yml).
 *
 *   1. type-check of the workspaces a changed file belongs to, and of every
 *      workspace that depends on them, transitively (scripts/type-check.mjs);
 *   2. ESLint and Prettier on the changed files;
 *   3. the Vitest tests related to the changed files (`vitest --changed`);
 *   4. the harness linters on the docs.
 *
 * Each step runs even when an earlier one failed; the exit code is 1 if any
 * failed.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');

function git(...args) {
  const run = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
  if (run.status !== 0) throw new Error(`git ${args.join(' ')}: ${run.stderr.trim()}`);
  return run.stdout.trim();
}

const base = git('merge-base', process.argv[2] ?? 'origin/main', 'HEAD');
const changed = [
  ...new Set(
    [
      git('diff', '--name-only', '--diff-filter=d', base),
      git('ls-files', '--others', '--exclude-standard'),
    ]
      .join('\n')
      .split('\n')
      .filter((path) => path !== '' && existsSync(join(ROOT, path))),
  ),
];
if (changed.length === 0) {
  process.stdout.write(`Nothing changed since ${base.slice(0, 8)}.\n`);
  process.exit(0);
}

/** @returns {{ dir: string, name: string, deps: string[] }[]} */
function workspaces() {
  /** @type {{ workspaces: string[] }} */
  const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  return manifest.workspaces.flatMap((pattern) => {
    const parent = pattern.replace(/\/\*$/, '');
    return readdirSync(join(ROOT, parent), { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isDirectory() && existsSync(join(ROOT, parent, entry.name, 'package.json')),
      )
      .map((entry) => {
        const dir = join(parent, entry.name);
        const pkg = JSON.parse(readFileSync(join(ROOT, dir, 'package.json'), 'utf8'));
        const deps = Object.keys({
          ...pkg.dependencies,
          ...pkg.devDependencies,
          ...pkg.peerDependencies,
        });
        return { dir, name: pkg.name, deps };
      });
  });
}

const all = workspaces();
const touched = new Set(
  all.filter(({ dir }) => changed.some((path) => path.startsWith(`${dir}/`))).map((w) => w.name),
);
// A change outside every workspace (root config, shared tsconfig, lockfile)
// can reach any of them: all are checked.
const outside = changed.some(
  (path) =>
    !all.some(({ dir }) => path.startsWith(`${dir}/`)) &&
    /^(package(-lock)?\.json|tsconfig[^/]*\.json)$/.test(path),
);
for (let grew = true; grew;) {
  grew = false;
  for (const w of all) {
    if (!touched.has(w.name) && w.deps.some((dep) => touched.has(dep))) {
      touched.add(w.name);
      grew = true;
    }
  }
}
const dirs = outside
  ? all.map((w) => w.dir)
  : all.filter((w) => touched.has(w.name)).map((w) => w.dir);

const results = [];
function step(title, command, args) {
  process.stdout.write(`\n▶ ${title}\n`);
  const run = spawnSync(command, args, { cwd: ROOT, stdio: 'inherit' });
  results.push({ title, ok: run.status === 0 });
}

process.stdout.write(`${changed.length} files changed since ${base.slice(0, 8)}.\n`);
if (dirs.length > 0) {
  step(`type-check: ${dirs.join(', ')}`, process.execPath, ['scripts/type-check.mjs', ...dirs]);
}
const lintable = changed.filter((path) => /\.(c|m)?(j|t)sx?$/.test(path));
if (lintable.length > 0) {
  step('eslint', process.execPath, [
    '--max-old-space-size=6144',
    'node_modules/eslint/bin/eslint.js',
    '--max-warnings=0',
    '--no-warn-ignored',
    ...lintable,
  ]);
}
step('prettier', process.execPath, [
  'node_modules/prettier/bin/prettier.cjs',
  '--check',
  '--ignore-unknown',
  ...changed,
]);
step('vitest (related to the change)', process.execPath, [
  'node_modules/vitest/vitest.mjs',
  'run',
  '--changed',
  base,
  '--passWithNoTests',
]);
step('harness lint', 'npx', ['vaubaan-harness', 'lint']);

process.stdout.write('\n');
for (const { title, ok } of results) process.stdout.write(`${ok ? 'ok  ' : 'FAIL'} ${title}\n`);
process.exit(results.every((r) => r.ok) ? 0 : 1);
