/**
 * Classifier of the `supabase` provider : `(tool, args, resources) → slices`.
 *
 * Spec : docs/spec/gateway-risk-model.md §7 ; docs/spec/vaubaan-gateway.md §10
 *        ("a classification error is a security hole").
 * Handbook : docs/handbook/providers/supabase.md §2 (tool → slice), §5 (edge cases).
 *
 * Pure : no IO, no credential, no `Date`. Every tool maps to at least one
 * slice ; a call the plugin cannot place on the data model is `denied`,
 * never silently mapped to a broad slice.
 *
 * ─── Cardinality markers ────────────────────────────────────────────────
 *
 * The slice DSL has no notion of cardinality, so the classifier encodes it
 * as literal identifiers in the identifier position :
 *
 *   row[one]    bounded write on a single identified row
 *   row[bulk]   unbounded write (multi-row UPDATE/DELETE, TRUNCATE, …)
 *   object[one] / object[bulk]   idem for storage paths
 *   user[one]   / user[bulk]     idem for GoTrue users
 *
 * The catalog patterns use the same literals, so `row[one].W` fires
 * `row-write-one` but not `bulk-row-write`, and vice versa. Where the value
 * does not matter for the risk (a schema or table name in a migration), the
 * literal `any` is emitted ; the catalog uses `[*]` there.
 *
 * ─── execute_sql is read-only ───────────────────────────────────────────
 *
 * Risk-model spec §7.2 #2 : `supabase__execute_sql` is strictly read-only. The
 * classifier always emits a single R slice ; `execute.ts` enforces it by
 * calling the Management API read-only endpoint, where Postgres refuses any
 * mutation.
 *
 * ─── apply_migration : DDL plus a DML / RLS mini-detector ───────────────
 *
 * A migration may embed DML (a backfill `UPDATE`) or RLS statements. To
 * protect a creator who accepted `migration-write` only, a minimal keyword
 * regex (no SQL parser) adds `row[bulk].W` when DML is present and
 * `policy[any].W` when a policy is touched. False positives over-protect,
 * which is the safe direction.
 */

import type { ClassifyOutcome, Resource, Slice } from '@vaubaan/plugin-sdk';

export type SupabasePlane = 'db' | 'storage' | 'auth' | 'functions';

const PROVIDER = 'supabase';

/**
 * Identifier characters accepted in a slice segment. Bucket ids, object
 * paths (`folder/file.png`), emails (`a@b.c`), phone numbers (`+33…`) and
 * secret names all fit ; brackets, whitespace, commas and glob characters
 * are refused rather than escaped, since they would corrupt the slice.
 */
const SAFE_IDENT = /^[a-zA-Z0-9_.@+:/~-]+$/;

type Segment = { kind: 'name'; value: string } | { kind: 'ident'; value: string };

interface ToolDescriptor {
  /** Informational : the slice path already encodes the plane through its entities. */
  readonly plane: SupabasePlane;
  /** Turn the arguments into slices for the resolved project ref ; `string` = denial reason. */
  readonly produce: (
    args: Readonly<Record<string, unknown>>,
    projectRef: string,
  ) => Slice[] | string;
}

// ─── slice helpers ──────────────────────────────────────────────────────────

function n(value: string): Segment {
  return { kind: 'name', value };
}
function i(value: string): Segment {
  return { kind: 'ident', value };
}
function slice(path: readonly Segment[], action: 'R' | 'W'): Slice {
  return { provider: PROVIDER, path: [...path], action };
}
function project(ref: string): Segment[] {
  return [n('project'), i(ref)];
}

/** A non-empty string made of safe identifier characters, else `null`. */
function ident(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && SAFE_IDENT.test(value) ? value : null;
}
function missing(arg: string): string {
  return `${arg}: missing or malformed.`;
}

// ─── apply_migration mini-detector ─────────────────────────────────────────

const DML_REGEX = /\b(?:insert|update|delete|merge|truncate|copy)\b/i;
const POLICY_REGEX = /\b(?:create|alter|drop)\s+policy\b|\brow\s+level\s+security\b/i;

function migrationSlices(query: string, ref: string): Slice[] {
  const table = [...project(ref), n('schema'), i('any'), n('table'), i('any')];
  const out: Slice[] = [slice(table, 'W')];
  if (DML_REGEX.test(query)) out.push(slice([...table, n('row'), i('bulk')], 'W'));
  if (POLICY_REGEX.test(query)) out.push(slice([...project(ref), n('policy'), i('any')], 'W'));
  return out;
}

// ─── per-tool producers ─────────────────────────────────────────────────────

const settingsRead = (_args: unknown, ref: string): Slice[] => [
  slice([...project(ref), n('project-settings')], 'R'),
];

