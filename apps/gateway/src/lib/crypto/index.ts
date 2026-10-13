/**
 * LEGACY v4 entry point — kept only so the v4 UI and `/mcp` route still
 * compile until Phase 1 replaces them (P1.4 connections, P1.6 execution
 * door). New code imports `@/server/crypto` and receives the `Encryptor`
 * from the composition root; nothing here reads configuration except this
 * shim, which keeps the v4 `ENCRYPTION_MASTER_KEY` contract.
 */
import { createEncryptor, type Encryptor } from '@/server/crypto';
import { MASTER_KEY_BYTES } from '@/server/config';

const LEGACY_ENV = 'ENCRYPTION_MASTER_KEY';
// single-process only — module-level memo of the v4 encryptor; the v5 replacement is the
// `Encryptor` held by the composition root (`getRoot()`), deleted with this shim in Phase 1.
let legacyEncryptor: Promise<Encryptor> | null = null;

function legacy(): Promise<Encryptor> {
  if (legacyEncryptor) return legacyEncryptor;
  const encoded = process.env[LEGACY_ENV];
  if (!encoded) {
    return Promise.reject(new Error(`${LEGACY_ENV} is not set (legacy v4 crypto shim)`));
  }
  const masterKey = new Uint8Array(Buffer.from(encoded, 'base64'));
  if (masterKey.length !== MASTER_KEY_BYTES) {
    return Promise.reject(
      new Error(`${LEGACY_ENV} must decode to ${MASTER_KEY_BYTES} bytes, got ${masterKey.length}`),
    );
  }
  legacyEncryptor = createEncryptor({ masterKey, keyVersion: 1, previousKeys: new Map() });
  return legacyEncryptor;
}

/** @deprecated v4 shim; use `Encryptor.encrypt` from the composition root. */
export async function encryptProviderSecret(orgId: string, plaintext: string): Promise<Buffer> {
  const { blob } = await (await legacy()).encrypt(orgId, plaintext);
  return Buffer.from(blob);
}

/** @deprecated v4 shim; use `Encryptor.decrypt` from the composition root. */
export async function decryptProviderSecret(
  orgId: string,
  ciphertext: Uint8Array | Buffer,
): Promise<string> {
  return (await legacy()).decrypt(orgId, { keyVersion: 1, blob: new Uint8Array(ciphertext) });
}
