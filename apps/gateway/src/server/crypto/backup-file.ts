/**
 * The encrypted backup file, format `vaubaan-backup` v1 (ADR
 * scheduled-encrypted-backup-to-object-storage, D4).
 *
 *   header = "VAUBAAN-BACKUP" (14) ‖ format 0x01 ‖ key version K (u32 BE) ‖ salt (32)
 *            ‖ chunk size (u32 BE) ‖ n (u8) ‖ n × sealed key version (u32 BE)
 *   body   = chunks: AES-256-GCM(ciphertext ‖ tag 16), nonce = index (u64 BE) ‖ final (u32 BE),
 *            associated data = the whole header
 *   file key = HKDF-SHA-256(master key of version K, salt, "vaubaan/backup-file/v1", 32)
 *
 * The STREAM construction: every chunk is bound to its position, to whether it is the
 * last, and to the header, so a reordered, dropped, appended or truncated chunk, or an
 * edited header, fails a tag. The last chunk always exists (empty when the plain size is
 * a multiple of the chunk size). Failures are `BackupCipherError`s with fixed messages:
 * an AEAD failure says nothing of what failed.
 */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { open, type FileHandle } from 'node:fs/promises';

import type { EncryptionKeys } from '../config/types';

export const BACKUP_MAGIC = Buffer.from('VAUBAAN-BACKUP', 'ascii');
export const BACKUP_FORMAT_V1 = 0x01;
export const BACKUP_HKDF_INFO = 'vaubaan/backup-file/v1';
export const BACKUP_CHUNK_BYTES = 1024 * 1024;
const SALT_BYTES = 32;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
/** The largest chunk a reader accepts: a header asking for more is refused, not allocated. */
const MAX_CHUNK_BYTES = 64 * 1024 * 1024;
const MAX_SEALED_VERSIONS = 255;
/** magic ‖ format ‖ K ‖ salt ‖ chunk size ‖ n */
const FIXED_HEADER_BYTES = BACKUP_MAGIC.length + 1 + 4 + SALT_BYTES + 4 + 1;

export class BackupCipherError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackupCipherError';
  }
}

export interface BackupHeader {
  /** The master key version the file key is derived from. */
  readonly keyVersion: number;
  readonly salt: Buffer;
  readonly chunkBytes: number;
  /** The master key versions the copy's sealed secrets are under (informational). */
  readonly sealedKeyVersions: readonly number[];
  /** The header as written: the associated data of every chunk. */
  readonly raw: Buffer;
}

