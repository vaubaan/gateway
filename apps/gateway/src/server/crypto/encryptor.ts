/**
 * `Encryptor` — the port the store and the connection flows use to protect
 * credentials at rest (spec §6 "encryption at rest"). Built once by the
 * composition root from `InstanceConfig.encryption`.
 *
 * Key rotation: the operator adds a new `master_key` with a higher
 * `key_version` and keeps the old one under `previous_keys`. New blobs carry
 * the new version; old blobs still open; a re-encryption sweep (later
 * feature) rewrites them and the old key can then be dropped.
 */
import type { EncryptionConfig } from '../config/types';
import { CryptoError, deriveConnectionKey, open, seal, sodiumReady, wipe } from './aead';

export interface EncryptedBlob {
  /** Master key version used; persisted by the store next to the blob. */
  readonly keyVersion: number;
  /** `format || nonce || ciphertext`. */
  readonly blob: Uint8Array;
}

export interface Encryptor {
  readonly currentKeyVersion: number;
  encrypt(connectionId: string, plaintext: string): Promise<EncryptedBlob>;
  decrypt(connectionId: string, sealed: EncryptedBlob): Promise<string>;
}

export async function createEncryptor(config: EncryptionConfig): Promise<Encryptor> {
  await sodiumReady();
  const keys = new Map<number, Uint8Array>(config.previousKeys);
  keys.set(config.keyVersion, config.masterKey);

  function keyFor(version: number): Uint8Array {
    const key = keys.get(version);
    if (!key) {
      throw new CryptoError(
        `no master key for key_version ${version} (current is ${config.keyVersion}; add it under encryption.previous_keys)`,
      );
    }
    return key;
  }

  return {
    currentKeyVersion: config.keyVersion,

    async encrypt(connectionId, plaintext) {
      const key = deriveConnectionKey(keyFor(config.keyVersion), connectionId);
      try {
        const encoder = new TextEncoder();
        return {
          keyVersion: config.keyVersion,
          blob: seal(key, encoder.encode(plaintext), encoder.encode(connectionId)),
        };
      } finally {
        wipe(key);
      }
    },

    async decrypt(connectionId, sealed) {
      const key = deriveConnectionKey(keyFor(sealed.keyVersion), connectionId);
      try {
        const plain = open(key, sealed.blob, new TextEncoder().encode(connectionId));
        return new TextDecoder().decode(plain);
      } finally {
        wipe(key);
      }
    },
  };
}
