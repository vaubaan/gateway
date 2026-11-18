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
 *   3. the Vitest tests related to the changed files (`vitest --changed`), and the
 *      structural tests, which read the whole tree and no import ties to a change;
 *   4. the harness linters on the docs, and the workflows (actionlint with shellcheck,
 *      the version CI fetches, from its Docker image) when one changed;
 *   5. when Docker is here, the static analysis exactly as CI runs it (scripts/sast.sh:
 *      the Semgrep image and the semgrep/semgrep-rules commit ci.yml pins, cloned once
 *      into the ignored .semgrep-rules/), over the whole tree: a rule finds what a
 *      changed file breaks elsewhere too.
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
// The structural tests read the whole tree without importing it (no hard-coded
// configuration, no forbidden import…): `--changed` never selects them. Seconds.
step('vitest (structural rules over the tree)', process.execPath, [
  'node_modules/vitest/vitest.mjs',
  'run',
  'apps/gateway/tests/unit/structural',
]);
step('harness lint', 'npx', ['vaubaan-harness', 'lint']);

/** The actionlint version CI fetches (scripts/fetch-tool.sh), or null. */
function actionlintVersion() {
  const fetchTool = readFileSync(join(ROOT, 'scripts/fetch-tool.sh'), 'utf8');
  return /actionlint\/x64\)\s*\n\s*version=([\d.]+)/.exec(fetchTool)?.[1] ?? null;
}

/** The Semgrep image and the rules commit the CI pins (ci.yml), or null when unreadable. */
function sastPins() {
  const workflow = readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf8');
  const image = /SEMGREP_IMAGE:\s*(\S+)/.exec(workflow)?.[1];
  const ref = /repository: semgrep\/semgrep-rules\s+ref: ([0-9a-f]{40})/.exec(workflow)?.[1];
  return image && ref ? { image, ref } : null;
}

const docker = spawnSync('docker', ['info'], { stdio: 'ignore' }).status === 0;

// The workflows, as CI's actionlint reads them, with shellcheck on every `run:`: the
// official image carries shellcheck, which a developer's machine may not.
const workflowsChanged = changed.some((path) => path.startsWith('.github/'));
const actionlint = actionlintVersion();
if (workflowsChanged && docker && actionlint !== null) {
  step(`actionlint ${actionlint} with shellcheck`, 'docker', [
    'run',
    '--rm',
    '-v',
    `${ROOT}:/repo`,
    '-w',
    '/repo',
    `rhysd/actionlint:${actionlint}`,
    '-color',
  ]);
}
const pins = sastPins();
if (!docker || pins === null) {
  process.stdout.write(
    `\n(static analysis skipped: ${docker ? 'pins not found in ci.yml' : 'no Docker'}; CI runs it)\n`,
  );
} else {
  const rules = join(ROOT, '.semgrep-rules');
  if (!existsSync(rules)) {
    spawnSync(
      'git',
      ['clone', '-q', '--filter=blob:none', 'https://github.com/semgrep/semgrep-rules', rules],
      { stdio: 'inherit' },
    );
  }
  spawnSync('git', ['-C', rules, 'fetch', '-q', 'origin', pins.ref], { stdio: 'inherit' });
  spawnSync('git', ['-C', rules, 'checkout', '-q', pins.ref], { stdio: 'inherit' });
  // A worktree's .git points into the main repository: mount it where it says.
  const gitDir = git('rev-parse', '--git-common-dir');
  step('static analysis (scripts/sast.sh)', 'docker', [
    'run',
    '--rm',
    '--network',
    'none',
    '-v',
    `${ROOT}:/src`,
    '-v',
    `${resolve(ROOT, gitDir)}:${resolve(ROOT, gitDir)}`,
    '-w',
    '/src',
    pins.image,
    'sh',
    '-c',
    'git config --global --add safe.directory "*" && scripts/sast.sh /src/.semgrep-rules',
  ]);
}

process.stdout.write('\n');
for (const { title, ok } of results) process.stdout.write(`${ok ? 'ok  ' : 'FAIL'} ${title}\n`);
process.exit(results.every((r) => r.ok) ? 0 : 1);
