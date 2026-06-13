/**
 * Supabase classifier — maps a concrete (tool, args) call to the capability it
 * requires, in Supabase-native semantics.
 *
 * Spec : docs/spec/gateway-capability-model.md §2.1, §3, §6.
 *
 * Supabase exposes four planes :
 *
 *   db        rows → tables → rls → project
 *   storage   objects → buckets → storage-config
 *   auth      users → providers → auth-config
 *   functions deployment → config → functions-config
 *
 * Env comes from the matched binding (one Supabase project_ref per env —
 * `staging` vs `prod` are *distinct projects*).
 *
 * `supabase__execute_sql` is a generic SQL passthrough : its capability is
 * computed dynamically by parsing the query (see `sql-classify.ts`) — a
 * SELECT lands on `db/rows:read`, an `INSERT` on `db/rows:write`, a
 * `CREATE POLICY` on `db/rls:write`, etc.
 */

import type { Capability, EnvResolution, ProviderBinding } from '@vaubaan/shared';
import { classifySql, type Action as SqlAction, type Level as SqlLevel } from './sql-classify.ts';

export type ClassifyResult = { capability: Capability } | { denied: string };

type Plane = 'db' | 'storage' | 'auth' | 'functions';

interface StaticEntry {
  plane: Plane;
  level: string;
  action: 'read' | 'write';
}

/** Surface for tools whose capability is fixed by the tool name alone.
 *  `execute_sql` is intentionally NOT in this map — it is classified
 *  per-statement via `classifySql`. */
const TOOL_SURFACE: Record<string, StaticEntry> = {
  // db plane — fixed-shape reads
  supabase__get_project: { plane: 'db', level: 'project', action: 'read' },
  supabase__get_anon_key: { plane: 'db', level: 'project', action: 'read' },
  supabase__list_tables: { plane: 'db', level: 'tables', action: 'read' },
  supabase__list_migrations: { plane: 'db', level: 'tables', action: 'read' },
  supabase__get_advisors: { plane: 'db', level: 'rls', action: 'read' },
  // db plane — writes
  supabase__apply_migration: { plane: 'db', level: 'tables', action: 'write' },
  // storage plane
  supabase__list_buckets: { plane: 'storage', level: 'buckets', action: 'read' },
  supabase__get_storage_config: { plane: 'storage', level: 'storage-config', action: 'read' },
  supabase__update_storage_config: { plane: 'storage', level: 'storage-config', action: 'write' },
  // auth plane — reads
  supabase__get_auth_config: { plane: 'auth', level: 'auth-config', action: 'read' },
  supabase__list_sso_providers: { plane: 'auth', level: 'providers', action: 'read' },
  supabase__get_sso_provider: { plane: 'auth', level: 'providers', action: 'read' },
  supabase__list_third_party_auth: { plane: 'auth', level: 'providers', action: 'read' },
  supabase__get_third_party_auth: { plane: 'auth', level: 'providers', action: 'read' },
  // auth plane — writes
  supabase__update_auth_config: { plane: 'auth', level: 'auth-config', action: 'write' },
  supabase__create_sso_provider: { plane: 'auth', level: 'providers', action: 'write' },
  supabase__update_sso_provider: { plane: 'auth', level: 'providers', action: 'write' },
  supabase__delete_sso_provider: { plane: 'auth', level: 'providers', action: 'write' },
  supabase__create_third_party_auth: { plane: 'auth', level: 'providers', action: 'write' },
  supabase__delete_third_party_auth: { plane: 'auth', level: 'providers', action: 'write' },
  // functions plane — reads
  supabase__list_functions: { plane: 'functions', level: 'deployment', action: 'read' },
  supabase__get_function: { plane: 'functions', level: 'deployment', action: 'read' },
  supabase__get_function_body: { plane: 'functions', level: 'deployment', action: 'read' },
  supabase__list_function_secrets: { plane: 'functions', level: 'config', action: 'read' },
  // functions plane — writes
  supabase__create_function: { plane: 'functions', level: 'deployment', action: 'write' },
  supabase__update_function: { plane: 'functions', level: 'deployment', action: 'write' },
  supabase__delete_function: { plane: 'functions', level: 'deployment', action: 'write' },
  supabase__deploy_function: { plane: 'functions', level: 'deployment', action: 'write' },
  supabase__create_function_secrets: { plane: 'functions', level: 'config', action: 'write' },
  supabase__delete_function_secrets: { plane: 'functions', level: 'config', action: 'write' },
  // auth/users — data plane (gateway uses service_role internally)
  supabase__list_users: { plane: 'auth', level: 'users', action: 'read' },
  supabase__get_user: { plane: 'auth', level: 'users', action: 'read' },
  supabase__create_user: { plane: 'auth', level: 'users', action: 'write' },
  supabase__update_user: { plane: 'auth', level: 'users', action: 'write' },
  supabase__delete_user: { plane: 'auth', level: 'users', action: 'write' },
  supabase__generate_link: { plane: 'auth', level: 'users', action: 'write' },
  // storage/buckets — data plane writes
  supabase__create_bucket: { plane: 'storage', level: 'buckets', action: 'write' },
  supabase__update_bucket: { plane: 'storage', level: 'buckets', action: 'write' },
  supabase__delete_bucket: { plane: 'storage', level: 'buckets', action: 'write' },
  // storage/objects — data plane
  supabase__list_objects: { plane: 'storage', level: 'objects', action: 'read' },
  supabase__upload_object: { plane: 'storage', level: 'objects', action: 'write' },
  supabase__delete_object: { plane: 'storage', level: 'objects', action: 'write' },
  supabase__create_signed_url: { plane: 'storage', level: 'objects', action: 'read' },
};

