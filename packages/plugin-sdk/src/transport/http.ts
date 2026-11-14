/**
 * One HTTP call to a provider that answers JSON, the way the plugin contract
 * wants it made : `fetch` and the caller's `signal` from the context, the
 * failure typed, the answer bounded and read through a type guard.
 *
 *   status 401 or 403   `UpstreamAuthError` (on a 401 the host refreshes the
 *                       credential, retries once, then marks it `expired`)
 *   any other non-2xx   `UpstreamHttpError` with that status
 *   too large           `UpstreamAnswerTooLarge`
 *   not JSON, or not    `UpstreamProtocolError`
 *   what the guard says
 *   a network error     the `fetch` error, as it is
 *
 * Every message names the request (method, origin and path, never the query
 * string, which can carry a key) and quotes at most the first
 * `QUOTED_LENGTH` characters of a failed answer : the host gives that text
 * to the agent and stores none of it (ADR
 * provider-error-text-stays-with-the-agent).
 */

import { UpstreamAuthError, UpstreamHttpError } from '@vaubaan/shared';

import { UpstreamProtocolError } from './errors.ts';
import { DEFAULT_MAX_ANSWER_BYTES, readBoundedText, readPrefixText } from './read-bounded.ts';
import { readShape, type Guard } from './shape.ts';

/** What a call to a provider needs of the context : an `ExecuteContext` or a `AccountContext` is one. */
export interface UpstreamIo {
  readonly fetch: typeof fetch;
  readonly signal?: AbortSignal;
}

/** Longest excerpt of a failed answer quoted in an error message. */
export const QUOTED_LENGTH = 300;

/** The most read of a failed answer : the excerpt needs no more (4 bytes per character at most). */
const FAILURE_READ_BYTES = QUOTED_LENGTH * 4;

interface HttpJsonRequestBase {
  readonly url: string | URL;
  /** Defaults to `GET`. */
  readonly method?: string;
  /** The credential goes here (`authorization`) ; `accept: application/json` is added. */
  readonly headers?: Readonly<Record<string, string>>;
  /** The bound of the answer ; `DEFAULT_MAX_ANSWER_BYTES` when absent. */
  readonly maxBytes?: number;
  /** How messages name the request ; `<METHOD> <origin><path>` when absent. */
  readonly what?: string;
}

/** A body sent as it is : a form, a file. */
export type RawRequestBody = string | Uint8Array<ArrayBuffer> | URLSearchParams | FormData | Blob;

/**
 * One request to a provider that answers JSON. Its body is either `body`,
 * sent as JSON with `content-type: application/json`, or `rawBody`, sent as
 * it is — never both : a form (`URLSearchParams`, `FormData`, whose
 * `content-type` `fetch` writes) or bytes and text whose `content-type` the
 * plugin puts in `headers`. Neither : no body.
 */
export type HttpJsonRequest = HttpJsonRequestBase &
  (
    | { readonly body?: unknown; readonly rawBody?: never }
    | { readonly rawBody: RawRequestBody; readonly body?: never }
  );

/**
 * Send `request` and return its JSON answer as a `T`, or throw the typed
 * failure (table above). An answer without content (`204`, an empty body)
 * is `null` : a guard that accepts it is `anyJson`.
 */
export async function httpJson<T>(
  io: UpstreamIo,
  request: HttpJsonRequest,
  guard: Guard<T>,
): Promise<T> {
  const method = (request.method ?? 'GET').toUpperCase();
  const what = request.what ?? `${method} ${describeUrl(request.url)}`;
  const json = request.body !== undefined;
  const body = request.rawBody ?? (json ? JSON.stringify(request.body) : undefined);
  const res = await io.fetch(request.url, {
    method,
    redirect: 'error',
    headers: {
      accept: 'application/json',
      ...(json ? { 'content-type': 'application/json' } : {}),
      ...request.headers,
    },
    ...(body !== undefined ? { body } : {}),
    ...(io.signal ? { signal: io.signal } : {}),
  });
  if (!res.ok) throw await upstreamFailure(res, what);
  const text = await readBoundedText(res, request.maxBytes ?? DEFAULT_MAX_ANSWER_BYTES, what);
  return readShape(parseJson(text, what), guard, what);
}

/**
 * The typed failure of an answer that is not a success, its body quoted
 * (bounded) for the agent : `UpstreamAuthError` for 401 and 403,
 * `UpstreamHttpError` otherwise. For a plugin that reads a success itself
 * (a stream, a binary body) and wants the same failures as `httpJson`.
 */
export async function upstreamFailure(res: Response, what: string): Promise<Error> {
  const excerpt = await quotedExcerpt(res);
  const message = `${what} failed with HTTP ${res.status}${excerpt ? `: ${excerpt}` : ''}`;
  if (res.status === 401 || res.status === 403) return new UpstreamAuthError(message, res.status);
  return new UpstreamHttpError(message, res.status);
}

async function quotedExcerpt(res: Response): Promise<string> {
  try {
    return (await readPrefixText(res, FAILURE_READ_BYTES)).trim().slice(0, QUOTED_LENGTH);
  } catch {
    // An answer that breaks while it is read : the status alone says it.
    return '';
  }
}

function parseJson(text: string, what: string): unknown {
  if (text.trim() === '') return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new UpstreamProtocolError(`${what}: the answer is not JSON`);
  }
}

/** Origin and path of a request URL : never its query string. */
export function describeUrl(url: string | URL): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return '<invalid URL>';
  }
}
