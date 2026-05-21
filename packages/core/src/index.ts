/**
 * @crm/core — shared business logic for the Cloud Resource Manager.
 *
 * Submodules:
 *
 * - `@crm/core/crypto`         — pure crypto primitives (libsodium).
 * - `@crm/core/secret-manager` — runtime SecretManager backends
 *                                (`db`, `infisical`).
 *
 * Other helpers (audit log writers, recipient-list resolvers wired to
 * DB) land in later phases.
 */

export type { SealedBlobV1, SealedRecipient, PubKeyEntry } from './crypto/types.js';
