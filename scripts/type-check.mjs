#!/usr/bin/env node
/**
 * `npm run type-check`: the `type-check` script of every workspace, several at
 * once (one per core), instead of `npm run --workspaces`, which runs them one
 * after the other. Each `tsc` is incremental (`tsconfig.base.json`), so a run
 * after a small change re-checks little. The output of a workspace is printed
 * whole once it ends; the exit code is 1 if any failed.
 */
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');

function workspaces() {
  /** @type {{ workspaces: string[] }} */
  const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  return manifest.workspaces.flatMap((pattern) => {
    const parent = pattern.replace(/\/\*$/, '');
    return readdirSync(join(ROOT, parent), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(parent, entry.name))
      .filter((dir) => {
        const manifest = join(ROOT, dir, 'package.json');
        return (
          existsSync(manifest) &&
          JSON.parse(readFileSync(manifest, 'utf8')).scripts?.['type-check'] !== undefined
        );
      });
  });
}

function check(dir) {
  return new Promise((done) => {
    const started = Date.now();
    const child = spawn('npm', ['run', '--silent', 'type-check'], {
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
  for (let dir = queue.shift(); dir !== undefined; dir = queue.shift()) {
    results.push(await check(dir));
  }
});
await Promise.all(lanes);
process.exit(results.every(Boolean) ? 0 : 1);
