/**
 * Resolve the set of Resources visible to an MCP / Export scope query.
 *
 * Spec docs/spec/cloud-resource-manager.md §6.6 / §7.5:
 *
 *   project-scoped:  Resources visible at (project=P, variant=v) =
 *                      (project_id=P AND (variant=v OR variant IS NULL))
 *                    UNION
 *                      (organization_id=org(P), scope='org')
 *
 *   org-scoped:      Resources visible at (org, variant?) =
 *                      (organization_id=org)
 *                    AND (variant=v OR variant IS NULL OR scope='org' when v is set)
 *
 * Without a `variant` filter we include all rows of the org.
 *
 * The query uses the user-bound Supabase client — RLS gates row
 * visibility (members only, no service role).
 */

import type { NarrowedDb } from '@/lib/resources/db';

export interface ResolveScopeInput {
  readonly db: NarrowedDb;
  readonly organizationId: string;
  readonly scope: 'org' | 'project';
  readonly projectId?: string | null;
  readonly variant?: string | null;
}

/**
 * Shape of the columns the MCP composer and the exports REST layer
 * need. Mirrors `resources` in spec §3.1 but trimmed to the columns
 * actually used downstream.
 */
export interface ScopedResourceRow {
  readonly id: string;
  readonly organization_id: string;
  readonly project_id: string | null;
  readonly kind: string;
  readonly scope: 'org' | 'project';
  readonly name: string;
  readonly variant: string | null;
  readonly provider_metadata: Record<string, unknown>;
  readonly secret_manager_id: string;
}

interface AnyChain {
  eq(col: string, val: string): AnyChain;
  or(filter: string): AnyChain;
  order(col: string, opts: { ascending: boolean }): AnyChain;
  then<T1, T2>(
    onfulfilled?: (value: {
      data: ReadonlyArray<ScopedResourceRow> | null;
      error: { message: string; code?: string } | null;
    }) => T1 | PromiseLike<T1>,
    onrejected?: (reason: unknown) => T2 | PromiseLike<T2>,
  ): Promise<T1 | T2>;
}

const COLS =
  'id, organization_id, project_id, kind, scope, name, variant, provider_metadata, secret_manager_id';

/**
 * Run the scope-resolution query. Returns the deduplicated list of
 * Resources visible at the given (scope, projectId?, variant?) — order
 * is by `(scope DESC, id ASC)` to keep `org` first (deterministic).
 *
 * NOTE: PostgREST's `or()` filter is composed inline as a single
 * string (`scope.eq.org,project_id.eq.<uuid>`). The `from('resources')`
 * client lib does not expose a union — instead we issue two SELECTs and
 * merge in JS (simple, RLS-friendly, deterministic). The cost stays
 * O(rows-per-org) which is bounded for a CRM workspace.
 */
export async function resolveScopedResources(
  input: ResolveScopeInput,
): Promise<ReadonlyArray<ScopedResourceRow>> {
  const { db, organizationId, scope, projectId, variant } = input;

  if (scope === 'org') {
    // Whole-org export — every Resource in the org. Variant filter
    // narrows to (variant=v OR variant IS NULL OR scope='org').
    const base = db
      .from('resources')
      .select(COLS)
      .eq('organization_id', organizationId) as unknown as AnyChain;
    let chain = base;
    if (typeof variant === 'string' && variant.length > 0) {
      chain = chain.or(`variant.eq.${variant},variant.is.null,scope.eq.org`);
    }
    const { data, error } = await chain
      .order('scope', { ascending: false })
      .order('id', { ascending: true });
    if (error) throw new Error(`resolveScopedResources: ${error.message}`);
    return data ?? [];
  }

  // Project-scoped. We need:
  //   (project_id=P AND (variant=v OR variant IS NULL))
  // UNION
  //   (project_id IS NULL AND scope='org')
  // Both are inside the same organization.

  if (typeof projectId !== 'string' || projectId.length === 0) {
    throw new Error('resolveScopedResources: projectId is required when scope=project');
  }

  const projChain = db
    .from('resources')
    .select(COLS)
    .eq('organization_id', organizationId)
    .eq('project_id', projectId) as unknown as AnyChain;
  let projFiltered = projChain;
  if (typeof variant === 'string' && variant.length > 0) {
    projFiltered = projFiltered.or(`variant.eq.${variant},variant.is.null`);
  }
  const projP = projFiltered.order('id', { ascending: true }) as unknown as Promise<{
    data: ReadonlyArray<ScopedResourceRow> | null;
    error: { message: string } | null;
  }>;

  const orgChain = db
    .from('resources')
    .select(COLS)
    .eq('organization_id', organizationId)
    .eq('scope', 'org')
    .order('id', { ascending: true }) as unknown as Promise<{
    data: ReadonlyArray<ScopedResourceRow> | null;
    error: { message: string } | null;
  }>;

  const [projRes, orgRes] = await Promise.all([projP, orgChain]);
  if (projRes.error) throw new Error(`resolveScopedResources: ${projRes.error.message}`);
  if (orgRes.error) throw new Error(`resolveScopedResources: ${orgRes.error.message}`);

  const seen = new Set<string>();
  const out: ScopedResourceRow[] = [];
  // Org-scoped first so the iteration order matches the org branch.
  for (const r of orgRes.data ?? []) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    out.push(r);
  }
  for (const r of projRes.data ?? []) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    out.push(r);
  }
  // Final order: id ASC across the union for byte-stable composer
  // output (the composer iterates input order).
  out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return out;
}
