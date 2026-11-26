/**
 * Classifier of the `supabase` service : `(tool, args, resources) → slices`.
 *
 * Spec : docs/spec/gateway-risk-model.md §7 ; docs/spec/vaubaan-gateway.md §10
 *        ("a classification error is a security hole").
 * Handbook : docs/handbook/services/supabase.md.
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
 * marker `any` is emitted (`UNNAMED`, which says why it is not `[*]`) ; the
 * catalog uses `[*]` there.
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
 * (and `tableSchemas` for `list_tables`), with the grammar of its kind
 * (`identifiers.ts`). `execute.ts` reads them through the same function and
 * builds its request from the answer, never from `args`.
 *
 * ─── execute_sql is read-only, and reads two kinds of schema ────────────
 *
 * Risk-model spec §7.2 #2 : `execute_sql` is strictly read-only. The
 * classifier only ever emits R slices ; `execute.ts` enforces it by calling
 * the Management API read-only endpoint, where Postgres refuses any mutation.
 *
 * Which read is decided by `query-sql.ts`, from what the SQL names :
 * `schema[any].row[bulk].R` always, plus `schema[managed].row[bulk].R` when
 * the query names a schema Supabase manages (`auth`, `vault`, `storage`…) or
 * cannot be read with confidence. `managed` is a literal marker like `bulk` :
 * the catalog entry `supabase.read-managed-schemas` names it, and no argument
 * of a tool can spell it into a slice.
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
  identSegment,
  isList,
  isRecord,
  undeclaredArgumentDenial,
  type ClassifyOutcome,
  type Resource,
  type Slice,
  type SliceSegment,
} from '@vaubaan/plugin-sdk';

import { SERVICE_ID, TOOL, projectUrl } from './identity.ts';
import {
  advisorType,
  base64Text,
  bucketId,
  emailAddress,
  mediaType,
  objectPath,
  pageNumber,
  signedUrlTtl,
  pathIdent,
  projectRefIdent,
  sliceName,
  tableSchemas,
} from './identifiers.ts';
import { readMigrationSql, type MigrationWriteClass } from './migration-sql.ts';
import { readQuerySql } from './query-sql.ts';
import { supabaseTools } from './tools.ts';

export type SupabasePlane = 'db' | 'storage' | 'auth' | 'functions';

type Args = Readonly<Record<string, unknown>>;

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

function n(value: string): SliceSegment {
  return { kind: 'name', value };
}
/**
 * An identifier segment. Bucket ids, object paths, secret names and e-mail addresses
 * may hold characters the slice grammar has no place for (`@`, `+`, `:`) : such a value
 * is emitted as `ANY_IDENT` (`identSegment`), so the slice the audit stores reads back
 * as itself.
 */
function i(value: string): SliceSegment {
  return identSegment(value);
}

/**
 * The marker of an identifier the risk does not depend on (the schema and
 * table a migration writes, the buckets a listing reads) : a literal, like
 * `bulk`, that the catalog's `[*]` matches and no specific pattern does. Not
 * the SDK's `ANY_IDENT` : an executed `[*]` stands for every instance, so
 * `schema[*]` would meet `schema[managed]` and price every query as a read
 * of the managed schemas.
 */
const UNNAMED = i('any');
/** The schema marker of a read that reaches the schemas Supabase manages. */
const MANAGED = 'managed';
function slice(path: readonly SliceSegment[], action: 'R' | 'W'): Slice {
  return { service: SERVICE_ID, path: [...path], action };
}
function project(ref: string): SliceSegment[] {
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
        [...project(ref), n('schema'), UNNAMED, n('table'), UNNAMED, n('row'), i('bulk')],
        'W',
      );
    case 'policy':
      return slice([...project(ref), n('policy'), UNNAMED], 'W');
    case 'db-role':
      return slice([...project(ref), n('db-role'), UNNAMED], 'W');
    case 'extension':
      return slice([...project(ref), n('extension'), UNNAMED], 'W');
  }
}

/**
 * The schema write, plus one slice per class the SQL takes — every class
 * when a statement is not recognised (`readMigrationSql` fails closed).
 */
