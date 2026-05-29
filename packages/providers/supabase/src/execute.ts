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
    default:
      throw new Error(`Unknown Supabase MCP tool: ${tool}`);
  }
}
