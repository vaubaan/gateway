// The desktop app runs the Node version the image pins, checked against nodejs.org's sums.
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { checksumOf, nodeVersionOf, replaceLinks } from './assemble.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

describe('assemble', () => {
  it('reads the Node version from the Dockerfile the image is built with', () => {
    const version = nodeVersionOf(readFileSync(resolve(ROOT, 'deploy/docker/Dockerfile'), 'utf8'));
    expect(version).toMatch(/^26\.\d+\.\d+$/);
    expect(() => nodeVersionOf('FROM debian:bookworm')).toThrow(/no node:<version>/);
  });

  it('finds the sum of one archive, and refuses an archive the list does not name', () => {
    const sum = 'a'.repeat(64);
    const shasums = `${'b'.repeat(64)}  node-v26.13.1-linux-x64.tar.gz\n${sum}  node-v26.13.1-darwin-arm64.tar.gz\n`;
    expect(checksumOf(shasums, 'node-v26.13.1-darwin-arm64.tar.gz')).toBe(sum);
    expect(() => checksumOf(shasums, 'node-v26.13.1-darwin-x64.tar.gz')).toThrow(/lists no/);
  });

  it('leaves no link in the tree: an alias of an external package re-exports it, any other link is copied', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vbn-assemble-'));
    try {
      mkdirSync(join(dir, 'node_modules/better-sqlite3'), { recursive: true });
      writeFileSync(join(dir, 'node_modules/better-sqlite3/index.js'), 'module.exports = 1;\n');
      mkdirSync(join(dir, 'apps/gateway/.next/node_modules'), { recursive: true });
      symlinkSync(
        '../../../../node_modules/better-sqlite3',
        join(dir, 'apps/gateway/.next/node_modules/better-sqlite3-90e2652d1716b047'),
      );
      writeFileSync(join(dir, 'real.txt'), 'kept\n');
      symlinkSync('real.txt', join(dir, 'other-link.txt'));

      expect(replaceLinks(dir).sort()).toEqual([
        'apps/gateway/.next/node_modules/better-sqlite3-90e2652d1716b047',
        'other-link.txt',
      ]);
      const alias = join(dir, 'apps/gateway/.next/node_modules/better-sqlite3-90e2652d1716b047');
      expect(lstatSync(alias).isDirectory()).toBe(true);
      expect(readFileSync(join(alias, 'index.js'), 'utf8')).toBe(
        'module.exports = require("better-sqlite3");\n',
      );
      expect(lstatSync(join(dir, 'other-link.txt')).isSymbolicLink()).toBe(false);
      expect(readFileSync(join(dir, 'other-link.txt'), 'utf8')).toBe('kept\n');
      expect(existsSync(join(dir, 'node_modules/better-sqlite3/index.js'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
