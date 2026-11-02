/**
 * The public aggregates of the collector (gateway spec §9; website spec §2.4),
 * read by the instances for their badge and by the site's plugin pages:
 *
 *   GET /v1/plugin_stats       plugin health per (plugin, version[, tool])
 *   GET /v1/plugin_instances   instances per plugin, version and minor
 *
 * Each accepts exactly the parameters its readers send, in the shape they
 * send them — `select` among the view's columns, `plugin=in.(…)`, and for
 * `plugin_stats` the `tool=is.null` of the gateway's client — and passes them
 * on to the view; anything else is a 400. The answer is cached for an hour at
 * the edge.
 */
import { REPORT_FIELD_PATTERNS } from '@vaubaan/telemetry';

import type { SupabaseRest } from './supabase';

export const STATS_COLUMNS = [
  'plugin',
  'plugin_version',
  'tool',
  'reports',
  'successes',
  'credential_rejections',
  'success_rate',
  'validated',
] as const;
export const INSTANCES_COLUMNS = ['plugin', 'plugin_version', 'plugin_minor', 'instances'] as const;
export const MAX_PLUGINS_PER_QUERY = 64;
export const STATS_CACHE_SECONDS = 60 * 60;

export interface StatsDeps {
  readonly store: SupabaseRest;
}

/** A public view of the collector and the query it answers. */
interface Aggregate {
  readonly view: 'plugin_stats' | 'plugin_instances';
  readonly columns: readonly string[];
  /** Whether `tool=is.null` is accepted (the view has a tool column). */
  readonly toolFilter: boolean;
}

const PLUGIN_STATS: Aggregate = { view: 'plugin_stats', columns: STATS_COLUMNS, toolFilter: true };
const PLUGIN_INSTANCES: Aggregate = {
  view: 'plugin_instances',
  columns: INSTANCES_COLUMNS,
  toolFilter: false,
};

/** The parameters passed on to the view, or `null` when the query is not one the collector answers. */
function aggregateParams(aggregate: Aggregate, search: URLSearchParams): URLSearchParams | null {
  const allowed = aggregate.toolFilter ? ['select', 'tool', 'plugin'] : ['select', 'plugin'];
  const out = new URLSearchParams();
  for (const key of new Set(search.keys())) {
    if (!allowed.includes(key)) return null;
    if (search.getAll(key).length !== 1) return null;
  }

  const select = search.get('select');
  if (select !== null) {
    const columns = select.split(',');
    if (!columns.every((c) => aggregate.columns.includes(c))) return null;
    if (new Set(columns).size !== columns.length) return null;
    out.set('select', columns.join(','));
  } else {
    out.set('select', aggregate.columns.join(','));
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

export function statsParams(search: URLSearchParams): URLSearchParams | null {
  return aggregateParams(PLUGIN_STATS, search);
}

export function instancesParams(search: URLSearchParams): URLSearchParams | null {
  return aggregateParams(PLUGIN_INSTANCES, search);
}

async function serveAggregate(
  aggregate: Aggregate,
  request: Request,
  deps: StatsDeps,
): Promise<Response> {
  const params = aggregateParams(aggregate, new URL(request.url).searchParams);
  if (params === null) return new Response(null, { status: 400 });
  const rows = await deps.store.select(aggregate.view, params);
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

export function handleStats(request: Request, deps: StatsDeps): Promise<Response> {
  return serveAggregate(PLUGIN_STATS, request, deps);
}

export function handleInstances(request: Request, deps: StatsDeps): Promise<Response> {
  return serveAggregate(PLUGIN_INSTANCES, request, deps);
}
