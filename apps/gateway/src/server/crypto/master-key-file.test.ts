/**
 * The key file the instance writes: the format the loader reads, mode 0600,
 * never over an existing file.
 */
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { KEY_BYTES } from './aead';
import { generateMasterKeyText, masterKeyFileText, writeMasterKeyFile } from './master-key-file';

describe('the master key file', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  function tempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'vbn-key-'));
    dirs.push(dir);
    return dir;
  }

  it('holds 32 random bytes in base64 on one line, different every time', () => {
    const a = generateMasterKeyText();
    const b = generateMasterKeyText();
    expect(a).toMatch(/^[A-Za-z0-9+/]{43}=\n$/);
    expect(Buffer.from(a.trim(), 'base64')).toHaveLength(KEY_BYTES);
    expect(a).not.toBe(b);
    expect(masterKeyFileText(new Uint8Array(KEY_BYTES))).toBe(`${'A'.repeat(43)}=\n`);
  });

  it('is written with mode 0600 and never over an existing file', () => {
    const path = join(tempDir(), 'master.key');
    writeMasterKeyFile(path, 'first\n');
    expect(readFileSync(path, 'utf8')).toBe('first\n');
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(() => writeMasterKeyFile(path, 'second\n')).toThrow(/EEXIST/);
    expect(readFileSync(path, 'utf8')).toBe('first\n');
  });

  it('fails when the directory does not exist, naming it', () => {
    const path = join(tempDir(), 'missing', 'master.key');
    expect(() => writeMasterKeyFile(path, 'x\n')).toThrow(/ENOENT/);
  });
});