export function encodeHeader(
  keyVersion: number,
  salt: Buffer,
  chunkBytes: number,
  sealedKeyVersions: readonly number[],
): Buffer {
  if (sealedKeyVersions.length > MAX_SEALED_VERSIONS) {
    throw new BackupCipherError('too many sealed key versions for one backup header');
  }
  const out = Buffer.alloc(FIXED_HEADER_BYTES + 4 * sealedKeyVersions.length);
  let at = BACKUP_MAGIC.copy(out, 0);
  at = out.writeUInt8(BACKUP_FORMAT_V1, at);
  at = out.writeUInt32BE(keyVersion, at);
  at += salt.copy(out, at);
  at = out.writeUInt32BE(chunkBytes, at);
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

/** Reads and checks the header of an open encrypted backup. */
async function readHeader(file: FileHandle): Promise<BackupHeader> {
  const fixed = Buffer.alloc(FIXED_HEADER_BYTES);
  const { bytesRead } = await file.read(fixed, 0, fixed.length, 0);
  if (bytesRead < fixed.length || !looksEncrypted(fixed)) {
    throw new BackupCipherError('not an encrypted backup of this gateway (no header)');
  }
  let at = BACKUP_MAGIC.length;
  const format = fixed.readUInt8(at);
  at += 1;
  if (format !== BACKUP_FORMAT_V1) {
    throw new BackupCipherError(
      `the backup is of format ${format}, this image reads format ${BACKUP_FORMAT_V1}`,
    );
  }
  const keyVersion = fixed.readUInt32BE(at);
  at += 4;
  const salt = Buffer.from(fixed.subarray(at, at + SALT_BYTES));
  at += SALT_BYTES;
  const chunkBytes = fixed.readUInt32BE(at);
  at += 4;
  const count = fixed.readUInt8(at);
  if (chunkBytes < 1 || chunkBytes > MAX_CHUNK_BYTES) {
    throw new BackupCipherError('the backup header names an impossible chunk size');
  }
  const versions = Buffer.alloc(4 * count);
  const more = await file.read(versions, 0, versions.length, FIXED_HEADER_BYTES);
  if (more.bytesRead < versions.length) {
    throw new BackupCipherError('the backup header is cut short');
  }
  const sealedKeyVersions: number[] = [];
  for (let i = 0; i < count; i++) sealedKeyVersions.push(versions.readUInt32BE(4 * i));
  return {
    keyVersion,
    salt,
    chunkBytes,
    sealedKeyVersions,
    raw: Buffer.concat([fixed, versions]),
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

export function deriveBackupKey(masterKey: Uint8Array, salt: Uint8Array): Buffer {
  return Buffer.from(hkdfSync('sha256', masterKey, salt, BACKUP_HKDF_INFO, KEY_BYTES));
}

function nonceOf(index: number, final: boolean): Buffer {
  const nonce = Buffer.alloc(12);
  nonce.writeBigUInt64BE(BigInt(index), 0);
  nonce.writeUInt32BE(final ? 1 : 0, 8);
  return nonce;
}

function sealChunk(key: Buffer, header: Buffer, index: number, final: boolean, plain: Buffer) {
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

/** What an encryption wrote. */
export interface EncryptedFile {
  readonly bytes: number;
  readonly header: BackupHeader;
}

/**
 * Encrypts the file at `plainPath` into `outPath` (created exclusively, mode 0600) under
 * the current master key of `keys`. `sealedKeyVersions` go into the header.
 */
export async function encryptBackupFile(
  plainPath: string,
  outPath: string,
  keys: EncryptionKeys,
  sealedKeyVersions: readonly number[],
  chunkBytes: number = BACKUP_CHUNK_BYTES,
): Promise<EncryptedFile> {
  const salt = randomBytes(SALT_BYTES);
  const header = encodeHeader(keys.keyVersion, salt, chunkBytes, sealedKeyVersions);
  const key = deriveBackupKey(keys.masterKey, salt);
  const input = await open(/* turbopackIgnore: true */ plainPath, 'r');
  const output = await open(/* turbopackIgnore: true */ outPath, 'wx', 0o600);
  try {
    const size = (await input.stat()).size;
    await output.write(header);
    let written = header.length;
    const buffer = Buffer.alloc(chunkBytes);
    let index = 0;
    let offset = 0;
    for (;;) {
      const { bytesRead } = await input.read(buffer, 0, chunkBytes, offset);
      offset += bytesRead;
      const final = offset >= size || bytesRead < chunkBytes;
      const sealed = sealChunk(key, header, index, final, buffer.subarray(0, bytesRead));
      await output.write(sealed);
      written += sealed.length;
      index++;
      if (final) break;
    }
    // A plain size that is a multiple of the chunk size ended on a full chunk marked
    // final: the reader takes the last chunk of the file as the final one either way.
    await output.sync();
    return {
      bytes: written,
      header: {
        keyVersion: keys.keyVersion,
        salt,
        chunkBytes,
        sealedKeyVersions: [...sealedKeyVersions],
        raw: header,
      },
    };
  } finally {
    key.fill(0);
    await input.close();
    await output.close();
  }
}

/**
 * Decrypts the encrypted backup at `inPath` into `outPath` (created exclusively, mode
 * 0600) with the key of the version its header names, current or previous. Refuses a
 * version without a key by name; anything else that does not open is one fixed message.
 */
export async function decryptBackupFile(
  inPath: string,
  outPath: string,
  keys: EncryptionKeys,
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
    const key = deriveBackupKey(master, header.salt);
    const output = await open(/* turbopackIgnore: true */ outPath, 'wx', 0o600);
    try {
      const size = (await input.stat()).size;
      const sealedChunk = header.chunkBytes + TAG_BYTES;
      const buffer = Buffer.alloc(sealedChunk);
      let offset = header.raw.length;
      let index = 0;
      for (;;) {
        const remaining = size - offset;
        // The last chunk of the file is the final one; it is shorter than a full chunk,
        // or exactly full when the plain size was a multiple of the chunk size.
        const final = remaining <= sealedChunk;
        const length = final ? remaining : sealedChunk;
        const { bytesRead } = await input.read(buffer, 0, length, offset);
        if (bytesRead < length) throw new BackupCipherError('the backup is cut short');
        offset += bytesRead;
        const plain = openChunk(key, header.raw, index, final, buffer.subarray(0, length));
        await output.write(plain);
        index++;
        if (final) break;
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
