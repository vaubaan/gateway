/**
 * SecretManager contract — spec §5.2.
 *
 * The SecretManager is the opaque store of sealed_blobs. ZK crypto lives
 * in the browser; the SM never sees cleartext. Shape is shared with the
 * CAR (coding-agent-runner) side; the CRM exercises the full interface
 * (read + write), the CAR uses only the read half.
 *
 * v1 init ships the types only. A concrete `infisical` implementation
 * lands in a later phase.
 */

export type { SealedBlobV1 as SealedBlob, SealedRecipient } from '@crm/core/crypto';

import { type SealedBlobV1 } from '@crm/core/crypto';

/**
 * Storage backend for sealed Access bundles. Same interface for CRM and
 * CAR; the CAR ignores `put` / `revoke` (read-only consumer).
 *
 * Adressing key is `(resourceId, accessKey)` — see spec §5.2 "Pas
 * d'AccessScope union".
 */
export interface SecretManager {
  /** Identifies the backend implementation (`'infisical'`, `'vault'`, …). */
  readonly kind: string;

  /** Identifies the instance within an org (multiple SMs of same kind allowed). */
  readonly name: string;

  /** Fetch the sealed bundle for `(resourceId, accessKey)`. Throws on 404. */
  get(resourceId: string, accessKey: string): Promise<SealedBlobV1>;

  /** List access keys known for a resource. Optional — not all backends index. */
  list?(resourceId: string): Promise<readonly string[]>;

  /** Persist a sealed bundle. CRM-side only (CAR never calls this). */
  put(resourceId: string, accessKey: string, blob: SealedBlobV1): Promise<void>;

  /** Delete the bundle for `(resourceId, accessKey)`. Idempotent. */
  revoke(resourceId: string, accessKey: string): Promise<void>;
}