/** Single-user write : `user[<id>].W` plus the `user[one]` cardinality marker. */
function userWrite(ref: string, id: string): Slice[] {
  const out = [slice([...project(ref), n('user'), i(id)], 'W')];
  if (id !== 'one') out.push(slice([...project(ref), n('user'), i('one')], 'W'));
  return out;
}

/** Single-object write : `object[<path>].W` plus the `object[one]` marker. */
function objectWrite(ref: string, bucket: string, path: string): Slice[] {
  const base = [...project(ref), n('bucket'), i(bucket), n('object')];
  return [slice([...base, i(path)], 'W'), slice([...base, i('one')], 'W')];
}

function secretNames(raw: unknown, key: string): string[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const names: string[] = [];
  for (const item of raw) {
    const name =
      typeof item === 'string' ? ident(item) : ident((item as Record<string, unknown>)?.[key]);
    if (!name) return null;
    names.push(name);
  }
  return names;
}

const TOOLS: Readonly<Record<string, ToolDescriptor>> = {
  // ─── db ───────────────────────────────────────────────────────────────────
  supabase__get_project: { plane: 'db', produce: settingsRead },
  supabase__get_anon_key: { plane: 'db', produce: settingsRead },
  supabase__get_advisors: { plane: 'db', produce: settingsRead },
  supabase__list_tables: {
    plane: 'db',
    produce: (_a, ref) => [
      slice([...project(ref), n('schema'), i('any'), n('table'), i('any')], 'R'),
    ],
  },
  supabase__list_migrations: {
    plane: 'db',
    produce: (_a, ref) => [slice([...project(ref), n('migration'), i('any')], 'R')],
  },
  supabase__apply_migration: {
    plane: 'db',
    produce: (args, ref) => migrationSlices(typeof args.query === 'string' ? args.query : '', ref),
  },
  // Always R : the SQL is opaque to the classifier, the read-only endpoint enforces it.
  supabase__execute_sql: {
    plane: 'db',
    produce: (_a, ref) => [
      slice([...project(ref), n('schema'), i('any'), n('row'), i('bulk')], 'R'),
    ],
  },

  // ─── storage ──────────────────────────────────────────────────────────────
  supabase__list_buckets: {
    plane: 'storage',
    produce: (_a, ref) => [slice([...project(ref), n('bucket'), i('any')], 'R')],
  },
  supabase__get_storage_config: {
    plane: 'storage',
    produce: (_a, ref) => [slice([...project(ref), n('storage-config')], 'R')],
  },
  supabase__update_storage_config: {
    plane: 'storage',
    produce: (_a, ref) => [slice([...project(ref), n('storage-config')], 'W')],
  },
  supabase__create_bucket: {
    plane: 'storage',
    produce: (args, ref) => {
      const id = ident(args.id) ?? ident(args.name);
      if (!id) return missing('id');
      return [slice([...project(ref), n('bucket'), i(id)], 'W')];
    },
  },
  supabase__update_bucket: {
    plane: 'storage',
    produce: (args, ref) => {
      const id = ident(args.id);
      if (!id) return missing('id');
      return [slice([...project(ref), n('bucket'), i(id)], 'W')];
    },
  },
  supabase__delete_bucket: {
    plane: 'storage',
    produce: (args, ref) => {
      const id = ident(args.id);
      if (!id) return missing('id');
      // The bucket itself, plus the cascade on every object it holds.
      return [
        slice([...project(ref), n('bucket'), i(id)], 'W'),
        slice([...project(ref), n('bucket'), i(id), n('object'), i('bulk')], 'W'),
      ];
    },
  },
  supabase__list_objects: {
    plane: 'storage',
    produce: (args, ref) => {
      const bucket = ident(args.bucket);
      if (!bucket) return missing('bucket');
      return [slice([...project(ref), n('bucket'), i(bucket), n('object'), i('any')], 'R')];
    },
  },
  supabase__upload_object: {
    plane: 'storage',
    produce: (args, ref) => {
      const bucket = ident(args.bucket);
      const path = ident(args.path);
      if (!bucket) return missing('bucket');
      if (!path) return missing('path');
      return objectWrite(ref, bucket, path);
    },
  },
  supabase__delete_object: {
    plane: 'storage',
    produce: (args, ref) => {
      const bucket = ident(args.bucket);
      const path = ident(args.path);
      if (!bucket) return missing('bucket');
      if (!path) return missing('path');
      return objectWrite(ref, bucket, path);
    },
  },
  supabase__create_signed_url: {
    plane: 'storage',
    produce: (args, ref) => {
      const bucket = ident(args.bucket);
      const path = ident(args.path);
      if (!bucket) return missing('bucket');
      if (!path) return missing('path');
      return [
        slice(
          [
            ...project(ref),
            n('bucket'),
            i(bucket),
            n('object'),
            i(path),
            n('signed-url'),
            i('any'),
          ],
          'R',
        ),
      ];
    },
  },

  // ─── auth ─────────────────────────────────────────────────────────────────
  supabase__get_auth_config: {
    plane: 'auth',
    produce: (_a, ref) => [slice([...project(ref), n('auth-config')], 'R')],
  },
  supabase__update_auth_config: {
    plane: 'auth',
    produce: (_a, ref) => [slice([...project(ref), n('auth-config')], 'W')],
  },
  supabase__list_sso_providers: {
    plane: 'auth',
    produce: (_a, ref) => [slice([...project(ref), n('sso-provider'), i('any')], 'R')],
  },
  supabase__get_sso_provider: {
    plane: 'auth',
    produce: (args, ref) => {
      const id = ident(args.provider_id);
      if (!id) return missing('provider_id');
      return [slice([...project(ref), n('sso-provider'), i(id)], 'R')];
    },
  },
  supabase__create_sso_provider: {
    plane: 'auth',
    produce: (args, ref) => {
      const type = ident(args.type);
      if (!type) return missing('type');
      return [slice([...project(ref), n('sso-provider'), i(type)], 'W')];
    },
  },
  supabase__update_sso_provider: {
    plane: 'auth',
    produce: (args, ref) => {
      const id = ident(args.provider_id);
      if (!id) return missing('provider_id');
      return [slice([...project(ref), n('sso-provider'), i(id)], 'W')];
    },
  },
  supabase__delete_sso_provider: {
    plane: 'auth',
    produce: (args, ref) => {
      const id = ident(args.provider_id);
      if (!id) return missing('provider_id');
      return [slice([...project(ref), n('sso-provider'), i(id)], 'W')];
    },
  },
  supabase__list_third_party_auth: {
    plane: 'auth',
    produce: (_a, ref) => [slice([...project(ref), n('third-party-auth'), i('any')], 'R')],
  },
  supabase__get_third_party_auth: {
    plane: 'auth',
    produce: (args, ref) => {
      const id = ident(args.tpa_id);
      if (!id) return missing('tpa_id');
      return [slice([...project(ref), n('third-party-auth'), i(id)], 'R')];
    },
  },
  supabase__create_third_party_auth: {
    plane: 'auth',
    produce: (args, ref) => {
      const type = ident(args.type);
      if (!type) return missing('type');
      return [slice([...project(ref), n('third-party-auth'), i(type)], 'W')];
    },
  },
  supabase__delete_third_party_auth: {
    plane: 'auth',
    produce: (args, ref) => {
      const id = ident(args.tpa_id);
      if (!id) return missing('tpa_id');
      return [slice([...project(ref), n('third-party-auth'), i(id)], 'W')];
    },
  },
  supabase__list_users: {
    plane: 'auth',
    produce: (_a, ref) => [slice([...project(ref), n('user'), i('any')], 'R')],
  },
  supabase__get_user: {
    plane: 'auth',
    produce: (args, ref) => {
      const id = ident(args.user_id);
      if (!id) return missing('user_id');
      return [slice([...project(ref), n('user'), i(id)], 'R')];
    },
  },
  supabase__create_user: {
    plane: 'auth',
    // The identity does not exist yet : name it by email or phone when given,
    // and always emit the single-user cardinality marker.
    produce: (args, ref) => userWrite(ref, ident(args.email) ?? ident(args.phone) ?? 'one'),
  },
  supabase__update_user: {
    plane: 'auth',
    produce: (args, ref) => {
      const id = ident(args.user_id);
      if (!id) return missing('user_id');
      return userWrite(ref, id);
    },
  },
  supabase__delete_user: {
    plane: 'auth',
    produce: (args, ref) => {
      const id = ident(args.user_id);
      if (!id) return missing('user_id');
      return userWrite(ref, id);
    },
  },
  supabase__generate_link: {
    plane: 'auth',
    produce: (args, ref) => {
      const email = ident(args.email);
      const type = ident(args.type);
      if (!email) return missing('email');
      if (!type) return missing('type');
      return [slice([...project(ref), n('user'), i(email), n('link'), i(type)], 'W')];
    },
  },

  // ─── functions ────────────────────────────────────────────────────────────
  supabase__list_functions: {
    plane: 'functions',
    produce: (_a, ref) => [slice([...project(ref), n('edge-function'), i('any')], 'R')],
  },
  supabase__get_function: {
    plane: 'functions',
    produce: (args, ref) => {
      const slug = ident(args.function_slug) ?? ident(args.slug);
      if (!slug) return missing('function_slug');
      return [slice([...project(ref), n('edge-function'), i(slug)], 'R')];
    },
  },
  supabase__get_function_body: {
    plane: 'functions',
    produce: (args, ref) => {
      const slug = ident(args.function_slug) ?? ident(args.slug);
      if (!slug) return missing('function_slug');
      return [
        slice([...project(ref), n('edge-function'), i(slug), n('function-body')], 'R'),
        slice([...project(ref), n('edge-function'), i(slug)], 'R'),
      ];
    },
  },
  supabase__list_function_secrets: {
    plane: 'functions',
    produce: (_a, ref) => [slice([...project(ref), n('function-secret'), i('any')], 'R')],
  },
  supabase__create_function: {
    plane: 'functions',
    produce: (args, ref) => {
      const slug = ident(args.slug);
      if (!slug) return missing('slug');
      return [slice([...project(ref), n('edge-function'), i(slug)], 'W')];
    },
  },
  supabase__update_function: {
    plane: 'functions',
    produce: (args, ref) => {
      const slug = ident(args.function_slug);
      if (!slug) return missing('function_slug');
      return [slice([...project(ref), n('edge-function'), i(slug)], 'W')];
    },
  },
  supabase__delete_function: {
    plane: 'functions',
    produce: (args, ref) => {
      const slug = ident(args.function_slug);
      if (!slug) return missing('function_slug');
      return [slice([...project(ref), n('edge-function'), i(slug)], 'W')];
    },
  },
  supabase__deploy_function: {
    plane: 'functions',
    produce: (args, ref) => {
      const slug = ident(args.slug);
      if (!slug) return missing('slug');
      // Always the deployment ; also the body when the bundle re-uploads code.
      const out = [
        slice(
          [...project(ref), n('edge-function'), i(slug), n('function-deployment'), i('any')],
          'W',
        ),
      ];
      if (Array.isArray(args.files) && args.files.length > 0) {
        out.push(slice([...project(ref), n('edge-function'), i(slug)], 'W'));
      }
      return out;
    },
  },
  supabase__create_function_secrets: {
    plane: 'functions',
    produce: (args, ref) => {
      const names = secretNames(args.secrets, 'name');
      if (!names) return missing('secrets');
      return names.map((name) => slice([...project(ref), n('function-secret'), i(name)], 'W'));
    },
  },
  supabase__delete_function_secrets: {
    plane: 'functions',
    produce: (args, ref) => {
      const names = secretNames(args.names, 'name');
      if (!names) return missing('names');
      return names.map((name) => slice([...project(ref), n('function-secret'), i(name)], 'W'));
    },
  },
};

