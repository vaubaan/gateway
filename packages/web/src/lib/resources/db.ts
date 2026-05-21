/**
 * Shared DB helpers for the `/api/crm/v1/orgs/:orgId/resources` routes.
 *
 * - `getDb()` narrows the Supabase client to the rows we actually read.
 * - `findOrgIdBySlugOrId()` accepts either the org UUID or the org slug
 *   in the `:orgId` segment of the URL — both forms are used in the
 *   wider codebase (slug for the UI, UUID for machine-to-machine).
 * - `findDefaultSecretManager()` resolves the org's default secret
 *   manager when the caller doesn't pin one explicitly (spec §6.2 :
 *   `is_default=true`).
 *
 * Spec docs/spec/cloud-resource-manager.md §3.1, §6.3.
 */

import { createSupabaseServerClient } from '@/lib/supabase/server';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface OrgRow {
  readonly id: string;
  readonly slug: string;
}

export interface ResourceRow {
  readonly id: string;
  readonly organization_id: string;
  readonly project_id: string | null;
  readonly admin_resource_id: string | null;
  readonly provider_name: string;
  readonly kind: string;
  readonly scope: 'org' | 'project';
  readonly is_admin: boolean;
  readonly name: string;
  readonly variant: string | null;
  readonly provider_ref: string | null;
  readonly console_url: string | null;
  readonly setup_docs_url: string | null;
  readonly health_test_cmd: string | null;
  readonly status: string;
  readonly secret_manager_id: string;
  readonly provider_metadata: Record<string, unknown>;
  readonly provider_permissions: Record<string, unknown>;
  readonly connection_status: string;
  readonly connection_checked_at: string | null;
  readonly connection_message: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface SecretManagerRow {
  readonly id: string;
  readonly organization_id: string;
  readonly kind: string;
  readonly name: string;
  readonly is_default: boolean;
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

/**
 * Resolve `:orgId` URL segment: accept either UUID or slug.
 * RLS gates the lookup — a non-member sees 0 rows and we surface 404.
 */
export async function findOrgIdBySlugOrId(db: NarrowedDb, segment: string): Promise<OrgRow | null> {
  const col = UUID_REGEX.test(segment) ? 'id' : 'slug';
  const { data } = (await db
    .from('organizations')
    .select('id, slug')
    .eq(col, segment)
    .maybeSingle()) as DbResult<OrgRow | null>;
  return data ?? null;
}

export async function findDefaultSecretManager(
  db: NarrowedDb,
  orgId: string,
): Promise<SecretManagerRow | null> {
  const { data } = (await db
    .from('secret_managers')
    .select('id, organization_id, kind, name, is_default')
    .eq('organization_id', orgId)
    .eq('is_default', true)
    .maybeSingle()) as DbResult<SecretManagerRow | null>;
  return data ?? null;
}
