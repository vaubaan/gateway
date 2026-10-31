/**
 * Requests to Notion's API, through the SDK's `httpJson`.
 *
 * Handbook : docs/handbook/providers/notion.md ; Notion's status codes
 *            and request limits pages.
 *
 *   - `ctx.fetch` only ; the token narrowed with `expectCredentialKind`,
 *     never logged, never in a result or an error message ;
 *   - `Notion-Version` pinned (`NOTION_VERSION`), a fact of the plugin ;
 *   - every answer is read through a type guard : one that is not JSON, or
 *     not the shape asked for, is an `UpstreamProtocolError` ;
 *   - a failed status is thrown : 401 → `UpstreamAuthError` (the credential),
 *     403 (`restricted_resource`, a capability the connection lacks) →
 *     `UpstreamAuthError`, anything else → `UpstreamHttpError`, with the
 *     `Retry-After` of a 429 / 529 in the message. No retry : Notion's 503
 *     may follow a write that was saved, so nothing is ever replayed.
 */

import {
  UpstreamHttpError,
  UpstreamProtocolError,
  expectCredentialKind,
  httpJson,
  type ConnectionContext,
  type Guard,
} from '@vaubaan/plugin-sdk';

import { API_TOKEN_FIELD, PROVIDER_ID } from './identity.ts';

export const NOTION_API_BASE = 'https://api.notion.com/v1';
/** Latest Notion API version on 2026-10-16 (versioning page). */
export const NOTION_VERSION = '2026-03-11';

export type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';

export interface RequestOptions {
  readonly body?: unknown;
  readonly query?: URLSearchParams;
}

function tokenOf(ctx: ConnectionContext): string {
  const secret = expectCredentialKind(PROVIDER_ID, ctx.credential, 'api-key');
  const token = secret.fields[API_TOKEN_FIELD];
  if (!token) throw new Error(`${PROVIDER_ID}: the credential has no '${API_TOKEN_FIELD}' field`);
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
  // on the way, so the agent is told when Notion lets it try again.
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
        url: `${NOTION_API_BASE}${path}${query}`,
        method,
        headers: { authorization: `Bearer ${tokenOf(ctx)}`, 'notion-version': NOTION_VERSION },
        ...(options.body !== undefined ? { body: options.body } : {}),
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

/**
 * A `GET` of one object, or `null` when Notion answers 404 : the object does
 * not exist, or is not shared with this token — Notion does not say which.
 * The ancestry walk and discovery read that answer themselves.
 */
export async function readOrMissing<T>(
  ctx: ConnectionContext,
  path: string,
  guard: Guard<T>,
): Promise<T | null> {
  try {
    return await request(ctx, 'GET', path, guard);
  } catch (err) {
    // A malformed answer is a 502 `UpstreamProtocolError`, never read as missing.
    if (err instanceof UpstreamHttpError && err.status === 404) return null;
    throw err;
  }
}
