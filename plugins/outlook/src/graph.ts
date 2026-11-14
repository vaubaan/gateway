/**
 * The one way the `outlook` plugin calls Microsoft Graph: the SDK's
 * `httpJson` with the brokered access token as a Bearer and the `Prefer`
 * header every request carries (immutable ids), plus what a request asks
 * for (a text body, UTC times).
 *
 * Handbook : docs/handbook/providers/outlook.md.
 *
 * A 401 is a rejected token (the host refreshes through the broker and
 * retries); Graph answers 403 for a missing permission or a blocked
 * mailbox, and 429 with `Retry-After`: thrown as the transport types them.
 */

import {
  ExecutorRefusal,
  anyJson,
  expectCredentialKind,
  httpJson,
  type AccountContext,
  type Guard,
} from '@vaubaan/plugin-sdk';

import { pathSegment } from './identifiers.ts';
import { GRAPH_API_BASE, PREFER_IMMUTABLE_ID, PROVIDER_ID } from './identity.ts';

export type Query = Readonly<Record<string, string | number | boolean | undefined>>;
export type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';

export interface GraphRequest<T> {
  readonly query?: Query;
  readonly body?: unknown;
  readonly guard?: Guard<T>;
  /** `Prefer` values besides the immutable-id one. */
  readonly prefer?: readonly string[];
  readonly maxBytes?: number;
}

function tokenOf(ctx: AccountContext): string {
  return expectCredentialKind(PROVIDER_ID, ctx.credential, 'oauth2').accessToken;
}

function queryString(query: Query): string {
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(query)) {
    if (value !== undefined) params.set(name, String(value));
  }
  const text = params.toString();
  return text === '' ? '' : `?${text}`;
}

/** One Graph request; an answer without content (202, 204) is `null`. */
export async function graph<T = unknown>(
  ctx: AccountContext,
  method: Method,
  path: string,
  options: GraphRequest<T> = {},
): Promise<T | null> {
  const guard = (options.guard ?? anyJson) as Guard<T>;
  return httpJson(
    ctx,
    {
      url: `${GRAPH_API_BASE}${path}${queryString(options.query ?? {})}`,
      method,
      headers: {
        authorization: `Bearer ${tokenOf(ctx)}`,
        prefer: [PREFER_IMMUTABLE_ID, ...(options.prefer ?? [])].join(', '),
      },
      what: `Microsoft Graph ${method} ${path}`,
      ...(options.body !== undefined ? { body: options.body } : {}),
      ...(options.maxBytes !== undefined ? { maxBytes: options.maxBytes } : {}),
    },
    (value): value is T | null => value === null || guard(value),
  );
}

/** One path segment from a value its grammar accepted; refused before any request otherwise. */
export function segment(value: string | null, what: string): string {
  const s = value === null ? null : pathSegment(value);
  if (s === null) throw new ExecutorRefusal(`${what}: not a path segment.`);
  return s;
}

/** An OData string literal: the value between single quotes, each quote doubled. */
export function odataString(value: string): string {
  return `'${value.split("'").join("''")}'`;
}
