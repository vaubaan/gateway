import sodium from 'libsodium-wrappers';
import { createHash } from 'node:crypto';

const KDF_CONTEXT = 'vaubaan_';
const NONCE_BYTES = 24;
const KEY_BYTES = 32;

let _masterKey: Uint8Array | null = null;

function getMasterKey(): Uint8Array {
  if (_masterKey) return _masterKey;
  const b64 = process.env.ENCRYPTION_MASTER_KEY;
  if (!b64) {
    throw new Error(
      'ENCRYPTION_MASTER_KEY is not set. ' +
        "Generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\"",
    );
  }
  const buf = Buffer.from(b64, 'base64');
  if (buf.length !== KEY_BYTES) {
    throw new Error(`ENCRYPTION_MASTER_KEY must decode to ${KEY_BYTES} bytes, got ${buf.length}`);
  }
  _masterKey = new Uint8Array(buf);
  return _masterKey;
}

function orgSubkeyIndex(orgId: string): number {
  const hash = createHash('sha256').update(orgId).digest();
  // libsodium-wrappers rejects values > 2^31-1 despite documenting "unsigned int"
  return hash.readUInt32BE(0) & 0x7fffffff;
}

function deriveOrgKey(orgId: string): Uint8Array {
  return sodium.crypto_kdf_derive_from_key(
    KEY_BYTES,
    orgSubkeyIndex(orgId),
    KDF_CONTEXT,
    getMasterKey(),
  );
}

export async function encryptProviderSecret(orgId: string, plaintext: string): Promise<Buffer> {
  await sodium.ready;
  const orgKey = deriveOrgKey(orgId);
  const nonce = sodium.randombytes_buf(NONCE_BYTES);
  const ad = new TextEncoder().encode(orgId);
  const ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
    new TextEncoder().encode(plaintext),
    ad,
    null,
    nonce,
    orgKey,
  );
  sodium.memzero(orgKey);
  return Buffer.concat([Buffer.from(nonce), Buffer.from(ciphertext)]);
}

export async function decryptProviderSecret(
  orgId: string,
  ciphertext: Uint8Array | Buffer,
): Promise<string> {
  await sodium.ready;
  const bytes = ciphertext instanceof Buffer ? new Uint8Array(ciphertext) : ciphertext;
  if (bytes.length < NONCE_BYTES + 1) {
    throw new Error('ciphertext too short');
  }
  const nonce = bytes.slice(0, NONCE_BYTES);
  const encrypted = bytes.slice(NONCE_BYTES);
  const ad = new TextEncoder().encode(orgId);
  const orgKey = deriveOrgKey(orgId);
  const plaintext = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
    null,
    encrypted,
    ad,
    nonce,
    orgKey,
  );
  sodium.memzero(orgKey);
  return new TextDecoder().decode(plaintext);
}

/** Reset cached master key — for testing only. */
export function _resetMasterKey(): void {
  _masterKey = null;
}
