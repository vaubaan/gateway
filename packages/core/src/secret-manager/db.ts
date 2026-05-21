/**
 * `db` SecretManager — the default v1 backend. The sealed_blob lives in
 * Postgres column `resource_access.sealed_blob` (bytea), gated by RLS
 * (spec §3.3). This is the source-of-truth in v1; the Infisical backend
 * is shipped as an optional companion store for future runner pulls
 * (spec §5.2 "Built-in v1 (CAR-side)") and as a place to demo the
 * machine-identity bootstrap pattern.
 *
 * On-disk wire format mirrors `packages/web/src/lib/resource-access/db.ts`:
 * the bytea column stores the UTF-8 bytes of `JSON.stringify(sealedBlob)`
 * (spec §4.3 — `v: 1` shape is canonical). PostgREST returns bytea
 * either as a `\x<hex>` text literal or as a base64 string depending on
 * the `?content` request header; both are accepted here.
 *
 * RLS does the gating: every method runs the user's session. A non-admin
 * member doing `put` will see a `42501` PostgREST error which surfaces
 * here as a thrown `SecretManagerError`.
 */

import type { SealedBlob, SecretManager } from './interface.js';

/**
 * Minimal narrow shape of the Supabase client surface we exercise here.
 * The official `SupabaseClient` types don't model bytea round-trips
 * well, so we declare exactly the chains we need — that gives us strict
 * typing inside the impl without dragging in `@supabase/supabase-js`
 * (which `@crm/core` is *not* a dependency of, to keep the core lean).
 */

export interface DbResult<T> {
  readonly data: T;
  readonly error: { code?: string; message: string } | null;
}

export interface DbSelectChain {
  eq(col: string, val: string): DbSelectChain;
  order(
    col: string,
    opts: { ascending: boolean },
  ): Promise<DbResult<ReadonlyArray<{ key: string }>>>;
  maybeSingle(): Promise<DbResult<{ sealed_blob: unknown } | null>>;
}

export interface DbDeleteChain {
  eq(col: string, val: string): DbDeleteChain & Promise<DbResult<null>>;
}

export interface DbFromTable {
  select(cols: string): DbSelectChain;
  upsert(row: Record<string, unknown>, opts?: { onConflict?: string }): Promise<DbResult<null>>;
  delete(): DbDeleteChain;
}

export interface DbSupabaseLike {
  from(table: string): DbFromTable;
}

export interface DbSecretManagerOptions {
  /**
   * Supabase client (anon role + session JWT). We narrow it to the
   * exact subset of chains this backend exercises.
   */
  readonly supabase: DbSupabaseLike;
  /** Human-readable label, defaults to `'default'`. */
  readonly name?: string;
}

export class SecretManagerError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = 'SecretManagerError';
  }
}

/** Decode a bytea value into the canonical `SealedBlob` JSON. */
export function decodeSealedBytea(value: unknown): SealedBlob | null {
  let bytes: Uint8Array;
  if (value instanceof Uint8Array) {
    bytes = value;
  } else if (typeof value === 'string' && value.startsWith('\\x')) {
    // Postgres `\x<hex>` text representation.
    const hex = value.slice(2);
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i++) {
      out[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
    }
    bytes = out;
  } else if (typeof value === 'string') {
    // PostgREST configured for base64 output. `atob` is available on
    // Node 16+ and every modern browser — no Buffer fallback needed.
    const bin = atob(value);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    bytes = out;
  } else {
    return null;
  }
  try {
    const json: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (!isSealedBlob(json)) return null;
    return json;
  } catch {
    return null;
  }
}

/** Encode a `SealedBlob` JSON to a `\x<hex>` bytea literal supabase-js preserves verbatim. */
export function encodeSealedBytea(blob: SealedBlob): string {
  const utf8 = new TextEncoder().encode(JSON.stringify(blob));
  let hex = '';
  for (let i = 0; i < utf8.length; i++) {
    hex += utf8[i]!.toString(16).padStart(2, '0');
  }
  return `\\x${hex}`;
}

function isSealedBlob(v: unknown): v is SealedBlob {
  if (v === null || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  if (o.v !== 1) return false;
  if (!Array.isArray(o.recipients)) return false;
  for (const r of o.recipients) {
    if (r === null || typeof r !== 'object') return false;
    const rr = r as Record<string, unknown>;
    if (typeof rr.fp !== 'string' || typeof rr.ct !== 'string') return false;
  }
  return true;
}

/**
 * Build a `db`-backed SecretManager bound to a Supabase client. The
 * client must already carry the session JWT — this factory does no auth
 * itself, RLS does the gating.
 */
export function createDbSecretManager(opts: DbSecretManagerOptions): SecretManager {
  const name = opts.name ?? 'default';
  const supabase = opts.supabase;

  async function get(resourceId: string, accessKey: string): Promise<SealedBlob | null> {
    const { data, error } = await supabase
      .from('resource_access')
      .select('sealed_blob')
      .eq('resource_id', resourceId)
      .eq('key', accessKey)
      .maybeSingle();
    if (error) {
      throw new SecretManagerError(
        `db SM get(${resourceId},${accessKey}) failed: ${error.message}`,
        error.code ?? 'database_error',
      );
    }
    if (!data) return null;
    const decoded = decodeSealedBytea(data.sealed_blob);
    if (!decoded) {
      throw new SecretManagerError(
        `db SM get(${resourceId},${accessKey}): sealed_blob payload is not a valid SealedBlobV1`,
        'corrupt_blob',
      );
    }
    return decoded;
  }

  async function list(resourceId: string): Promise<readonly string[]> {
    const { data, error } = await supabase
      .from('resource_access')
      .select('key')
      .eq('resource_id', resourceId)
      .order('key', { ascending: true });
    if (error) {
      throw new SecretManagerError(
        `db SM list(${resourceId}) failed: ${error.message}`,
        error.code ?? 'database_error',
      );
    }
    return (data ?? []).map((r) => r.key);
  }

  async function put(resourceId: string, accessKey: string, blob: SealedBlob): Promise<void> {
    if (!isSealedBlob(blob)) {
      throw new SecretManagerError('db SM put: blob is not a valid SealedBlobV1', 'invalid_blob');
    }
    const sealed = encodeSealedBytea(blob);
    const { error } = await supabase.from('resource_access').upsert(
      {
        resource_id: resourceId,
        key: accessKey,
        sealed_blob: sealed,
      },
      { onConflict: 'resource_id,key' },
    );
    if (error) {
      throw new SecretManagerError(
        `db SM put(${resourceId},${accessKey}) failed: ${error.message}`,
        error.code ?? 'database_error',
      );
    }
  }

  async function revoke(resourceId: string, accessKey: string): Promise<void> {
    const { error } = await supabase
      .from('resource_access')
      .delete()
      .eq('resource_id', resourceId)
      .eq('key', accessKey);
    if (error) {
      throw new SecretManagerError(
        `db SM revoke(${resourceId},${accessKey}) failed: ${error.message}`,
        error.code ?? 'database_error',
      );
    }
  }

  return {
    kind: 'db',
    name,
    get,
    list,
    put,
    revoke,
  };
}
