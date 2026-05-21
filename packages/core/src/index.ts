/**
 * @crm/core — shared business logic for the Cloud Resource Manager.
 *
 * The crypto submodule lives under `@crm/core/crypto`. Other helpers
 * (audit log writers, recipient-list resolvers wired to DB) land in
 * later phases.
 */

export type { SealedBlobV1, SealedRecipient, PubKeyEntry } from './crypto/types.js';
