/**
 * Stable hash + canonical-JSON helper for `mcp_configs` snapshots.
 *
 * Spec §6.6: regenerate is idempotent — when the new snapshot is
 * byte-equivalent to the previous one, we keep `generated_at` unchanged
 * (no-op). Byte-equivalence is computed on the **canonical JSON** of
 * the `{ mcp_snapshot, env_snapshot }` pair (sorted keys, deterministic
 * separator).
 *
 * The audit_log entry for `mcp_config.regenerated` records the
 * **hash** of the snapshot (sha256 hex), never the snapshot itself —
 * the latter can be re-fetched via the GET endpoint if needed.
 */

import { createHash } from 'node:crypto';

/**
 * Produce a canonical JSON string for an arbitrary JSON-compatible
 * value. Object keys are sorted lexicographically; arrays preserve
 * input order; primitives use the standard JSON encoding. Used as the
 * comparison and hashing target so cosmetic key reordering doesn't
 * trigger a spurious `generated_at` bump.
 */
export function canonicalJsonStringify(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    const out: Record<string, unknown> = {};
    for (const [k, v] of entries) {
      out[k] = canonicalize(v);
    }
    return out;
  }
  return value;
}

export interface SnapshotPair {
  readonly mcp_snapshot: Record<string, unknown>;
  readonly env_snapshot: Record<string, unknown>;
}

export function snapshotHash(pair: SnapshotPair): string {
  const canon = canonicalJsonStringify({
    mcp_snapshot: pair.mcp_snapshot,
    env_snapshot: pair.env_snapshot,
  });
  return createHash('sha256').update(canon).digest('hex');
}

export function snapshotsByteEqual(a: SnapshotPair, b: SnapshotPair): boolean {
  return (
    canonicalJsonStringify(a.mcp_snapshot) === canonicalJsonStringify(b.mcp_snapshot) &&
    canonicalJsonStringify(a.env_snapshot) === canonicalJsonStringify(b.env_snapshot)
  );
}
