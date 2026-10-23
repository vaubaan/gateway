/**
 * The encrypted backup file, format `vaubaan-backup` (ADR
 * scheduled-encrypted-backup-to-object-storage, D4, and its 2026-10-23 amendment).
 *
 *   v2 header = "VAUBAAN-BACKUP" (14) ‖ format 0x02 ‖ key version K (u32 BE) ‖ salt (32)
 *               ‖ chunk size (u32 BE) ‖ store size (u64 BE) ‖ n (u8) ‖ n × sealed key version (u32 BE)
 *   v1 header = the same without the store size, format 0x01
 *   body      = chunks: AES-256-GCM(ciphertext ‖ tag 16), nonce = index (u64 BE) ‖ final (u32 BE),
 *               associated data = the whole header
 *   file key  = HKDF-SHA-256(master key of version K, salt, "vaubaan/backup-file/v<format>", 32)
 *   plaintext = v2: the store copy compressed with Brotli (RFC 7932); v1: the store copy
 *
 * The STREAM construction: every chunk is bound to its position, to whether it is the
 * last, and to the header — format byte included, so a v2 file presented as v1 (or the
 * reverse) fails a tag, and its key differs too. The last chunk of the file always
 * exists and is the one marked final (full when the plaintext size is a multiple of the
 * chunk size, a tag alone when the plaintext is empty). A v2 reader decompresses only chunks
 * that opened, refuses a store size above its cap before reading any chunk, and stops
 * as soon as the output passes the size the header declares (a decompression bomb
 * writes at most that much). Failures are `BackupCipherError`s with fixed messages: an
 * AEAD failure says nothing of what failed.
 */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { constants as zlib, createBrotliCompress, createBrotliDecompress } from 'node:zlib';

import type { EncryptionKeys } from '../config/types';

export const BACKUP_MAGIC = Buffer.from('VAUBAAN-BACKUP', 'ascii');
export const BACKUP_FORMAT_V1 = 0x01;
export const BACKUP_FORMAT_V2 = 0x02;
export type BackupFormat = typeof BACKUP_FORMAT_V1 | typeof BACKUP_FORMAT_V2;
/** The format the writer produces. */
export const BACKUP_FORMAT = BACKUP_FORMAT_V2;
export const BACKUP_HKDF_INFO: Readonly<Record<BackupFormat, string>> = {
  [BACKUP_FORMAT_V1]: 'vaubaan/backup-file/v1',
  [BACKUP_FORMAT_V2]: 'vaubaan/backup-file/v2',
};
export const BACKUP_CHUNK_BYTES = 1024 * 1024;
/** Brotli quality of a v2 file (0–11): the measured knee of ratio against time. */
export const BACKUP_BROTLI_QUALITY = 4;
const SALT_BYTES = 32;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
/** The largest chunk a reader accepts: a header asking for more is refused, not allocated. */
const MAX_CHUNK_BYTES = 64 * 1024 * 1024;
const MAX_SEALED_VERSIONS = 255;
const MAX_SIZE_HINT = 0xffffffff;
/** magic ‖ format */
const PREFIX_BYTES = BACKUP_MAGIC.length + 1;
/** K ‖ salt ‖ chunk size [‖ store size] ‖ n, after the prefix. */
const FIXED_AFTER_PREFIX: Readonly<Record<BackupFormat, number>> = {
  [BACKUP_FORMAT_V1]: 4 + SALT_BYTES + 4 + 1,
  [BACKUP_FORMAT_V2]: 4 + SALT_BYTES + 4 + 8 + 1,
};

export class BackupCipherError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackupCipherError';
  }
}

export interface BackupHeaderFields {
  readonly format: BackupFormat;
  /** The master key version the file key is derived from. */
  readonly keyVersion: number;
  readonly salt: Buffer;
  readonly chunkBytes: number;
  /** v2: the size of the store copy before compression; `null` in v1 (not compressed). */
  readonly storeBytes: number | null;
  /** The master key versions the copy's sealed secrets are under (informational). */
  readonly sealedKeyVersions: readonly number[];
}

export interface BackupHeader extends BackupHeaderFields {
  /** The header as written: the associated data of every chunk. */
  readonly raw: Buffer;
}

function isFormat(value: number): value is BackupFormat {
  return value === BACKUP_FORMAT_V1 || value === BACKUP_FORMAT_V2;
}

