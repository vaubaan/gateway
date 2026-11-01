/**
 * `GET /ops/stats` — the counters of the instance for the operator's monitoring
 * (spec §4.3 bis). Web-standard `Response`, like `/healthz`, so any host can mount it.
 *
 * Opened by `ops.token` as a bearer token, compared in constant time over the SHA-256
 * of both values:
 *
 *   no `ops.token` configured        404, as if the path did not exist
 *   token missing or wrong           401, nothing more said
 *   setup mode (no master key yet)   503 `{"status":"setup"}`, once the token is right
 *   otherwise                        200 with the counts (`collectOpsStats`)
 *
 * The answer is never cached. It takes the token and a collector (`OpsStatsDeps`),
 * not the composition root.
 */
import { createHash, timingSafeEqual } from 'node:crypto';

import type { OpsStats } from '../limits/stats';
import type { Logger } from '../logging';

export interface OpsStatsDeps {
  /** `config.ops.token`; `null`: the endpoint does not exist. */
  readonly token: string | null;
  readonly collect: () => Promise<OpsStats>;
  readonly logger: Pick<Logger, 'error'>;
}

const JSON_HEADERS = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
const BEARER = /^Bearer[ \t]+(\S+)[ \t]*$/i;

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

/** Whether the request carries `token` as its bearer; constant time in the value. */
export function presentsOpsToken(headers: Headers, token: string): boolean {
  const presented = BEARER.exec(headers.get('authorization') ?? '')?.[1] ?? '';
  // Both sides digested: equal lengths, and the time says nothing of the token.
  return timingSafeEqual(digest(presented), digest(token)) && presented.length > 0;
}

function notFound(): Response {
  return new Response(null, { status: 404, headers: { 'Cache-Control': 'no-store' } });
}

function unauthorized(): Response {
  return new Response(null, {
    status: 401,
    headers: { 'Cache-Control': 'no-store', 'WWW-Authenticate': 'Bearer' },
  });
}

/** 404 or 401 when the request may not read the counters; `null` when it may. */
function gate(request: Request, token: string | null): Response | null {
  if (token === null) return notFound();
  return presentsOpsToken(request.headers, token) ? null : unauthorized();
}

export async function opsStatsResponse(request: Request, deps: OpsStatsDeps): Promise<Response> {
  const refused = gate(request, deps.token);
  if (refused) return refused;
  try {
    return new Response(JSON.stringify(await deps.collect()), {
      status: 200,
      headers: JSON_HEADERS,
    });
  } catch (err) {
    deps.logger.error('counters could not be read', { err });
    return opsStatsUnavailableResponse();
  }
}

/** The composition root could not be built: no configuration to check a token against. */
export function opsStatsUnavailableResponse(): Response {
  return new Response(JSON.stringify({ status: 'unavailable' }), {
    status: 503,
    headers: JSON_HEADERS,
  });
}

/** Setup mode: no store yet, so no counts. The token of the configuration still gates. */
export function opsStatsSetupResponse(request: Request, token: string | null): Response {
  const refused = gate(request, token);
  if (refused) return refused;
  return new Response(JSON.stringify({ status: 'setup' }), { status: 503, headers: JSON_HEADERS });
}
