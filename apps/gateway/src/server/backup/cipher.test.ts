/**
 * The encrypted backup file (ADR scheduled-encrypted-backup-to-object-storage, D4):
 * round trips at the chunk boundaries, the key versions, and every alteration refused.
 * Keys are generated per run; none is real.
 */
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { EncryptionKeys } from '../config/types';
import {
  BACKUP_MAGIC,
  BackupCipherError,
  decryptBackupFile,
  encryptBackupFile,
  isEncryptedBackupFile,
  readBackupHeader,
} from './cipher';

const CHUNK = 64;

function keysOf(version: number, previous: [number, Buffer][] = []): EncryptionKeys {
  return { masterKey: randomBytes(32), keyVersion: version, previousKeys: new Map(previous) };
}

describe('the encrypted backup file', () => {
  let dir: string;
  let n = 0;
  const path = (name: string) => join(dir, `${name}-${n++}`);

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'vaubaan-cipher-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  async function roundTrip(plain: Buffer, keys: EncryptionKeys, open: EncryptionKeys = keys) {
    const source = path('plain');
    const sealed = path('sealed');
    const back = path('back');
    writeFileSync(source, plain);
    await encryptBackupFile(source, sealed, keys, [1, keys.keyVersion], CHUNK);
    await decryptBackupFile(sealed, back, open);
    return { sealed, back: readFileSync(back) };
  }

  it.each([0, 1, CHUNK - 1, CHUNK, CHUNK + 1, 3 * CHUNK, 3 * CHUNK + 7])(
    'round-trips %i bytes',
    async (size) => {
      const keys = keysOf(2);
      const plain = randomBytes(size);
      const { sealed, back } = await roundTrip(plain, keys);
      expect(back.equals(plain)).toBe(true);
      expect(readFileSync(sealed).includes(plain.subarray(0, Math.min(size, 16)))).toBe(size === 0);
    },
  );

  it('writes a header naming the key version, the chunk size and the sealed versions', async () => {
    const keys = keysOf(5);
    const { sealed } = await roundTrip(randomBytes(100), keys);
    expect(await isEncryptedBackupFile(sealed)).toBe(true);
    const header = await readBackupHeader(sealed);
    expect(header.keyVersion).toBe(5);
    expect(header.chunkBytes).toBe(CHUNK);
    expect(header.sealedKeyVersions).toEqual([1, 5]);
    expect(readFileSync(sealed).subarray(0, BACKUP_MAGIC.length).toString()).toBe('VAUBAAN-BACKUP');
  });

  it('a SQLite file is not an encrypted backup', async () => {
    const file = path('db');
    writeFileSync(file, Buffer.from('SQLite format 3\0rest'));
    expect(await isEncryptedBackupFile(file)).toBe(false);
  });

  it('two encryptions of the same file differ (a fresh salt per file)', async () => {
    const keys = keysOf(1);
    const plain = randomBytes(200);
    const a = await roundTrip(plain, keys);
    const b = await roundTrip(plain, keys);
    expect(readFileSync(a.sealed).equals(readFileSync(b.sealed))).toBe(false);
  });

  it('after a rotation, the previous key opens a backup made under it', async () => {
    const old = keysOf(1);
    const plain = randomBytes(300);
    const rotated: EncryptionKeys = {
      masterKey: randomBytes(32),
      keyVersion: 2,
      previousKeys: new Map([[1, Buffer.from(old.masterKey)]]),
    };
    const { back } = await roundTrip(plain, old, rotated);
    expect(back.equals(plain)).toBe(true);
  });

  it('refuses a key version the instance does not hold, by name', async () => {
    const source = path('plain');
    const sealed = path('sealed');
    writeFileSync(source, randomBytes(50));
    await encryptBackupFile(source, sealed, keysOf(3), [], CHUNK);
    await expect(decryptBackupFile(sealed, path('back'), keysOf(4))).rejects.toThrow(
      /master key version 3: no key is configured/,
    );
  });

  it('a wrong key under the same version does not open', async () => {
    const source = path('plain');
    const sealed = path('sealed');
    writeFileSync(source, randomBytes(50));
    await encryptBackupFile(source, sealed, keysOf(1), [], CHUNK);
    await expect(decryptBackupFile(sealed, path('back'), keysOf(1))).rejects.toThrow(
      BackupCipherError,
    );
  });

  describe('an altered file does not open', () => {
    const keys = keysOf(1);
    let sealed: Buffer;
    let headerLength: number;

    beforeEach(async () => {
      const source = path('plain');
      const out = path('sealed');
      writeFileSync(source, randomBytes(3 * CHUNK + 10));
      await encryptBackupFile(source, out, keys, [1], CHUNK);
      sealed = readFileSync(out);
      headerLength = (await readBackupHeader(out)).raw.length;
    });

    async function opens(bytes: Buffer): Promise<boolean> {
      const file = path('altered');
      writeFileSync(file, bytes);
      try {
        await decryptBackupFile(file, path('back'), keys);
        return true;
      } catch (err) {
        expect(err).toBeInstanceOf(BackupCipherError);
        return false;
      }
    }

    it('the untouched file opens', async () => {
      expect(await opens(sealed)).toBe(true);
    });

    it('one flipped bit in a chunk', async () => {
      const copy = Buffer.from(sealed);
      copy[headerLength + 5] = (copy[headerLength + 5] ?? 0) ^ 1;
      expect(await opens(copy)).toBe(false);
    });

    it('an edited header (the sealed versions it names)', async () => {
      const copy = Buffer.from(sealed);
      copy[headerLength - 1] = (copy[headerLength - 1] ?? 0) ^ 1;
      expect(await opens(copy)).toBe(false);
    });

    it('the last chunk cut off', async () => {
      const lastChunk = 10 + 16;
      expect(await opens(sealed.subarray(0, sealed.length - lastChunk))).toBe(false);
    });

    it('cut in the middle of a chunk', async () => {
      expect(await opens(sealed.subarray(0, sealed.length - 3))).toBe(false);
    });

    it('two chunks swapped', async () => {
      const full = CHUNK + 16;
      const a = sealed.subarray(headerLength, headerLength + full);
      const b = sealed.subarray(headerLength + full, headerLength + 2 * full);
      const swapped = Buffer.concat([
        sealed.subarray(0, headerLength),
        b,
        a,
        sealed.subarray(headerLength + 2 * full),
      ]);
      expect(await opens(swapped)).toBe(false);
    });

    it('a chunk appended', async () => {
      const full = CHUNK + 16;
      expect(
        await opens(Buffer.concat([sealed, sealed.subarray(headerLength, headerLength + full)])),
      ).toBe(false);
    });

    it('the header alone', async () => {
      expect(await opens(sealed.subarray(0, headerLength))).toBe(false);
    });
  });
});
