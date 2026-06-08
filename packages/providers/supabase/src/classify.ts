/**
 * Supabase classifier — maps a concrete (tool, args) call to the capability it
 * requires, in Supabase-native semantics.
 *
 * Spec : docs/spec/gateway-capability-model.draft.md §2.1, §3, §6.
 *
 * Supabase exposes (at least) the `db` plane with the ladder (interne → externe) :
 *
 *   niv1 `rows`    — données (`execute_sql` SELECT)
 *   niv2 `tables`  — tables, colonnes, migrations
 *   niv3 `rls`     — policies, roles, advisors
 *   niv4 `project` — projet, clés, conn string
 *
 * The MVP scope is read-only on `db`. Env comes from the matched binding (one
 * Supabase project_ref per env — `staging` vs `prod` are *distinct projects*).
 * If write SQL (INSERT/UPDATE/DDL) is ever exposed through `execute_sql`, it
 * MUST be reclassified as a `rows:write` (and the gating rises with it).
 */

import type { Capability, ProviderBinding } from '@vaubaan/shared';

export type ClassifyResult = { capability: Capability } | { denied: string };

type Kind = 'read-project' | 'read-tables' | 'read-rows' | 'read-rls';

const TOOL_KIND: Record<string, Kind> = {
  supabase__get_project: 'read-project',
  supabase__list_tables: 'read-tables',
  supabase__list_migrations: 'read-tables',
  // MVP: read-only query path. See module note — becomes rows:write if write
  // SQL is ever exposed.
  supabase__execute_sql: 'read-rows',
  supabase__get_advisors: 'read-rls',
};

function levelOf(kind: Kind): string {
  switch (kind) {
    case 'read-project':
      return 'project';
    case 'read-tables':
      return 'tables';
    case 'read-rows':
      return 'rows';
    case 'read-rls':
      return 'rls';
  }
}

function cap(level: string, env?: string): Capability {
  return env
    ? { provider: 'supabase', plane: 'db', level, action: 'read', env }
    : { provider: 'supabase', plane: 'db', level, action: 'read' };
}

/** Env-less capability surface of a tool, for static tools/list filtering. */
export function supabaseToolCapabilities(tool: string): readonly Capability[] {
  const kind = TOOL_KIND[tool];
  return kind ? [cap(levelOf(kind))] : [];
}

/** The Supabase project ref carried by the call, if any. */
function targetRefArg(args: Record<string, unknown>): string | undefined {
  const ref = args.project_ref ?? args.projectRef;
  return typeof ref === 'string' ? ref : undefined;
}

export function classifySupabase(
  tool: string,
  args: Record<string, unknown>,
  bindings: ReadonlyArray<ProviderBinding>,
): ClassifyResult {
  const kind = TOOL_KIND[tool];
  if (!kind) return { denied: `unknown supabase tool '${tool}'.` };

  const supabaseBindings = bindings.filter((b) => b.provider === 'supabase');

  // Resolve the targeted project ref : explicit arg wins ; otherwise fall back
  // to the single binding when unambiguous.
  let targetRef = targetRefArg(args);
  if (targetRef === undefined) {
    if (supabaseBindings.length === 1) {
      targetRef = supabaseBindings[0]!.resource_ref;
    } else {
      return { denied: 'ambiguous supabase target: specify project_ref.' };
    }
  }

  const binding = supabaseBindings.find((b) => b.resource_ref === targetRef);
  if (!binding) {
    return { denied: `supabase project '${targetRef}' is not bound to this project.` };
  }

  // env = the binding's environment. null/absent → env-less capability.
  const env = binding.environment ?? undefined;
  return { capability: cap(levelOf(kind), env) };
}
