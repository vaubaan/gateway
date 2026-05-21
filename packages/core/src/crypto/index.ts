/**
 * @crm/core/crypto — pure crypto primitives for the CRM zero-knowledge
 * runtime. Reusable from the browser (sealed-box at PUT time) and from
 * the Runner / Node tests (unseal at use time).
 *
 * Spec: docs/spec/cloud-resource-manager.md §4.
 * ADRs: docs/decisions/crypto-libsodium-sealed-box-multi-recipient.md,
 *       docs/decisions/single-keypair-per-user.md.
 */

export { getSodium } from './sodium.js';
export { deriveKEK, type KdfParams } from './kdf.js';
export { generateUserKeypair, fingerprintOf, type UserKeypair } from './keypair.js';
export { wrapPrivateKey, unwrapPrivateKey } from './wrap.js';
export { sealForRecipients, unsealAs, decodeUtf8 } from './sealed-box.js';
export { defaultRecipients, type DefaultRecipientsInput } from './recipient-defaults.js';
export type { PubKeyEntry, SealedBlobV1, SealedRecipient } from './types.js';
