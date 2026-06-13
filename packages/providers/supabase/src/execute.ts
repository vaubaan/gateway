/**
 * Supabase tool dispatcher — direct against the Management API.
 *
 * Spec : docs/spec/vaubaan-gateway.md §7.4.
 */

export type FetchImpl = typeof fetch;

const BASE = 'https://api.supabase.com/v1';

async function mgmtFetch(
  fetchImpl: FetchImpl,
  token: string,
  path: string,
  init?: RequestInit,
): Promise<unknown> {
  const res = await fetchImpl(BASE + path, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...((init?.headers ?? {}) as Record<string, string>),
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Supabase ${path} → ${res.status}: ${body.slice(0, 300)}`);
  }
  // 204 No Content
  if (res.status === 204) return null;
  return res.json();
}

/**
 * Fetch the project's `service_role` JWT from the Mgmt API. The PAT (scope
 * "Secrets") authorizes this — the gateway uses the key internally for data
 * plane calls (/auth/v1/admin, /storage/v1) and intentionally NEVER surfaces
 * it to the caller (cf. `supabase__get_anon_key` which strips it from the
 * response).
 */
async function fetchServiceRoleKey(
  fetchImpl: FetchImpl,
  pat: string,
  projectRef: string,
): Promise<string> {
  const keys = (await mgmtFetch(fetchImpl, pat, `/projects/${projectRef}/api-keys`)) as Array<{
    name: string;
    api_key: string;
  }> | null;
  const sr = keys?.find((k) => k.name === 'service_role')?.api_key;
  if (!sr) {
    throw new Error(`Supabase /projects/${projectRef}/api-keys returned no 'service_role' entry.`);
  }
  return sr;
}

/** Body shape accepted by the data plane helpers — JSON strings via
 *  JSON.stringify (most calls) or raw bytes via Buffer (object upload). */
type DataApiBody = string | Buffer | Uint8Array;

interface DataApiInit {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  body?: DataApiBody | null;
  headers?: Record<string, string>;
}

/**
 * Call the project's data plane API at `{ref}.supabase.co/<path>` using the
 * `service_role` JWT as Bearer + apikey. Returns parsed JSON, the raw text
 * (for binary or text responses), or `null` on 204.
 */
async function dataApiFetch(
  fetchImpl: FetchImpl,
  serviceRole: string,
  projectRef: string,
  path: string,
  init: DataApiInit = {},
): Promise<unknown> {
  const url = `https://${projectRef}.supabase.co${path}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${serviceRole}`,
    apikey: serviceRole,
    ...(init.headers ?? {}),
  };
  if (init.body !== undefined && init.body !== null && !('Content-Type' in headers)) {
    headers['Content-Type'] = 'application/json';
  }
  // Buffer is a Uint8Array subclass at runtime ; the lib.dom BodyInit overload
  // doesn't list Buffer, and the provider package's tsconfig doesn't pull lib.dom
  // — cast via `RequestInit` to keep the runtime semantics without re-typing.
  const requestInit = {
    method: init.method ?? 'GET',
    headers,
    body: init.body ?? undefined,
  } as Parameters<FetchImpl>[1];
  const res = await fetchImpl(url, requestInit);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Supabase data-plane ${path} → ${res.status}: ${body.slice(0, 300)}`);
  }
  if (res.status === 204) return null;
  const contentType = res.headers.get('content-type') ?? '';
  if (contentType.startsWith('application/json')) return res.json();
  return res.text();
}

export async function executeCall(
  fetchImpl: FetchImpl,
  token: string,
  tool: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const ref = encodeURIComponent(args.project_ref as string);
  switch (tool) {
    case 'supabase__get_project':
      return mgmtFetch(fetchImpl, token, `/projects/${ref}`);
    case 'supabase__get_anon_key': {
      // Supabase Mgmt API returns an array of `{name, api_key}` entries.
      // We surface only the public anon key (service_role is intentionally
      // not exposed by this tool — it would require a write-level cap).
      const keys = (await mgmtFetch(fetchImpl, token, `/projects/${ref}/api-keys`)) as Array<{
        name: string;
        api_key: string;
      }> | null;
      const anon = keys?.find((k) => k.name === 'anon')?.api_key;
      if (!anon) {
        throw new Error(`Supabase /projects/${ref}/api-keys returned no 'anon' entry`);
      }
      // Project URL is the canonical Supabase convention — we surface it here
      // to spare callers a string interpolation.
      return { url: `https://${args.project_ref as string}.supabase.co`, anon_key: anon };
    }
    case 'supabase__list_tables': {
      const schemas = Array.isArray(args.schemas) ? (args.schemas as string[]) : ['public'];
      const listLiteral = schemas.map((s) => `'${s.replace(/'/g, "''")}'`).join(',');
      const query = `select table_schema, table_name, table_type
        from information_schema.tables
        where table_schema in (${listLiteral})
        order by table_schema, table_name;`;
      return mgmtFetch(fetchImpl, token, `/projects/${ref}/database/query`, {
        method: 'POST',
        body: JSON.stringify({ query }),
      });
    }
    case 'supabase__list_migrations':
      return mgmtFetch(fetchImpl, token, `/projects/${ref}/database/query`, {
        method: 'POST',
        body: JSON.stringify({
          query:
            'select version, name from supabase_migrations.schema_migrations order by version;',
        }),
      });
    case 'supabase__execute_sql':
      return mgmtFetch(fetchImpl, token, `/projects/${ref}/database/query`, {
        method: 'POST',
        body: JSON.stringify({ query: args.query as string }),
      });
    case 'supabase__get_advisors': {
      const type = (args.type as string) ?? 'security';
      return mgmtFetch(fetchImpl, token, `/projects/${ref}/advisors/${type}`);
    }
    case 'supabase__apply_migration':
      return mgmtFetch(fetchImpl, token, `/projects/${ref}/database/migrations`, {
        method: 'POST',
        body: JSON.stringify({ name: args.name as string, query: args.query as string }),
      });
    case 'supabase__list_buckets':
      return mgmtFetch(fetchImpl, token, `/projects/${ref}/storage/buckets`);
    case 'supabase__get_storage_config':
      return mgmtFetch(fetchImpl, token, `/projects/${ref}/config/storage`);
    case 'supabase__get_auth_config':
      return mgmtFetch(fetchImpl, token, `/projects/${ref}/config/auth`);
    case 'supabase__list_sso_providers':
      return mgmtFetch(fetchImpl, token, `/projects/${ref}/config/auth/sso/providers`);
    case 'supabase__list_functions':
      return mgmtFetch(fetchImpl, token, `/projects/${ref}/functions`);
    case 'supabase__get_function': {
      const slug = encodeURIComponent(args.function_slug as string);
      return mgmtFetch(fetchImpl, token, `/projects/${ref}/functions/${slug}`);
    }
    case 'supabase__get_function_body': {
      const slug = encodeURIComponent(args.function_slug as string);
      return mgmtFetch(fetchImpl, token, `/projects/${ref}/functions/${slug}/body`);
    }

    // ─── storage plane — writes ──────────────────────────────────────────
    case 'supabase__update_storage_config':
      return mgmtFetch(fetchImpl, token, `/projects/${ref}/config/storage`, {
        method: 'PATCH',
        body: JSON.stringify(args.config ?? {}),
      });

    // ─── auth plane — writes ─────────────────────────────────────────────
    case 'supabase__update_auth_config':
      return mgmtFetch(fetchImpl, token, `/projects/${ref}/config/auth`, {
        method: 'PATCH',
        body: JSON.stringify(args.config ?? {}),
      });
    case 'supabase__list_third_party_auth':
      return mgmtFetch(fetchImpl, token, `/projects/${ref}/config/auth/third-party-auth`);
    case 'supabase__get_third_party_auth': {
      const tpa = encodeURIComponent(args.tpa_id as string);
      return mgmtFetch(fetchImpl, token, `/projects/${ref}/config/auth/third-party-auth/${tpa}`);
    }
    case 'supabase__create_third_party_auth':
      return mgmtFetch(fetchImpl, token, `/projects/${ref}/config/auth/third-party-auth`, {
        method: 'POST',
        body: JSON.stringify(stripProjectRef(args)),
      });
    case 'supabase__delete_third_party_auth': {
      const tpa = encodeURIComponent(args.tpa_id as string);
      return mgmtFetch(fetchImpl, token, `/projects/${ref}/config/auth/third-party-auth/${tpa}`, {
        method: 'DELETE',
      });
    }
    case 'supabase__get_sso_provider': {
      const pid = encodeURIComponent(args.provider_id as string);
      return mgmtFetch(fetchImpl, token, `/projects/${ref}/config/auth/sso/providers/${pid}`);
    }
    case 'supabase__create_sso_provider':
      return mgmtFetch(fetchImpl, token, `/projects/${ref}/config/auth/sso/providers`, {
        method: 'POST',
        body: JSON.stringify(stripProjectRef(args)),
      });
    case 'supabase__update_sso_provider': {
      const pid = encodeURIComponent(args.provider_id as string);
      return mgmtFetch(fetchImpl, token, `/projects/${ref}/config/auth/sso/providers/${pid}`, {
        method: 'PUT',
        body: JSON.stringify(stripProjectRef(args, ['provider_id'])),
      });
    }
    case 'supabase__delete_sso_provider': {
      const pid = encodeURIComponent(args.provider_id as string);
      return mgmtFetch(fetchImpl, token, `/projects/${ref}/config/auth/sso/providers/${pid}`, {
        method: 'DELETE',
      });
    }

    // ─── functions plane — writes ────────────────────────────────────────
    case 'supabase__create_function':
      return mgmtFetch(fetchImpl, token, `/projects/${ref}/functions`, {
        method: 'POST',
        body: JSON.stringify(stripProjectRef(args)),
      });
    case 'supabase__update_function': {
      const slug = encodeURIComponent(args.function_slug as string);
      return mgmtFetch(fetchImpl, token, `/projects/${ref}/functions/${slug}`, {
        method: 'PATCH',
        body: JSON.stringify(stripProjectRef(args, ['function_slug'])),
      });
    }
    case 'supabase__delete_function': {
      const slug = encodeURIComponent(args.function_slug as string);
      return mgmtFetch(fetchImpl, token, `/projects/${ref}/functions/${slug}`, {
        method: 'DELETE',
      });
    }
    case 'supabase__deploy_function': {
      // The deploy endpoint takes the slug as a query param + a JSON body that
      // describes the bundle (entrypoint, optional import map, verify_jwt, files).
      const slug = encodeURIComponent(args.slug as string);
      const body = stripProjectRef(args, ['slug']);
      return mgmtFetch(fetchImpl, token, `/projects/${ref}/functions/deploy?slug=${slug}`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
    }
    case 'supabase__list_function_secrets':
      return mgmtFetch(fetchImpl, token, `/projects/${ref}/secrets`);
    case 'supabase__create_function_secrets':
      return mgmtFetch(fetchImpl, token, `/projects/${ref}/secrets`, {
        method: 'POST',
        body: JSON.stringify(args.secrets ?? []),
      });
    case 'supabase__delete_function_secrets':
      return mgmtFetch(fetchImpl, token, `/projects/${ref}/secrets`, {
        method: 'DELETE',
        body: JSON.stringify(args.names ?? []),
      });

    // ─── data plane (auth/users, storage/buckets, storage/objects) ───────
    // The PAT cannot directly hit /auth/v1/admin or /storage/v1 — those need
    // the project's service_role JWT. We fetch it via the Mgmt API once per
    // call (Secrets scope on the PAT authorizes the read) and use it as
    // Bearer for the actual data plane request. service_role is never
    // surfaced to the caller (cf. fetchServiceRoleKey doc).
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
      return executeDataPlane(fetchImpl, token, tool, args);

    default:
      throw new Error(`Unknown Supabase MCP tool: ${tool}`);
  }
}

