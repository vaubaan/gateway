/**
 * Requests to Notion's API.
 *
 * Handbook : docs/handbook/providers/notion.md ; Notion's status codes
 *            and request limits pages.
 *
 *   - `ctx.fetch` only ; the token narrowed with `expectCredentialKind`,
 *     never logged, never in a result or an error message ;
 *   - `Notion-Version` pinned (`NOTION_VERSION`), a fact of the plugin ;
 *   - a failed status is thrown : 401 → `UpstreamAuthError` (the credential),
 *     403 (`restricted_resource`, a capability the connection lacks) →
 *     `UpstreamAuthError`, anything else → `UpstreamHttpError`, with the
 *     `Retry-After` of a 429 / 529 in the message. No retry : Notion's 503
 *     may follow a write that was saved, so nothing is ever replayed.
 */

import {
  UpstreamAuthError,
  UpstreamHttpError,
  expectCredentialKind,
  type ConnectionContext,
} from '@vaubaan/plugin-sdk';

import { API_TOKEN_FIELD, PROVIDER_ID } from './identity.ts';

export const NOTION_API_BASE = 'https://api.notion.com/v1';
/** Latest Notion API version on 2026-10-16 (versioning page). */
export const NOTION_VERSION = '2026-03-11';

const PROVIDER_TEXT_SHOWN = 500;

/** A provider answer, its status kept : the ancestry walk reads a 404 itself. */
export interface Answer {
  readonly status: number;
  readonly body: unknown;
  readonly text: string;
  readonly retryAfter: string | null;
}

export type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';

function tokenOf(ctx: ConnectionContext): string {
  const secret = expectCredentialKind(PROVIDER_ID, ctx.credential, 'api-key');
  const token = secret.fields[API_TOKEN_FIELD];
  if (!token) throw new Error(`${PROVIDER_ID}: the credential has no '${API_TOKEN_FIELD}' field`);
  return token;
}

/** One request ; the answer whatever its status. A network failure propagates. */
export async function send(
  ctx: ConnectionContext,
  method: Method,
  path: string,
  options: { readonly body?: unknown; readonly query?: URLSearchParams } = {},
): Promise<Answer> {
  const query =
    options.query && [...options.query].length > 0 ? `?${options.query.toString()}` : '';
  const res = await ctx.fetch(`${NOTION_API_BASE}${path}${query}`, {
    redirect: 'error',
    method,
    headers: {
      authorization: `Bearer ${tokenOf(ctx)}`,
      'notion-version': NOTION_VERSION,
      accept: 'application/json',
      ...(options.body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    ...(ctx.signal ? { signal: ctx.signal } : {}),
  });
  const text = await res.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { status: res.status, body, text, retryAfter: res.headers.get('retry-after') };
}

/** The failure an unsuccessful answer is, thrown by `request` and by the walk. */
export function failureOf(method: Method, path: string, answer: Answer): Error {
  const said = answer.text.slice(0, PROVIDER_TEXT_SHOWN);
  const wait = answer.retryAfter ? ` (retry after ${answer.retryAfter} s)` : '';
  const message = `Notion ${method} ${path} ${answer.status}${wait}: ${said}`;
  if (answer.status === 401 || answer.status === 403) {
    return new UpstreamAuthError(message, answer.status);
  }
  return new UpstreamHttpError(message, answer.status);
}

/** One request whose failure is thrown ; the parsed body of a success. */
export async function request(
  ctx: ConnectionContext,
  method: Method,
  path: string,
  options: { readonly body?: unknown; readonly query?: URLSearchParams } = {},
): Promise<unknown> {
  const answer = await send(ctx, method, path, options);
  if (answer.status < 200 || answer.status >= 300) throw failureOf(method, path, answer);
  return answer.body;
}
