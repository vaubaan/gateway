/**
 * Server-side resolution helpers shared by the 3 `/exports/*` routes.
 *
 * Spec docs/spec/cloud-resource-manager.md §6.7, §6.7.1, §7.5.
 *
 * What lives here:
 *
 *   - `resolveAccessBlobsForResources` — for a set of Resources, fetch
 *     every `resource_access` row (sealed_blob + key + description +
 *     rotated_at) the caller can see via RLS. Returns a flat list keyed
 *     by source resource.
 *   - `pickSecretManagersForResources` — looks up the
 *     `(secret_manager.kind, .name)` pair referenced by each Resource's
 *     `secret_manager_id`. Used by the cloud-resource-map export.
 *
 * ZK invariant: this module **never** unseals a blob. It returns the
 * canonical `SealedBlobV1` shape (or `null` when no row exists), and
 * leaves cleartext resolution to the browser caller.
 */

import { byteaToSealedBlob } from '@/lib/resource-access/db';
import type { NarrowedDb } from '@/lib/resources/db';
import type { ScopedResourceRow } from '@/lib/mcp/resolve-scope';

export interface SealedAccessRow {
  readonly resource_id: string;
  readonly key: string;
  readonly sealed_blob: unknown;
  readonly description: string | null;
  readonly rotated_at: string;
  /** Recipient fingerprints (32-hex), extracted from the blob. */
  readonly recipient_fingerprints: ReadonlyArray<string>;
}

interface RawAccessRow {
  readonly resource_id: string;
  readonly key: string;
  readonly sealed_blob: string | Uint8Array;
  readonly description: string | null;
  readonly rotated_at: string;
}

function extractRecipientFingerprints(blob: unknown): ReadonlyArray<string> {
  if (typeof blob !== 'object' || blob === null) return [];
  const recipients = (blob as { recipients?: unknown }).recipients;
  if (!Array.isArray(recipients)) return [];
  const fps: string[] = [];
  for (const r of recipients) {
    if (typeof r === 'object' && r !== null) {
      const fp = (r as { fp?: unknown }).fp;
      if (typeof fp === 'string' && /^[0-9a-f]{32}$/i.test(fp)) fps.push(fp.toLowerCase());
    }
  }
  return fps;
}

/**
 * Fetch every `resource_access` row attached to the given resource ids.
 * Uses a single PostgREST `IN` clause — RLS strips rows the caller
 * cannot see (the recipient list is **not** the gate at the RLS level;
 * row visibility is org membership).
 *
 * Order is `(resource_id ASC, key ASC)` for byte-stable output.
 */
export async function resolveAccessBlobsForResources(
  db: NarrowedDb,
  resourceIds: ReadonlyArray<string>,
): Promise<ReadonlyArray<SealedAccessRow>> {
  if (resourceIds.length === 0) return [];
  const { data, error } = (await db
    .from('resource_access')
    .select('resource_id, key, sealed_blob, description, rotated_at')
    .in('resource_id', resourceIds)) as {
    data: ReadonlyArray<RawAccessRow> | null;
    error: { message: string } | null;
  };
  if (error) throw new Error(`resolveAccessBlobsForResources: ${error.message}`);
  const rows = data ?? [];
  const out: SealedAccessRow[] = [];
  for (const r of rows) {
    const blob = byteaToSealedBlob(r.sealed_blob);
    if (blob === null) continue;
    out.push({
      resource_id: r.resource_id,
      key: r.key,
      sealed_blob: blob,
      description: r.description,
      rotated_at: r.rotated_at,
      recipient_fingerprints: extractRecipientFingerprints(blob),
    });
  }
  out.sort((a, b) => {
    if (a.resource_id !== b.resource_id) return a.resource_id < b.resource_id ? -1 : 1;
    if (a.key !== b.key) return a.key < b.key ? -1 : 1;
    return 0;
  });
  return out;
}

export interface SecretManagerLookup {
  readonly id: string;
  readonly kind: string;
  readonly name: string;
}

/**
 * Look up the `(kind, name)` of every secret_manager referenced by the
 * resources. Keyed by `secret_manager.id`. Order doesn't matter — the
 * map is consumed by `cloud-resource-map` serialization for per-row
 * embedding.
 */
export async function pickSecretManagersForResources(
  db: NarrowedDb,
  resources: ReadonlyArray<ScopedResourceRow>,
): Promise<ReadonlyMap<string, SecretManagerLookup>> {
  const smIds = Array.from(new Set(resources.map((r) => r.secret_manager_id)));
  if (smIds.length === 0) return new Map();
  const { data, error } = (await db
    .from('secret_managers')
    .select('id, kind, name')
    .in('id', smIds)) as {
    data: ReadonlyArray<SecretManagerLookup> | null;
    error: { message: string } | null;
  };
  if (error) throw new Error(`pickSecretManagersForResources: ${error.message}`);
  const map = new Map<string, SecretManagerLookup>();
  for (const row of data ?? []) map.set(row.id, row);
  return map;
}
