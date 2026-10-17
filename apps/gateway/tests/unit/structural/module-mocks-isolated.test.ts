/**
 * Structural test: a test file that replaces a module (`vi.mock`,
 * `vi.doMock`) runs in the `isolated` project of `vitest.config.ts`
 * (`ISOLATED_TESTS`, `apps/<app>/tests/unit/app/`). Every other file runs
 * without isolation, on a module graph its worker shares with the files before
 * it: a module one of them already loaded keeps the real dependency, the mock
 * never applies, and the file passes or fails by the order the files ran in.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');
const ROOTS = ['apps', 'packages', 'plugins', 'scripts'];
const SKIPPED = new Set(['node_modules', 'dist', '.next', 'e2e']);
const TEST_FILE = /\.test\.(ts|tsx|mjs)$/;
const ISOLATED = /^apps\/[^/]+\/tests\/unit\/app\//;
const MODULE_MOCK = /\bvi\s*\.\s*(mock|doMock)\s*\(/;

function testFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (SKIPPED.has(entry.name)) return [];
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return testFiles(path);
    return TEST_FILE.test(entry.name) ? [relative(REPO, path)] : [];
  });
}

describe('module mocks run isolated', () => {
  const files = ROOTS.flatMap((root) => testFiles(join(REPO, root)));

  it('finds the test files', () => {
    expect(files.length).toBeGreaterThan(300);
  });

  it('replaces a module only in a file of the isolated project', () => {
    const outside = files.filter(
      (file) => !ISOLATED.test(file) && MODULE_MOCK.test(readFileSync(join(REPO, file), 'utf8')),
    );
    expect(outside).toEqual([]);
  });
});
