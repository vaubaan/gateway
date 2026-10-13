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
 *   row[bulk]   a write of rows (UPDATE/DELETE, TRUNCATE, a column rewrite…).
 *               No tool writes one identified row : `row[one]` is emitted by
 *               nothing, and the catalog entry it matched is deprecated.
 *   object[one] / object[bulk]   idem for storage paths
 *   user[one]   / user[bulk]     idem for GoTrue users
 *
 * The catalog patterns use the same literals, so `user[one].W` fires the
 * single-user write and not the bulk one, and vice versa. Where the value
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
 * ─── One grammar per identifier kind, shared with execute ───────────────
 *
 * Every argument that lands in a URL path, a query string, a host, a header
 * or the SQL text the plugin writes is read by `readIdentifiers(tool, args)`
 * (and `tableSchemas` for `list_tables`), with the grammar of its kind :
 * `pathIdent` for opaque ids and slugs, `bucketId` and `objectPath` for the
 * dotted storage names, `emailAddress`, and closed sets or integers for the
 * rest. `execute.ts` reads them through the same function and builds its
 * request from the answer, never from `args`. A value outside its grammar is
 * denied — never escaped, never replaced by another argument : a dot-only
 * segment would otherwise be classified as a function or an object and sent
 * to the parent endpoint, which URL parsers resolve `..` to.
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

import {
  declaredArgumentsOf,
  isSliceIdent,
  undeclaredArgumentDenial,
  type ClassifyOutcome,
  type Resource,
  type Slice,
} from '@vaubaan/plugin-sdk';

import { readMigrationSql, type MigrationWriteClass } from './migration-sql.ts';
import { supabaseTools } from './tools.ts';

export type SupabasePlane = 'db' | 'storage' | 'auth' | 'functions';

const PROVIDER = 'supabase';

type Args = Readonly<Record<string, unknown>>;

// ─────────────────────────────────────────────────────────────────────────────
// Identifier grammars — one per kind, shared with `execute`
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A project ref becomes a URL path segment **and a host label**
 * (`https://<ref>.supabase.co`), so it is held to the grammar of a host
 * label : lowercase letters, digits and inner hyphens, 63 characters at most.
 * No dot, slash, colon, `@`, `?` or `#` ; no uppercase either, which a URL
 * parser would fold in the host while the path kept it.
 */
const PROJECT_REF = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** The value as a project ref, or `null`. */
export function projectRefIdent(value: unknown): string | null {
  return typeof value === 'string' && PROJECT_REF.test(value) ? value : null;
}

/**
 * An opaque identifier the provider issues or constrains (a user, SSO
 * provider or third-party-auth id — UUIDs —, an edge function slug, a closed
 * keyword such as a link type) : one path segment, no dot, no separator, no
 * escape, bounded. It lands in a slice **and** in a request path, so one
 * grammar serves both. A wider class is not safe for a URL :
 * `encodeURIComponent` leaves `.` and `..` untouched and every URL parser
 * then removes them, so `…/functions/..` would be sent as the project
 * endpoint while the slice named a function.
 */
export const PATH_IDENT = /^[A-Za-z0-9_-]{1,64}$/;

/** The value as a path-safe identifier, or `null`. */
export function pathIdent(value: unknown): string | null {
  return typeof value === 'string' && PATH_IDENT.test(value) ? value : null;
}

/** Characters of a name that is legitimately dotted (a bucket id, a segment of an object path). */
const DOTTED_SEGMENT = /^[A-Za-z0-9_.@+:~-]+$/;
const DOT_ONLY = /^\.+$/;

/** One path segment that may hold dots but is not made of dots alone, and holds no separator. */
function isDottedSegment(value: string): boolean {
  return DOTTED_SEGMENT.test(value) && !DOT_ONLY.test(value);
}

const BUCKET_ID_MAX_LENGTH = 100;

/**
 * A bucket id : one dotted segment (`my.bucket-1`), never `.` or `..`, never
 * a separator. `execute` percent-encodes it ; the grammar is what keeps it
 * one segment a URL parser leaves in place.
 */
