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
 * A single-user or single-object write emits the marker slice **alone**
 * (`user[one].W`, `object[one].W`). The user id or object path is validated
 * but is not a slice segment : no catalog entry names an arbitrary
 * identifier there, so it would land on the fallback, and an id spelled
 * `bulk` would be read as the bulk marker.
 *
 * ─── One project resolution, shared with execute ────────────────────────
 *
 * `resolveProjectRef(args, resources)` decides which project a call targets.
 * `execute.ts` calls the same function with the same inputs and builds every
 * URL from its answer, so the project named in the authorised slices is the
 * project the request reaches. Never read `args.project_ref` anywhere else.
 *
 * ─── execute_sql is read-only ───────────────────────────────────────────
 *
 * Risk-model spec §7.2 #2 : `supabase__execute_sql` is strictly read-only. The
 * classifier always emits a single R slice ; `execute.ts` enforces it by
 * calling the Management API read-only endpoint, where Postgres refuses any
 * mutation.
 *
 * ─── apply_migration : one slice per write class, fail closed ───────────
 *
 * A migration is arbitrary SQL. `migration-sql.ts` reads it against an
 * allow-list of statement shapes : the schema write is always emitted, plus
 * `row[bulk].W`, `policy[any].W`, `db-role[any].W`, `extension[any].W` for
 * the classes the recognised statements take. As soon as one statement is
 * not recognised (dynamic SQL, function body, CTE, unknown command…) every
 * class is emitted, so the mission needs all of them. A query that is not a
 * non-empty string is denied.
 */

import type { ClassifyOutcome, Resource, Slice } from '@vaubaan/plugin-sdk';

import { readMigrationSql, type MigrationWriteClass } from './migration-sql.ts';

export type SupabasePlane = 'db' | 'storage' | 'auth' | 'functions';

const PROVIDER = 'supabase';

/**
 * Identifier characters accepted in a slice segment. Bucket ids, object
 * paths (`folder/file.png`), emails (`a@b.c`), phone numbers (`+33…`) and
 * secret names all fit ; brackets, whitespace, commas and glob characters
 * are refused rather than escaped, since they would corrupt the slice.
 */
const SAFE_IDENT = /^[a-zA-Z0-9_.@+:/~-]+$/;

/**
 * A project ref becomes a URL path segment and a host label
 * (`https://<ref>.supabase.co`), so it is held to a narrower alphabet than
 * a slice identifier : no dot, slash, colon, `@`, `?` or `#`.
 */
const PROJECT_REF = /^[a-zA-Z0-9_-]+$/;

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

/** A SQL text the classifier accepts to read : a non-blank string. */
function sqlText(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

// ─── apply_migration : one slice per write class ───────────────────────────

/** The slice of each write class a migration may take on top of the schema write. */
function migrationClassSlice(cls: MigrationWriteClass, ref: string): Slice {
  switch (cls) {
    case 'bulk-row':
      return slice(
        [...project(ref), n('schema'), i('any'), n('table'), i('any'), n('row'), i('bulk')],
        'W',
      );
    case 'policy':
      return slice([...project(ref), n('policy'), i('any')], 'W');
    case 'db-role':
      return slice([...project(ref), n('db-role'), i('any')], 'W');
    case 'extension':
      return slice([...project(ref), n('extension'), i('any')], 'W');
  }
}

/**
 * The schema write, plus one slice per class the SQL takes — every class
 * when a statement is not recognised (`readMigrationSql` fails closed).
 */
function migrationSlices(query: string, ref: string): Slice[] {
  const schemaWrite = slice([...project(ref), n('schema'), i('any'), n('table'), i('any')], 'W');
  return [
    schemaWrite,
    ...readMigrationSql(query).classes.map((cls) => migrationClassSlice(cls, ref)),
  ];
}

// ─── per-tool producers ─────────────────────────────────────────────────────

const settingsRead = (_args: unknown, ref: string): Slice[] => [
  slice([...project(ref), n('project-settings')], 'R'),
];

/** Single-user write : the `user[one]` cardinality marker, the slice the catalog matches. */
function userWrite(ref: string): Slice[] {
  return [slice([...project(ref), n('user'), i('one')], 'W')];
}

/** Single-object write : the `object[one]` cardinality marker under its bucket. */
function objectWrite(ref: string, bucket: string): Slice[] {
  return [slice([...project(ref), n('bucket'), i(bucket), n('object'), i('one')], 'W')];
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
    produce: (args, ref) => {
      const query = sqlText(args.query);
      return query === null ? missing('query') : migrationSlices(query, ref);
    },
  },
  // Always R : the SQL is opaque to the classifier, the read-only endpoint enforces it.
  supabase__execute_sql: {
    plane: 'db',
    produce: (args, ref) => {
      if (sqlText(args.query) === null) return missing('query');
      return [slice([...project(ref), n('schema'), i('any'), n('row'), i('bulk')], 'R')];
    },
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
      return objectWrite(ref, bucket);
    },
  },
  supabase__delete_object: {
    plane: 'storage',
    produce: (args, ref) => {
      const bucket = ident(args.bucket);
      const path = ident(args.path);
      if (!bucket) return missing('bucket');
      if (!path) return missing('path');
      return objectWrite(ref, bucket);
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
    // The identity does not exist yet : one user is created, whatever names it.
    produce: (_a, ref) => userWrite(ref),
  },
  supabase__update_user: {
    plane: 'auth',
    produce: (args, ref) => {
      const id = ident(args.user_id);
      if (!id) return missing('user_id');
      return userWrite(ref);
    },
  },
  supabase__delete_user: {
    plane: 'auth',
    produce: (args, ref) => {
      const id = ident(args.user_id);
      if (!id) return missing('user_id');
      return userWrite(ref);
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

/** A non-empty string safe as a URL path segment and host label, else `null`. */
function projectRefIdent(value: unknown): string | null {
  return typeof value === 'string' && PROJECT_REF.test(value) ? value : null;
}

/**
 * Which project the call targets — the **only** place that decides it, for
 * `classifySupabase` and for `executeSupabase` alike.
 *
 *   - `project_ref` present : it must be a string made of ref characters
 *     (anything else, an array or an object included, is a denial — never
 *     coerced, never skipped) and one of the mission's Supabase resources ;
 *   - `project_ref` absent : the mission's single Supabase project ;
 *   - the camelCase `projectRef` is not an argument of any tool : a call
 *     carrying it is denied, so no second spelling can name another project.
 */
export function resolveProjectRef(
  args: Readonly<Record<string, unknown>>,
  resources: readonly Resource[],
): { ref: string } | { denied: string } {
  if (args.projectRef !== undefined) {
    return { denied: 'projectRef: unknown argument, name the project with project_ref.' };
  }
  const own = resources.filter((r) => r.provider === PROVIDER);
  if (args.project_ref !== undefined) {
    const explicit = projectRefIdent(args.project_ref);
    if (explicit === null) return { denied: missing('project_ref') };
    return own.some((r) => r.ref === explicit)
      ? { ref: explicit }
      : { denied: `supabase project '${explicit}' is not a resource of this mission.` };
  }
  if (own.length !== 1) return { denied: 'ambiguous supabase target: specify project_ref.' };
  const only = projectRefIdent(own[0]!.ref);
  return only === null ? { denied: missing('project_ref') } : { ref: only };
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