export function encodeHeader(fields: BackupHeaderFields): Buffer {
  const { format, sealedKeyVersions } = fields;
  if (sealedKeyVersions.length > MAX_SEALED_VERSIONS) {
    throw new BackupCipherError('too many sealed key versions for one backup header');
  }
  const out = Buffer.alloc(
    PREFIX_BYTES + FIXED_AFTER_PREFIX[format] + 4 * sealedKeyVersions.length,
  );
  let at = BACKUP_MAGIC.copy(out, 0);
  at = out.writeUInt8(format, at);
  at = out.writeUInt32BE(fields.keyVersion, at);
  at += fields.salt.copy(out, at);
  at = out.writeUInt32BE(fields.chunkBytes, at);
  if (format === BACKUP_FORMAT_V2) at = out.writeBigUInt64BE(BigInt(fields.storeBytes ?? 0), at);
  at = out.writeUInt8(sealedKeyVersions.length, at);
  for (const version of sealedKeyVersions) at = out.writeUInt32BE(version, at);
  return out;
}

/** Whether the bytes start like an encrypted backup (the magic, whatever follows). */
export function looksEncrypted(firstBytes: Uint8Array): boolean {
  return (
    firstBytes.length >= BACKUP_MAGIC.length &&
    Buffer.from(firstBytes.subarray(0, BACKUP_MAGIC.length)).equals(BACKUP_MAGIC)
  );
}

/** Whether the file at `path` is an encrypted backup (by its magic). */
export async function isEncryptedBackupFile(path: string): Promise<boolean> {
  const file = await open(/* turbopackIgnore: true */ path, 'r');
  try {
    const head = Buffer.alloc(BACKUP_MAGIC.length);
    const { bytesRead } = await file.read(head, 0, head.length, 0);
    return looksEncrypted(head.subarray(0, bytesRead));
  } finally {
    await file.close();
  }
}

async function readExactly(file: FileHandle, length: number, position: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await file.read(buffer, 0, length, position);
  if (bytesRead < length) throw new BackupCipherError('the backup header is cut short');
  return buffer;
}

/** Reads and checks the header of an open encrypted backup (not yet authenticated). */
async function readHeader(file: FileHandle): Promise<BackupHeader> {
  const prefix = Buffer.alloc(PREFIX_BYTES);
  const { bytesRead } = await file.read(prefix, 0, prefix.length, 0);
  if (bytesRead < prefix.length || !looksEncrypted(prefix)) {
    throw new BackupCipherError('not an encrypted backup of this gateway (no header)');
  }
  const format = prefix.readUInt8(BACKUP_MAGIC.length);
  if (!isFormat(format)) {
    throw new BackupCipherError(
      `the backup is of format ${format}, this image reads formats ${BACKUP_FORMAT_V1} and ${BACKUP_FORMAT_V2}`,
    );
  }
  const fixed = await readExactly(file, FIXED_AFTER_PREFIX[format], PREFIX_BYTES);
  let at = 0;
  const keyVersion = fixed.readUInt32BE(at);
  at += 4;
  const salt = Buffer.from(fixed.subarray(at, at + SALT_BYTES));
  at += SALT_BYTES;
  const chunkBytes = fixed.readUInt32BE(at);
  at += 4;
  let storeBytes: number | null = null;
  if (format === BACKUP_FORMAT_V2) {
    const declared = fixed.readBigUInt64BE(at);
    at += 8;
    if (declared > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new BackupCipherError('the backup header names an impossible store size');
    }
    storeBytes = Number(declared);
  }
  const count = fixed.readUInt8(at);
  if (chunkBytes < 1 || chunkBytes > MAX_CHUNK_BYTES) {
    throw new BackupCipherError('the backup header names an impossible chunk size');
  }
  const versions = await readExactly(file, 4 * count, PREFIX_BYTES + fixed.length);
  const sealedKeyVersions: number[] = [];
  for (let i = 0; i < count; i++) sealedKeyVersions.push(versions.readUInt32BE(4 * i));
  return {
    format,
    keyVersion,
    salt,
    chunkBytes,
    storeBytes,
    sealedKeyVersions,
    raw: Buffer.concat([prefix, fixed, versions]),
  };
}

/** The header of the encrypted backup at `path`. */
export async function readBackupHeader(path: string): Promise<BackupHeader> {
  const file = await open(/* turbopackIgnore: true */ path, 'r');
  try {
    return await readHeader(file);
  } finally {
    await file.close();
  }
}

export function deriveBackupKey(
  masterKey: Uint8Array,
  salt: Uint8Array,
  format: BackupFormat,
): Buffer {
  return Buffer.from(hkdfSync('sha256', masterKey, salt, BACKUP_HKDF_INFO[format], KEY_BYTES));
}

function nonceOf(index: number, final: boolean): Buffer {
  const nonce = Buffer.alloc(12);
  nonce.writeBigUInt64BE(BigInt(index), 0);
  nonce.writeUInt32BE(final ? 1 : 0, 8);
  return nonce;
}

