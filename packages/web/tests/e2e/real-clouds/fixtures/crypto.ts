/**
 * Crypto helpers for E2E specs. Node-side libsodium via `@crm/core/crypto`,
 * exact same primitives the browser uses inside the UnlockIdentityDialog
 * + sealed-input + exports/dotenv components.
 *
 * Why node-side, not `page.evaluate` :
 *  - The harness owns the test user end-to-end (created + deleted by
 *    the fixture). Driving the in-page identity dialog adds flakiness
 *    without gaining ZK assurance — the spec uses dummy `vauban-e2e-…`
 *    tokens, not production creds.
 *  - Node-side seal/unseal is deterministic and faster.
 *
 * ZK posture in test mode: the cleartext PAT used by the tests
 * (`PAT_E2E_…`) ONLY exists in the test process's memory + the
 * resulting sealed_blob. Provider tokens swept at cleanup belong to
 * the dedicated `vauban-e2e` test account, never prod.
 *
 * The helpers below also wire the test user's identity into the
 * Vauban CRM by POSTing `/me/crypto-key`, so the sign-in flow in
 * `setup.ts` doesn't have to drive the dialog UI.
 */

import {
  deriveKEK,
  generateUserKeypair,
  sealForRecipients,
  unsealAs,
  unwrapPrivateKey,
  wrapPrivateKey,
  decodeUtf8,
  type KdfParams,
  type SealedBlobV1,
} from '@crm/core/crypto';

const DEFAULT_KDF: KdfParams = { m: 67108864, t: 3, p: 1 };

export interface E2EIdentity {
  readonly publicKey: Uint8Array;
  readonly privateKey: Uint8Array;
  readonly fingerprint: string;
  readonly kdfSalt: Uint8Array;
  readonly wrappedPrivateKey: Uint8Array;
  readonly password: string;
}

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

function fromBase64(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, 'base64'));
}

function randomSalt(): Uint8Array {
  const out = new Uint8Array(16);
  for (let i = 0; i < out.length; i++) {
    out[i] = Math.floor(Math.random() * 256);
  }
  return out;
}

/**
 * Generates a fresh identity, derives the KEK from `password`, wraps
 * the private key. Mirrors the bootstrap path inside the browser
 * (spec §4.1 step 6) but executes node-side.
 */
export async function generateE2EIdentity(password: string): Promise<E2EIdentity> {
  const kp = await generateUserKeypair();
  const kdfSalt = randomSalt();
  const kek = await deriveKEK(password, kdfSalt, DEFAULT_KDF);
  const wrappedPrivateKey = await wrapPrivateKey(kp.privateKey, kek);
  return {
    publicKey: kp.publicKey,
    privateKey: kp.privateKey,
    fingerprint: kp.fingerprint,
    kdfSalt,
    wrappedPrivateKey,
    password,
  };
}

/**
 * Re-derive an existing identity from `wrapped_private_key` + `kdf_salt`
 * + the user's password. Used by RBAC/re-seal specs to assert that the
 * member's key chain is intact after rotation.
 */
export async function unwrapE2EIdentity(input: {
  publicKey: Uint8Array;
  wrappedPrivateKey: Uint8Array;
  kdfSalt: Uint8Array;
  password: string;
  fingerprint: string;
}): Promise<E2EIdentity | null> {
  const kek = await deriveKEK(input.password, input.kdfSalt, DEFAULT_KDF);
  const privateKey = await unwrapPrivateKey(input.wrappedPrivateKey, kek);
  if (privateKey === null) return null;
  return {
    publicKey: input.publicKey,
    privateKey,
    fingerprint: input.fingerprint,
    kdfSalt: input.kdfSalt,
    wrappedPrivateKey: input.wrappedPrivateKey,
    password: input.password,
  };
}

export function identityToCryptoKeyPostBody(identity: E2EIdentity): {
  public_key: string;
  fingerprint: string;
  wrapped_private_key: string;
  kdf_salt: string;
  kdf_params: KdfParams;
} {
  return {
    public_key: toBase64(identity.publicKey),
    fingerprint: identity.fingerprint,
    wrapped_private_key: toBase64(identity.wrappedPrivateKey),
    kdf_salt: toBase64(identity.kdfSalt),
    kdf_params: DEFAULT_KDF,
  };
}

/**
 * Seals a UTF-8 cleartext for one or more recipients. Returns the
 * canonical `v: 1` wire shape directly consumable by
 * `PUT /resources/:rId/access/:key`.
 */
export async function seal(
  cleartext: string,
  recipients: ReadonlyArray<{ fingerprint: string; publicKey: Uint8Array }>,
): Promise<SealedBlobV1> {
  return sealForRecipients(cleartext, recipients);
}

/**
 * Unseals the recipient entry matching `identity.fingerprint`. Returns
 * the UTF-8 cleartext or `null` if the user is not a recipient or the
 * ciphertext is broken.
 */
export async function unseal(blob: SealedBlobV1, identity: E2EIdentity): Promise<string | null> {
  const bytes = await unsealAs(blob, identity.fingerprint, {
    publicKey: identity.publicKey,
    privateKey: identity.privateKey,
  });
  if (bytes === null) return null;
  return decodeUtf8(bytes);
}

export { toBase64, fromBase64 };