const EXECUTE_SQL = 'supabase__execute_sql';

function cap(plane: Plane, level: string, action: 'read' | 'write', env?: string): Capability {
  return env
    ? { provider: 'supabase', plane, level, action, env }
    : { provider: 'supabase', plane, level, action };
}

/** Env-less capability surface of a tool, for static tools/list filtering.
 *  `execute_sql` is dynamic — its static surface advertises every (level,
 *  action) on the db plane so the tools/list filter exposes it to any token
 *  that has at least one db capability. */
export function supabaseToolCapabilities(tool: string): readonly Capability[] {
  if (tool === EXECUTE_SQL) {
    const levels: SqlLevel[] = ['rows', 'tables', 'rls', 'project'];
    const actions: SqlAction[] = ['read', 'write'];
    const out: Capability[] = [];
    for (const level of levels) {
      for (const action of actions) out.push(cap('db', level, action));
    }
    return out;
  }
  const entry = TOOL_SURFACE[tool];
  return entry ? [cap(entry.plane, entry.level, entry.action)] : [];
}

/** How env is determined at `tools/call` time. Every Supabase tool resolves
 *  env from the matched binding's `environment` (one project_ref per env), so
 *  the static filter ignores env — any env-qualified grant on the right plane
 *  is a potential match ; the binding-bound env defensive check fires at call
 *  time. Unknown tools default to `static` (env-less surface, no callability). */
export function supabaseToolEnvResolution(tool: string): EnvResolution {
  if (tool === EXECUTE_SQL || tool in TOOL_SURFACE) return 'runtime';
  return 'static';
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
  if (tool !== EXECUTE_SQL && !TOOL_SURFACE[tool]) {
    return { denied: `unknown supabase tool '${tool}'.` };
  }

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
  const env = binding.environment ?? undefined;

  if (tool === EXECUTE_SQL) {
    const query = typeof args.query === 'string' ? args.query : '';
    const req = classifySql(query);
    return { capability: cap('db', req.level, req.action, env) };
  }

  const entry = TOOL_SURFACE[tool]!;
  return { capability: cap(entry.plane, entry.level, entry.action, env) };
}
