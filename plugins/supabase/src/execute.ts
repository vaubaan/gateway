/**
 * Upstream calls of the `supabase` provider : Management API, per-project
 * data plane, and resource discovery.
 *
 * Spec : docs/spec/vaubaan-gateway.md §2.4 (the credential arrives decrypted
 *        in the context, is used for one call, never returned to the executor).
 * Handbook : docs/handbook/providers/supabase.md §3 (execution).
 *
 * Rules :
 *   - `fetch` comes from the context, never from the global ;
 *   - 401 / 403 from Supabase → `UpstreamAuthError`, so the host tries
 *     `refresh` and otherwise marks the connection `expired` ;
 *   - the Management API base URL is a fact about the provider, hence a
 *     constant of the plugin, not configuration of the instance ;
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
 *     `args` : each is within the grammar of its kind (no dot-only segment,
 *     no separator, no escape), so the request names the function, user,
 *     bucket or object the slices named. A call the classifier denies is
 *     refused before any request, the `service_role` key lookup included.
 *
 * Data plane (GoTrue admin, Storage) : the Management API token cannot call
 * `{ref}.supabase.co/auth/v1/admin` or `/storage/v1`. The plugin fetches the
 * project's `service_role` key through the Management API for the duration of
 * the call and never surfaces it (`get_anon_key` strips it from its answer).
 */

import {
  UpstreamAuthError,
  UpstreamHttpError,
  expectCredentialKind,
  type ConnectionContext,
  type ExecuteContext,
  type McpToolResult,
  type Resource,
} from '@vaubaan/plugin-sdk';

import {
  classifySupabase,
  projectRefIdent,
  readIdentifiers,
  resolveProjectRef,
  tableSchemas,
  type ToolIdentifiers,
} from './classify.ts';
import { SUPABASE_TOOL_NAMES } from './tools.ts';

/** Public Management API of Supabase. */
export const SUPABASE_API_BASE = 'https://api.supabase.com/v1';

/** Upper bound on the projects one connection may expose ; the owner labels them one by one. */
export const MAX_DISCOVERED_PROJECTS = 200;

type FetchImpl = typeof fetch;

// ─────────────────────────────────────────────────────────────────────────────
// ProviderPlugin entry points
// ─────────────────────────────────────────────────────────────────────────────

export async function executeSupabase(
  ctx: ExecuteContext,
  tool: string,
  args: Readonly<Record<string, unknown>>,
): Promise<McpToolResult> {
  if (!SUPABASE_TOOL_NAMES.has(tool)) return errorResult(`unknown tool '${tool}'`);
  // What the classifier denies is refused here for the same reason, before
  // any request : a missing SQL text, an identifier outside its grammar, a
  // project outside the mission.
  const classified = classifySupabase(tool, args, ctx.resources);
  if ('denied' in classified) return errorResult(classified.denied);
  // Same functions, same inputs as the classifier : the project and the
  // identifiers the slices named are the ones the request carries.
  const target = resolveProjectRef(args, ctx.resources);
  if ('denied' in target) return errorResult(target.denied);
  const read = readIdentifiers(tool, args);
  if ('denied' in read) return errorResult(read.denied);
  const token = expectCredentialKind('supabase', ctx.credential, 'oauth2').accessToken;
  const call: SupabaseCall = { fetchImpl: ctx.fetch, token, projectRef: target.ref, id: read.id };
  const payload = await callSupabase(call, tool, args, ctx.signal);
  return text(payload);
}

/** One call, resolved : where it goes and the identifiers it carries. */
interface SupabaseCall {
  readonly fetchImpl: FetchImpl;
  readonly token: string;
  /** The project `resolveProjectRef` answered. */
  readonly projectRef: string;
  /** The identifiers `readIdentifiers` answered, each within the grammar of its kind. */
  readonly id: ToolIdentifiers;
}

interface OrganizationDto {
  readonly id?: string;
  readonly slug?: string;
  readonly name?: string;
}

