/**
 * Upstream calls of the `supabase` provider : Management API, per-project
 * data plane, and resource discovery.
 *
 * Spec : docs/spec/vaubaan-gateway.md §2.4 (the credential arrives decrypted
 *        in the context, is used for one call, never returned to the executor).
 * Handbook : docs/handbook/providers/supabase.md.
 *
 * Rules :
 *   - every request goes through the SDK's transport, with `fetch` and the
 *     caller's `signal` from the context : `httpJson` for an API that answers
 *     JSON, `upstreamFailure` + `readBoundedText` for a data-plane answer that
 *     may be text. A failure is thrown typed — 401 / 403 `UpstreamAuthError`
 *     (the host tries `refresh`, otherwise marks the connection `expired`),
 *     another failed status `UpstreamHttpError`, an answer that is not what
 *     the plugin reads `UpstreamProtocolError` ;
 *   - what this executor declines itself (an unknown tool, a call the
 *     classifier denies) is an `isError` result (`refusalResult`,
 *     `ExecutorRefusal` under `declining`) : nothing failed at the provider ;
 *   - the Management API base URL is a fact about the provider, hence a
 *     constant of the plugin (`identity.ts`), not configuration of the instance ;
 *   - `execute_sql`, `list_tables` and `list_migrations` go through the
 *     **read-only** query endpoint : Postgres refuses any mutation there,
 *     which is what lets the classifier emit a read slice for opaque SQL ;
 *   - the target project is resolved **once**, by the classifier's own
 *     `resolveProjectRef(args, ctx.resources)` : every URL is built from its
 *     answer, never from `args.project_ref`, so a call reaches the project
 *     its authorised slices name or no project at all ;
 *   - every other identifier that lands in a path, a query string, a header
 *     or the SQL text of `list_tables` comes from the classifier's own
 *     `readIdentifiers(tool, args)` / `tableSchemas(args)`, never from
 *     `args` : each is within the grammar of its kind (`identifiers.ts`), so
 *     the request names the function, user, bucket or object the slices
 *     named. A call the classifier denies is refused before any request, the
 *     `service_role` key lookup included.
 *
 * Data plane (GoTrue admin, Storage) : the Management API token cannot call
 * `{ref}.supabase.co/auth/v1/admin` or `/storage/v1`. The plugin fetches the
 * project's `service_role` key through the Management API for the duration of
 * the call and never surfaces it (`get_anon_key` returns the anon key only).
 *
 * Project secrets : the edge-function secrets listing and the auth config
 * answer with secret values ; `redact.ts` replaces each by a fixed marker
 * (allow-list of non-secret fields), so no Supabase read returns one.
 */

import {
  DEFAULT_MAX_ANSWER_BYTES,
  ExecutorRefusal,
  UpstreamProtocolError,
  anyJson,
  declining,
  describeUrl,
  httpJson,
  isList,
  isRecord,
  jsonResult,
  readBoundedText,
  readShape,
  refusalResult,
  upstreamFailure,
  type ConnectionContext,
  type ExecuteContext,
  type Guard,
  type McpToolResult,
  type Resource,
  type UpstreamIo,
} from '@vaubaan/plugin-sdk';

import {
  classifySupabase,
  readIdentifiers,
  resolveProjectRef,
  type ToolIdentifiers,
} from './classify.ts';
import { supabaseBearerOf } from './credential.ts';
import { PROVIDER_ID, SUPABASE_API_BASE, TOOL, projectUrl } from './identity.ts';
import { projectRefIdent, tableSchemas } from './identifiers.ts';
import { redactAuthConfig, redactFunctionSecrets } from './redact.ts';
import { SUPABASE_DATA_PLANE_TOOLS, SUPABASE_TOOL_NAMES } from './tools.ts';

/** Upper bound on the projects one connection may expose ; the owner labels them one by one. */
export const MAX_DISCOVERED_PROJECTS = 200;

/** What a call without an answer body returns to the agent (a `204`, a `DELETE`). */
const NO_CONTENT_PAYLOAD = { ok: true };

const DATA_PLANE_TOOLS: ReadonlySet<string> = new Set(SUPABASE_DATA_PLANE_TOOLS);

// ─────────────────────────────────────────────────────────────────────────────
// ProviderPlugin entry points
// ─────────────────────────────────────────────────────────────────────────────

