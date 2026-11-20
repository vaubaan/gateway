/**
 * vercel.json as Vercel validates it: a schema failure stops every deployment
 * before any build (2026-11-20: an `ignoreCommand` over 256 characters).
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SITE = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const config = JSON.parse(readFileSync(join(SITE, 'vercel.json'), 'utf8')) as Record<
  string,
  unknown
>;

describe('vercel.json', () => {
  it('keeps ignoreCommand within the 256 characters Vercel accepts', () => {
    expect(typeof config.ignoreCommand).toBe('string');
    expect((config.ignoreCommand as string).length).toBeLessThanOrEqual(256);
  });

  it('names in the ignore script every workspace package the site depends on', () => {
    const script = readFileSync(join(SITE, 'scripts/vercel-ignore.sh'), 'utf8');
    const pkg = JSON.parse(readFileSync(join(SITE, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
    };
    for (const name of Object.keys(pkg.dependencies ?? {}).filter((n) =>
      n.startsWith('@vaubaan/'),
    )) {
      expect(script, name).toContain(`packages/${name.slice('@vaubaan/'.length)}`);
    }
  });

  it('answers 0 or 1 only, and builds when the last deployed commit is missing from the clone', () => {
    const run = (env: Record<string, string>) =>
      spawnSync('sh', ['scripts/vercel-ignore.sh'], { cwd: SITE, env: { ...process.env, ...env } })
        .status;
    expect(run({ VERCEL_GIT_COMMIT_REF: 'some-branch' })).toBe(0);
    expect(run({ VERCEL_GIT_COMMIT_REF: 'main', VERCEL_GIT_PREVIOUS_SHA: 'f'.repeat(40) })).toBe(1);
    expect(run({ VERCEL_GIT_COMMIT_REF: 'main', VERCEL_GIT_PREVIOUS_SHA: 'HEAD' })).toBe(0);
  });
});