export function bucketId(value: unknown): string | null {
  return typeof value === 'string' && value.length <= BUCKET_ID_MAX_LENGTH && isDottedSegment(value)
    ? value
    : null;
}

const OBJECT_PATH_MAX_LENGTH = 1024;

/**
 * An object path inside a bucket (`folder/file.v1.png`) : `/`-separated
 * dotted segments, none empty (no leading, trailing or doubled separator)
 * and none made of dots alone, so the path cannot climb out of its bucket.
 */
export function objectPath(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > OBJECT_PATH_MAX_LENGTH) return null;
  return value.split('/').every(isDottedSegment) ? value : null;
}

const EMAIL_MAX_LENGTH = 254;
const EMAIL_LABEL = '[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?';
const EMAIL = new RegExp(`^[A-Za-z0-9_.+~-]+@${EMAIL_LABEL}(?:\\.${EMAIL_LABEL})+$`);

/** An email address : a local part, one `@`, a dotted domain. It travels in a JSON body. */
export function emailAddress(value: unknown): string | null {
  return typeof value === 'string' && value.length <= EMAIL_MAX_LENGTH && EMAIL.test(value)
    ? value
    : null;
}

/**
 * A name that lands in a slice segment and a JSON body only (a function
 * secret) : brackets, whitespace, commas and glob characters are refused
 * rather than escaped, since they would corrupt the slice.
 */
const SLICE_NAME = /^[a-zA-Z0-9_.@+:/~-]{1,256}$/;

function sliceName(value: unknown): string | null {
  return typeof value === 'string' && SLICE_NAME.test(value) ? value : null;
}

/** The advisor families the Management API serves. */
const ADVISOR_TYPES: ReadonlySet<string> = new Set(['security', 'performance']);
const DEFAULT_ADVISOR_TYPE = 'security';

function advisorType(value: unknown): string | null {
  if (value === undefined) return DEFAULT_ADVISOR_TYPE;
  return typeof value === 'string' && ADVISOR_TYPES.has(value) ? value : null;
}

const PAGE_NUMBER_MAX = 1_000_000;

/** A page number or page size : a positive integer, as its decimal digits ; `fallback` when absent. */
function pageNumber(value: unknown, fallback: number): string | null {
  if (value === undefined) return String(fallback);
  return typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 1 &&
    value <= PAGE_NUMBER_MAX
    ? String(value)
    : null;
}

const BASE64_TEXT = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * A base64 payload : the content of an uploaded object, in the standard alphabet,
 * padded or not, possibly empty. A length no encoding produces (one character over a
 * multiple of four) is refused rather than decoded to whatever fits.
 */
export function base64Text(value: unknown): string | null {
  if (typeof value !== 'string' || !BASE64_TEXT.test(value)) return null;
  const symbols = value.replace(/=+$/, '').length;
  return symbols % 4 === 1 ? null : value;
}

const MEDIA_TOKEN = '[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}';
const MEDIA_TYPE = new RegExp(
  `^${MEDIA_TOKEN}/${MEDIA_TOKEN}(?:; ?[A-Za-z0-9_-]{1,64}=[A-Za-z0-9_.-]{1,64})*$`,
);
const DEFAULT_MEDIA_TYPE = 'application/octet-stream';

/** A media type (`image/png`, `text/plain; charset=utf-8`) : it becomes a request header. */
function mediaType(value: unknown): string | null {
  if (value === undefined) return DEFAULT_MEDIA_TYPE;
  return typeof value === 'string' && MEDIA_TYPE.test(value) ? value : null;
}

/** A Postgres schema name as an unquoted identifier : no quote, no backslash, no whitespace. */
const SCHEMA_NAME = /^[A-Za-z_][A-Za-z0-9_$]{0,62}$/;
const DEFAULT_SCHEMAS: readonly string[] = ['public'];