export async function executeSupabase(
  ctx: ExecuteContext,
  tool: string,
  args: Readonly<Record<string, unknown>>,
): Promise<McpToolResult> {
  if (!SUPABASE_TOOL_NAMES.has(tool)) return refusalResult(`unknown tool '${tool}'`);
  // What the classifier denies is refused here for the same reason, before
  // any request : a missing SQL text, an identifier outside its grammar, a
  // project outside the mission.
  const classified = classifySupabase(tool, args, ctx.resources);
  if ('denied' in classified) return refusalResult(classified.denied);
  // Same functions, same inputs as the classifier : the project and the
  // identifiers the slices named are the ones the request carries.
  const target = resolveProjectRef(args, ctx.resources);
  if ('denied' in target) return refusalResult(target.denied);
  const read = readIdentifiers(tool, args);
  if ('denied' in read) return refusalResult(read.denied);
  const token = supabaseBearerOf(PROVIDER_ID, ctx.credential);
  const call: SupabaseCall = { io: ctx, token, projectRef: target.ref, id: read.id };
  return declining(async () => {
    const payload = DATA_PLANE_TOOLS.has(tool)
      ? await callDataPlane(call, tool, args)
      : await callManagement(call, tool, args);
    return jsonResult(payload ?? NO_CONTENT_PAYLOAD);
  });
}

/** One call, resolved : where it goes and the identifiers it carries. */
interface SupabaseCall {
  readonly io: UpstreamIo;
  /** The connection's personal access token : the Management API's bearer. */
  readonly token: string;
  /** The project `resolveProjectRef` answered. */
  readonly projectRef: string;
  /** The identifiers `readIdentifiers` answered, each within the grammar of its kind. */
  readonly id: ToolIdentifiers;
}

/**
 * One `Resource` per project the token can reach, across every organization
 * of the connected account. The Management API returns the whole list in one
 * answer (no paging) ; the plugin caps it at `MAX_DISCOVERED_PROJECTS` and
 * warns through the logger when the cap truncates. The owner labels `env`
 * on the connection page.
 */
