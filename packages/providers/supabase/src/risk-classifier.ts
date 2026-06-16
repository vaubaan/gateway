/**
 * Supabase risk classifier (v4) — maps a concrete (tool, args) call to
 * the slice(s) it touches.
 *
 * Source of truth : `.vaubaan/research/providers/supabase.md` §2 (mapping
 * tool → slice) + §6 (edge cases) + §3 (execute_sql read-only).
 * Spec            : docs/spec/gateway-risk-model.md §7 (plugin contract).
 *
 * Contract :
 *
 *   classifySupabaseV4(tool, args, bindings)
 *     → { slices: Slice[] }   when the tool is known and the binding resolves
 *     → { denied: string }    when the tool is unknown OR the project_ref does
 *                             not resolve to a bound resource
 *
 * The classifier does NOT consult the catalog ; it only produces concrete
 * slices. The runtime (`risk-evaluator` + `risk-runtime`) intersects with
 * the catalog and decides.
 *
 * ─── Cardinality markers in concrete slices ────────────────────────────
 *
 * The slice DSL (cf. `slice-dsl.ts`) is intentionally minimal — there is
 * no notion of "cardinality" at the DSL level. We encode cardinality via
 * **literal ident markers** in the concrete identifier position :
 *
 *   row[one]    bounded write on a single identified row
 *   row[bulk]   unbounded write (multi-row UPDATE/DELETE, TRUNCATE, …)
 *   object[one] / object[bulk]   ditto for storage paths
 *   user[one]   / user[bulk]     ditto for GoTrue users
 *
 * The catalog patterns use the same literal markers so a `row[one].W`
 * concrete matches `row-write-one` but NOT `bulk-row-write`, and vice
 * versa. See `risk-catalog.yaml` and the test fixtures.
 *
 * For positions where the *value* doesn't matter for risk classification
 * (schema name, table name in a migration that touches all schemas), we
 * use the literal marker `any` — the catalog patterns use a wild-one
 * `[*]` which matches any literal ident (including `any`, `users`, …).
 *
 * ─── execute_sql is read-only (spec §7.2 #2) ──────────────────────────
 *
 * Per the v4 decision actée, `supabase__execute_sql` is strictly R-only ;
 * the Postgres wrapper (`BEGIN TRANSACTION READ ONLY`) enforces it. The
 * classifier therefore emits only an R slice, regardless of the actual
 * query content :
 *
 *   supabase.project[<ref>].schema[*].row[*].R
 *
 * (`schema[*]` and `row[*]` use wild-one because the SQL is opaque to us ;
 * the catalog's broad `supabase.**.R` `read-data` pattern matches via
 * wild-rec.) The wrapper setup is Phase 4 plumbing — for Phase 1 the
 * classifier just emits this single slice.
 *
 * ─── apply_migration : DDL + DML mini-detector (research §6.2 option 2) ─
 *
 * A migration may embed DML (`UPDATE … SET … WHERE` for backfill, …) in
 * addition to DDL. To protect a manager who only accepted `migration.W`
 * from accidental row writes, we detect DML/RLS keywords with a minimal
 * regex (no full SQL parser — we explicitly dropped that surface) and
 * emit the corresponding additional slice :
 *
 *   - DML keyword detected   → emit row[bulk].W in addition to schema/table.W
 *   - RLS keyword detected   → emit policy[any].W in addition
 *
 * False positives over-protect, which is the safe direction.
 */

import type { ProviderBinding, Slice } from '@vaubaan/shared';

export type ClassifyV4Result = { slices: Slice[] } | { denied: string };

type Plane = 'db' | 'storage' | 'auth' | 'functions';

// ─────────────────────────────────────────────────────────────────────────
// Tool → emission strategy
// ─────────────────────────────────────────────────────────────────────────

/**
 * A tool descriptor : the plane it sits on (informational only — the
 * slice path encodes the plane through the entity chain) and a producer
 * that turns args into one or more slices, given the resolved project
 * ref. Returning `null` from a producer means "denied — args invalid".
 */
interface ToolDescriptor {
  readonly plane: Plane;
  readonly produce: (args: Record<string, unknown>, projectRef: string) => Slice[] | null;
}

const PROVIDER = 'supabase';

// ─── small helpers for building slices ───────────────────────────────────