/**
 * The schemas `list_tables` reads, for `classify` and `execute` alike :
 * `public` when the argument is absent or empty, otherwise an array of
 * schema identifiers. `null` — a denial — for anything else : a name that is
 * not an identifier is refused, never quoted nor dropped, since the names are
 * written into the SQL text the plugin sends.
 */
export function tableSchemas(args: Args): readonly string[] | null {
  const raw = args.schemas;
  if (raw === undefined) return DEFAULT_SCHEMAS;
  if (!Array.isArray(raw)) return null;
  if (raw.length === 0) return DEFAULT_SCHEMAS;
  const names: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string' || !SCHEMA_NAME.test(item)) return null;
    names.push(item);
  }
  return names;
}

type Segment = { kind: 'name'; value: string } | { kind: 'ident'; value: string };

/** Read one identifier from the arguments ; `null` when it is missing or malformed. */
type Reader = (args: Args) => string | null;

/** The identifiers of one call, by argument name. Asking for one the tool does not read is a bug. */
export type ToolIdentifiers = (name: string) => string;

interface ToolDescriptor {
  /** Informational : the slice path already encodes the plane through its entities. */
  readonly plane: SupabasePlane;
  /**
   * The identifier arguments of the tool, each with its grammar, in the order
   * they are checked. The key names the argument in the denial. `execute`
   * builds its request from the same values (`readIdentifiers`).
   */
  readonly ids?: Readonly<Record<string, Reader>>;
  /** Turn the call into slices for the resolved project ref ; `string` = denial reason. */
  readonly produce: (id: ToolIdentifiers, projectRef: string, args: Args) => Slice[] | string;
}

/** The reader of a required argument held to one grammar. */
function arg(name: string, grammar: (value: unknown) => string | null): Record<string, Reader> {
  return { [name]: (args) => grammar(args[name]) };
}

// ─── slice helpers ──────────────────────────────────────────────────────────

function n(value: string): Segment {
  return { kind: 'name', value };
}
/**
 * An identifier segment. Bucket ids, object paths, secret names and e-mail addresses
 * may hold characters the slice grammar has no place for (`@`, `+`, `:`) : such a value
 * is emitted as "any identifier", so the slice the audit stores reads back as itself.
 */
function i(value: string): Segment {
  return { kind: 'ident', value: isSliceIdent(value) ? value : ANY };
}

/** The "any identifier" placeholder of an executed slice. */
const ANY = '*';
function slice(path: readonly Segment[], action: 'R' | 'W'): Slice {
  return { provider: PROVIDER, path: [...path], action };
}
function project(ref: string): Segment[] {
  return [n('project'), i(ref)];
}

function missing(name: string): string {
  return `${name}: missing or malformed.`;
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

const settingsRead = (_id: ToolIdentifiers, ref: string): Slice[] => [
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
      typeof item === 'string'
        ? sliceName(item)
        : sliceName((item as Record<string, unknown>)?.[key]);
    if (!name) return null;
    names.push(name);
  }
  return names;
}

