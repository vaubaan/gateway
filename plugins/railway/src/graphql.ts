/**
 * Railway's public GraphQL API, `https://backboard.railway.com/graphql/v2` :
 * the variable tools, discovery and the token checks.
 *
 * Handbook : docs/handbook/providers/railway.md.
 *
 * Railway answers a query it could not run with HTTP 200 and an `errors`
 * list (a refused token included : `Not Authorized`). Two readers, for the
 * two ways the plugin asks :
 *   - `railwayGraphql` — a call whose failure is the provider's : 401 / 403
 *     `UpstreamAuthError`, another failed status `UpstreamHttpError`, and an
 *     answer that carries `errors`, no `data`, or `data` of the wrong shape
 *     `UpstreamProtocolError` naming the operation ;
 *   - `askRailwayGraphql` — a question about the token, whose refusal is an
 *     answer : 401 / 403, `errors` or no `data` come back as `{ ok: false }`.
 *     Any other failure is still thrown : Railway did not answer, which says
 *     nothing of the token.
 *
 * No identifier reaches the URL : the documents are constants, the ids
 * travel as GraphQL variables.
 */

import {
  UpstreamAuthError,
  UpstreamProtocolError,
  httpJson,
  isList,
  isRecord,
  readShape,
  type Guard,
  type UpstreamIo,
} from '@vaubaan/plugin-sdk';

import { RAILWAY_GRAPHQL_URL, RAILWAY_USER_AGENT } from './identity.ts';

/** One GraphQL request : a constant document, its variables, and the operation that names it in messages. */
export interface GraphqlRequest {
  readonly operation: string;
  readonly query: string;
  readonly variables: Readonly<Record<string, unknown>>;
}

/** A GraphQL answer, or what Railway said when it refused the token. */
export type GraphqlAnswer<T> =
  { readonly ok: true; readonly data: T } | { readonly ok: false; readonly said: string };

/** The `data` of `request`, read through `guard` ; the provider's failure thrown (module comment). */
export async function railwayGraphql<T>(
  io: UpstreamIo,
  token: string,
  request: GraphqlRequest,
  guard: Guard<T>,
): Promise<T> {
  const what = whatOf(request);
  const envelope = await envelopeOf(io, token, request);
  const errors = errorText(envelope);
  if (errors !== null) throw new UpstreamProtocolError(`${what}: ${errors}`);
  if (envelope.data === undefined || envelope.data === null) {
    throw new UpstreamProtocolError(`${what}: no data`);
  }
  return readShape(envelope.data, guard, what);
}

/**
 * The `data` of `request` read through `guard`, or `{ ok: false }` with what
 * Railway said when it refused the token (module comment).
 */
export async function askRailwayGraphql<T>(
  io: UpstreamIo,
  token: string,
  request: GraphqlRequest,
  guard: Guard<T>,
): Promise<GraphqlAnswer<T>> {
  let envelope: GraphqlEnvelope;
  try {
    envelope = await envelopeOf(io, token, request);
  } catch (err) {
    if (err instanceof UpstreamAuthError) return { ok: false, said: `HTTP ${err.upstreamStatus}` };
    throw err;
  }
  const errors = errorText(envelope);
  if (errors !== null) return { ok: false, said: errors };
  if (envelope.data === undefined || envelope.data === null) return { ok: false, said: 'no data' };
  return { ok: true, data: readShape(envelope.data, guard, whatOf(request)) };
}

/**
 * The objects of a GraphQL connection (`{ edges: [{ node }] }`) or of a
 * plain list ; anything else, and every item that is not an object, is
 * skipped. For answers read field by field, where an odd item proves nothing.
 */
export function nodesOf(value: unknown): Record<string, unknown>[] {
  const items: readonly unknown[] = isList(value)
    ? value
    : isRecord(value) && isList(value.edges)
      ? value.edges.map((edge) => (isRecord(edge) ? edge.node : undefined))
      : [];
  return items.filter(isRecord);
}

interface GraphqlEnvelope {
  readonly data?: unknown;
  readonly errors?: unknown;
}

function isGraphqlEnvelope(value: unknown): value is GraphqlEnvelope {
  return isRecord(value);
}

async function envelopeOf(
  io: UpstreamIo,
  token: string,
  request: GraphqlRequest,
): Promise<GraphqlEnvelope> {
  return httpJson(
    io,
    {
      url: RAILWAY_GRAPHQL_URL,
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'user-agent': RAILWAY_USER_AGENT },
      body: { query: request.query, variables: request.variables },
      what: whatOf(request),
    },
    isGraphqlEnvelope,
  );
}

/** The messages of a non-empty `errors` list, joined ; `null` when there is none. */
function errorText(envelope: GraphqlEnvelope): string | null {
  if (!isList(envelope.errors) || envelope.errors.length === 0) return null;
  return envelope.errors
    .map((error) => (isRecord(error) ? String(error.message) : String(error)))
    .join('; ');
}

function whatOf(request: GraphqlRequest): string {
  return `Railway GraphQL ${request.operation}`;
}
