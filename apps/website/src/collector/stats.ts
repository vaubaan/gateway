/**
 * `GET /v1/plugin_stats` — the public plugin health aggregates (gateway spec
 * §9; website spec §2.4), read by the instances for their badge and by the
 * site's plugin pages.
 *
 * The instance's client asks with the query it has always built for the
 * `plugin_stats` view (`select`, `tool=is.null`, `plugin=in.(…)`). The
 * collector accepts exactly those parameters, each in the shape the client
 * sends, and passes them on to the view; anything else is a 400. The answer
 * is cached for an hour at the edge.
 */
import { REPORT_FIELD_PATTERNS } from '@vaubaan/telemetry';

import type { SupabaseRest } from './supabase';

export const STATS_COLUMNS = [
  'plugin',
  'plugin_version',
  'tool',
  'reports',
  'successes',
  'success_rate',
  'validated',
] as const;
export const MAX_PLUGINS_PER_QUERY = 64;
export const STATS_CACHE_SECONDS = 60 * 60;

export interface StatsDeps {
  readonly store: SupabaseRest;
}

/** The parameters passed on to the view, or `null` when the query is not one the collector answers. */
export function statsParams(search: URLSearchParams): URLSearchParams | null {
  const out = new URLSearchParams();
  for (const key of new Set(search.keys())) {
    if (!['select', 'tool', 'plugin'].includes(key)) return null;
    if (search.getAll(key).length !== 1) return null;
  }

  const select = search.get('select');
  if (select !== null) {
    const columns = select.split(',');
    if (!columns.every((c) => (STATS_COLUMNS as readonly string[]).includes(c))) return null;
    if (new Set(columns).size !== columns.length) return null;
    out.set('select', columns.join(','));
  } else {
    out.set('select', STATS_COLUMNS.join(','));
  }

  const tool = search.get('tool');
  if (tool !== null) {
    if (tool !== 'is.null') return null;
    out.set('tool', tool);
  }

  const plugin = search.get('plugin');
  if (plugin !== null) {
    const match = /^in\.\(([^()]*)\)$/.exec(plugin);
    const ids = match?.[1]?.split(',') ?? [];
    if (ids.length === 0 || ids.length > MAX_PLUGINS_PER_QUERY) return null;
    if (!ids.every((id) => REPORT_FIELD_PATTERNS.plugin.test(id))) return null;
    out.set('plugin', `in.(${ids.join(',')})`);
  }
  return out;
}

export async function handleStats(request: Request, deps: StatsDeps): Promise<Response> {
  const params = statsParams(new URL(request.url).searchParams);
  if (params === null) return new Response(null, { status: 400 });
  const rows = await deps.store.select('plugin_stats', params);
  if (!Array.isArray(rows)) {
    return new Response(null, { status: 503, headers: { 'cache-control': 'no-store' } });
  }
  return Response.json(rows, {
    headers: {
      'cache-control': `public, max-age=300, s-maxage=${STATS_CACHE_SECONDS}`,
      'access-control-allow-origin': '*',
    },
  });
}
