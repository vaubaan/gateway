/**
 * The catalog builds and packs every plugin with this CLI run by plain Node, which strips the
 * types of a `.ts` file but transforms nothing (`gateway-plugins`, `scripts/build.sh` and its
 * release workflow, `node packages/plugin-cli/src/cli.ts`). A module `build` or `pack` loads must
 * not reach the SDK's root, which holds syntax stripping cannot read: the CLI loads `try` only
 * when it runs, and reads the SDK's version from `@vaubaan/plugin-sdk/version`.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

import { sdkBuildRange, SDK_VERSION } from '@vaubaan/plugin-sdk/version';

const CLI = fileURLToPath(new URL('../../src/cli.ts', import.meta.url));
const TEMPLATE = fileURLToPath(new URL('../../../../plugins/_template', import.meta.url));
const work = mkdtempSync(join(tmpdir(), 'plain-node-'));

afterAll(() => {
  rmSync(work, { recursive: true, force: true });
});

describe('the CLI under plain Node, as the catalog runs it', () => {
  it('builds and packs a plugin, writing the SDK build range', { timeout: 120_000 }, () => {
    const out = join(work, 'template');
    execFileSync(process.execPath, [CLI, 'build', TEMPLATE, '--out', out], { stdio: 'pipe' });
    const pkg = JSON.parse(readFileSync(join(out, 'package.json'), 'utf8')) as {
      peerDependencies: Record<string, string>;
    };
    expect(pkg.peerDependencies['@vaubaan/plugin-sdk']).toBe(sdkBuildRange(SDK_VERSION));
    execFileSync(process.execPath, [CLI, 'pack', out, '--out', join(work, 'template.tgz')], {
      stdio: 'pipe',
    });
    expect(readFileSync(join(work, 'template.tgz')).length).toBeGreaterThan(0);
  });
});
