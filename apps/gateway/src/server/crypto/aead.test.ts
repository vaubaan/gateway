import { randomBytes } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';

import type { EncryptionKeys } from '../config/types';
import { BLOB_FORMAT_V1, CryptoError, deriveAccountKey, NONCE_BYTES, sodiumReady } from './aead';
import { createEncryptor, type Encryptor } from './encryptor';

const KEY_V1 = new Uint8Array(randomBytes(32));
const KEY_V2 = new Uint8Array(randomBytes(32));
const CONN_A = '018f3c6e-0000-7000-8000-000000000001';
const CONN_B = '018f3c6e-0000-7000-8000-000000000002';

function config(partial: Partial<EncryptionKeys> = {}): EncryptionKeys {
  return { masterKey: KEY_V1, keyVersion: 1, previousKeys: new Map(), ...partial };
}

describe('Encryptor (XChaCha20-Poly1305, per-account key)', () => {
  let enc: Encryptor;
  beforeAll(async () => {
    enc = await createEncryptor(config());
  });

  it('round-trips and stamps the current key version', async () => {
    const sealed = await enc.encrypt(CONN_A, 'ghp_secret_token_abc123');
    expect(sealed.keyVersion).toBe(1);
    expect(sealed.blob[0]).toBe(BLOB_FORMAT_V1);
    expect(sealed.blob.length).toBe(1 + NONCE_BYTES + 'ghp_secret_token_abc123'.length + 16);
    await expect(enc.decrypt(CONN_A, sealed)).resolves.toBe('ghp_secret_token_abc123');
  });

  it('uses a fresh nonce every time', async () => {
    const a = await enc.encrypt(CONN_A, 'same');
    const b = await enc.encrypt(CONN_A, 'same');
    expect(Buffer.compare(Buffer.from(a.blob), Buffer.from(b.blob))).not.toBe(0);
  });

  it('refuses to open a blob under another account id (key and AD differ)', async () => {
    const sealed = await enc.encrypt(CONN_A, 'secret');
    await expect(enc.decrypt(CONN_B, sealed)).rejects.toBeInstanceOf(CryptoError);
  });

  it('refuses a tampered blob', async () => {
    const sealed = await enc.encrypt(CONN_A, 'secret');
    const blob = new Uint8Array(sealed.blob);
    blob[blob.length - 1]! ^= 0xff;
    await expect(enc.decrypt(CONN_A, { ...sealed, blob })).rejects.toThrow('decryption failed');
  });

  it('refuses a short blob and an unknown format byte', async () => {
    await expect(enc.decrypt(CONN_A, { keyVersion: 1, blob: new Uint8Array(10) })).rejects.toThrow(
      'too short',
    );
    const sealed = await enc.encrypt(CONN_A, 'secret');
    const blob = new Uint8Array(sealed.blob);
    blob[0] = 0x7f;
    await expect(enc.decrypt(CONN_A, { ...sealed, blob })).rejects.toThrow('unknown blob format');
  });

  it('handles empty and unicode plaintext', async () => {
    await expect(enc.decrypt(CONN_A, await enc.encrypt(CONN_A, ''))).resolves.toBe('');
    const text = 'clé secrète éàü 🔐';
    await expect(enc.decrypt(CONN_A, await enc.encrypt(CONN_A, text))).resolves.toBe(text);
  });

  it('refuses an empty account id', async () => {
    await expect(enc.encrypt('', 'x')).rejects.toThrow('account id');
  });
});

describe('Encryptor — key_version', () => {
  it('opens old blobs with a previous key and seals new ones with the current key', async () => {
    const v1 = await createEncryptor(config());
    const old = await v1.encrypt(CONN_A, 'minted under v1');

    const v2 = await createEncryptor(
      config({ masterKey: KEY_V2, keyVersion: 2, previousKeys: new Map([[1, KEY_V1]]) }),
    );
    await expect(v2.decrypt(CONN_A, old)).resolves.toBe('minted under v1');
    const fresh = await v2.encrypt(CONN_A, 'minted under v2');
    expect(fresh.keyVersion).toBe(2);
    await expect(v2.decrypt(CONN_A, fresh)).resolves.toBe('minted under v2');
    // v1 alone cannot open a v2 blob: it does not hold that key.
    await expect(v1.decrypt(CONN_A, fresh)).rejects.toThrow('no master key for key_version 2');
  });

  it('refuses a blob whose version is not configured, naming the fix', async () => {
    const v1 = await createEncryptor(config());
    const old = await v1.encrypt(CONN_A, 'x');
    const v2 = await createEncryptor(config({ masterKey: KEY_V2, keyVersion: 2 }));
    await expect(v2.decrypt(CONN_A, old)).rejects.toThrow('encryption.previous_keys');
  });

  it('refuses a blob stamped with the right version but sealed under another key', async () => {
    const a = await createEncryptor(config());
    const b = await createEncryptor(config({ masterKey: KEY_V2 }));
    const sealed = await a.encrypt(CONN_A, 'x');
    await expect(b.decrypt(CONN_A, sealed)).rejects.toBeInstanceOf(CryptoError);
  });
});

describe('deriveAccountKey', () => {
  beforeAll(sodiumReady);

  it('is deterministic per (master key, account id) and distinct otherwise', () => {
    const a1 = deriveAccountKey(KEY_V1, CONN_A);
    const a2 = deriveAccountKey(KEY_V1, CONN_A);
    const b = deriveAccountKey(KEY_V1, CONN_B);
    const other = deriveAccountKey(KEY_V2, CONN_A);
    expect(Buffer.from(a1).equals(Buffer.from(a2))).toBe(true);
    expect(Buffer.from(a1).equals(Buffer.from(b))).toBe(false);
    expect(Buffer.from(a1).equals(Buffer.from(other))).toBe(false);
    expect(Buffer.from(a1).equals(Buffer.from(KEY_V1))).toBe(false);
  });

  it('rejects a master key of the wrong length', () => {
    expect(() => deriveAccountKey(new Uint8Array(16), CONN_A)).toThrow('32 bytes');
  });
});