export async function discoverSupabaseResources(
  ctx: ConnectionContext,
): Promise<readonly Resource[]> {
  const token = supabaseBearerOf(PROVIDER_ID, ctx.credential);
  const [organizations, projects] = await Promise.all([
    managementJson(ctx, token, '/organizations', isRecordList),
    managementJson(ctx, token, '/projects', isRecordList),
  ]);
  const orgNames = new Map<string, string>();
  for (const org of organizations) {
    const name = stringField(org, 'name');
    if (!name) continue;
    for (const key of [stringField(org, 'id'), stringField(org, 'slug')]) {
      if (key) orgNames.set(key, name);
    }
  }
  // A project without a ref names nothing a mission could reach : left out.
  const all = projects.flatMap((project) => {
    const ref = refOf(project);
    return ref === null ? [] : [{ ref, project }];
  });
  // A ref the classifier would refuse is of no use to a mission : say so at
  // connection time instead of listing a resource no call can name.
  const unusable = all.find(({ ref }) => projectRefIdent(ref) === null);
  if (unusable) {
    throw new UpstreamProtocolError(
      `${PROVIDER_ID}: project ref ${JSON.stringify(unusable.ref)} is not a project ref (a host label)`,
    );
  }
  if (all.length > MAX_DISCOVERED_PROJECTS) {
    ctx.logger?.warn(`${PROVIDER_ID}: more projects than the discovery cap, list truncated`, {
      total: all.length,
      cap: MAX_DISCOVERED_PROJECTS,
    });
  }
  return all.slice(0, MAX_DISCOVERED_PROJECTS).map(({ ref, project }) => {
    const orgKey =
      stringField(project, 'organization_slug') ?? stringField(project, 'organization_id') ?? null;
    const orgName = orgKey ? (orgNames.get(orgKey) ?? orgKey) : null;
    const name = stringField(project, 'name') ?? ref;
    const region = stringField(project, 'region');
    const status = stringField(project, 'status');
    return {
      provider: PROVIDER_ID,
      ref,
      displayName: orgName ? `${orgName} / ${name}` : name,
      metadata: {
        ...(orgKey ? { organization: orgKey } : {}),
        ...(orgName ? { organization_name: orgName } : {}),
        ...(region ? { region } : {}),
        ...(status ? { status } : {}),
      },
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Reading Supabase's answers : guards, never casts
// ─────────────────────────────────────────────────────────────────────────────

/** A list of objects : the Management API's organizations, projects and API keys. */
function isRecordList(value: unknown): value is readonly Readonly<Record<string, unknown>>[] {
  return isList(value) && value.every(isRecord);
}

/** The field `key` of an answer's object when it is a string. */
function stringField(record: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

/** The ref of a listed project : `ref`, else `id` (older answers), when it is a non-empty string. */
function refOf(project: Readonly<Record<string, unknown>>): string | null {
  const ref = project.ref ?? project.id;
  return typeof ref === 'string' && ref.length > 0 ? ref : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Management API
// ─────────────────────────────────────────────────────────────────────────────

/** One Management API call with the personal access token, its JSON answer read through `guard`. */
function managementJson<T>(
  io: UpstreamIo,
  token: string,
  path: string,
  guard: Guard<T>,
  method = 'GET',
  body?: unknown,
): Promise<T> {
  return httpJson(
    io,
    {
      url: `${SUPABASE_API_BASE}${path}`,
      method,
      headers: { authorization: `Bearer ${token}` },
      body,
    },
    guard,
  );
}

/** The Supabase names of the two project keys the plugin reads (`GET /projects/{ref}/api-keys`). */
type ProjectKeyName = 'anon' | 'service_role';

/**
 * One key of the project, read through the Management API. `service_role`
 * serves the data-plane calls and is never returned to the caller.
 */
async function projectKey(call: SupabaseCall, name: ProjectKeyName): Promise<string> {
  const path = `/projects/${call.projectRef}/api-keys`;
  const keys = await managementJson(call.io, call.token, path, isRecordList);
  const key = keys.find((entry) => entry.name === name)?.api_key;
  if (typeof key !== 'string' || key.length === 0) {
    throw new UpstreamProtocolError(`${PROVIDER_ID} ${path} returned no '${name}' entry`);
  }
  return key;
}

/**
 * Dispatch one resolved Management API call. The project ref and every
 * `id(…)` went through the classifier's grammars : an opaque id or a slug is
 * one path segment and is interpolated as it is. Nothing that reaches a
 * path, a query string or a header is read from `args`.
 */
async function callManagement(
  call: SupabaseCall,
  tool: string,
  args: Readonly<Record<string, unknown>>,
): Promise<unknown> {
  const { projectRef: ref, id } = call;
  const mgmt = (path: string, method?: string, body?: unknown): Promise<unknown> =>
    managementJson(call.io, call.token, path, anyJson, method, body);
  const readOnlyQuery = (query: string): Promise<unknown> =>
    mgmt(`/projects/${ref}/database/query/read-only`, 'POST', { query });

  switch (tool) {
    // ─── db ─────────────────────────────────────────────────────────────────
    case TOOL.getProject:
      return mgmt(`/projects/${ref}`);
    case TOOL.getAnonKey:
      return { url: projectUrl(ref), anon_key: await projectKey(call, 'anon') };
    case TOOL.listTables: {
      // Schema identifiers only (`tableSchemas`) : no quote, no backslash, so
      // each one is written between quotes as it is.
      const schemas = tableSchemas(args);
      if (schemas === null) throw new ExecutorRefusal('schemas: missing or malformed.');
      const listLiteral = schemas.map((s) => `'${s}'`).join(',');
      return readOnlyQuery(
        `select table_schema, table_name, table_type
        from information_schema.tables
        where table_schema in (${listLiteral})
        order by table_schema, table_name;`,
      );
    }
    case TOOL.listMigrations:
      return readOnlyQuery(
        'select version, name from supabase_migrations.schema_migrations order by version;',
      );
    case TOOL.executeSql:
      return readOnlyQuery(String(args.query));
    case TOOL.getAdvisors:
      return mgmt(`/projects/${ref}/advisors/${id('type')}`);
    case TOOL.applyMigration:
      return mgmt(`/projects/${ref}/database/migrations`, 'POST', {
        name: args.name,
        query: args.query,
      });

    // ─── storage (Management API side) ──────────────────────────────────────
    case TOOL.listBuckets:
      return mgmt(`/projects/${ref}/storage/buckets`);
    case TOOL.getStorageConfig:
      return mgmt(`/projects/${ref}/config/storage`);
    case TOOL.updateStorageConfig:
      return mgmt(`/projects/${ref}/config/storage`, 'PATCH', args.config ?? {});

    // ─── auth (Management API side) ─────────────────────────────────────────
    // The auth config carries the project's OAuth client secrets, SMTP
    // password, hook secrets… : `redactAuthConfig` keeps the settings only.
    case TOOL.getAuthConfig:
      return redactAuthConfig(await mgmt(`/projects/${ref}/config/auth`));
    case TOOL.updateAuthConfig:
      return redactAuthConfig(
        await mgmt(`/projects/${ref}/config/auth`, 'PATCH', args.config ?? {}),
      );
    case TOOL.listSsoProviders:
      return mgmt(`/projects/${ref}/config/auth/sso/providers`);
    case TOOL.getSsoProvider:
      return mgmt(`/projects/${ref}/config/auth/sso/providers/${id('provider_id')}`);
    case TOOL.createSsoProvider:
      return mgmt(`/projects/${ref}/config/auth/sso/providers`, 'POST', bodyOf(args));
    case TOOL.updateSsoProvider:
      return mgmt(
        `/projects/${ref}/config/auth/sso/providers/${id('provider_id')}`,
        'PUT',
        bodyOf(args, ['provider_id']),
      );
    case TOOL.deleteSsoProvider:
      return mgmt(`/projects/${ref}/config/auth/sso/providers/${id('provider_id')}`, 'DELETE');
    case TOOL.listThirdPartyAuth:
      return mgmt(`/projects/${ref}/config/auth/third-party-auth`);
    case TOOL.getThirdPartyAuth:
      return mgmt(`/projects/${ref}/config/auth/third-party-auth/${id('tpa_id')}`);
    case TOOL.createThirdPartyAuth:
      return mgmt(`/projects/${ref}/config/auth/third-party-auth`, 'POST', bodyOf(args));
    case TOOL.deleteThirdPartyAuth:
      return mgmt(`/projects/${ref}/config/auth/third-party-auth/${id('tpa_id')}`, 'DELETE');

    // ─── functions ──────────────────────────────────────────────────────────
    case TOOL.listFunctions:
      return mgmt(`/projects/${ref}/functions`);
    case TOOL.getFunction:
      return mgmt(`/projects/${ref}/functions/${id('function_slug')}`);
    case TOOL.getFunctionBody:
      return mgmt(`/projects/${ref}/functions/${id('function_slug')}/body`);
    case TOOL.createFunction:
      return mgmt(`/projects/${ref}/functions`, 'POST', bodyOf(args));
    case TOOL.updateFunction:
      return mgmt(
        `/projects/${ref}/functions/${id('function_slug')}`,
        'PATCH',
        bodyOf(args, ['function_slug']),
      );
    case TOOL.deleteFunction:
      return mgmt(`/projects/${ref}/functions/${id('function_slug')}`, 'DELETE');
    case TOOL.deployFunction: {
      // The slug travels as a query parameter ; the body describes the bundle.
      const query = new URLSearchParams({ slug: id('slug') }).toString();
      return mgmt(`/projects/${ref}/functions/deploy?${query}`, 'POST', bodyOf(args, ['slug']));
    }
    case TOOL.listFunctionSecrets:
      // Supabase answers `{ name, value, updated_at }` : names and dates only.
      return redactFunctionSecrets(await mgmt(`/projects/${ref}/secrets`));
    case TOOL.createFunctionSecrets:
      return mgmt(`/projects/${ref}/secrets`, 'POST', args.secrets ?? []);
    case TOOL.deleteFunctionSecrets:
      return mgmt(`/projects/${ref}/secrets`, 'DELETE', args.names ?? []);

    default:
      throw new ExecutorRefusal(`unknown tool '${tool}'`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Data plane — `{ref}.supabase.co` with the service_role key
// ─────────────────────────────────────────────────────────────────────────────

const NO_CONTENT = 204;

/**
 * One data-plane call with a JSON body (or none). GoTrue and Storage answer
 * JSON, but the plugin has always passed a text answer through as text :
 * the `content-type` decides, and only a JSON answer is parsed.
 */
async function dataPlane(
  call: SupabaseCall,
  serviceRole: string,
  path: string,
  method = 'GET',
  body?: unknown,
): Promise<unknown> {
  const url = `${projectUrl(call.projectRef)}${path}`;
  const what = `${method} ${describeUrl(url)}`;
  const res = await call.io.fetch(url, {
    method,
    headers: {
      accept: 'application/json',
      ...serviceRoleHeaders(serviceRole),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    ...(call.io.signal ? { signal: call.io.signal } : {}),
  });
  if (!res.ok) throw await upstreamFailure(res, what);
  const text = await readBoundedText(res, DEFAULT_MAX_ANSWER_BYTES, what);
  if (res.status === NO_CONTENT) return null;
  const contentType = res.headers.get('content-type') ?? '';
  if (!contentType.startsWith('application/json')) return text;
  return readShape(parsedJson(text, what), anyJson, what);
}

/** The data plane takes the `service_role` key twice : as the bearer and as the `apikey`. */
function serviceRoleHeaders(serviceRole: string): Record<string, string> {
  return { authorization: `Bearer ${serviceRole}`, apikey: serviceRole };
}

/** A JSON answer's value ; an empty body is `null`, a body that is not JSON a protocol failure. */
function parsedJson(text: string, what: string): unknown {
  if (text.trim() === '') return null;
  try {
    const value: unknown = JSON.parse(text);
    return value;
  } catch {
    throw new UpstreamProtocolError(`${what}: the answer is not JSON`);
  }
}

/**
 * Dispatch one resolved data-plane call. A bucket id and the segments of an
 * object path may hold dots (never dots alone, per their grammar) and are
 * percent-encoded ; the other identifiers are one path segment each.
 */
async function callDataPlane(
  call: SupabaseCall,
  tool: string,
  args: Readonly<Record<string, unknown>>,
): Promise<unknown> {
  const { id } = call;
  const serviceRole = await projectKey(call, 'service_role');
  const data = (path: string, method?: string, body?: unknown): Promise<unknown> =>
    dataPlane(call, serviceRole, path, method, body);

  switch (tool) {
    // ─── auth / users ───────────────────────────────────────────────────────
    case TOOL.listUsers: {
      const query = new URLSearchParams({ page: id('page'), per_page: id('per_page') });
      return data(`/auth/v1/admin/users?${query.toString()}`);
    }
    case TOOL.getUser:
      return data(`/auth/v1/admin/users/${id('user_id')}`);
    case TOOL.createUser:
      return data('/auth/v1/admin/users', 'POST', bodyOf(args));
    case TOOL.updateUser:
      return data(`/auth/v1/admin/users/${id('user_id')}`, 'PUT', bodyOf(args, ['user_id']));
    case TOOL.deleteUser:
      return data(`/auth/v1/admin/users/${id('user_id')}`, 'DELETE');
    case TOOL.generateLink:
      return data('/auth/v1/admin/generate_link', 'POST', bodyOf(args));

    // ─── storage / buckets ──────────────────────────────────────────────────
    case TOOL.createBucket:
      return data('/storage/v1/bucket', 'POST', bodyOf(args));
    case TOOL.updateBucket:
      return data(`/storage/v1/bucket/${enc(id('id'))}`, 'PUT', bodyOf(args, ['id']));
    case TOOL.deleteBucket:
      return data(`/storage/v1/bucket/${enc(id('id'))}`, 'DELETE');

    // ─── storage / objects ──────────────────────────────────────────────────
    case TOOL.listObjects:
      return data(`/storage/v1/object/list/${enc(id('bucket'))}`, 'POST', bodyOf(args, ['bucket']));
    case TOOL.uploadObject:
      // The bytes, not JSON : sent as they are, under the media type the agent named.
      return httpJson(
        call.io,
        {
          url: `${projectUrl(call.projectRef)}${objectPathOf(id)}`,
          method: 'POST',
          headers: {
            ...serviceRoleHeaders(serviceRole),
            'content-type': id('content_type'),
            'x-upsert': args.upsert === true ? 'true' : 'false',
          },
          rawBody: new Uint8Array(Buffer.from(id('content_base64'), 'base64')),
        },
        anyJson,
      );
    case TOOL.deleteObject:
      return data(objectPathOf(id), 'DELETE');
    case TOOL.createSignedUrl: {
      const expiresIn = typeof args.expires_in === 'number' ? args.expires_in : 3600;
      return data(
        `/storage/v1/object/sign/${enc(id('bucket'))}/${encodePath(id('path'))}`,
        'POST',
        { expiresIn },
      );
    }
    default:
      throw new ExecutorRefusal(`unknown tool '${tool}'`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** The Storage path of the call's object : `/storage/v1/object/{bucket}/{path}`. */
function objectPathOf(id: ToolIdentifiers): string {
  return `/storage/v1/object/${enc(id('bucket'))}/${encodePath(id('path'))}`;
}

/** Percent-encode one dotted path segment the classifier's grammar accepted (never dot-only). */
function enc(segment: string): string {
  return encodeURIComponent(segment);
}

/** Encode a `/`-separated object path, keeping the separators ; no segment is empty or dot-only. */
function encodePath(p: string): string {
  return p.split('/').map(encodeURIComponent).join('/');
}

/** Request body from the arguments, minus the path parameters (never body fields). */
function bodyOf(
  args: Readonly<Record<string, unknown>>,
  alsoStrip: readonly string[] = [],
): Record<string, unknown> {
  const drop = new Set<string>(['project_ref', ...alsoStrip]);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (!drop.has(k) && v !== undefined) out[k] = v;
  }
  return out;
}
