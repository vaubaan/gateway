/**
 * Native addons survive the Next.js build (Turbopack, `output: 'standalone'`).
 *
 * `argon2` and `better-sqlite3` ship prebuilt `.node` binaries that Next's file
 * tracing does not discover on its own; `next.config.ts` lists them in
 * `outputFileTracingIncludes`. This test reads the build output and checks:
 *
 * 1. the route handler trace (`/healthz`, compiled by the build) includes the
 *    `.node` binaries of both addons;
 * 2. a Node process started inside `.next/standalone` loads both addons from
 *    the standalone `node_modules` (not from the repository's) and runs them.
 *
 * The suite is skipped when `apps/gateway/.next/standalone` is absent (no
 * build yet). CI builds before testing, so it runs there; the container smoke
 * test (`deploy/docker/smoke.sh`) repeats the check inside the image.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const nextDir = join(appDir, '.next');
const standaloneDir = join(nextDir, 'standalone');
const healthzTrace = join(nextDir, 'server/app/healthz/route.js.nft.json');
const hasBuild = existsSync(standaloneDir) && existsSync(healthzTrace);

interface NftTrace {
  files: string[];
}

function runInStandalone(script: string): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const result = spawnSync(process.execPath, ['-e', script], {
    // server.js runs from here (`process.chdir(__dirname)`); resolution walks
    // up to `.next/standalone/node_modules` first.
    cwd: join(standaloneDir, 'apps/gateway'),
    encoding: 'utf8',
    timeout: 30_000,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe.skipIf(!hasBuild)('standalone output keeps the native addons (Next build)', () => {
  it('traces the argon2 and better-sqlite3 binaries for the /healthz route handler', () => {
    const trace = JSON.parse(readFileSync(healthzTrace, 'utf8')) as NftTrace;
    const nodeBinaries = trace.files.filter((f) => f.endsWith('.node'));
    expect(
      nodeBinaries.some((f) => /argon2\/prebuilds\/linux-x64\/argon2\.glibc\.node$/.test(f)),
    ).toBe(true);
    expect(
      nodeBinaries.some((f) => /better-sqlite3\/build\/Release\/better_sqlite3\.node$/.test(f)),
    ).toBe(true);
  });

  it('loads argon2 from the standalone node_modules and hashes', () => {
    const { status, stdout, stderr } = runInStandalone(
      "const p=require.resolve('argon2');require('argon2').hash('smoke').then(h=>{console.log(JSON.stringify({p,ok:h.startsWith('$argon2id')}))})",
    );
    expect(stderr).toBe('');
    expect(status).toBe(0);
    const out = JSON.parse(stdout.trim()) as { p: string; ok: boolean };
    expect(out.ok).toBe(true);
    expect(out.p.startsWith(join(standaloneDir, 'node_modules'))).toBe(true);
  });

  it('loads better-sqlite3 from the standalone node_modules and queries', () => {
    const { status, stdout, stderr } = runInStandalone(
      "const p=require.resolve('better-sqlite3');const D=require('better-sqlite3');const r=new D(':memory:').prepare('select 1 as one').get();console.log(JSON.stringify({p,one:r.one}))",
    );
    expect(stderr).toBe('');
    expect(status).toBe(0);
    const out = JSON.parse(stdout.trim()) as { p: string; one: number };
    expect(out.one).toBe(1);
    expect(out.p.startsWith(join(standaloneDir, 'node_modules'))).toBe(true);
  });
});
