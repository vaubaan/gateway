/**
 * The master key file the instance writes at its first start (ADR
 * master-key-generated-and-handed-over-by-the-instance): 32 random bytes in
 * base64, one line, the format `encryption.master_key` reads (and the one
 * `scripts/gen-master-key.mjs` prints). Written exclusively (`wx`: never over an
 * existing file) with mode 0600, in the directory the configuration names —
 * the data volume, where the store lives.
 */
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';

import { KEY_BYTES } from './aead';

/** What the download hands over and what the setup page receives: the file's name. */
export const MASTER_KEY_FILE_NAME = 'vaubaan-master-key.txt';

/** A fresh key as its file holds it: base64, trailing newline. */
export function generateMasterKeyText(): string {
  return masterKeyFileText(new Uint8Array(randomBytes(KEY_BYTES)));
}

/** The content of the key file for a key: base64 of the bytes, trailing newline. */
export function masterKeyFileText(key: Uint8Array): string {
  return `${Buffer.from(key).toString('base64')}\n`;
}

/**
 * The key a file holds, or `null`: exactly `KEY_BYTES` bytes in base64 (standard
 * or url-safe, padded or not), surrounded by nothing but whitespace — the rule
 * of `encryption.master_key` in the loader.
 */
export function parseMasterKeyText(text: string): Uint8Array | null {
  const trimmed = text.trim();
  if (trimmed === '' || /\s/.test(trimmed)) return null;
  const bytes = Buffer.from(trimmed, 'base64');
  const padded = trimmed.replace(/-/g, '+').replace(/_/g, '/');
  const normalized = padded + '='.repeat((4 - (padded.length % 4)) % 4);
  if (bytes.length !== KEY_BYTES || bytes.toString('base64') !== normalized) return null;
  return new Uint8Array(bytes);
}

export type MasterKeyFileWriter = (path: string, text: string) => void;

/** Writes the key file, 0600, refusing to replace an existing one. */
export const writeMasterKeyFile: MasterKeyFileWriter = (path, text) => {
  writeFileSync(path, text, { mode: 0o600, flag: 'wx' });
};