function migrationSlices(query: string, ref: string): Slice[] {
  const schemaWrite = slice([...project(ref), n('schema'), UNNAMED, n('table'), UNNAMED], 'W');
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

/**
 * The fields of a user that sign in as them, or grant them roles: setting one is the
 * `credential` slice beside the user write. At creation the identity is new, so only
 * `app_metadata` (roles, claims) counts; an update takes over an existing user.
 */
const CREDENTIAL_FIELDS_AT_UPDATE = [
  'password',
  'email',
  'email_confirm',
  'phone',
  'phone_confirm',
  'app_metadata',
] as const;
const CREDENTIAL_FIELDS_AT_CREATE = ['app_metadata'] as const;

function userWriteWithCredential(ref: string, args: Args, fields: readonly string[]): Slice[] {
  const touches = fields.some((field) => args[field] !== undefined && args[field] !== null);
  return touches
    ? [...userWrite(ref), slice([...project(ref), n('user'), i('one'), n('credential')], 'W')]
    : userWrite(ref);
}

/** Single-object write : the `object[one]` cardinality marker under its bucket. */
function objectWrite(ref: string, bucket: string): Slice[] {
  return [slice([...project(ref), n('bucket'), i(bucket), n('object'), i('one')], 'W')];
}

/** The secret names of a call : each a string, or an object whose `key` is one ; `null` when one is not. */
function secretNames(raw: unknown, key: string): string[] | null {
  if (!isList(raw) || raw.length === 0) return null;
  const names: string[] = [];
  for (const item of raw) {
    const name = sliceName(isRecord(item) ? item[key] : item);
    if (!name) return null;
    names.push(name);
  }
  return names;
}

const TOOLS: Readonly<Record<string, ToolDescriptor>> = {
  // ─── db ───────────────────────────────────────────────────────────────────
  [TOOL.getProject]: { plane: 'db', produce: settingsRead },
  [TOOL.getAnonKey]: { plane: 'db', produce: settingsRead },
  [TOOL.getAdvisors]: {
    plane: 'db',
    // The advisor family is a path segment of the request : a closed set.
    ids: { type: (args) => advisorType(args.type) },
    produce: settingsRead,
  },
  [TOOL.listTables]: {
    plane: 'db',
    produce: (_id, ref, args) => {
      // The schema names are written into the SQL text `execute` sends.
      if (tableSchemas(args) === null) return missing('schemas');
      return [slice([...project(ref), n('schema'), UNNAMED, n('table'), UNNAMED], 'R')];
    },
  },
  [TOOL.listMigrations]: {
    plane: 'db',
    produce: (_id, ref) => [slice([...project(ref), n('migration'), UNNAMED], 'R')],
  },
  [TOOL.applyMigration]: {
    plane: 'db',
    produce: (_id, ref, args) => {
      const query = sqlText(args.query);
      return query === null ? missing('query') : migrationSlices(query, ref);
    },
  },
  // Always R : the read-only endpoint enforces it. The data read, plus the managed
  // schemas when the SQL names one or cannot be read with confidence (fail closed).
  [TOOL.executeSql]: {
    plane: 'db',
    produce: (_id, ref, args) => {
      const query = sqlText(args.query);
      if (query === null) return missing('query');
      const rows = (schema: SliceSegment): Slice =>
        slice([...project(ref), n('schema'), schema, n('row'), i('bulk')], 'R');
      return readQuerySql(query).managed ? [rows(UNNAMED), rows(i(MANAGED))] : [rows(UNNAMED)];
    },
  },

  // ─── preview branches ─────────────────────────────────────────────────────
  // Listed under the parent project ; read, deleted and reset under the branch
  // itself, a resource of its own labelled `preview` (ADR
  // preview-branches-are-discovered-resources) : the call is judged in the
  // branch's environment, never the parent's.
  [TOOL.listBranches]: {
    plane: 'db',
    produce: (_id, ref) => [slice([...project(ref), n('branch'), UNNAMED], 'R')],
  },
  [TOOL.getBranch]: {
    plane: 'db',
    produce: (_id, ref) => [slice([...project(ref), n('branch')], 'R')],
  },
  [TOOL.deleteBranch]: {
    plane: 'db',
    produce: (_id, ref) => [slice([...project(ref), n('branch'), n('delete')], 'W')],
  },
  [TOOL.resetBranch]: {
    plane: 'db',
    produce: (_id, ref) => [slice([...project(ref), n('branch'), n('reset')], 'W')],
  },

  // ─── storage ──────────────────────────────────────────────────────────────
  [TOOL.listBuckets]: {
    plane: 'storage',
    produce: (_id, ref) => [slice([...project(ref), n('bucket'), UNNAMED], 'R')],
  },
  [TOOL.getStorageConfig]: {
    plane: 'storage',
    produce: (_id, ref) => [slice([...project(ref), n('storage-config')], 'R')],
  },
  [TOOL.updateStorageConfig]: {
    plane: 'storage',
    produce: (_id, ref) => [slice([...project(ref), n('storage-config')], 'W')],
  },
  [TOOL.createBucket]: {
    plane: 'storage',
    // Storage names the bucket after `id`, and after `name` when `id` is
    // absent. A malformed `id` is a denial : `name` is not a second chance,
    // `execute` sends both as given.
    ids: { id: (args) => bucketId(args.id !== undefined ? args.id : args.name) },
    produce: (id, ref) => [slice([...project(ref), n('bucket'), i(id('id'))], 'W')],
  },
  [TOOL.updateBucket]: {
    plane: 'storage',
    ids: arg('id', bucketId),
    produce: (id, ref) => [slice([...project(ref), n('bucket'), i(id('id'))], 'W')],
  },
  [TOOL.deleteBucket]: {
    plane: 'storage',
    ids: arg('id', bucketId),
    // The bucket itself, plus the cascade on every object it holds.
    produce: (id, ref) => [
      slice([...project(ref), n('bucket'), i(id('id'))], 'W'),
      slice([...project(ref), n('bucket'), i(id('id')), n('object'), i('bulk')], 'W'),
    ],
  },
  [TOOL.listObjects]: {
    plane: 'storage',
    ids: arg('bucket', bucketId),
    produce: (id, ref) => [
      slice([...project(ref), n('bucket'), i(id('bucket')), n('object'), UNNAMED], 'R'),
    ],
  },
  [TOOL.uploadObject]: {
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
  [TOOL.deleteObject]: {
    plane: 'storage',
    ids: { ...arg('bucket', bucketId), ...arg('path', objectPath) },
    produce: (id, ref) => objectWrite(ref, id('bucket')),
  },
  [TOOL.createSignedUrl]: {
    plane: 'storage',
    ids: {
      ...arg('bucket', bucketId),
      ...arg('path', objectPath),
      expires_in: (args) => signedUrlTtl(args.expires_in),
    },
    produce: (id, ref) => [
      slice(
        [
          ...project(ref),
          n('bucket'),
          i(id('bucket')),
          n('object'),
          i(id('path')),
          n('signed-url'),
          UNNAMED,
        ],
        'R',
      ),
    ],
  },

  // ─── auth ─────────────────────────────────────────────────────────────────
  [TOOL.getAuthConfig]: {
    plane: 'auth',
    produce: (_id, ref) => [slice([...project(ref), n('auth-config')], 'R')],
  },
  [TOOL.updateAuthConfig]: {
    plane: 'auth',
    produce: (_id, ref) => [slice([...project(ref), n('auth-config')], 'W')],
  },
  [TOOL.listSsoProviders]: {
    plane: 'auth',
    produce: (_id, ref) => [slice([...project(ref), n('sso-provider'), UNNAMED], 'R')],
  },
  [TOOL.getSsoProvider]: {
    plane: 'auth',
    ids: arg('provider_id', pathIdent),
    produce: (id, ref) => [slice([...project(ref), n('sso-provider'), i(id('provider_id'))], 'R')],
  },
  [TOOL.createSsoProvider]: {
    plane: 'auth',
    ids: arg('type', pathIdent),
    produce: (id, ref) => [slice([...project(ref), n('sso-provider'), i(id('type'))], 'W')],
  },
  [TOOL.updateSsoProvider]: {
    plane: 'auth',
    ids: arg('provider_id', pathIdent),
    produce: (id, ref) => [slice([...project(ref), n('sso-provider'), i(id('provider_id'))], 'W')],
  },
  [TOOL.deleteSsoProvider]: {
    plane: 'auth',
    ids: arg('provider_id', pathIdent),
    produce: (id, ref) => [slice([...project(ref), n('sso-provider'), i(id('provider_id'))], 'W')],
  },
  [TOOL.listThirdPartyAuth]: {
    plane: 'auth',
    produce: (_id, ref) => [slice([...project(ref), n('third-party-auth'), UNNAMED], 'R')],
  },
  [TOOL.getThirdPartyAuth]: {
    plane: 'auth',
    ids: arg('tpa_id', pathIdent),
    produce: (id, ref) => [slice([...project(ref), n('third-party-auth'), i(id('tpa_id'))], 'R')],
  },
  [TOOL.createThirdPartyAuth]: {
    plane: 'auth',
    ids: arg('type', pathIdent),
    produce: (id, ref) => [slice([...project(ref), n('third-party-auth'), i(id('type'))], 'W')],
  },
  [TOOL.deleteThirdPartyAuth]: {
    plane: 'auth',
    ids: arg('tpa_id', pathIdent),
    produce: (id, ref) => [slice([...project(ref), n('third-party-auth'), i(id('tpa_id'))], 'W')],
  },
  [TOOL.listUsers]: {
    plane: 'auth',
    // Both numbers are written into the query string of the request.
    ids: {
      page: (args) => pageNumber(args.page, 1),
      per_page: (args) => pageNumber(args.per_page, 50),
    },
    produce: (_id, ref) => [slice([...project(ref), n('user'), UNNAMED], 'R')],
  },
  [TOOL.getUser]: {
    plane: 'auth',
    ids: arg('user_id', pathIdent),
    produce: (id, ref) => [slice([...project(ref), n('user'), i(id('user_id'))], 'R')],
  },
  [TOOL.createUser]: {
    plane: 'auth',
    // The identity does not exist yet : one user is created, whatever names it.
    produce: (_id, ref, args) => userWriteWithCredential(ref, args, CREDENTIAL_FIELDS_AT_CREATE),
  },
  [TOOL.updateUser]: {
    plane: 'auth',
    ids: arg('user_id', pathIdent),
    produce: (_id, ref, args) => userWriteWithCredential(ref, args, CREDENTIAL_FIELDS_AT_UPDATE),
  },
  [TOOL.deleteUser]: {
    plane: 'auth',
    ids: arg('user_id', pathIdent),
    produce: (_id, ref) => userWrite(ref),
  },
  [TOOL.generateLink]: {
    plane: 'auth',
    ids: { ...arg('email', emailAddress), ...arg('type', pathIdent) },
    produce: (id, ref) => [
      slice([...project(ref), n('user'), i(id('email')), n('link'), i(id('type'))], 'W'),
    ],
  },

  // ─── functions ────────────────────────────────────────────────────────────
  [TOOL.listFunctions]: {
    plane: 'functions',
    produce: (_id, ref) => [slice([...project(ref), n('edge-function'), UNNAMED], 'R')],
  },
  [TOOL.getFunction]: {
    plane: 'functions',
    ids: arg('function_slug', pathIdent),
    produce: (id, ref) => [
      slice([...project(ref), n('edge-function'), i(id('function_slug'))], 'R'),
    ],
  },
  [TOOL.getFunctionBody]: {
    plane: 'functions',
    ids: arg('function_slug', pathIdent),
    produce: (id, ref) => [
      slice([...project(ref), n('edge-function'), i(id('function_slug')), n('function-body')], 'R'),
      slice([...project(ref), n('edge-function'), i(id('function_slug'))], 'R'),
    ],
  },
  [TOOL.listFunctionSecrets]: {
    plane: 'functions',
    produce: (_id, ref) => [slice([...project(ref), n('function-secret'), UNNAMED], 'R')],
  },
  [TOOL.createFunction]: {
    plane: 'functions',
    ids: arg('slug', pathIdent),
    produce: (id, ref) => [slice([...project(ref), n('edge-function'), i(id('slug'))], 'W')],
  },
  [TOOL.updateFunction]: {
    plane: 'functions',
    ids: arg('function_slug', pathIdent),
    produce: (id, ref) => [
      slice([...project(ref), n('edge-function'), i(id('function_slug'))], 'W'),
    ],
  },
  [TOOL.deleteFunction]: {
    plane: 'functions',
    ids: arg('function_slug', pathIdent),
    produce: (id, ref) => [
      slice([...project(ref), n('edge-function'), i(id('function_slug'))], 'W'),
    ],
  },
  [TOOL.deployFunction]: {
    plane: 'functions',
    ids: arg('slug', pathIdent),
    produce: (id, ref, args) => {
      // A deployment replaces what runs : the code (`files`, in whatever shape the
      // caller gave it) and how it is exposed (`verify_jwt`, the entrypoint). Both
      // writes, always — `update_function` prices the same changes as a body write.
      if (args.files !== undefined && !Array.isArray(args.files)) return missing('files');
      return [
        slice(
          [...project(ref), n('edge-function'), i(id('slug')), n('function-deployment'), UNNAMED],
          'W',
        ),
        slice([...project(ref), n('edge-function'), i(id('slug'))], 'W'),
      ];
    },
  },
  [TOOL.createFunctionSecrets]: {
    plane: 'functions',
    produce: (_id, ref, args) => {
      const names = secretNames(args.secrets, 'name');
      if (!names) return missing('secrets');
      return names.map((name) => slice([...project(ref), n('function-secret'), i(name)], 'W'));
    },
  },
  [TOOL.deleteFunctionSecrets]: {
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
/** Every tool the classifier places : `list_projects` ahead of the table, which resolves a project first. */
export const SUPABASE_CLASSIFIED_TOOLS: readonly string[] = [
  TOOL.listProjects,
  ...Object.keys(TOOLS),
];

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
        throw new Error(`${SERVICE_ID}: tool '${tool}' reads no identifier '${name}'`);
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
 *   - `project_ref` present : it names one of the mission's Supabase
 *     resources, by its ref or by its exact name (the resource's display
 *     name) ; the answer is always the resource's ref, held to the ref
 *     grammar. A name two mission projects share is refused (name it by its
 *     ref) ; anything else, an array or an object included, is a denial —
 *     never coerced, never skipped ;
 *   - `project_ref` absent : the mission's single Supabase project ;
 *   - the camelCase `projectRef` is not an argument of any tool : a call
 *     carrying it is denied, so no second spelling can name another project.
 *
 * Every refusal about the project names the mission's projects
 * (`missionProjectsHint`) and the tool that lists them all
 * (`supabase__list_projects`, `missionProjects`).
 */
export function resolveProjectRef(
  args: Args,
  resources: readonly Resource[],
): { ref: string } | { denied: string } {
  if (args.projectRef !== undefined) {
    return { denied: 'projectRef: unknown argument, name the project with project_ref.' };
  }
  const own = resources.filter((r) => r.service === SERVICE_ID);
  if (args.project_ref !== undefined) {
    const given = args.project_ref;
    const byRef = own.find((r) => r.ref === given);
    if (byRef !== undefined) return refOf(byRef);
    const byName = own.filter((r) => r.displayName === given);
    if (byName.length === 1) return refOf(byName[0]!);
    if (byName.length > 1) {
      return {
        denied: `project_ref: ${byName.length} Supabase projects of this mission are named '${String(given)}' — name one by its ref. ${missionProjectsHint(own)}`,
      };
    }
    const explicit = projectRefIdent(given);
    if (explicit === null) return { denied: missing('project_ref') };
    return {
      denied: `supabase project '${explicit}' is not a resource of this mission. ${missionProjectsHint(own)} A preview branch opened a moment ago becomes known once ${TOOL.listBranches} on its project has listed it.`,
    };
  }
  if (own.length === 1) return refOf(own[0]!);
  return {
    denied:
      own.length === 0
        ? 'project_ref: argument missing and the mission touches no Supabase project.'
        : `ambiguous supabase target: the mission touches ${own.length} Supabase projects, specify project_ref (a ref or a name). ${missionProjectsHint(own)}`,
  };
}

/**
 * The tools that act on a preview branch itself : the resource they name must
 * be one discovery described as a branch, never a project. `execute` checks
 * it again against Supabase before deleting or resetting anything.
 */
const BRANCH_ONLY_TOOLS: ReadonlySet<string> = new Set([
  TOOL.getBranch,
  TOOL.deleteBranch,
  TOOL.resetBranch,
]);

/**
 * The parent project of a mission resource discovery described as a preview
 * branch (`metadata.parent_project_ref`, held to the ref grammar), or `null`
 * for a project, a default branch, or a ref the mission does not hold.
 */
export function branchParentOf(ref: string, resources: readonly Resource[]): string | null {
  const resource = resources.find((r) => r.service === SERVICE_ID && r.ref === ref);
  const metadata = resource?.metadata;
  if (metadata === undefined || metadata.is_default === true) return null;
  const parent = projectRefIdent(metadata.parent_project_ref);
  return parent !== null && parent !== ref ? parent : null;
}

function notABranch(ref: string): string {
  return `project_ref: '${ref}' is not a preview branch. Name the branch by its own ref, as ${TOOL.listBranches} on its project lists it.`;
}

/** The resource's ref as the call sends it : a URL path segment and a host label. */
function refOf(resource: Resource): { ref: string } | { denied: string } {
  const ref = projectRefIdent(resource.ref);
  return ref === null ? { denied: missing('project_ref') } : { ref };
}

/** Most projects a refusal names. */
const HINT_MAX_PROJECTS = 10;

/** The mission's projects, as a refusal names them : `name (ref)`. */
function missionProjectsHint(own: readonly Resource[]): string {
  if (own.length === 0) return 'The mission holds no Supabase project.';
  const shown = own.slice(0, HINT_MAX_PROJECTS).map((r) => `${r.displayName} (${r.ref})`);
  const more = own.length > HINT_MAX_PROJECTS ? `, and ${own.length - HINT_MAX_PROJECTS} more` : '';
  return `Projects of this mission: ${shown.join(', ')}${more} — ${TOOL.listProjects} lists them.`;
}

/** One project of the mission, as `list_projects` answers it. */
export interface MissionProject {
  readonly ref: string;
  readonly name: string;
  readonly environment: string | null;
  readonly region: unknown;
  readonly url: string;
  /** A preview branch : its parent project's ref and its git branch. */
  readonly branch_of?: string;
  readonly git_branch?: unknown;
}

/** The note `list_projects` answers with : what it lists, and how to name a project. */
export const LIST_PROJECTS_NOTE =
  "The Supabase projects of this mission on this account; the account's other projects are left out. " +
  'A preview branch is listed as a project of its own, with `branch_of` naming its parent. ' +
  'Name one in `project_ref` by its ref or its name.';

/**
 * `list_projects` : the mission's projects of this account. Read from the
 * resources the gateway passes, never from Supabase : a project outside the
 * mission is not named, and the names listed are the names
 * `resolveProjectRef` accepts.
 */
export function missionProjects(resources: readonly Resource[]): {
  projects: MissionProject[];
  note: string;
} {
  const projects = resources
    .filter((r) => r.service === SERVICE_ID)
    .map((r) => {
      const parent = branchParentOf(r.ref, resources);
      return {
        ref: r.ref,
        name: r.displayName,
        environment: r.env ?? null,
        region: r.metadata?.region ?? null,
        url: projectUrl(r.ref),
        ...(parent !== null
          ? { branch_of: parent, git_branch: r.metadata?.git_branch ?? null }
          : {}),
      };
    });
  return { projects, note: LIST_PROJECTS_NOTE };
}

/**
 * The slices of `list_projects` : the metadata read of every project it
 * names (`project[ref].project-settings.R`, as `get_project`), so the
 * listing is priced like reading each project, and refused when the
 * mission holds none.
 */
function listProjectsOutcome(args: Args, resources: readonly Resource[]): ClassifyOutcome {
  const undeclared = undeclaredArgumentDenial(DECLARED_ARGUMENTS, TOOL.listProjects, args);
  if (undeclared !== null) return { denied: undeclared };
  const slices: Slice[] = [];
  for (const r of resources) {
    if (r.service !== SERVICE_ID) continue;
    const ref = projectRefIdent(r.ref);
    if (ref === null) return { denied: missing('project_ref') };
    slices.push(slice([...project(ref), n('project-settings')], 'R'));
  }
  if (slices.length === 0) return { denied: 'The mission holds no Supabase project.' };
  return { slices };
}

export function classifySupabase(
  tool: string,
  args: Args,
  resources: readonly Resource[],
): ClassifyOutcome {
  if (tool === TOOL.listProjects) return listProjectsOutcome(args, resources);
  const descriptor = descriptorOf(tool);
  if (!descriptor) return { denied: `unknown supabase tool '${tool}'.` };
  const target = resolveProjectRef(args, resources);
  if ('denied' in target) return target;
  if (BRANCH_ONLY_TOOLS.has(tool) && branchParentOf(target.ref, resources) === null) {
    return { denied: notABranch(target.ref) };
  }
  const read = readIdentifiers(tool, args);
  if ('denied' in read) return read;
  // `execute` builds most request bodies from the arguments: one the schema does not
  // declare is priced by no rule, and is refused rather than forwarded.
  const undeclared = undeclaredArgumentDenial(DECLARED_ARGUMENTS, tool, args);
  if (undeclared !== null) return { denied: undeclared };
  const produced = descriptor.produce(read.id, target.ref, args);
  return typeof produced === 'string' ? { denied: produced } : { slices: produced };
}
