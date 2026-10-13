/**
 * `npm run demo` serves the existing build when it is the build of the sources
 * as they are (handbook demo-mode, "Starting it"): the stamp is a digest of
 * contents, an edit invalidates it, an unstamped build is never taken as fresh.
 */
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  BUILD_INPUTS,
  BUILD_STAMP_FILE,
  buildIsFresh,
  readBuildStamp,
  sourceDigest,
  writeBuildStamp,
} from '../../demo/build-stamp';

let root: string;
let buildDir: string;

const put = (path: string, text: string): void => {
  const file = join(root, path);
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, text);
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'vaubaan-build-stamp-'));
  buildDir = join(root, 'apps/gateway/.next');
  put('apps/gateway/src/page.tsx', 'export default 1;');
  put('packages/shared/src/index.ts', 'export const a = 1;');
  put('plugins/github/src/risk-catalog.yaml', 'catalog_version: 4');
  put('package-lock.json', '{}');
  put('apps/gateway/.next/BUILD_ID', 'abc');
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('demo build stamp', () => {
  it('does not take an unstamped build as fresh', () => {
    expect(readBuildStamp(buildDir)).toBeNull();
    expect(buildIsFresh(buildDir, sourceDigest(root))).toBe(false);
  });

  it('takes the build as fresh while no input changed, whatever the file dates', () => {
    const digest = sourceDigest(root);
    writeBuildStamp(buildDir, digest);
    const later = new Date(Date.now() + 60_000);
    utimesSync(join(root, 'apps/gateway/src/page.tsx'), later, later);
    expect(sourceDigest(root)).toBe(digest);
    expect(buildIsFresh(buildDir, sourceDigest(root))).toBe(true);
  });

  it.each([
    ['an application source', 'apps/gateway/src/page.tsx'],
    ['a workspace package', 'packages/shared/src/index.ts'],
    ['a plugin catalog', 'plugins/github/src/risk-catalog.yaml'],
    ['the lockfile', 'package-lock.json'],
  ])('builds again once %s changed', (_what, path) => {
    writeBuildStamp(buildDir, sourceDigest(root));
    put(path, 'changed');
    expect(buildIsFresh(buildDir, sourceDigest(root))).toBe(false);
  });

  it('builds again when a file was added or renamed with the same contents', () => {
    const digest = sourceDigest(root);
    put('apps/gateway/src/other.tsx', 'export default 1;');
    expect(sourceDigest(root)).not.toBe(digest);
  });

  it('ignores what a build does not read: tests, dependencies, the build itself', () => {
    const digest = sourceDigest(root);
    put('packages/shared/tests/a.test.ts', 'x');
    put('packages/shared/node_modules/dep/index.js', 'x');
    put('apps/gateway/.next/server/chunk.js', 'x');
    put('apps/gateway/tests/demo/main.ts', 'x');
    expect(sourceDigest(root)).toBe(digest);
  });

  it('is not fresh without a build, even with a matching stamp', () => {
    const digest = sourceDigest(root);
    writeBuildStamp(buildDir, digest);
    rmSync(join(buildDir, 'BUILD_ID'));
    expect(buildIsFresh(buildDir, digest)).toBe(false);
  });

  it('keeps the stamp inside the build directory and names real inputs', () => {
    writeBuildStamp(buildDir, 'd');
    expect(readBuildStamp(buildDir)).toBe('d');
    expect(BUILD_STAMP_FILE).not.toContain('/');
    expect(BUILD_INPUTS).toContain('apps/gateway/src');
    expect(BUILD_INPUTS).toContain('plugins');
  });
});
