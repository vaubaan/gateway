/**
 * Concrete-side interface for SecretManager backends used inside
 * `@crm/core`. Spec docs/spec/cloud-resource-manager.md §5.2.
 *
 * The contract is *structurally identical* to the one exposed in
 * `@crm/catalog` (`packages/crm-catalog/src/secret-manager.ts`) — both
 * derive from the same spec section. We keep a local copy here to avoid
 * a cyclic dependency:
 *
 *     @crm/catalog  →  @crm/core           (for SealedBlobV1)
 *     @crm/core/secret-manager  →  ???     (if it imported @crm/catalog
 *                                            we would have core → catalog → core)
 *
 * The two declarations are kept in lock-step. The catalog interface stays
 * the public surface advertised to plugin authors; this one is the one
 * the in-tree implementations target. Any divergence is a bug — a single
 * smoke test asserts the shapes are compatible (`tests/unit/secret-manager/interface.test.ts`).
 *
 * Implementations:
 *
 * - `./db.ts`        — backed by Supabase column `resource_access.sealed_blob`.
 * - `./infisical.ts` — backed by an Infisical REST workspace.
 *
 * ZK invariant: every SecretManager only ever sees the opaque
 * multi-recipient `SealedBlob` (spec §4.3). No cleartext crosses the
 * SM boundary. The bootstrap auth credential (machine-identity token for
 * Infisical) is itself sealed in `secret_managers.auth_sealed_blob`
 * (spec §5.2 "Bootstrap auth Infisical") and unsealed transitorily in
 * the browser before being handed to a factory; it is never logged.
 */

import type { SealedBlobV1 } from '../crypto/types.js';

export type SealedBlob = SealedBlobV1;

export interface SecretManager {
  /** Backend kind (`'db'`, `'infisical'`, …). Same string as `secret_managers.kind`. */
  readonly kind: string;

  /** Per-org instance label (`'default'`, `'infisical-prod'`, …). */
  readonly name: string;

  /**
   * Fetch the sealed bundle for `(resourceId, accessKey)`. Resolves to
   * `null` when the SM has no entry — implementations must NOT throw on
   * a clean "not found" (callers branch on `null`). Throws only on
   * actual transport / auth failures.
   */
  get(resourceId: string, accessKey: string): Promise<SealedBlob | null>;

  /** Enumerate `accessKey` strings under a resource. Optional. */
  list?(resourceId: string): Promise<readonly string[]>;

  /** Persist a sealed bundle. CRM-side only. */
  put(resourceId: string, accessKey: string, blob: SealedBlob): Promise<void>;

  /** Delete the bundle for `(resourceId, accessKey)`. Idempotent. */
  revoke(resourceId: string, accessKey: string): Promise<void>;
}