/** Tool → plane, for a UI that filters tools and risks per plane. */
export const SUPABASE_TOOL_PLANES: Readonly<Record<string, SupabasePlane>> = Object.fromEntries(
  Object.entries(TOOLS).map(([name, d]) => [name, d.plane]),
);

/** Every tool the classifier knows ; equal to the declared tool list (asserted in tests). */
export const SUPABASE_CLASSIFIED_TOOLS: readonly string[] = Object.keys(TOOLS);

/**
 * Which project the call targets. An explicit `project_ref` (or `projectRef`)
 * must be one of the mission's Supabase resources ; without it, the mission's
 * single Supabase project is used. Anything else is a denial.
 */
function resolveProjectRef(
  args: Readonly<Record<string, unknown>>,
  resources: readonly Resource[],
): { ref: string } | { denied: string } {
  const explicit = ident(args.project_ref) ?? ident(args.projectRef);
  const own = resources.filter((r) => r.provider === PROVIDER);
  if (explicit) {
    return own.some((r) => r.ref === explicit)
      ? { ref: explicit }
      : { denied: `supabase project '${explicit}' is not a resource of this mission.` };
  }
  if (args.project_ref !== undefined || args.projectRef !== undefined) {
    return { denied: missing('project_ref') };
  }
  if (own.length === 1 && ident(own[0]!.ref)) return { ref: own[0]!.ref };
  return { denied: 'ambiguous supabase target: specify project_ref.' };
}

export function classifySupabase(
  tool: string,
  args: Readonly<Record<string, unknown>>,
  resources: readonly Resource[],
): ClassifyOutcome {
  const descriptor = TOOLS[tool];
  if (!descriptor) return { denied: `unknown supabase tool '${tool}'.` };
  const target = resolveProjectRef(args, resources);
  if ('denied' in target) return target;
  const produced = descriptor.produce(args, target.ref);
  return typeof produced === 'string' ? { denied: produced } : { slices: produced };
}
