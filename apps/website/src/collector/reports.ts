/**
 * `POST /v1/reports` — what the collector does with a batch from an instance
 * (website spec §3; ADR telemetry-two-levels-behind-a-vercel-collector, D4).
 *
 *   1. the body is JSON, at most `MAX_BODY_BYTES`;
 *   2. `parseBatch` of `@vaubaan/telemetry` — the code the instance runs —
 *      rebuilds every report, and one report that does not fit refuses the
 *      whole request;
 *   3. the rows go to the four tables of the store, with nothing added;
 *   4. the answer carries nothing an instance could learn from.
 *
 * Statuses, read by the instance's client: 202 stored; 400, 413, 415 never
 * sent again; 429 and 503 retried later with backoff.
 *
 * Nothing of the request is logged: not its body, not its headers. The only
 * log line is a count.
 */
import { batchSize, parseBatch, type ReportBatch } from '@vaubaan/telemetry';

import type { StoreResult, SupabaseRest } from './supabase';

export const MAX_BODY_BYTES = 64 * 1024;

export interface ReportsDeps {
  readonly store: SupabaseRest;
  readonly log: (line: Readonly<Record<string, number | string>>) => void;
}

function status(code: number): Response {
  return new Response(null, { status: code, headers: { 'cache-control': 'no-store' } });
}

/** The body as text, or `null` past the bound (the stream is not read further). */
export async function readBoundedText(request: Request, maxBytes: number): Promise<string | null> {
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > maxBytes) return null;
  const reader = request.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(Buffer.concat(chunks));
}

/** The rows of each table, in the column names of `schema.sql`. */
export function rowsOf(batch: ReportBatch): Readonly<Record<string, readonly object[]>> {
  return {
    plugin_reports: batch.plugin_health,
    decision_reports: batch.decisions,
    instance_profiles: batch.instance_profiles.map(({ plugins: _plugins, ...profile }) => profile),
    instance_profile_plugins: batch.instance_profiles.flatMap((profile) =>
      profile.plugins.map((plugin) => ({ instance_id: profile.instance_id, ...plugin })),
    ),
  };
}

/** The worst result wins: a batch is stored only when every table took its rows. */
const SEVERITY: Readonly<Record<StoreResult, number>> = {
  stored: 0,
  refused: 1,
  'rate-limited': 2,
  unavailable: 3,
};

export async function handleReports(request: Request, deps: ReportsDeps): Promise<Response> {
  const type = request.headers.get('content-type') ?? '';
  if (!/^application\/json(\s*;|$)/i.test(type)) return status(415);
  const text = await readBoundedText(request, MAX_BODY_BYTES);
  if (text === null) return status(413);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return status(400);
  }
  const batch = parseBatch(body);
  if (batch === null) {
    deps.log({ event: 'batch-refused' });
    return status(400);
  }

  let worst: StoreResult = 'stored';
  for (const [table, rows] of Object.entries(rowsOf(batch))) {
    const result = await deps.store.insert(table, rows);
    if (SEVERITY[result] > SEVERITY[worst]) worst = result;
    if (result !== 'stored') break;
  }
  deps.log({ event: 'batch', reports: batchSize(batch), result: worst });
  if (worst === 'stored') return status(202);
  if (worst === 'rate-limited') return status(429);
  // Every report passed the shared constructors: a refusal of the store is a
  // schema out of step with the package, the collector's fault, retried later.
  return status(503);
}
