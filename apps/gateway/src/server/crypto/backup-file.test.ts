/**
 * The encrypted backup file (ADR scheduled-encrypted-backup-to-object-storage, D4 and
 * its 2026-10-23 amendment): round trips at the chunk boundaries in both formats, the
 * key versions, every alteration refused, a v2 file presented as v1 (and the reverse),
 * the decompression bounds, and a v1 file written by 2.0.0-alpha.4 still opening.
 * Keys are generated per run, or are fixed fillers (the fixture); none is real.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { brotliCompressSync } from 'node:zlib';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { EncryptionKeys } from '../config/types';
import {
  BACKUP_FORMAT_V1,
  BACKUP_FORMAT_V2,
  BACKUP_MAGIC,
  BackupCipherError,
  decryptBackupFile,
  deriveBackupKey,
  encodeHeader,
  encryptBackupFile,
  isEncryptedBackupFile,
  readBackupHeader,
  sealChunk,
  type BackupFormat,
} from './backup-file';

const CHUNK = 64;
const TAG = 16;

function keysOf(version: number, previous: [number, Buffer][] = []): EncryptionKeys {
  return { masterKey: randomBytes(32), keyVersion: version, previousKeys: new Map(previous) };
}

/** Text that compresses, of `size` bytes. */
function compressible(size: number): Buffer {
  const line = Buffer.from('{"kind":"admin","act":"approval-granted","object":"request"}\n');
  const out = Buffer.alloc(size);
  for (let at = 0; at < size; at += line.length) line.copy(out, at);
  return out;
}

/**
 * A v1 file written by 2.0.0-alpha.4 (`encryptBackupFile` before the format v2): master
 * key 32 × 0x11 of version 3, sealed versions [1, 3], chunks of 64 bytes.
 */
const V1_FIXTURE =
  'VkFVQkFBTi1CQUNLVVABAAAAAxV2EoGBbNSqRfsifbuMU1n1lGyPWBjDO+yUgYQ9lDvfAAAAQAIAAAABAAAAA6Gw7kgefhElIWhzFCh6kWLJpBViXsC2WhGA/cCKf+7cXIefpLSDBZkHo4ErcNFuWzpLLKyXozWcaM6SW01FupScdQdDkue9VszYKXHdPmPkS7hN/bID1lQebij9m+6aIwJKnO7ryr4MtgxwEULL77c3K6aWR5xzT7kEq774Lu2K3TI7Sp4nrP9S8/VgogoXtQeeh/akX1HjGDwPBq34S6y7ukFjefqq9m9aH3WxvTzHKXTj5+8Dk0/798k5/FA=';