/** Seals one chunk (exported for the format's tests, which build files by hand). */
export function sealChunk(
  key: Buffer,
  header: Buffer,
  index: number,
  final: boolean,
  plain: Buffer,
): Buffer {
  const cipher = createCipheriv('aes-256-gcm', key, nonceOf(index, final), {
    authTagLength: TAG_BYTES,
  });
  cipher.setAAD(header);
  return Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
}

function openChunk(
  key: Buffer,
  header: Buffer,
  index: number,
  final: boolean,
  sealed: Buffer,
): Buffer {
  if (sealed.length < TAG_BYTES) throw new BackupCipherError('the backup is cut short');
  const decipher = createDecipheriv('aes-256-gcm', key, nonceOf(index, final), {
    authTagLength: TAG_BYTES,
  });
  decipher.setAAD(header);
  decipher.setAuthTag(sealed.subarray(sealed.length - TAG_BYTES));
  try {
    return Buffer.concat([
      decipher.update(sealed.subarray(0, sealed.length - TAG_BYTES)),
      decipher.final(),
    ]);
  } catch {
    throw new BackupCipherError(
      'the backup does not open: wrong key for its version, or the file was altered or cut',
    );
  }
}

/**
 * Cuts `source` into chunks of `chunkBytes` and seals them in order into `output`. A full
 * chunk is sealed only once more data follows it, so the last chunk — full, partial or
 * empty — is the one marked final. Holds one chunk in memory. Returns the bytes written.
 */
async function sealInto(
  source: AsyncIterable<Buffer>,
  output: FileHandle,
  key: Buffer,
  header: Buffer,
  chunkBytes: number,
): Promise<number> {
  const chunk = Buffer.alloc(chunkBytes);
  let fill = 0;
  let index = 0;
  let written = 0;
  const seal = async (plain: Buffer, final: boolean) => {
    const sealed = sealChunk(key, header, index, final, plain);
    await output.write(sealed);
    written += sealed.length;
    index++;
  };
  for await (const piece of source) {
    let at = 0;
    while (at < piece.length) {
      if (fill === chunkBytes) {
        await seal(chunk, false);
        fill = 0;
      }
      const copied = piece.copy(chunk, fill, at, Math.min(piece.length, at + chunkBytes - fill));
      fill += copied;
      at += copied;
    }
  }
  await seal(chunk.subarray(0, fill), true);
  return written;
}

/** What an encryption wrote. */
export interface EncryptedFile {
  /** Size of the encrypted file: what is uploaded. */
  readonly bytes: number;
  /** Size of the store copy it holds, before compression. */
  readonly storeBytes: number;
  readonly header: BackupHeader;
}

export interface EncryptOptions {
  readonly chunkBytes?: number;
  /** The format to write: 2 (default). 1 is kept for the compatibility tests only. */
  readonly format?: BackupFormat;
}

/**
 * Compresses (v2) and encrypts the file at `plainPath` into `outPath` (created
 * exclusively, mode 0600) under the current master key of `keys`, streamed: one chunk
 * and the compressor's window in memory. `sealedKeyVersions` go into the header.
 */
export async function encryptBackupFile(
  plainPath: string,
  outPath: string,
  keys: EncryptionKeys,
  sealedKeyVersions: readonly number[],
  options: EncryptOptions = {},
): Promise<EncryptedFile> {
  const chunkBytes = options.chunkBytes ?? BACKUP_CHUNK_BYTES;
  const format = options.format ?? BACKUP_FORMAT;
  const input = await open(/* turbopackIgnore: true */ plainPath, 'r');
  const storeBytes = (await input.stat()).size;
  await input.close();
  const salt = randomBytes(SALT_BYTES);
  const fields: BackupHeaderFields = {
    format,
    keyVersion: keys.keyVersion,
    salt,
    chunkBytes,
    storeBytes: format === BACKUP_FORMAT_V2 ? storeBytes : null,
    sealedKeyVersions: [...sealedKeyVersions],
  };
  const header = encodeHeader(fields);
  const key = deriveBackupKey(keys.masterKey, salt, format);
  const output = await open(/* turbopackIgnore: true */ outPath, 'wx', 0o600);
  try {
    await output.write(header);
    const reading = createReadStream(/* turbopackIgnore: true */ plainPath, {
      highWaterMark: chunkBytes,
    });
    let body = 0;
    if (format === BACKUP_FORMAT_V1) {
      body = await sealInto(reading, output, key, header, chunkBytes);
    } else {
      const compressor = createBrotliCompress({
        params: {
          [zlib.BROTLI_PARAM_QUALITY]: BACKUP_BROTLI_QUALITY,
          [zlib.BROTLI_PARAM_SIZE_HINT]: Math.min(storeBytes, MAX_SIZE_HINT),
        },
      });
      await pipeline(reading, compressor, async (compressed: AsyncIterable<Buffer>) => {
        body = await sealInto(compressed, output, key, header, chunkBytes);
      });
      if (compressor.bytesWritten !== storeBytes) {
        throw new BackupCipherError('the store copy changed while it was encrypted');
      }
    }
    await output.sync();
    return { bytes: header.length + body, storeBytes, header: { ...fields, raw: header } };
  } finally {
    key.fill(0);
    await output.close();
  }
}

