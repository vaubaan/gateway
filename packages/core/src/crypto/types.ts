/**
 * Canonical crypto types shared between the browser, the Runner, and the
 * SecretManager backends. Spec §4.3 (sealed_blob shape) is authoritative —
 * the `fp` field name (not `fingerprint`) is fixed on-disk.
 */

/**
 * One recipient inside a sealed bundle (spec §4.3).
 *
 * `ct` is base64-encoded `crypto_box_seal(cleartext, recipient_pubkey)`.
 * `fp` is the 32-hex-char fingerprint of the recipient's X25519 public key
 * (sha256(pubkey) truncated to 16 bytes — see `fingerprintOf`).
 */
export interface SealedRecipient {
  readonly fp: string;
  readonly ct: string;
}

/**
 * Multi-recipient sealed bundle persisted in `resource_access.sealed_blob`
 * (or in the SecretManager's backing store). Spec §4.3 fixes v=1 in v1;
 * a DEK envelope may land later as v=2.
 */
export interface SealedBlobV1 {
  readonly v: 1;
  readonly recipients: ReadonlyArray<SealedRecipient>;
}

/**
 * Minimal recipient identity: the X25519 public key + its fingerprint.
 * Pure data — no I/O, no sodium instance carried around.
 */
export interface PubKeyEntry {
  readonly publicKey: Uint8Array;
  readonly fingerprint: string;
}
