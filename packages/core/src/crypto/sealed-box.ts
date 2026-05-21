import { getSodium } from './sodium.js';
import { type PubKeyEntry, type SealedBlobV1 } from './types.js';

/**
 * Seals `plaintext` independently for each recipient using libsodium
 * `crypto_box_seal` (spec §4.3, ADR libsodium-sealed-box-multi-recipient).
 * The resulting bundle is the canonical `v: 1` on-disk shape.
 *
 * Accepts a plain string (encoded as UTF-8) or a raw `Uint8Array` for
 * non-textual payloads.
 */
export async function sealForRecipients(
  plaintext: Uint8Array | string,
  recipients: ReadonlyArray<PubKeyEntry>,
): Promise<SealedBlobV1> {
  const sodium = await getSodium();
  const plaintextBytes =
    typeof plaintext === 'string' ? new TextEncoder().encode(plaintext) : plaintext;
  const sealed = recipients.map((recipient) => {
    const ct = sodium.crypto_box_seal(plaintextBytes, recipient.publicKey);
    return { fp: recipient.fingerprint, ct: sodium.to_base64(ct, sodium.base64_variants.ORIGINAL) };
  });
  return { v: 1, recipients: sealed };
}

/**
 * Unseals the recipient entry matching `ownFingerprint`. Returns `null`
 * if no entry matches or if `crypto_box_seal_open` rejects the
 * ciphertext (tampered, wrong key, malformed base64). Never throws on
 * cryptographic failure — callers branch on `null`.
 */
export async function unsealAs(
  blob: SealedBlobV1,
  ownFingerprint: string,
  ownKeypair: { publicKey: Uint8Array; privateKey: Uint8Array },
): Promise<Uint8Array | null> {
  const entry = blob.recipients.find((r) => r.fp === ownFingerprint);
  if (!entry) return null;
  const sodium = await getSodium();
  try {
    const ct = sodium.from_base64(entry.ct, sodium.base64_variants.ORIGINAL);
    return sodium.crypto_box_seal_open(ct, ownKeypair.publicKey, ownKeypair.privateKey);
  } catch {
    return null;
  }
}

/** Decodes a UTF-8 cleartext (e.g. the output of `unsealAs` for a string payload). */
export function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}
