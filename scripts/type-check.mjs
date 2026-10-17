#!/usr/bin/env node
/**
 * `npm run type-check`: the `type-check` script of every workspace, several at
 * once (one per core), instead of `npm run --workspaces`, which runs them one
 * after the other. Each `tsc` is incremental (`tsconfig.base.json`), so a run
 * after a small change re-checks little. A script that is a plain `tsc …`
 * runs as `node <typescript>/bin/tsc …`, without npm (on a two-core runner,
 * starting npm 22 times cost more than the checks). The output of a workspace
 * is printed whole once it ends; the exit code is 1 if any failed.
 */
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const TSC = join(ROOT, 'node_modules/typescript/bin/tsc');

function workspaces() {
  /** @type {{ workspaces: string[] }} */
  const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  return manifest.workspaces.flatMap((pattern) => {
    const parent = pattern.replace(/\/\*$/, '');
    return readdirSync(join(ROOT, parent), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(parent, entry.name))
      .flatMap((dir) => {
        const manifest = join(ROOT, dir, 'package.json');
        if (!existsSync(manifest)) return [];
        /** @type {{ scripts?: Record<string, string> }} */
        const workspace = JSON.parse(readFileSync(manifest, 'utf8'));
        const script = workspace.scripts?.['type-check'];
        return script === undefined ? [] : [{ dir, script }];
      });
  });
}

const PLAIN_ARGUMENT = /^[\w./-]+$/;

/**
 * `tsc` and plain arguments only (no quote, no shell syntax): anything else
 * goes through npm.
 * @param {string} script
 * @returns {string[] | undefined} the arguments of tsc
 */
function plainTsc(script) {
  const [command, ...args] = script.split(' ');
  return command === 'tsc' && args.every((arg) => PLAIN_ARGUMENT.test(arg)) ? args : undefined;
}

function check({ dir, script }) {
  return new Promise((done) => {
    const started = Date.now();
    const tscArgs = plainTsc(script);
    const [command, args] =
      tscArgs === undefined
        ? ['npm', ['run', '--silent', 'type-check']]
        : [process.execPath, [TSC, ...tscArgs]];
    const child = spawn(command, args, {
      cwd: join(ROOT, dir),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => (output += chunk));
    child.stderr.on('data', (chunk) => (output += chunk));
    child.on('close', (code) => {
      const seconds = ((Date.now() - started) / 1000).toFixed(1);
      process.stdout.write(`${code === 0 ? 'ok  ' : 'FAIL'} ${dir} (${seconds} s)\n`);
      if (code !== 0) process.stdout.write(output);
      done(code === 0);
    });
  });
}

const queue = workspaces();
const results = [];
const lanes = Array.from({ length: Math.min(availableParallelism(), queue.length) }, async () => {
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    results.push(await check(next));
  }
});
await Promise.all(lanes);
process.exit(results.every(Boolean) ? 0 : 1);
