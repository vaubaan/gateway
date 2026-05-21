/**
 * Shared DB helpers for `/api/crm/v1/orgs/:orgId/secret-managers` and
 * `/api/crm/v1/orgs/:orgId/needs-reseal` route handlers.
 *
 * Spec docs/spec/cloud-resource-manager.md §3.1, §6.2, §4.5.
 *
 * The `auth_sealed_blob` column is `bytea` — we encode the JSON
 * `SealedBlobV1` shape the same way the access blob is encoded
 * (`\x<hex>` text literal), so the wire format is uniform across the
 * codebase.
 */

import { createSupabaseServerClient } from '@/lib/supabase/server';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface OrgRow {
  readonly id: string;
  readonly slug: string;
}

export interface SecretManagerRow {
  readonly id: string;
  readonly organization_id: string;
  readonly kind: string;
  readonly name: string;
  readonly is_default: boolean;
  readonly config: Record<string, unknown>;
  readonly auth_sealed_blob: string | Uint8Array | null;
  readonly created_at: string;
}

export interface NeedsResealRow {
  readonly resource_id: string;
  readonly key: string;
  readonly resource_name: string;
  readonly recipients_stale: boolean;
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
  eq(col: string, val: string | boolean): UpdateChain;
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

export interface FromTable {
  select(cols: string): SelectChain;
  insert(row: Record<string, unknown> | ReadonlyArray<Record<string, unknown>>): InsertChain;
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

/**
 * Encode the sealed `auth_sealed_blob` JSON as a `\x<hex>` text literal.
 * Mirrors `lib/resource-access/db.ts::sealedBlobToBytea`.
 */
export function sealedAuthToBytea(blob: unknown): string {
  const utf8 = Buffer.from(JSON.stringify(blob), 'utf8');
  return `\\x${utf8.toString('hex')}`;
}
