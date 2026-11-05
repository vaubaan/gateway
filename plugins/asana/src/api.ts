/**
 * Requests to Asana's REST API, through the SDK's `httpJson`.
 *
 * Handbook : docs/handbook/providers/asana.md ; Asana's rate limits and
 *            pagination pages.
 *
 *   - `ctx.fetch` only ; the token narrowed with `expectCredentialKind`,
 *     never logged, never in a result or an error message ;
 *   - Asana wraps every request and answer in `data` : a write sends
 *     `{ data: … }`, an answer is read through `isDataObject` / `isDataList` ;
 *   - a failed status is thrown by the transport : 401 and 403 →
 *     `UpstreamAuthError` (Asana also answers 403 for an object the account
 *     cannot open), 402 (search without Premium), 429 and the others →
 *     `UpstreamHttpError`, with the `Retry-After` of a 429 in the message.
 *     No retry : a rejected request still counts against Asana's quota.
 */

import {
  UpstreamProtocolError,
  expectCredentialKind,
  httpJson,
  isList,
  isRecord,
  type ConnectionContext,
  type Guard,
} from '@vaubaan/plugin-sdk';

import { PAT_FIELD, PROVIDER_ID } from './identity.ts';

export const ASANA_API_BASE = 'https://app.asana.com/api/1.0';

export type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';

/** A JSON object, read-only. */
export type Json = Readonly<Record<string, unknown>>;

/** `{ data: { … } }` : one object. */
export interface DataObject {
  readonly data: Json;
}

/** `{ data: [ … ], next_page? }` : a page of a list. */
export interface DataList {
  readonly data: readonly unknown[];
  readonly next_page?: unknown;
}

export function isDataObject(value: unknown): value is DataObject {
  return isRecord(value) && isRecord(value.data);
}

export function isDataList(value: unknown): value is DataList {
  if (!isRecord(value) || !isList(value.data)) return false;
  const next = value.next_page;
  return next === undefined || next === null || (isRecord(next) && typeof next.offset === 'string');
}

/** The offset of the next page, `null` on the last one. */
export function nextOffsetOf(list: DataList): string | null {
  return isRecord(list.next_page) && typeof list.next_page.offset === 'string'
    ? list.next_page.offset
    : null;
}

export interface RequestOptions {
  readonly query?: URLSearchParams;
  /** Sent as `{ data: body }`. */
  readonly body?: Json;
}

function tokenOf(ctx: ConnectionContext): string {
  const secret = expectCredentialKind(PROVIDER_ID, ctx.credential, 'api-key');
  const token = secret.fields[PAT_FIELD];
  if (!token) throw new Error(`${PROVIDER_ID}: the credential has no '${PAT_FIELD}' field`);
  return token;
}

/** One request whose failure is thrown ; its answer through `guard`. A network failure propagates. */
export async function request<T>(
  ctx: ConnectionContext,
  method: Method,
  path: string,
  guard: Guard<T>,
  options: RequestOptions = {},
): Promise<T> {
  const query =
    options.query && [...options.query].length > 0 ? `?${options.query.toString()}` : '';
  // `httpJson` keeps no header of a failed answer : the `Retry-After` is read
  // on the way, so the agent is told when Asana lets it try again.
  const seen: { retryAfter: string | null } = { retryAfter: null };
  const io = {
    fetch: async (...call: Parameters<typeof fetch>) => {
      const res = await ctx.fetch(call[0], { ...call[1], redirect: 'error' });
      seen.retryAfter = res.headers.get('retry-after');
      return res;
    },
    ...(ctx.signal ? { signal: ctx.signal } : {}),
  };
  try {
    return await httpJson(
      io,
      {
        url: `${ASANA_API_BASE}${path}${query}`,
        method,
        headers: { authorization: `Bearer ${tokenOf(ctx)}` },
        ...(options.body !== undefined ? { body: { data: options.body } } : {}),
        what: `${PROVIDER_ID} ${method} ${path}`,
      },
      guard,
    );
  } catch (err) {
    if (seen.retryAfter && err instanceof Error && !(err instanceof UpstreamProtocolError)) {
      err.message = `${err.message} (retry after ${seen.retryAfter} s)`;
    }
    throw err;
  }
}

/** A GET of one object : its `data`. */
export async function getObject(
  ctx: ConnectionContext,
  path: string,
  fields: readonly string[],
): Promise<Json> {
  const answer = await request(ctx, 'GET', path, isDataObject, {
    query: new URLSearchParams({ opt_fields: fields.join(',') }),
  });
  return answer.data;
}
