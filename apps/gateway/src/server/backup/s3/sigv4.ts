/**
 * AWS Signature Version 4, header-based, for S3 and S3-compatible stores (ADR
 * scheduled-encrypted-backup-to-object-storage, D6). Implemented with `node:crypto` and
 * held to the examples of the S3 documentation ("Signature Calculations for the
 * Authorization Header") by `sigv4.test.ts`.
 *
 * S3 differs from the other services in one rule: the path is URI-encoded once, not
 * twice. The caller hands the path already encoded (`encodeKeyPath`).
 */
import { createHash, createHmac } from 'node:crypto';

export const SIGV4_ALGORITHM = 'AWS4-HMAC-SHA256';
export const EMPTY_PAYLOAD_SHA256 =
  'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

export interface SigV4Credentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly region: string;
  readonly service: string;
}

export interface SignableRequest {
  readonly method: string;
  /** `host[:port]` as sent in the Host header. */
  readonly host: string;
  /** The path, already URI-encoded (each segment, `/` kept). */
  readonly path: string;
  /** Query parameters, not encoded. */
  readonly query?: readonly (readonly [string, string])[];
  /** Headers to sign besides host, x-amz-date and x-amz-content-sha256. */
  readonly headers?: Readonly<Record<string, string>>;
  /** Hex SHA-256 of the body. */
  readonly payloadHash: string;
}

/** RFC 3986 encoding as SigV4 wants it: everything but `A-Z a-z 0-9 - _ . ~`. */
export function uriEncode(text: string): string {
  return encodeURIComponent(text).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** An object key as a path: each segment encoded, the slashes kept. */
export function encodeKeyPath(key: string): string {
  return key.split('/').map(uriEncode).join('/');
}

export function canonicalQuery(query: readonly (readonly [string, string])[]): string {
  return query
    .map(([k, v]) => [uriEncode(k), uriEncode(v)] as const)
    .sort(([ak, av], [bk, bv]) => (ak < bk ? -1 : ak > bk ? 1 : av < bv ? -1 : av > bv ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
}

export function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

function hmac(key: Uint8Array | string, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest();
}

/** `20130524T000000Z` */
export function amzDate(now: Date): string {
  return now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
}

export function signingKey(secret: string, date: string, region: string, service: string): Buffer {
  const kDate = hmac(`AWS4${secret}`, date);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, 'aws4_request');
}

export interface SignedRequest {
  /** Every header to send, the signed ones and `authorization`. */
  readonly headers: Record<string, string>;
  readonly canonicalRequest: string;
  readonly stringToSign: string;
  readonly signature: string;
}

export function signRequest(
  request: SignableRequest,
  credentials: SigV4Credentials,
  now: Date,
): SignedRequest {
  const stamp = amzDate(now);
  const date = stamp.slice(0, 8);
  const all: Record<string, string> = {};
  for (const [name, value] of Object.entries(request.headers ?? {})) {
    all[name.toLowerCase()] = value.trim().replace(/\s+/g, ' ');
  }
  all.host = request.host;
  all['x-amz-date'] = stamp;
  all['x-amz-content-sha256'] = request.payloadHash;
  const names = Object.keys(all).sort();
  const signedHeaders = names.join(';');
  const canonicalRequest = [
    request.method,
    request.path === '' ? '/' : request.path,
    canonicalQuery(request.query ?? []),
    names.map((name) => `${name}:${all[name]}\n`).join(''),
    signedHeaders,
    request.payloadHash,
  ].join('\n');
  const scope = `${date}/${credentials.region}/${credentials.service}/aws4_request`;
  const stringToSign = [SIGV4_ALGORITHM, stamp, scope, sha256Hex(canonicalRequest)].join('\n');
  const signature = createHmac(
    'sha256',
    signingKey(credentials.secretAccessKey, date, credentials.region, credentials.service),
  )
    .update(stringToSign, 'utf8')
    .digest('hex');
  const headers: Record<string, string> = { ...all };
  headers.authorization =
    `${SIGV4_ALGORITHM} Credential=${credentials.accessKeyId}/${scope},` +
    `SignedHeaders=${signedHeaders},Signature=${signature}`;
  return { headers, canonicalRequest, stringToSign, signature };
}