interface ProjectDto {
  readonly id?: string;
  readonly ref?: string;
  readonly name?: string;
  readonly organization_id?: string;
  readonly organization_slug?: string;
  readonly region?: string;
  readonly status?: string;
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
  const token = expectCredentialKind('supabase', ctx.credential, 'oauth2').accessToken;
  const [organizations, projects] = await Promise.all([
    mgmtFetch(ctx.fetch, token, '/organizations', undefined, ctx.signal) as Promise<
      readonly OrganizationDto[] | null
    >,
    mgmtFetch(ctx.fetch, token, '/projects', undefined, ctx.signal) as Promise<
      readonly ProjectDto[] | null
    >,
  ]);
  const orgNames = new Map<string, string>();
  for (const org of organizations ?? []) {
    if (!org.name) continue;
    if (org.id) orgNames.set(org.id, org.name);
    if (org.slug) orgNames.set(org.slug, org.name);
  }
  const all = (projects ?? []).filter((p): p is ProjectDto & { ref: string } => {
    const ref = p.ref ?? p.id;
    return typeof ref === 'string' && ref.length > 0;
  });
  // A ref the classifier would refuse is of no use to a mission : say so at
  // connection time instead of listing a resource no call can name.
  const unusable = all.find((p) => projectRefIdent(p.ref ?? p.id) === null);
  if (unusable) {
    throw new Error(
      `supabase: project ref ${JSON.stringify(unusable.ref ?? unusable.id)} is not a project ref (a host label)`,
    );
  }
  if (all.length > MAX_DISCOVERED_PROJECTS) {
    ctx.logger?.warn('supabase: more projects than the discovery cap, list truncated', {
      total: all.length,
      cap: MAX_DISCOVERED_PROJECTS,
    });
  }
  return all.slice(0, MAX_DISCOVERED_PROJECTS).map((p) => {
    const ref = p.ref ?? p.id!;
    const orgKey = p.organization_slug ?? p.organization_id ?? null;
    const orgName = orgKey ? (orgNames.get(orgKey) ?? orgKey) : null;
    const name = p.name ?? ref;
    return {
      provider: 'supabase',
      ref,
      displayName: orgName ? `${orgName} / ${name}` : name,
      metadata: {
        ...(orgKey ? { organization: orgKey } : {}),
        ...(orgName ? { organization_name: orgName } : {}),
        ...(p.region ? { region: p.region } : {}),
        ...(p.status ? { status: p.status } : {}),
      },
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Management API
// ─────────────────────────────────────────────────────────────────────────────

async function mgmtFetch(
  fetchImpl: FetchImpl,
  token: string,
  path: string,
  init?: RequestInit,
  signal?: AbortSignal,
): Promise<unknown> {
  const res = await fetchImpl(SUPABASE_API_BASE + path, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...((init?.headers ?? {}) as Record<string, string>),
    },
    ...(signal ? { signal } : {}),
  });
  if (!res.ok) {
    const body = await res.text();
    const msg = `Supabase ${path} → ${res.status}: ${body.slice(0, 300)}`;
    if (res.status === 401 || res.status === 403) throw new UpstreamAuthError(msg, res.status);
    throw new UpstreamHttpError(msg, res.status);
  }
  if (res.status === 204) return null;
  return res.json();
}

interface ApiKeyDto {
  readonly name: string;
  readonly api_key: string;
}

/**
 * The project's `service_role` JWT, read through the Management API. Used
 * internally for data-plane calls and never returned to the caller.
 */
async function fetchServiceRoleKey(
  fetchImpl: FetchImpl,
  token: string,
  projectRef: string,
  signal?: AbortSignal,
): Promise<string> {
  const keys = (await mgmtFetch(
    fetchImpl,
    token,
    `/projects/${encodeURIComponent(projectRef)}/api-keys`,
    undefined,
    signal,
  )) as readonly ApiKeyDto[] | null;
  const sr = keys?.find((k) => k.name === 'service_role')?.api_key;
  if (!sr) {
    throw new Error(`Supabase /projects/${projectRef}/api-keys returned no 'service_role' entry.`);
  }
  return sr;
}

/**
 * Dispatch one resolved call. The project ref and every `id(…)` went through
 * the classifier's grammars : an opaque id or a slug is one path segment and
 * is interpolated as it is ; a bucket id and the segments of an object path
 * may hold dots (never dots alone) and are percent-encoded. Nothing that
 * reaches a path, a query string or a header is read from `args`.
 * Throws on unknown tool.
 */
async function callSupabase(
  call: SupabaseCall,
  tool: string,
  args: Readonly<Record<string, unknown>>,
  signal?: AbortSignal,
): Promise<unknown> {
  const { fetchImpl, token, projectRef, id } = call;
  const ref = projectRef;
  const mgmt = (path: string, init?: RequestInit) =>
    mgmtFetch(fetchImpl, token, path, init, signal);
  const readOnlyQuery = (query: string) =>
    mgmt(`/projects/${ref}/database/query/read-only`, {
      method: 'POST',
      body: JSON.stringify({ query }),
    });

  switch (tool) {
    // ─── db ─────────────────────────────────────────────────────────────────
    case 'supabase__get_project':
      return mgmt(`/projects/${ref}`);
    case 'supabase__get_anon_key': {
      const keys = (await mgmt(`/projects/${ref}/api-keys`)) as readonly ApiKeyDto[] | null;
      const anon = keys?.find((k) => k.name === 'anon')?.api_key;
      if (!anon) throw new Error(`Supabase /projects/${ref}/api-keys returned no 'anon' entry`);
      return { url: projectUrl(projectRef), anon_key: anon };
    }
    case 'supabase__list_tables': {
      // Schema identifiers only (`tableSchemas`) : no quote, no backslash, so
      // each one is written between quotes as it is.
      const schemas = tableSchemas(args);
      if (schemas === null) throw new Error('supabase list_tables: schemas were not validated');
      const listLiteral = schemas.map((s) => `'${s}'`).join(',');
      return readOnlyQuery(
        `select table_schema, table_name, table_type
        from information_schema.tables
        where table_schema in (${listLiteral})
        order by table_schema, table_name;`,
      );
    }
    case 'supabase__list_migrations':
      return readOnlyQuery(
        'select version, name from supabase_migrations.schema_migrations order by version;',
      );
    case 'supabase__execute_sql':
      return readOnlyQuery(String(args.query));
    case 'supabase__get_advisors':
      return mgmt(`/projects/${ref}/advisors/${id('type')}`);
    case 'supabase__apply_migration':
      return mgmt(`/projects/${ref}/database/migrations`, {
        method: 'POST',
        body: JSON.stringify({ name: args.name, query: args.query }),
      });

    // ─── storage (Management API side) ──────────────────────────────────────
    case 'supabase__list_buckets':
      return mgmt(`/projects/${ref}/storage/buckets`);
    case 'supabase__get_storage_config':
      return mgmt(`/projects/${ref}/config/storage`);
    case 'supabase__update_storage_config':
      return mgmt(`/projects/${ref}/config/storage`, {
        method: 'PATCH',
        body: JSON.stringify(args.config ?? {}),
      });

    // ─── auth (Management API side) ─────────────────────────────────────────
    case 'supabase__get_auth_config':
      return mgmt(`/projects/${ref}/config/auth`);
    case 'supabase__update_auth_config':
      return mgmt(`/projects/${ref}/config/auth`, {
        method: 'PATCH',
        body: JSON.stringify(args.config ?? {}),
      });
    case 'supabase__list_sso_providers':
      return mgmt(`/projects/${ref}/config/auth/sso/providers`);
    case 'supabase__get_sso_provider':
      return mgmt(`/projects/${ref}/config/auth/sso/providers/${id('provider_id')}`);
    case 'supabase__create_sso_provider':
      return mgmt(`/projects/${ref}/config/auth/sso/providers`, {
        method: 'POST',
        body: JSON.stringify(bodyOf(args)),
      });
    case 'supabase__update_sso_provider':
      return mgmt(`/projects/${ref}/config/auth/sso/providers/${id('provider_id')}`, {
        method: 'PUT',
        body: JSON.stringify(bodyOf(args, ['provider_id'])),
      });
    case 'supabase__delete_sso_provider':
      return mgmt(`/projects/${ref}/config/auth/sso/providers/${id('provider_id')}`, {
        method: 'DELETE',
      });
    case 'supabase__list_third_party_auth':
      return mgmt(`/projects/${ref}/config/auth/third-party-auth`);
    case 'supabase__get_third_party_auth':
      return mgmt(`/projects/${ref}/config/auth/third-party-auth/${id('tpa_id')}`);
    case 'supabase__create_third_party_auth':
      return mgmt(`/projects/${ref}/config/auth/third-party-auth`, {
        method: 'POST',
        body: JSON.stringify(bodyOf(args)),
      });
    case 'supabase__delete_third_party_auth':
      return mgmt(`/projects/${ref}/config/auth/third-party-auth/${id('tpa_id')}`, {
        method: 'DELETE',
      });

    // ─── functions ──────────────────────────────────────────────────────────
    case 'supabase__list_functions':
      return mgmt(`/projects/${ref}/functions`);
    case 'supabase__get_function':
      return mgmt(`/projects/${ref}/functions/${id('function_slug')}`);
    case 'supabase__get_function_body':
      return mgmt(`/projects/${ref}/functions/${id('function_slug')}/body`);
    case 'supabase__create_function':
      return mgmt(`/projects/${ref}/functions`, {
        method: 'POST',
        body: JSON.stringify(bodyOf(args)),
      });
    case 'supabase__update_function':
      return mgmt(`/projects/${ref}/functions/${id('function_slug')}`, {
        method: 'PATCH',
        body: JSON.stringify(bodyOf(args, ['function_slug'])),
      });
    case 'supabase__delete_function':
      return mgmt(`/projects/${ref}/functions/${id('function_slug')}`, { method: 'DELETE' });
    case 'supabase__deploy_function':
      // The slug travels as a query parameter ; the body describes the bundle.
      return mgmt(
        `/projects/${ref}/functions/deploy?${new URLSearchParams({ slug: id('slug') }).toString()}`,
        {
          method: 'POST',
          body: JSON.stringify(bodyOf(args, ['slug'])),
        },
      );
    case 'supabase__list_function_secrets':
      return mgmt(`/projects/${ref}/secrets`);
    case 'supabase__create_function_secrets':
      return mgmt(`/projects/${ref}/secrets`, {
        method: 'POST',
        body: JSON.stringify(args.secrets ?? []),
      });
    case 'supabase__delete_function_secrets':
      return mgmt(`/projects/${ref}/secrets`, {
        method: 'DELETE',
        body: JSON.stringify(args.names ?? []),
      });

    // ─── data plane (GoTrue admin, Storage) ─────────────────────────────────
    case 'supabase__list_users':
    case 'supabase__get_user':
    case 'supabase__create_user':
    case 'supabase__update_user':
    case 'supabase__delete_user':
    case 'supabase__generate_link':
    case 'supabase__create_bucket':
    case 'supabase__update_bucket':
    case 'supabase__delete_bucket':
    case 'supabase__list_objects':
    case 'supabase__upload_object':
    case 'supabase__delete_object':
    case 'supabase__create_signed_url':
      return executeDataPlane(call, tool, args, signal);

    default:
      throw new Error(`Unknown Supabase MCP tool: ${tool}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Data plane — `{ref}.supabase.co` with the service_role key
// ─────────────────────────────────────────────────────────────────────────────

type DataApiBody = string | Buffer | Uint8Array;

interface DataApiInit {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  body?: DataApiBody | null;
  headers?: Record<string, string>;
}

async function dataApiFetch(
  fetchImpl: FetchImpl,
  serviceRole: string,
  projectRef: string,
  path: string,
  init: DataApiInit = {},
  signal?: AbortSignal,
): Promise<unknown> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${serviceRole}`,
    apikey: serviceRole,
    ...(init.headers ?? {}),
  };
  if (init.body !== undefined && init.body !== null && !('Content-Type' in headers)) {
    headers['Content-Type'] = 'application/json';
  }
  // Buffer is a Uint8Array at runtime ; the lib.dom BodyInit overload does not
  // list it and this package does not pull lib.dom, hence the cast.
  const requestInit = {
    method: init.method ?? 'GET',
    headers,
    body: init.body ?? undefined,
    ...(signal ? { signal } : {}),
  } as Parameters<FetchImpl>[1];
  const res = await fetchImpl(`${projectUrl(projectRef)}${path}`, requestInit);
  if (!res.ok) {
    const body = await res.text();
    const msg = `Supabase data-plane ${path} → ${res.status}: ${body.slice(0, 300)}`;
    if (res.status === 401 || res.status === 403) throw new UpstreamAuthError(msg, res.status);
    throw new UpstreamHttpError(msg, res.status);
  }
  if (res.status === 204) return null;
  const contentType = res.headers.get('content-type') ?? '';
  if (contentType.startsWith('application/json')) return res.json();
  return res.text();
}

async function executeDataPlane(
  call: SupabaseCall,
  tool: string,
  args: Readonly<Record<string, unknown>>,
  signal?: AbortSignal,
): Promise<unknown> {
  const { fetchImpl, token, projectRef, id } = call;
  const serviceRole = await fetchServiceRoleKey(fetchImpl, token, projectRef, signal);
  const data = (path: string, init?: DataApiInit) =>
    dataApiFetch(fetchImpl, serviceRole, projectRef, path, init, signal);

  switch (tool) {
    // ─── auth / users ───────────────────────────────────────────────────────
    case 'supabase__list_users': {
      const query = new URLSearchParams({ page: id('page'), per_page: id('per_page') });
      return data(`/auth/v1/admin/users?${query.toString()}`);
    }
    case 'supabase__get_user':
      return data(`/auth/v1/admin/users/${id('user_id')}`);
    case 'supabase__create_user':
      return data('/auth/v1/admin/users', { method: 'POST', body: JSON.stringify(bodyOf(args)) });
    case 'supabase__update_user':
      return data(`/auth/v1/admin/users/${id('user_id')}`, {
        method: 'PUT',
        body: JSON.stringify(bodyOf(args, ['user_id'])),
      });
    case 'supabase__delete_user':
      return data(`/auth/v1/admin/users/${id('user_id')}`, { method: 'DELETE' });
    case 'supabase__generate_link':
      return data('/auth/v1/admin/generate_link', {
        method: 'POST',
        body: JSON.stringify(bodyOf(args)),
      });

    // ─── storage / buckets ──────────────────────────────────────────────────
    case 'supabase__create_bucket':
      return data('/storage/v1/bucket', { method: 'POST', body: JSON.stringify(bodyOf(args)) });
    case 'supabase__update_bucket':
      return data(`/storage/v1/bucket/${enc(id('id'))}`, {
        method: 'PUT',
        body: JSON.stringify(bodyOf(args, ['id'])),
      });
    case 'supabase__delete_bucket':
      return data(`/storage/v1/bucket/${enc(id('id'))}`, { method: 'DELETE' });

    // ─── storage / objects ──────────────────────────────────────────────────
    case 'supabase__list_objects':
      return data(`/storage/v1/object/list/${enc(id('bucket'))}`, {
        method: 'POST',
        body: JSON.stringify(bodyOf(args, ['bucket'])),
      });
    case 'supabase__upload_object': {
      return data(`/storage/v1/object/${enc(id('bucket'))}/${encodePath(id('path'))}`, {
        method: 'POST',
        body: Buffer.from(String(args.content_base64), 'base64'),
        headers: {
          'Content-Type': id('content_type'),
          'x-upsert': args.upsert === true ? 'true' : 'false',
        },
      });
    }
    case 'supabase__delete_object':
      return data(`/storage/v1/object/${enc(id('bucket'))}/${encodePath(id('path'))}`, {
        method: 'DELETE',
      });
    case 'supabase__create_signed_url': {
      const expiresIn = typeof args.expires_in === 'number' ? args.expires_in : 3600;
      return data(`/storage/v1/object/sign/${enc(id('bucket'))}/${encodePath(id('path'))}`, {
        method: 'POST',
        body: JSON.stringify({ expiresIn }),
      });
    }
    default:
      throw new Error(`Unknown Supabase data-plane tool: ${tool}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Canonical API URL of a project. */
export function projectUrl(projectRef: string): string {
  return `https://${projectRef}.supabase.co`;
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

function errorResult(message: string): McpToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function text(payload: unknown): McpToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload ?? { ok: true }, null, 2) }] };
}
