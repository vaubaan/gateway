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

    default:
      throw new Error(`Unknown Supabase MCP tool: ${tool}`);
  }
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