async function executeDataPlane(
  fetchImpl: FetchImpl,
  pat: string,
  tool: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const projectRef = String(args.project_ref);
  const serviceRole = await fetchServiceRoleKey(fetchImpl, pat, projectRef);

  switch (tool) {
    // ─── auth/users ─────────────────────────────────────────────────────
    case 'supabase__list_users': {
      const page = typeof args.page === 'number' ? args.page : 1;
      const perPage = typeof args.per_page === 'number' ? args.per_page : 50;
      return dataApiFetch(
        fetchImpl,
        serviceRole,
        projectRef,
        `/auth/v1/admin/users?page=${page}&per_page=${perPage}`,
      );
    }
    case 'supabase__get_user': {
      const uid = encodeURIComponent(args.user_id as string);
      return dataApiFetch(fetchImpl, serviceRole, projectRef, `/auth/v1/admin/users/${uid}`);
    }
    case 'supabase__create_user':
      return dataApiFetch(fetchImpl, serviceRole, projectRef, `/auth/v1/admin/users`, {
        method: 'POST',
        body: JSON.stringify(stripProjectRef(args)),
      });
    case 'supabase__update_user': {
      const uid = encodeURIComponent(args.user_id as string);
      return dataApiFetch(fetchImpl, serviceRole, projectRef, `/auth/v1/admin/users/${uid}`, {
        method: 'PUT',
        body: JSON.stringify(stripProjectRef(args, ['user_id'])),
      });
    }
    case 'supabase__delete_user': {
      const uid = encodeURIComponent(args.user_id as string);
      return dataApiFetch(fetchImpl, serviceRole, projectRef, `/auth/v1/admin/users/${uid}`, {
        method: 'DELETE',
      });
    }
    case 'supabase__generate_link':
      return dataApiFetch(fetchImpl, serviceRole, projectRef, `/auth/v1/admin/generate_link`, {
        method: 'POST',
        body: JSON.stringify(stripProjectRef(args)),
      });

    // ─── storage/buckets ────────────────────────────────────────────────
    case 'supabase__create_bucket':
      return dataApiFetch(fetchImpl, serviceRole, projectRef, `/storage/v1/bucket`, {
        method: 'POST',
        body: JSON.stringify(stripProjectRef(args)),
      });
    case 'supabase__update_bucket': {
      const id = encodeURIComponent(args.id as string);
      return dataApiFetch(fetchImpl, serviceRole, projectRef, `/storage/v1/bucket/${id}`, {
        method: 'PUT',
        body: JSON.stringify(stripProjectRef(args, ['id'])),
      });
    }
    case 'supabase__delete_bucket': {
      const id = encodeURIComponent(args.id as string);
      return dataApiFetch(fetchImpl, serviceRole, projectRef, `/storage/v1/bucket/${id}`, {
        method: 'DELETE',
      });
    }

    // ─── storage/objects ────────────────────────────────────────────────
    case 'supabase__list_objects': {
      const bucket = encodeURIComponent(args.bucket as string);
      const body = stripProjectRef(args, ['bucket']);
      return dataApiFetch(fetchImpl, serviceRole, projectRef, `/storage/v1/object/list/${bucket}`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
    }
    case 'supabase__upload_object': {
      const bucket = encodeURIComponent(args.bucket as string);
      const path = encodePath(args.path as string);
      const contentB64 = String(args.content_base64);
      const buffer = Buffer.from(contentB64, 'base64');
      const upsert = args.upsert === true ? 'true' : 'false';
      const contentType =
        typeof args.content_type === 'string' ? args.content_type : 'application/octet-stream';
      return dataApiFetch(
        fetchImpl,
        serviceRole,
        projectRef,
        `/storage/v1/object/${bucket}/${path}`,
        {
          method: 'POST',
          body: buffer,
          headers: {
            'Content-Type': contentType,
            'x-upsert': upsert,
          },
        },
      );
    }
    case 'supabase__delete_object': {
      const bucket = encodeURIComponent(args.bucket as string);
      const path = encodePath(args.path as string);
      return dataApiFetch(
        fetchImpl,
        serviceRole,
        projectRef,
        `/storage/v1/object/${bucket}/${path}`,
        { method: 'DELETE' },
      );
    }
    case 'supabase__create_signed_url': {
      const bucket = encodeURIComponent(args.bucket as string);
      const path = encodePath(args.path as string);
      const expiresIn = typeof args.expires_in === 'number' ? args.expires_in : 3600;
      return dataApiFetch(
        fetchImpl,
        serviceRole,
        projectRef,
        `/storage/v1/object/sign/${bucket}/${path}`,
        {
          method: 'POST',
          body: JSON.stringify({ expiresIn }),
        },
      );
    }
    default:
      throw new Error(`Unknown Supabase data-plane tool: ${tool}`);
  }
}

/** Encode a forward-slash-separated object path, preserving the `/` separators. */
function encodePath(p: string): string {
  return p.split('/').map(encodeURIComponent).join('/');
}

/** Build a body object from MCP args, dropping the project_ref (path param,
 *  never a body field) and any other path-binding args. */
function stripProjectRef(
  args: Record<string, unknown>,
  alsoStrip: readonly string[] = [],
): Record<string, unknown> {
  const drop = new Set<string>(['project_ref', 'projectRef', ...alsoStrip]);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (!drop.has(k) && v !== undefined) out[k] = v;
  }
  return out;
}