const V1_FIXTURE_PLAIN =
  'a vaubaan-backup v1 file, written by 2.0.0-alpha.4, kept as a fixture. '.repeat(2);

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

  async function roundTrip(
    plain: Buffer,
    keys: EncryptionKeys,
    open: EncryptionKeys = keys,
    format: BackupFormat = BACKUP_FORMAT_V2,
    chunkBytes = CHUNK,
  ) {
    const source = path('plain');
    const sealed = path('sealed');
    const back = path('back');
    writeFileSync(source, plain);
    const written = await encryptBackupFile(source, sealed, keys, [1, keys.keyVersion], {
      chunkBytes,
      format,
    });
    await decryptBackupFile(sealed, back, open);
    return { sealed, written, back: readFileSync(back) };
  }

  /** Builds a v2 file by hand: `body` (already "compressed") sealed in chunks. */
  function handMade(
    keys: EncryptionKeys,
    storeBytes: number,
    body: Buffer,
    format: BackupFormat = BACKUP_FORMAT_V2,
  ): string {
    const salt = randomBytes(32);
    const header = encodeHeader({
      format,
      keyVersion: keys.keyVersion,
      salt,
      chunkBytes: CHUNK,
      storeBytes,
      sealedKeyVersions: [],
    });
    const key = deriveBackupKey(keys.masterKey, salt, format);
    const parts = [header];
    let index = 0;
    for (let at = 0; ; at += CHUNK, index++) {
      const final = at + CHUNK >= body.length;
      parts.push(sealChunk(key, header, index, final, body.subarray(at, at + CHUNK)));
      if (final) break;
    }
    const file = path('handmade');
    writeFileSync(file, Buffer.concat(parts));
    return file;
  }

  describe.each([
    ['v2', BACKUP_FORMAT_V2],
    ['v1', BACKUP_FORMAT_V1],
  ] as const)('format %s', (_name, format) => {
    it.each([0, 1, CHUNK - 1, CHUNK, CHUNK + 1, 3 * CHUNK, 3 * CHUNK + 7])(
      'round-trips %i random bytes',
      async (size) => {
        const keys = keysOf(2);
        const plain = randomBytes(size);
        const { sealed, back } = await roundTrip(plain, keys, keys, format);
        expect(back.equals(plain)).toBe(true);
        expect(readFileSync(sealed).includes(plain.subarray(0, Math.min(size, 16)))).toBe(
          size === 0,
        );
      },
    );

    it('writes a header naming the format, the key version, the chunk size and the sealed versions', async () => {
      const keys = keysOf(5);
      const { sealed } = await roundTrip(randomBytes(100), keys, keys, format);
      expect(await isEncryptedBackupFile(sealed)).toBe(true);
      const header = await readBackupHeader(sealed);
      expect(header.format).toBe(format);
      expect(header.keyVersion).toBe(5);
      expect(header.chunkBytes).toBe(CHUNK);
      expect(header.storeBytes).toBe(format === BACKUP_FORMAT_V2 ? 100 : null);
      expect(header.sealedKeyVersions).toEqual([1, 5]);
      expect(readFileSync(sealed).subarray(0, BACKUP_MAGIC.length).toString()).toBe(
        'VAUBAAN-BACKUP',
      );
      expect(readFileSync(sealed)[BACKUP_MAGIC.length]).toBe(format);
    });

    it('two encryptions of the same file differ (a fresh salt per file)', async () => {
      const keys = keysOf(1);
      const plain = randomBytes(200);
      const a = await roundTrip(plain, keys, keys, format);
      const b = await roundTrip(plain, keys, keys, format);
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
      const { back } = await roundTrip(plain, old, rotated, format);
      expect(back.equals(plain)).toBe(true);
    });

    it('refuses a key version the instance does not hold, by name', async () => {
      const source = path('plain');
      const sealed = path('sealed');
      writeFileSync(source, randomBytes(50));
      await encryptBackupFile(source, sealed, keysOf(3), [], { chunkBytes: CHUNK, format });
      await expect(decryptBackupFile(sealed, path('back'), keysOf(4))).rejects.toThrow(
        /master key version 3: no key is configured/,
      );
    });

    it('a wrong key under the same version does not open', async () => {
      const source = path('plain');
      const sealed = path('sealed');
      writeFileSync(source, randomBytes(50));
      await encryptBackupFile(source, sealed, keysOf(1), [], { chunkBytes: CHUNK, format });
      await expect(decryptBackupFile(sealed, path('back'), keysOf(1))).rejects.toThrow(
        BackupCipherError,
      );
    });

    describe('an altered file does not open', () => {
      const keys = keysOf(1);
      const full = CHUNK + TAG;
      let sealed: Buffer;
      let headerLength: number;

      beforeEach(async () => {
        const source = path('plain');
        const out = path('sealed');
        // Random bytes do not compress: several chunks in either format.
        writeFileSync(source, randomBytes(3 * CHUNK + 10));
        await encryptBackupFile(source, out, keys, [1], { chunkBytes: CHUNK, format });
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

      it('one flipped bit in the last tag', async () => {
        const copy = Buffer.from(sealed);
        copy[copy.length - 1] = (copy[copy.length - 1] ?? 0) ^ 0x80;
        expect(await opens(copy)).toBe(false);
      });

      it('an edited header (the sealed versions it names)', async () => {
        const copy = Buffer.from(sealed);
        copy[headerLength - 1] = (copy[headerLength - 1] ?? 0) ^ 1;
        expect(await opens(copy)).toBe(false);
      });

      it('the last chunk cut off', async () => {
        const lastChunk = (sealed.length - headerLength) % full || full;
        expect(await opens(sealed.subarray(0, sealed.length - lastChunk))).toBe(false);
      });

      it('cut in the middle of a chunk', async () => {
        expect(await opens(sealed.subarray(0, sealed.length - 3))).toBe(false);
      });

      it('two chunks swapped', async () => {
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
        expect(
          await opens(Buffer.concat([sealed, sealed.subarray(headerLength, headerLength + full)])),
        ).toBe(false);
      });

      it('the header alone', async () => {
        expect(await opens(sealed.subarray(0, headerLength))).toBe(false);
      });

      it('presented as the other format (its version byte swapped)', async () => {
        const copy = Buffer.from(sealed);
        copy[BACKUP_MAGIC.length] =
          format === BACKUP_FORMAT_V2 ? BACKUP_FORMAT_V1 : BACKUP_FORMAT_V2;
        expect(await opens(copy)).toBe(false);
      });
    });
  });

  describe('format v2 (compressed)', () => {
    it('is the format written by default, and compresses', async () => {
      const keys = keysOf(1);
      const plain = compressible(20_000);
      const { sealed, written, back } = await roundTrip(plain, keys);
      expect(back.equals(plain)).toBe(true);
      expect((await readBackupHeader(sealed)).format).toBe(BACKUP_FORMAT_V2);
      expect(written.storeBytes).toBe(plain.length);
      expect(written.bytes).toBe(statSync(sealed).size);
      expect(written.bytes).toBeLessThan(plain.length / 10);
    });

    it('round-trips every size up to five chunks, the compressed size landing on chunk boundaries', async () => {
      const keys = keysOf(1);
      const bodySizes = new Set<number>();
      for (let size = 0; size <= 5 * CHUNK; size += 3) {
        const plain = randomBytes(size);
        const { sealed, back } = await roundTrip(plain, keys);
        expect(back.equals(plain)).toBe(true);
        const header = await readBackupHeader(sealed);
        const sealedBody = statSync(sealed).size - header.raw.length;
        const chunks = Math.ceil(sealedBody / (CHUNK + TAG));
        bodySizes.add(sealedBody - chunks * TAG);
      }
      // At least one compressed body was an exact multiple of the chunk size (the last
      // chunk full and final).
      expect([...bodySizes].some((size) => size > 0 && size % CHUNK === 0)).toBe(true);
    });

    it('round-trips a large store in 1 MiB chunks, holding no more than it streams', async () => {
      const keys = keysOf(1);
      const plain = Buffer.concat([compressible(3 * 1024 * 1024), randomBytes(1024 * 1024 + 5)]);
      const { written, back } = await roundTrip(plain, keys, keys, BACKUP_FORMAT_V2, 1024 * 1024);
      expect(back.equals(plain)).toBe(true);
      expect(written.bytes).toBeLessThan(plain.length / 2);
    });

    it('refuses a store above the cap before reading a chunk', async () => {
      const keys = keysOf(1);
      const source = path('plain');
      const sealed = path('sealed');
      const back = path('back');
      writeFileSync(source, compressible(10_000));
      await encryptBackupFile(source, sealed, keys, [], { chunkBytes: CHUNK });
      await expect(decryptBackupFile(sealed, back, keys, { maxStoreBytes: 9_999 })).rejects.toThrow(
        'the backup holds a store of 10000 bytes, above the cap of 9999 bytes',
      );
      expect(existsSync(back)).toBe(false);
      await decryptBackupFile(sealed, back, keys, { maxStoreBytes: 10_000 });
      expect(statSync(back).size).toBe(10_000);
    });

    it('stops a decompression bomb at the size the header declares', async () => {
      const keys = keysOf(1);
      // 16 MiB of zeros compress to a few hundred bytes; the header declares 1000.
      const bomb = brotliCompressSync(Buffer.alloc(16 * 1024 * 1024));
      const file = handMade(keys, 1000, bomb);
      const back = path('back');
      await expect(decryptBackupFile(file, back, keys)).rejects.toThrow(
        'the backup decompresses past the store size its header declares: refused',
      );
      expect(statSync(back).size).toBeLessThanOrEqual(1000);
    });

    it('refuses a content that decompresses short of the declared size', async () => {
      const keys = keysOf(1);
      const file = handMade(keys, 5000, brotliCompressSync(Buffer.alloc(100, 7)));
      await expect(decryptBackupFile(file, path('back'), keys)).rejects.toThrow(
        'the backup decompresses short of the store size its header declares: refused',
      );
    });

    it('refuses a content that opens but is not Brotli', async () => {
      const keys = keysOf(1);
      const file = handMade(keys, 300, randomBytes(300));
      await expect(decryptBackupFile(file, path('back'), keys)).rejects.toThrow(
        'the backup opens but its content does not decompress',
      );
    });

    it('a v2 file whose key was derived with the v1 info does not open', async () => {
      const keys = keysOf(1);
      const salt = randomBytes(32);
      const header = encodeHeader({
        format: BACKUP_FORMAT_V2,
        keyVersion: 1,
        salt,
        chunkBytes: CHUNK,
        storeBytes: 10,
        sealedKeyVersions: [],
      });
      const wrongKey = deriveBackupKey(keys.masterKey, salt, BACKUP_FORMAT_V1);
      const body = sealChunk(wrongKey, header, 0, true, brotliCompressSync(Buffer.alloc(10)));
      const file = path('v1-key');
      writeFileSync(file, Buffer.concat([header, body]));
      await expect(decryptBackupFile(file, path('back'), keys)).rejects.toThrow(
        'the backup does not open',
      );
    });
  });

  it('a v1 file written by 2.0.0-alpha.4 still opens', async () => {
    const file = path('v1');
    writeFileSync(file, Buffer.from(V1_FIXTURE, 'base64'));
    const keys: EncryptionKeys = {
      masterKey: Buffer.alloc(32, 0x11),
      keyVersion: 3,
      previousKeys: new Map(),
    };
    const back = path('back');
    const header = await decryptBackupFile(file, back, keys);
    expect(header).toMatchObject({
      format: BACKUP_FORMAT_V1,
      keyVersion: 3,
      chunkBytes: CHUNK,
      storeBytes: null,
      sealedKeyVersions: [1, 3],
    });
    expect(readFileSync(back).toString()).toBe(V1_FIXTURE_PLAIN);
  });

  it('refuses a format this image does not know', async () => {
    const file = path('v3');
    const bytes = Buffer.from(V1_FIXTURE, 'base64');
    bytes[BACKUP_MAGIC.length] = 3;
    writeFileSync(file, bytes);
    await expect(decryptBackupFile(file, path('back'), keysOf(3))).rejects.toThrow(
      'the backup is of format 3, this image reads formats 1 and 2',
    );
  });

  it('a SQLite file is not an encrypted backup', async () => {
    const file = path('db');
    writeFileSync(file, Buffer.from('SQLite format 3\0rest'));
    expect(await isEncryptedBackupFile(file)).toBe(false);
  });
});
