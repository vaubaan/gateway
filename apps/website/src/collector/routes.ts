/**
 * The glue between the Next.js route files and the collector's handlers:
 * the configuration, the host gate and the store, built once per process.
 * On any host but the collector's, the routes answer 404 as if they did not
 * exist (ADR website-nextjs-on-vercel, D4).
 */
import { isCollectorHost, readCollectorConfig, type CollectorConfig } from './config';
import { handleReports } from './reports';
import { handleInstances, handleStats } from './stats';
import { createSupabaseRest, type SupabaseRest } from './supabase';

interface Collector {
  readonly config: CollectorConfig;
  readonly store: SupabaseRest;
}

let collector: Collector | null = null;

function collectorOf(): Collector {
  if (collector === null) {
    const config = readCollectorConfig();
    collector = { config, store: createSupabaseRest(config) };
  }
  return collector;
}

const NOT_FOUND = (): Response => new Response(null, { status: 404 });

function log(line: Readonly<Record<string, number | string>>): void {
  // A count and a result, never a header or a body.
  // eslint-disable-next-line no-console -- the collector's one log line, an info, not a warning
  console.info(JSON.stringify({ collector: line }));
}

export async function reportsRoute(request: Request): Promise<Response> {
  const { config, store } = collectorOf();
  if (!isCollectorHost(request, config)) return NOT_FOUND();
  return handleReports(request, { store, log });
}

export async function statsRoute(request: Request): Promise<Response> {
  const { config, store } = collectorOf();
  if (!isCollectorHost(request, config)) return NOT_FOUND();
  return handleStats(request, { store });
}

export async function instancesRoute(request: Request): Promise<Response> {
  const { config, store } = collectorOf();
  if (!isCollectorHost(request, config)) return NOT_FOUND();
  return handleInstances(request, { store });
}