/** The chunks of an open backup, each opened (authenticated) before it is yielded. */
async function* openedChunks(
  input: FileHandle,
  header: BackupHeader,
  key: Buffer,
): AsyncGenerator<Buffer> {
  const size = (await input.stat()).size;
  const sealedChunk = header.chunkBytes + TAG_BYTES;
  const buffer = Buffer.alloc(sealedChunk);
  let offset = header.raw.length;
  for (let index = 0; ; index++) {
    const remaining = size - offset;
    // The last chunk of the file is the final one; it is shorter than a full chunk,
    // or exactly full when the plaintext size was a multiple of the chunk size.
    const final = remaining <= sealedChunk;
    const length = final ? remaining : sealedChunk;
    if (length < TAG_BYTES) throw new BackupCipherError('the backup is cut short');
    const { bytesRead } = await input.read(buffer, 0, length, offset);
    if (bytesRead < length) throw new BackupCipherError('the backup is cut short');
    offset += bytesRead;
    yield openChunk(key, header.raw, index, final, buffer.subarray(0, length));
    if (final) return;
  }
}

export interface DecryptOptions {
  /**
   * The largest store a v2 backup may decompress to. A header declaring more is refused
   * before any chunk is read; the restore passes its own cap (`restore.max_mb`).
   */
  readonly maxStoreBytes?: number;
}

/**
 * Decrypts (and, for v2, decompresses) the encrypted backup at `inPath` into `outPath`
 * (created exclusively, mode 0600) with the key of the version its header names,
 * current or previous. Refuses a version without a key by name; anything else that does
 * not open is one fixed message.
 */
export async function decryptBackupFile(
  inPath: string,
  outPath: string,
  keys: EncryptionKeys,
  options: DecryptOptions = {},
): Promise<BackupHeader> {
  const input = await open(/* turbopackIgnore: true */ inPath, 'r');
  try {
    const header = await readHeader(input);
    const master =
      header.keyVersion === keys.keyVersion
        ? keys.masterKey
        : keys.previousKeys.get(header.keyVersion);
    if (!master) {
      throw new BackupCipherError(
        `the backup is encrypted under master key version ${header.keyVersion}: no key is configured for it (add it to VAUBAAN_MASTER_KEY_PREVIOUS)`,
      );
    }
    const cap = options.maxStoreBytes ?? Number.MAX_SAFE_INTEGER;
    if (header.storeBytes !== null && header.storeBytes > cap) {
      throw new BackupCipherError(
        `the backup holds a store of ${header.storeBytes} bytes, above the cap of ${cap} bytes`,
      );
    }
    const key = deriveBackupKey(master, header.salt, header.format);
    const output = await open(/* turbopackIgnore: true */ outPath, 'wx', 0o600);
    try {
      const chunks = openedChunks(input, header, key);
      if (header.storeBytes === null) {
        for await (const plain of chunks) await output.write(plain);
      } else {
        await decompressInto(chunks, output, header.storeBytes);
      }
      await output.sync();
      return header;
    } finally {
      key.fill(0);
      await output.close();
    }
  } finally {
    await input.close();
  }
}

/** Brotli-decompresses opened chunks into `output`, never past `storeBytes`. */
async function decompressInto(
  chunks: AsyncIterable<Buffer>,
  output: FileHandle,
  storeBytes: number,
): Promise<void> {
  let written = 0;
  try {
    await pipeline(chunks, createBrotliDecompress(), async (plain: AsyncIterable<Buffer>) => {
      for await (const piece of plain) {
        written += piece.length;
        if (written > storeBytes) {
          throw new BackupCipherError(
            'the backup decompresses past the store size its header declares: refused',
          );
        }
        await output.write(piece);
      }
    });
  } catch (err) {
    if (err instanceof BackupCipherError) throw err;
    throw new BackupCipherError('the backup opens but its content does not decompress');
  }
  if (written !== storeBytes) {
    throw new BackupCipherError(
      'the backup decompresses short of the store size its header declares: refused',
    );
  }
}
