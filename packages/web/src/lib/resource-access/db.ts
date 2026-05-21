/**
 * Shared DB helpers for the `/api/crm/v1/orgs/:orgId/resources/:rId/access`
 * route handlers (sister of `lib/resources/db.ts`).
 *
 * Spec docs/spec/cloud-resource-manager.md §3.1, §6.4.
 *
 * Wire format for the `sealed_blob` column (bytea): the JSON shape
 * `SealedBlobV1` is canonical (spec §4.3). On disk we store the
 * **bytes of the UTF-8 encoding** of `JSON.stringify(blob)` — that way
 * the column is opaque to Postgres, RLS gates the row, and we don't
 * have to expand the schema for a polymorphic JSON variant later. The
 * recipient list inside is still readable in clear by anyone with a
 * SELECT permission (recipient list lives in plain JSON), which is the
 * intent of spec §4.4 (recipients are public, ciphertexts are not).
 */

import { createSupabaseServerClient } from '@/lib/supabase/server';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface OrgRow {
  readonly id: string;
  readonly slug: string;
}

export interface ResourceRefRow {
  readonly id: string;
  readonly organization_id: string;
  readonly kind: string;
  readonly scope: string;
}

export interface AccessRow {
  readonly id: string;
  readonly resource_id: string;
  readonly key: string;
  readonly sealed_blob: string | Uint8Array;
  readonly description: string | null;
  readonly rotated_at: string;
}

export interface DbError {
  readonly code?: string;
  readonly message: string;
}

export interface DbResult<T> {
  readonly data: T;
  readonly error: DbError | null;
}

export interface SelectChain {
  eq(col: string, val: string | boolean): SelectChain;
  in(col: string, vals: ReadonlyArray<string>): SelectChain;
  order(col: string, opts: { ascending: boolean }): SelectChain;
  maybeSingle(): Promise<DbResult<unknown>>;
  single(): Promise<DbResult<unknown>>;
  then<T1, T2>(
    onfulfilled?: (value: DbResult<unknown>) => T1 | PromiseLike<T1>,
    onrejected?: (reason: unknown) => T2 | PromiseLike<T2>,
  ): Promise<T1 | T2>;
}

export interface UpdateChain {
  eq(col: string, val: string): UpdateChain;
  select(cols?: string): SelectChain;
}

export interface DeleteEqChain extends Promise<DbResult<unknown>> {
  eq(col: string, val: string): DeleteEqChain;
}

export interface DeleteChain {
  eq(col: string, val: string): DeleteEqChain;
}

export interface InsertChain extends Promise<DbResult<unknown>> {
  select(cols?: string): SelectChain;
}

export interface UpsertChain extends Promise<DbResult<unknown>> {
  select(cols?: string): SelectChain;
}

export interface FromTable {
  select(cols: string): SelectChain;
  insert(row: Record<string, unknown> | ReadonlyArray<Record<string, unknown>>): InsertChain;
  upsert(row: Record<string, unknown>, opts?: { onConflict?: string }): UpsertChain;
  update(row: Record<string, unknown>): UpdateChain;
  delete(): DeleteChain;
}

export interface NarrowedDb {
  auth: {
    getUser(): Promise<{
      data: { user: { id: string } | null };
      error: { message: string } | null;
    }>;
  };
  from(table: string): FromTable;
}

export async function getDb(): Promise<NarrowedDb> {
  const client: unknown = await createSupabaseServerClient();
  return client as NarrowedDb;
}

export async function findOrgIdBySlugOrId(db: NarrowedDb, segment: string): Promise<OrgRow | null> {
  const col = UUID_REGEX.test(segment) ? 'id' : 'slug';
  const { data } = (await db
    .from('organizations')
    .select('id, slug')
    .eq(col, segment)
    .maybeSingle()) as DbResult<OrgRow | null>;
  return data ?? null;
}

export async function findResourceByOrgAndId(
  db: NarrowedDb,
  orgId: string,
  resourceId: string,
): Promise<ResourceRefRow | null> {
  const { data } = (await db
    .from('resources')
    .select('id, organization_id, kind, scope')
    .eq('organization_id', orgId)
    .eq('id', resourceId)
    .maybeSingle()) as DbResult<ResourceRefRow | null>;
  return data ?? null;
}

/**
 * Encode the canonical `SealedBlobV1` JSON to a Postgres bytea
 * literal (the `\x<hex>` wire format) that supabase-js will preserve
 * unchanged through the INSERT/UPDATE.
 */
export function sealedBlobToBytea(blob: unknown): string {
  const utf8 = Buffer.from(JSON.stringify(blob), 'utf8');
  return `\\x${utf8.toString('hex')}`;
}

/**
 * Decode a bytea value coming back from the wire (`\x<hex>` or
 * Uint8Array) into the canonical JSON object. Returns `null` if the
 * payload is not a valid JSON object — the caller is expected to map
 * that to a 500 (data corruption) which is a programmer error.
 */
export function byteaToSealedBlob(value: string | Uint8Array): unknown {
  let bytes: Uint8Array;
  if (value instanceof Uint8Array) {
    bytes = value;
  } else if (typeof value === 'string' && value.startsWith('\\x')) {
    const hex = value.slice(2);
    bytes = Buffer.from(hex, 'hex');
  } else if (typeof value === 'string') {
    // PostgREST configured for base64 output already.
    bytes = Buffer.from(value, 'base64');
  } else {
    return null;
  }
  try {
    return JSON.parse(Buffer.from(bytes).toString('utf8'));
  } catch {
    return null;
  }
}
