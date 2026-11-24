// The desktop app runs the Node version the image pins, checked against nodejs.org's sums.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { checksumOf, nodeVersionOf } from './assemble.mjs';

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
});
