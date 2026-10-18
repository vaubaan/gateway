/**
 * The key file the instance writes: the format the loader reads, mode 0600,
 * never over an existing file.
 */
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { KEY_BYTES } from './aead';
import {
  generateMasterKeyText,
  masterKeyFileText,
  parseMasterKeyText,
  writeGeneratedMasterKeyFile,
  writeMasterKeyFile,
} from './master-key-file';

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

  it('is read back as the loader reads it: 32 bytes, base64 or base64url, whitespace around', () => {
    const text = generateMasterKeyText();
    expect(parseMasterKeyText(text)).toHaveLength(KEY_BYTES);
    expect(parseMasterKeyText(`  ${text.trim()}  \n`)).toEqual(parseMasterKeyText(text));
    const url = Buffer.from(parseMasterKeyText(text) ?? []).toString('base64url');
    expect(parseMasterKeyText(url)).toEqual(parseMasterKeyText(text));
    expect(parseMasterKeyText('')).toBeNull();
    expect(parseMasterKeyText('not a key')).toBeNull();
    expect(parseMasterKeyText(Buffer.alloc(16).toString('base64'))).toBeNull();
    expect(parseMasterKeyText(`${text.trim()}\n${text.trim()}`)).toBeNull();
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

  it('at generation, creates the missing parent directories (0700) on an empty volume', () => {
    const root = tempDir();
    const path = join(root, 'data', 'keys', 'master.key');
    writeGeneratedMasterKeyFile(path, 'k\n');
    expect(readFileSync(path, 'utf8')).toBe('k\n');
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(root, 'data')).mode & 0o777).toBe(0o700);
    expect(statSync(join(root, 'data', 'keys')).mode & 0o777).toBe(0o700);
  });

  it('at generation, leaves an existing directory as it is and never writes over a file', () => {
    const root = tempDir();
    const dir = join(root, 'keys');
    mkdirSync(dir, { mode: 0o755 });
    chmodSync(dir, 0o755);
    writeGeneratedMasterKeyFile(join(dir, 'master.key'), 'k\n');
    expect(statSync(dir).mode & 0o777).toBe(0o755);
    expect(() => writeGeneratedMasterKeyFile(join(dir, 'master.key'), 'other\n')).toThrow(/EEXIST/);
    expect(readFileSync(join(dir, 'master.key'), 'utf8')).toBe('k\n');
  });

  it('at generation, fails when a parent is not a directory or cannot be created', () => {
    const root = tempDir();
    writeFileSync(join(root, 'keys'), 'not a directory');
    expect(() => writeGeneratedMasterKeyFile(join(root, 'keys', 'master.key'), 'k\n')).toThrow(
      /ENOTDIR|EEXIST/,
    );
    expect(() =>
      writeGeneratedMasterKeyFile(join(root, 'keys', 'sub', 'master.key'), 'k\n'),
    ).toThrow(/ENOTDIR|EEXIST/);
    if (process.getuid?.() === 0) return; // root ignores directory permissions
    const locked = join(root, 'locked');
    mkdirSync(locked, { mode: 0o500 });
    chmodSync(locked, 0o500);
    expect(() => writeGeneratedMasterKeyFile(join(locked, 'keys', 'master.key'), 'k\n')).toThrow(
      /EACCES/,
    );
    chmodSync(locked, 0o700);
  });
});