const TOOLS: Readonly<Record<string, ToolDescriptor>> = {
  // ─── db ───────────────────────────────────────────────────────────────────
  supabase__get_project: { plane: 'db', produce: settingsRead },
  supabase__get_anon_key: { plane: 'db', produce: settingsRead },
  supabase__get_advisors: {
    plane: 'db',
    // The advisor family is a path segment of the request : a closed set.
    ids: { type: (args) => advisorType(args.type) },
    produce: settingsRead,
  },
  supabase__list_tables: {
    plane: 'db',
    produce: (_id, ref, args) => {
      // The schema names are written into the SQL text `execute` sends.
      if (tableSchemas(args) === null) return missing('schemas');
      return [slice([...project(ref), n('schema'), i('any'), n('table'), i('any')], 'R')];
    },
  },
  supabase__list_migrations: {
    plane: 'db',
    produce: (_id, ref) => [slice([...project(ref), n('migration'), i('any')], 'R')],
  },
  supabase__apply_migration: {
    plane: 'db',
    produce: (_id, ref, args) => {
      const query = sqlText(args.query);
      return query === null ? missing('query') : migrationSlices(query, ref);
    },
  },
  // Always R : the SQL is opaque to the classifier, the read-only endpoint enforces it.
  supabase__execute_sql: {
    plane: 'db',
    produce: (_id, ref, args) => {
      if (sqlText(args.query) === null) return missing('query');
      return [slice([...project(ref), n('schema'), i('any'), n('row'), i('bulk')], 'R')];
    },
  },

  // ─── storage ──────────────────────────────────────────────────────────────
  supabase__list_buckets: {
    plane: 'storage',
    produce: (_id, ref) => [slice([...project(ref), n('bucket'), i('any')], 'R')],
  },
  supabase__get_storage_config: {
    plane: 'storage',
    produce: (_id, ref) => [slice([...project(ref), n('storage-config')], 'R')],
  },
  supabase__update_storage_config: {
    plane: 'storage',
    produce: (_id, ref) => [slice([...project(ref), n('storage-config')], 'W')],
  },
  supabase__create_bucket: {
    plane: 'storage',
    // Storage names the bucket after `id`, and after `name` when `id` is
    // absent. A malformed `id` is a denial : `name` is not a second chance,
    // `execute` sends both as given.
    ids: { id: (args) => bucketId(args.id !== undefined ? args.id : args.name) },
    produce: (id, ref) => [slice([...project(ref), n('bucket'), i(id('id'))], 'W')],
  },
  supabase__update_bucket: {
    plane: 'storage',
    ids: arg('id', bucketId),
    produce: (id, ref) => [slice([...project(ref), n('bucket'), i(id('id'))], 'W')],
  },
  supabase__delete_bucket: {
    plane: 'storage',
    ids: arg('id', bucketId),
    // The bucket itself, plus the cascade on every object it holds.
    produce: (id, ref) => [
      slice([...project(ref), n('bucket'), i(id('id'))], 'W'),
      slice([...project(ref), n('bucket'), i(id('id')), n('object'), i('bulk')], 'W'),
    ],
  },
  supabase__list_objects: {
    plane: 'storage',
    ids: arg('bucket', bucketId),
    produce: (id, ref) => [
      slice([...project(ref), n('bucket'), i(id('bucket')), n('object'), i('any')], 'R'),
    ],
  },
  supabase__upload_object: {
    plane: 'storage',
    ids: {
      ...arg('bucket', bucketId),
      ...arg('path', objectPath),
      // The media type becomes a request header.
      content_type: (args) => mediaType(args.content_type),
      // The bytes to store: absent or of another type, `String(undefined)` would be
      // uploaded as six bytes of valid base64 over the object.
      content_base64: (args) => base64Text(args.content_base64),
    },
    produce: (id, ref) => objectWrite(ref, id('bucket')),
  },
  supabase__delete_object: {
    plane: 'storage',
    ids: { ...arg('bucket', bucketId), ...arg('path', objectPath) },
    produce: (id, ref) => objectWrite(ref, id('bucket')),
  },
  supabase__create_signed_url: {
    plane: 'storage',
    ids: { ...arg('bucket', bucketId), ...arg('path', objectPath) },
    produce: (id, ref) => [
      slice(
        [
          ...project(ref),
          n('bucket'),
          i(id('bucket')),
          n('object'),
          i(id('path')),
          n('signed-url'),
          i('any'),
        ],
        'R',
      ),
    ],
  },

  // ─── auth ─────────────────────────────────────────────────────────────────
  supabase__get_auth_config: {
    plane: 'auth',
    produce: (_id, ref) => [slice([...project(ref), n('auth-config')], 'R')],
  },
  supabase__update_auth_config: {
    plane: 'auth',
    produce: (_id, ref) => [slice([...project(ref), n('auth-config')], 'W')],
  },
  supabase__list_sso_providers: {
    plane: 'auth',
    produce: (_id, ref) => [slice([...project(ref), n('sso-provider'), i('any')], 'R')],
  },
  supabase__get_sso_provider: {
    plane: 'auth',
    ids: arg('provider_id', pathIdent),
    produce: (id, ref) => [slice([...project(ref), n('sso-provider'), i(id('provider_id'))], 'R')],
  },
  supabase__create_sso_provider: {
    plane: 'auth',
    ids: arg('type', pathIdent),
    produce: (id, ref) => [slice([...project(ref), n('sso-provider'), i(id('type'))], 'W')],
  },
  supabase__update_sso_provider: {
    plane: 'auth',
    ids: arg('provider_id', pathIdent),
    produce: (id, ref) => [slice([...project(ref), n('sso-provider'), i(id('provider_id'))], 'W')],
  },
  supabase__delete_sso_provider: {
    plane: 'auth',
    ids: arg('provider_id', pathIdent),
    produce: (id, ref) => [slice([...project(ref), n('sso-provider'), i(id('provider_id'))], 'W')],
  },
  supabase__list_third_party_auth: {
    plane: 'auth',
    produce: (_id, ref) => [slice([...project(ref), n('third-party-auth'), i('any')], 'R')],
  },
  supabase__get_third_party_auth: {
    plane: 'auth',
    ids: arg('tpa_id', pathIdent),
    produce: (id, ref) => [slice([...project(ref), n('third-party-auth'), i(id('tpa_id'))], 'R')],
  },
  supabase__create_third_party_auth: {
    plane: 'auth',
    ids: arg('type', pathIdent),
    produce: (id, ref) => [slice([...project(ref), n('third-party-auth'), i(id('type'))], 'W')],
  },
  supabase__delete_third_party_auth: {
    plane: 'auth',
    ids: arg('tpa_id', pathIdent),
    produce: (id, ref) => [slice([...project(ref), n('third-party-auth'), i(id('tpa_id'))], 'W')],
  },
  supabase__list_users: {
    plane: 'auth',
    // Both numbers are written into the query string of the request.
    ids: {
      page: (args) => pageNumber(args.page, 1),
      per_page: (args) => pageNumber(args.per_page, 50),
    },
    produce: (_id, ref) => [slice([...project(ref), n('user'), i('any')], 'R')],
  },
  supabase__get_user: {
    plane: 'auth',
    ids: arg('user_id', pathIdent),
    produce: (id, ref) => [slice([...project(ref), n('user'), i(id('user_id'))], 'R')],
  },
  supabase__create_user: {
    plane: 'auth',
    // The identity does not exist yet : one user is created, whatever names it.
    produce: (_id, ref) => userWrite(ref),
  },
  supabase__update_user: {
    plane: 'auth',
    ids: arg('user_id', pathIdent),
    produce: (_id, ref) => userWrite(ref),
  },
  supabase__delete_user: {
    plane: 'auth',
    ids: arg('user_id', pathIdent),
    produce: (_id, ref) => userWrite(ref),
  },
  supabase__generate_link: {
    plane: 'auth',
    ids: { ...arg('email', emailAddress), ...arg('type', pathIdent) },
    produce: (id, ref) => [
      slice([...project(ref), n('user'), i(id('email')), n('link'), i(id('type'))], 'W'),
    ],
  },

  // ─── functions ────────────────────────────────────────────────────────────
  supabase__list_functions: {
    plane: 'functions',
    produce: (_id, ref) => [slice([...project(ref), n('edge-function'), i('any')], 'R')],
  },
  supabase__get_function: {
    plane: 'functions',
    ids: arg('function_slug', pathIdent),
    produce: (id, ref) => [
      slice([...project(ref), n('edge-function'), i(id('function_slug'))], 'R'),
    ],
  },
  supabase__get_function_body: {
    plane: 'functions',
    ids: arg('function_slug', pathIdent),
    produce: (id, ref) => [
      slice([...project(ref), n('edge-function'), i(id('function_slug')), n('function-body')], 'R'),
      slice([...project(ref), n('edge-function'), i(id('function_slug'))], 'R'),
    ],
  },
  supabase__list_function_secrets: {
    plane: 'functions',
    produce: (_id, ref) => [slice([...project(ref), n('function-secret'), i('any')], 'R')],
  },
  supabase__create_function: {
    plane: 'functions',
    ids: arg('slug', pathIdent),
    produce: (id, ref) => [slice([...project(ref), n('edge-function'), i(id('slug'))], 'W')],
  },
  supabase__update_function: {
    plane: 'functions',
    ids: arg('function_slug', pathIdent),
    produce: (id, ref) => [
      slice([...project(ref), n('edge-function'), i(id('function_slug'))], 'W'),
    ],
  },
  supabase__delete_function: {
    plane: 'functions',
    ids: arg('function_slug', pathIdent),
    produce: (id, ref) => [
      slice([...project(ref), n('edge-function'), i(id('function_slug'))], 'W'),
    ],
  },
  supabase__deploy_function: {
    plane: 'functions',
    ids: arg('slug', pathIdent),
    produce: (id, ref, args) => {
      // A deployment replaces what runs : the code (`files`, in whatever shape the
      // caller gave it) and how it is exposed (`verify_jwt`, the entrypoint). Both
      // writes, always — `update_function` prices the same changes as a body write.
      if (args.files !== undefined && !Array.isArray(args.files)) return missing('files');
      return [
        slice(
          [...project(ref), n('edge-function'), i(id('slug')), n('function-deployment'), i('any')],
          'W',
        ),
        slice([...project(ref), n('edge-function'), i(id('slug'))], 'W'),
      ];
    },
  },
  supabase__create_function_secrets: {
    plane: 'functions',
    produce: (_id, ref, args) => {
      const names = secretNames(args.secrets, 'name');
      if (!names) return missing('secrets');
      return names.map((name) => slice([...project(ref), n('function-secret'), i(name)], 'W'));
    },
  },
  supabase__delete_function_secrets: {
    plane: 'functions',
    produce: (_id, ref, args) => {
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
 * The identifier arguments of a call, each read by the grammar of its kind —
 * the **only** place that reads them, for `classifySupabase` and for
 * `executeSupabase` alike. The classifier builds its slices from the answer
 * and the executor its URLs, query strings and headers : what is classified
 * is what is sent. A missing or malformed identifier is a denial, never
 * escaped nor replaced.
 */
export function readIdentifiers(
  tool: string,
  args: Args,
): { readonly id: ToolIdentifiers } | { readonly denied: string } {
  const descriptor = descriptorOf(tool);
  if (!descriptor) return { denied: `unknown supabase tool '${tool}'.` };
  const values = new Map<string, string>();
  for (const [name, read] of Object.entries(descriptor.ids ?? {})) {
    const value = read(args);
    if (value === null) return { denied: missing(name) };
    values.set(name, value);
  }
  return {
    id: (name) => {
      const value = values.get(name);
      if (value === undefined) {
        throw new Error(`supabase: tool '${tool}' reads no identifier '${name}'`);
      }
      return value;
    },
  };
}

/** The descriptor of a declared tool ; an inherited key (`constructor`) is no tool. */
function descriptorOf(tool: string): ToolDescriptor | undefined {
  return Object.hasOwn(TOOLS, tool) ? TOOLS[tool] : undefined;
}

const DECLARED_ARGUMENTS = declaredArgumentsOf(supabaseTools);

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
  args: Args,
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
  args: Args,
  resources: readonly Resource[],
): ClassifyOutcome {
  const descriptor = descriptorOf(tool);
  if (!descriptor) return { denied: `unknown supabase tool '${tool}'.` };
  const target = resolveProjectRef(args, resources);
  if ('denied' in target) return target;
  const read = readIdentifiers(tool, args);
  if ('denied' in read) return read;
  // `execute` builds most request bodies from the arguments: one the schema does not
  // declare is priced by no rule, and is refused rather than forwarded.
  const undeclared = undeclaredArgumentDenial(DECLARED_ARGUMENTS, tool, args);
  if (undeclared !== null) return { denied: undeclared };
  const produced = descriptor.produce(read.id, target.ref, args);
  return typeof produced === 'string' ? { denied: produced } : { slices: produced };
}
