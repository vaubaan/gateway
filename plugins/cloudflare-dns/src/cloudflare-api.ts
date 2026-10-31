/**
 * The Cloudflare REST API v4 as `execute`, discovery and `verify` call it :
 * the bearer, the way the arguments travel, and Cloudflare's answer envelope.
 *
 * Every call goes through the SDK's transport, so a failure is thrown typed :
 * 401 / 403 → `UpstreamAuthError`, another failed status →
 * `UpstreamHttpError`, an answer that is not JSON or not the envelope the
 * caller reads → `UpstreamProtocolError`. The one answer that is not JSON,
 * the BIND export, is read as bounded text (`callCloudflareText`).
 */

import {
  DEFAULT_MAX_ANSWER_BYTES,
  expectCredentialKind,
  httpJson,
  isRecord,
  readBoundedText,
  upstreamFailure,
  type ConnectionContext,
  type Guard,
  type RawRequestBody,
  type UpstreamIo,
} from '@vaubaan/plugin-sdk';

import { API_TOKEN_FIELD, CLOUDFLARE_API_BASE, PROVIDER_ID } from './identity.ts';

type Args = Readonly<Record<string, unknown>>;

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE';

/** How the arguments of a call travel : query string, JSON body, multipart `file`, or not at all. */
export type Payload = 'query' | 'json' | 'multipart' | 'none';

/** The request line of a call, without its arguments. */
export interface Endpoint {
  readonly method: HttpMethod;
  readonly payload: Payload;
}

/**
 * What Cloudflare answers on success : `{ success, errors, messages, result,
 * result_info? }`. Only `result` is read, through the caller's guard ;
 * `result_info` carries the pagination of a list.
 */
export interface CloudflareEnvelope<T> {
  readonly result: T;
  readonly result_info?: unknown;
}

/** The guard of an envelope whose `result` passes `isResult`. */
export function envelopeOf<T>(isResult: Guard<T>): Guard<CloudflareEnvelope<T>> {
  return (value: unknown): value is CloudflareEnvelope<T> =>
    isRecord(value) && isResult(value.result);
}

/** The pasted API token of a connection. */
export function tokenOf(ctx: ConnectionContext): string {
  const secret = expectCredentialKind(PROVIDER_ID, ctx.credential, 'api-key');
  const token = secret.fields[API_TOKEN_FIELD];
  // A host bug, not a refusal : the credential spec requires the field.
  if (!token) throw new Error(`${PROVIDER_ID}: the credential has no '${API_TOKEN_FIELD}' field`);
  return token;
}

/** One call whose answer is JSON, read through `guard`. */
export function callCloudflareApi<T>(
  io: UpstreamIo,
  token: string,
  endpoint: Endpoint,
  path: string,
  args: Args,
  guard: Guard<T>,
): Promise<T> {
  const headers = { authorization: `Bearer ${token}` };
  const method = endpoint.method;
  switch (endpoint.payload) {
    case 'query':
      return httpJson(
        io,
        { url: `${CLOUDFLARE_API_BASE}${path}${toQueryString(args)}`, method, headers },
        guard,
      );
    case 'json':
      return httpJson(
        io,
        { url: `${CLOUDFLARE_API_BASE}${path}`, method, headers, body: args },
        guard,
      );
    case 'multipart':
      return httpJson(
        io,
        { url: `${CLOUDFLARE_API_BASE}${path}`, method, headers, rawBody: bindFileForm(args) },
        guard,
      );
    case 'none':
      return httpJson(io, { url: `${CLOUDFLARE_API_BASE}${path}`, method, headers }, guard);
  }
}

/**
 * One GET whose answer is text : the BIND file of `dns_records/export`. The
 * `accept` header is the one every call sends ; Cloudflare answers the file
 * whatever it says.
 */
export async function callCloudflareText(
  io: UpstreamIo,
  token: string,
  path: string,
): Promise<string> {
  const url = `${CLOUDFLARE_API_BASE}${path}`;
  const what = `GET ${url}`;
  const res = await io.fetch(url, {
    method: 'GET',
    redirect: 'error',
    headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
    ...(io.signal ? { signal: io.signal } : {}),
  });
  if (!res.ok) throw await upstreamFailure(res, what);
  return readBoundedText(res, DEFAULT_MAX_ANSWER_BYTES, what);
}

/** The BIND file of an import, as the multipart `file` field Cloudflare reads. */
function bindFileForm(args: Args): RawRequestBody {
  const form = new FormData();
  form.append(
    'file',
    new Blob([String(args.file ?? '')], { type: 'application/octet-stream' }),
    'records.txt',
  );
  return form;
}

function toQueryString(args: Args): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(args)) {
    if (value === null || value === undefined) continue;
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  }
  return parts.length > 0 ? `?${parts.join('&')}` : '';
}