function s(name: string): { kind: 'name'; value: string } {
  return { kind: 'name', value: name };
}
function id(value: string): { kind: 'ident'; value: string } {
  return { kind: 'ident', value };
}

function asStr(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function slice(
  path: ReadonlyArray<{ kind: 'name'; value: string } | { kind: 'ident'; value: string }>,
  action: 'R' | 'W',
): Slice {
  return { provider: PROVIDER, path: [...path], action };
}

// ─── DML/RLS mini-detector for apply_migration (research §6.2) ──────────

const DML_REGEX = /\b(?:insert|update|delete|merge|truncate|copy)\b/i;
const POLICY_REGEX = /\b(?:create|alter|drop)\s+policy\b|\brow\s+level\s+security\b/i;

function detectMigrationSlices(query: string, projectRef: string): Slice[] {
  const out: Slice[] = [];
  // Always emit the schema/table-level DDL slice (the migration itself).
  out.push(
    slice([s('project'), id(projectRef), s('schema'), id('any'), s('table'), id('any')], 'W'),
  );
  // DML embedded → row[bulk].W
  if (DML_REGEX.test(query)) {
    out.push(
      slice(
        [
          s('project'),
          id(projectRef),
          s('schema'),
          id('any'),
          s('table'),
          id('any'),
          s('row'),
          id('bulk'),
        ],
        'W',
      ),
    );
  }
  // RLS / POLICY keywords → policy[any].W
  if (POLICY_REGEX.test(query)) {
    out.push(slice([s('project'), id(projectRef), s('policy'), id('any')], 'W'));
  }
  return out;
}

// ─── Tool descriptors — one entry per supported MCP tool ────────────────

const TOOLS: Record<string, ToolDescriptor> = {
  // ─── plane `db` ────────────────────────────────────────────────────────
  supabase__get_project: {
    plane: 'db',
    produce: (_args, ref) => [slice([s('project'), id(ref), s('project-settings')], 'R')],
  },
  supabase__get_anon_key: {
    plane: 'db',
    produce: (_args, ref) => [slice([s('project'), id(ref), s('project-settings')], 'R')],
  },
  supabase__list_tables: {
    plane: 'db',
    produce: (_args, ref) => [
      slice([s('project'), id(ref), s('schema'), id('any'), s('table'), id('any')], 'R'),
    ],
  },
  supabase__list_migrations: {
    plane: 'db',
    produce: (_args, ref) => [slice([s('project'), id(ref), s('migration'), id('any')], 'R')],
  },
  supabase__get_advisors: {
    plane: 'db',
    produce: (_args, ref) => [slice([s('project'), id(ref), s('project-settings')], 'R')],
  },
  supabase__apply_migration: {
    plane: 'db',
    produce: (args, ref) => {
      const query = asStr(args.query) ?? '';
      return detectMigrationSlices(query, ref);
    },
  },
  // execute_sql — R only (spec v4 §7.2 #2). Phase 4 will add the
  // Postgres READ ONLY wrapper ; the classifier always emits the R slice.
  supabase__execute_sql: {
    plane: 'db',
    produce: (_args, ref) => [
      slice(
        [
          s('project'),
          id(ref),
          s('schema'),
          { kind: 'ident', value: 'any' },
          s('row'),
          { kind: 'ident', value: 'bulk' },
        ],
        'R',
      ),
    ],
  },

  // ─── plane `storage` ───────────────────────────────────────────────────
  supabase__list_buckets: {
    plane: 'storage',
    produce: (_args, ref) => [slice([s('project'), id(ref), s('bucket'), id('any')], 'R')],
  },
  supabase__get_storage_config: {
    plane: 'storage',
    produce: (_args, ref) => [slice([s('project'), id(ref), s('storage-config')], 'R')],
  },
  supabase__update_storage_config: {
    plane: 'storage',
    produce: (_args, ref) => [slice([s('project'), id(ref), s('storage-config')], 'W')],
  },
  supabase__create_bucket: {
    plane: 'storage',
    produce: (args, ref) => {
      const bid = asStr(args.id) ?? asStr(args.name) ?? 'any';
      return [slice([s('project'), id(ref), s('bucket'), id(bid)], 'W')];
    },
  },
  supabase__update_bucket: {
    plane: 'storage',
    produce: (args, ref) => {
      const bid = asStr(args.id) ?? 'any';
      return [slice([s('project'), id(ref), s('bucket'), id(bid)], 'W')];
    },
  },
  supabase__delete_bucket: {
    plane: 'storage',
    produce: (args, ref) => {
      const bid = asStr(args.id) ?? 'any';
      return [
        // bucket.W (the bucket itself) …
        slice([s('project'), id(ref), s('bucket'), id(bid)], 'W'),
        // … AND a cascade bulk-object-write (research §5.1 note on
        // delete_bucket).
        slice([s('project'), id(ref), s('bucket'), id(bid), s('object'), id('bulk')], 'W'),
      ];
    },
  },
  supabase__list_objects: {
    plane: 'storage',
    produce: (args, ref) => {
      const bid = asStr(args.bucket) ?? 'any';
      return [slice([s('project'), id(ref), s('bucket'), id(bid), s('object'), id('any')], 'R')];
    },
  },
  supabase__upload_object: {
    plane: 'storage',
    produce: (args, ref) => {
      const bid = asStr(args.bucket) ?? 'any';
      const path = asStr(args.path) ?? 'any';
      return [
        slice([s('project'), id(ref), s('bucket'), id(bid), s('object'), id(path)], 'W'),
        // tag the cardinality marker so the catalog can distinguish one-vs-bulk
        slice([s('project'), id(ref), s('bucket'), id(bid), s('object'), id('one')], 'W'),
      ];
    },
  },
  supabase__delete_object: {
    plane: 'storage',
    produce: (args, ref) => {
      const bid = asStr(args.bucket) ?? 'any';
      const path = asStr(args.path) ?? 'any';
      return [
        slice([s('project'), id(ref), s('bucket'), id(bid), s('object'), id(path)], 'W'),
        slice([s('project'), id(ref), s('bucket'), id(bid), s('object'), id('one')], 'W'),
      ];
    },
  },
  supabase__create_signed_url: {
    plane: 'storage',
    produce: (args, ref) => {
      const bid = asStr(args.bucket) ?? 'any';
      const path = asStr(args.path) ?? 'any';
      return [
        slice(
          [
            s('project'),
            id(ref),
            s('bucket'),
            id(bid),
            s('object'),
            id(path),
            s('signed-url'),
            id('any'),
          ],
          'R',
        ),
      ];
    },
  },

  // ─── plane `auth` ──────────────────────────────────────────────────────
  supabase__get_auth_config: {
    plane: 'auth',
    produce: (_args, ref) => [slice([s('project'), id(ref), s('auth-config')], 'R')],
  },
  supabase__update_auth_config: {
    plane: 'auth',
    produce: (_args, ref) => [slice([s('project'), id(ref), s('auth-config')], 'W')],
  },
  supabase__list_sso_providers: {
    plane: 'auth',
    produce: (_args, ref) => [slice([s('project'), id(ref), s('sso-provider'), id('any')], 'R')],
  },
  supabase__get_sso_provider: {
    plane: 'auth',
    produce: (args, ref) => {
      const pid = asStr(args.provider_id) ?? 'any';
      return [slice([s('project'), id(ref), s('sso-provider'), id(pid)], 'R')];
    },
  },
  supabase__create_sso_provider: {
    plane: 'auth',
    produce: (args, ref) => {
      const pid = asStr(args.type) ?? 'any';
      return [slice([s('project'), id(ref), s('sso-provider'), id(pid)], 'W')];
    },
  },
  supabase__update_sso_provider: {
    plane: 'auth',
    produce: (args, ref) => {
      const pid = asStr(args.provider_id) ?? 'any';
      return [slice([s('project'), id(ref), s('sso-provider'), id(pid)], 'W')];
    },
  },
  supabase__delete_sso_provider: {
    plane: 'auth',
    produce: (args, ref) => {
      const pid = asStr(args.provider_id) ?? 'any';
      return [slice([s('project'), id(ref), s('sso-provider'), id(pid)], 'W')];
    },
  },
  supabase__list_third_party_auth: {
    plane: 'auth',
    produce: (_args, ref) => [
      slice([s('project'), id(ref), s('third-party-auth'), id('any')], 'R'),
    ],
  },
  supabase__get_third_party_auth: {
    plane: 'auth',
    produce: (args, ref) => {
      const pid = asStr(args.tpa_id) ?? 'any';
      return [slice([s('project'), id(ref), s('third-party-auth'), id(pid)], 'R')];
    },
  },
  supabase__create_third_party_auth: {
    plane: 'auth',
    produce: (args, ref) => {
      const pid = asStr(args.type) ?? 'any';
      return [slice([s('project'), id(ref), s('third-party-auth'), id(pid)], 'W')];
    },
  },
  supabase__delete_third_party_auth: {
    plane: 'auth',
    produce: (args, ref) => {
      const pid = asStr(args.tpa_id) ?? 'any';
      return [slice([s('project'), id(ref), s('third-party-auth'), id(pid)], 'W')];
    },
  },
  supabase__list_users: {
    plane: 'auth',
    produce: (_args, ref) => [slice([s('project'), id(ref), s('user'), id('any')], 'R')],
  },
  supabase__get_user: {
    plane: 'auth',
    produce: (args, ref) => {
      const uid = asStr(args.user_id) ?? 'any';
      return [slice([s('project'), id(ref), s('user'), id(uid)], 'R')];
    },
  },
  supabase__create_user: {
    plane: 'auth',
    produce: (args, ref) => {
      // Identifier may be missing pre-creation ; we still emit a single-user
      // slice so the catalog fires `auth.user-write-one`. Use the email when
      // available, else the literal "one".
      const uid = asStr(args.email) ?? 'one';
      return [
        slice([s('project'), id(ref), s('user'), id(uid)], 'W'),
        // explicit cardinality marker
        slice([s('project'), id(ref), s('user'), id('one')], 'W'),
      ];
    },
  },
  supabase__update_user: {
    plane: 'auth',
    produce: (args, ref) => {
      const uid = asStr(args.user_id) ?? 'one';
      return [
        slice([s('project'), id(ref), s('user'), id(uid)], 'W'),
        slice([s('project'), id(ref), s('user'), id('one')], 'W'),
      ];
    },
  },
  supabase__delete_user: {
    plane: 'auth',
    produce: (args, ref) => {
      const uid = asStr(args.user_id) ?? 'one';
      return [
        slice([s('project'), id(ref), s('user'), id(uid)], 'W'),
        slice([s('project'), id(ref), s('user'), id('one')], 'W'),
      ];
    },
  },
  supabase__generate_link: {
    plane: 'auth',
    produce: (args, ref) => {
      const target = asStr(args.email) ?? 'one';
      const type = asStr(args.type) ?? 'any';
      return [slice([s('project'), id(ref), s('user'), id(target), s('link'), id(type)], 'W')];
    },
  },

  // ─── plane `functions` ─────────────────────────────────────────────────
  supabase__list_functions: {
    plane: 'functions',
    produce: (_args, ref) => [slice([s('project'), id(ref), s('edge-function'), id('any')], 'R')],
  },
  supabase__get_function: {
    plane: 'functions',
    produce: (args, ref) => {
      const sg = asStr(args.function_slug) ?? asStr(args.slug) ?? 'any';
      return [slice([s('project'), id(ref), s('edge-function'), id(sg)], 'R')];
    },
  },
  supabase__get_function_body: {
    plane: 'functions',
    produce: (args, ref) => {
      const sg = asStr(args.function_slug) ?? asStr(args.slug) ?? 'any';
      return [
        slice([s('project'), id(ref), s('edge-function'), id(sg), s('function-body')], 'R'),
        // also fire the broader functions.read pattern via edge-function[*].R
        slice([s('project'), id(ref), s('edge-function'), id(sg)], 'R'),
      ];
    },
  },
  supabase__list_function_secrets: {
    plane: 'functions',
    produce: (_args, ref) => [slice([s('project'), id(ref), s('function-secret'), id('any')], 'R')],
  },
  supabase__create_function: {
    plane: 'functions',
    produce: (args, ref) => {
      const sg = asStr(args.slug) ?? 'any';
      return [slice([s('project'), id(ref), s('edge-function'), id(sg)], 'W')];
    },
  },
  supabase__update_function: {
    plane: 'functions',
    produce: (args, ref) => {
      const sg = asStr(args.function_slug) ?? 'any';
      return [slice([s('project'), id(ref), s('edge-function'), id(sg)], 'W')];
    },
  },
  supabase__delete_function: {
    plane: 'functions',
    produce: (args, ref) => {
      const sg = asStr(args.function_slug) ?? 'any';
      return [slice([s('project'), id(ref), s('edge-function'), id(sg)], 'W')];
    },
  },
  supabase__deploy_function: {
    plane: 'functions',
    produce: (args, ref) => {
      const sg = asStr(args.slug) ?? 'any';
      // Always emits the deployment slice ; ALSO emits the body.W slice
      // when files[] is non-empty (research §5.1 + §6 — re-upload of code).
      const out: Slice[] = [
        slice(
          [s('project'), id(ref), s('edge-function'), id(sg), s('function-deployment'), id('any')],
          'W',
        ),
      ];
      if (Array.isArray(args.files) && args.files.length > 0) {
        out.push(slice([s('project'), id(ref), s('edge-function'), id(sg)], 'W'));
      }
      return out;
    },
  },
  supabase__create_function_secrets: {
    plane: 'functions',
    produce: (args, ref) => {
      const out: Slice[] = [];
      const secrets = Array.isArray(args.secrets) ? args.secrets : [];
      const names = secrets
        .map((x): string | undefined => {
          if (x === null || typeof x !== 'object') return undefined;
          const n = (x as Record<string, unknown>).name;
          return typeof n === 'string' ? n : undefined;
        })
        .filter((x): x is string => !!x);
      if (names.length === 0) names.push('any');
      for (const n of names) {
        out.push(slice([s('project'), id(ref), s('function-secret'), id(n)], 'W'));
      }
      return out;
    },
  },
  supabase__delete_function_secrets: {
    plane: 'functions',
    produce: (args, ref) => {
      const names = Array.isArray(args.names)
        ? (args.names as unknown[]).filter((x): x is string => typeof x === 'string')
        : [];
      if (names.length === 0) names.push('any');
      return names.map((n) => slice([s('project'), id(ref), s('function-secret'), id(n)], 'W'));
    },
  },
};

/** All MCP tool names this classifier covers (used for lint coverage). */
export const SUPPORTED_TOOLS: ReadonlyArray<string> = Object.keys(TOOLS);

/**
 * Tool → plane lookup. Exposed for the UI : the provider info page filters
 * tools/risks per plane when the provider has > 1 plane. Mirrors what's
 * declared on each `ToolDescriptor.plane` above — the cast is safe because
 * `TOOLS` is the single source of truth for the supported set.
 */
export const TOOL_PLANES: Readonly<Record<string, 'db' | 'storage' | 'auth' | 'functions'>> =
  Object.fromEntries(Object.entries(TOOLS).map(([name, desc]) => [name, desc.plane]));

/** Resolve which project_ref the call targets. Mirrors classifySupabase v1
 *  semantics : explicit `project_ref` (or `projectRef`) arg wins ; falls back
 *  to the single Supabase binding when unambiguous. Returns `null` on
 *  ambiguity / mismatch. */
function resolveTargetRef(
  args: Record<string, unknown>,
  bindings: ReadonlyArray<ProviderBinding>,
): string | null {
  const explicit = asStr(args.project_ref) ?? asStr(args.projectRef);
  const supabaseBindings = bindings.filter((b) => b.provider === 'supabase');
  if (explicit) {
    const match = supabaseBindings.find((b) => b.resource_ref === explicit);
    return match ? explicit : null;
  }
  if (supabaseBindings.length === 1) return supabaseBindings[0]!.resource_ref;
  return null;
}

/**
 * Classify a (tool, args, bindings) call into the slice(s) it touches.
 * Strict-fail : unknown tool → denied ; unresolved project_ref → denied.
 * Per-tool producers can also return `null` to signal arg-level denial.
 */
export function classifySupabaseV4(
  tool: string,
  args: Record<string, unknown>,
  bindings: ReadonlyArray<ProviderBinding>,
): ClassifyV4Result {
  const descriptor = TOOLS[tool];
  if (!descriptor) return { denied: `unknown supabase tool '${tool}'.` };

  const ref = resolveTargetRef(args, bindings);
  if (!ref) {
    const explicit = asStr(args.project_ref) ?? asStr(args.projectRef);
    if (explicit) {
      return {
        denied: `supabase project '${explicit}' is not bound to this access token.`,
      };
    }
    return { denied: 'ambiguous supabase target: specify project_ref.' };
  }

  const slices = descriptor.produce(args, ref);
  if (slices === null) {
    return { denied: `invalid arguments for '${tool}'.` };
  }
  return { slices };
}
