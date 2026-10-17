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

export type MasterKeyFileWriter = (path: string, text: string) => void;

/** Writes the key file, 0600, refusing to replace an existing one. */
export const writeMasterKeyFile: MasterKeyFileWriter = (path, text) => {
  writeFileSync(path, text, { mode: 0o600, flag: 'wx' });
};
