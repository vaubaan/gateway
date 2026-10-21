/**
 * The few S3 calls the scheduled backup makes (ADR
 * scheduled-encrypted-backup-to-object-storage, D6, D7), over `fetch`, signed with
 * SigV4: `PutObject`, the multipart upload (create, part, complete, abort),
 * `ListObjectsV2` and `DeleteObject`. Virtual-hosted (`<bucket>.<host>`) or
 * path-style (`<host>/<bucket>`) addressing.
 *
 * Every failure is an `S3Error` naming the operation, the HTTP status and the S3
 * error code — never a URL, a header or a body beyond the code: the messages reach
 * the status that `/healthz` shows.
 */
import type { BackupBucketConfig } from '../../config/types';
import {
  EMPTY_PAYLOAD_SHA256,
  encodeKeyPath,
  canonicalQuery,
  sha256Hex,
  signRequest,
  type SigV4Credentials,
} from './sigv4';

/** One request of an upload may last this long (a 16 MiB part on a slow link). */
export const S3_UPLOAD_TIMEOUT_MS = 10 * 60 * 1000;
/** Every other request. */
export const S3_REQUEST_TIMEOUT_MS = 60 * 1000;
/** The longest error body read, for its `<Code>`. */
const MAX_ERROR_BODY = 64 * 1024;

export type S3Operation =
  | 'PutObject'
  | 'CreateMultipartUpload'
  | 'UploadPart'
  | 'CompleteMultipartUpload'
  | 'AbortMultipartUpload'
  | 'ListObjectsV2'
  | 'DeleteObject';

export class S3Error extends Error {
  constructor(
    readonly operation: S3Operation,
    /** HTTP status, or 0 when no answer came. */
    readonly status: number,
    /** The S3 error code (`AccessDenied`), or the network failure code. */
    readonly code: string,
  ) {
    super(
      status === 0
        ? `${operation}: no answer from the storage (${code})`
        : `${operation}: the storage answered ${status}${code ? ` ${code}` : ''}`,
    );
    this.name = 'S3Error';
  }
}

export interface S3Object {
  readonly key: string;
  readonly size: number;
}

export interface CompletedPart {
  readonly partNumber: number;
  readonly etag: string;
}

export interface S3ClientDeps {
  readonly fetch?: typeof fetch;
  readonly now?: () => Date;
}

interface S3Request {
  readonly operation: S3Operation;
  readonly method: 'GET' | 'PUT' | 'POST' | 'DELETE';
  /** The object key, or `null` for the bucket itself. */
  readonly key: string | null;
  readonly query?: readonly (readonly [string, string])[];
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: Uint8Array;
  readonly timeoutMs?: number;
}

export class S3Client {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;
  private readonly credentials: SigV4Credentials;

  constructor(
    private readonly bucket: BackupBucketConfig,
    deps: S3ClientDeps = {},
  ) {
    this.fetchImpl = deps.fetch ?? fetch;
    this.now = deps.now ?? (() => new Date());
    this.credentials = {
      accessKeyId: bucket.accessKeyId,
      secretAccessKey: bucket.secretAccessKey,
      region: bucket.region,
      service: 's3',
    };
  }

  async putObject(
    key: string,
    body: Uint8Array,
    metadata: Readonly<Record<string, string>> = {},
  ): Promise<void> {
    await this.send({
      operation: 'PutObject',
      method: 'PUT',
      key,
      headers: metaHeaders(metadata),
      body,
      timeoutMs: S3_UPLOAD_TIMEOUT_MS,
    });
  }

  async createMultipartUpload(
    key: string,
    metadata: Readonly<Record<string, string>> = {},
  ): Promise<string> {
    const text = await this.send({
      operation: 'CreateMultipartUpload',
      method: 'POST',
      key,
      query: [['uploads', '']],
      headers: metaHeaders(metadata),
    });
    const uploadId = tagValue(text, 'UploadId');
    if (!uploadId) throw new S3Error('CreateMultipartUpload', 200, 'NoUploadId');
    return uploadId;
  }

  async uploadPart(
    key: string,
    uploadId: string,
    partNumber: number,
    body: Uint8Array,
  ): Promise<CompletedPart> {
    const response = await this.request({
      operation: 'UploadPart',
      method: 'PUT',
      key,
      query: [
        ['partNumber', String(partNumber)],
        ['uploadId', uploadId],
      ],
      body,
      timeoutMs: S3_UPLOAD_TIMEOUT_MS,
    });
    await response.body?.cancel();
    const etag = response.headers.get('etag');
    if (!etag) throw new S3Error('UploadPart', response.status, 'NoETag');
    return { partNumber, etag };
  }

  async completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: readonly CompletedPart[],
  ): Promise<void> {
    const xml =
      '<CompleteMultipartUpload>' +
      parts
        .map(
          (p) =>
            `<Part><PartNumber>${p.partNumber}</PartNumber><ETag>${escapeXml(p.etag)}</ETag></Part>`,
        )
        .join('') +
      '</CompleteMultipartUpload>';
    const text = await this.send({
      operation: 'CompleteMultipartUpload',
      method: 'POST',
      key,
      query: [['uploadId', uploadId]],
      headers: { 'content-type': 'application/xml' },
      body: Buffer.from(xml, 'utf8'),
      timeoutMs: S3_UPLOAD_TIMEOUT_MS,
    });
    // S3 may answer 200 and put the error in the body.
    if (/<Error>/.test(text)) {
      throw new S3Error('CompleteMultipartUpload', 200, tagValue(text, 'Code') ?? 'Error');
    }
  }

  async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
    await this.send({
      operation: 'AbortMultipartUpload',
      method: 'DELETE',
      key,
      query: [['uploadId', uploadId]],
    });
  }

  /** Every object under `prefix`, every page. */
  async listObjects(prefix: string): Promise<S3Object[]> {
    const out: S3Object[] = [];
    let token: string | null = null;
    for (;;) {
      const query: [string, string][] = [
        ['list-type', '2'],
        ['prefix', prefix],
      ];
      if (token !== null) query.push(['continuation-token', token]);
      const text = await this.send({ operation: 'ListObjectsV2', method: 'GET', key: null, query });
      for (const block of text.match(/<Contents>[\s\S]*?<\/Contents>/g) ?? []) {
        const key = tagValue(block, 'Key');
        if (key !== null) out.push({ key, size: Number(tagValue(block, 'Size') ?? 0) });
      }
      token =
        tagValue(text, 'IsTruncated') === 'true' ? tagValue(text, 'NextContinuationToken') : null;
      if (token === null) return out;
    }
  }

  async deleteObject(key: string): Promise<void> {
    await this.send({ operation: 'DeleteObject', method: 'DELETE', key });
  }

  /** The request, its status checked; the body as text. */
  private async send(request: S3Request): Promise<string> {
    const response = await this.request(request);
    return response.text();
  }

  private async request(request: S3Request): Promise<Response> {
    const { host, path, origin } = this.addressOf(request.key);
    const body = request.body ?? new Uint8Array(0);
    const signed = signRequest(
      {
        method: request.method,
        host,
        path,
        query: request.query,
        headers: request.headers,
        payloadHash: request.body ? sha256Hex(body) : EMPTY_PAYLOAD_SHA256,
      },
      this.credentials,
      this.now(),
    );
    const query = canonicalQuery(request.query ?? []);
    const url = `${origin}${path}${query ? `?${query}` : ''}`;
    // `fetch` sets Host from the URL, to the value signed.
    const { host: _host, ...headers } = signed.headers;
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: request.method,
        headers,
        // A copy into a plain ArrayBuffer-backed view: what `BodyInit` accepts.
        body: request.body ? new Uint8Array(body) : undefined,
        redirect: 'manual',
        signal: AbortSignal.timeout(request.timeoutMs ?? S3_REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      throw new S3Error(request.operation, 0, failureCode(err));
    }
    if (response.status < 200 || response.status >= 300) {
      const code = tagValue(await readCapped(response), 'Code') ?? '';
      // A code is a word (`AccessDenied`); anything else is not repeated.
      const safe = /^[A-Za-z0-9._-]{1,64}$/.test(code) ? code : '';
      throw new S3Error(request.operation, response.status, safe);
    }
    return response;
  }

  private addressOf(key: string | null): { host: string; path: string; origin: string } {
    const { endpoint, bucket, pathStyle } = this.bucket;
    const keyPath = key === null ? '' : `/${encodeKeyPath(key)}`;
    if (pathStyle) {
      return {
        host: endpoint.host,
        origin: `${endpoint.protocol}//${endpoint.host}`,
        path: `/${encodeKeyPath(bucket)}${keyPath}`,
      };
    }
    const host = `${bucket}.${endpoint.host}`;
    return { host, origin: `${endpoint.protocol}//${host}`, path: keyPath || '/' };
  }
}

function metaHeaders(metadata: Readonly<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(metadata)) out[`x-amz-meta-${name}`] = value;
  return out;
}

/** The text of the first `<tag>…</tag>`, XML entities decoded, or `null`. */
export function tagValue(xml: string, tag: string): string | null {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(xml);
  if (!match) return null;
  return (match[1] ?? '')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function readCapped(response: Response): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (size < MAX_ERROR_BODY) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.byteLength;
    }
  } catch {
    // An error body that breaks off says nothing more.
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return Buffer.concat(chunks).toString('utf8').slice(0, MAX_ERROR_BODY);
}

/** A short name for a network failure: an error code or class, never a message. */
function failureCode(err: unknown): string {
  const cause = (err as { cause?: unknown })?.cause;
  for (const candidate of [cause, err]) {
    const code = (candidate as { code?: unknown } | undefined)?.code;
    if (typeof code === 'string' && /^[A-Z0-9_]{2,40}$/.test(code)) return code;
  }
  if (err instanceof Error && err.name === 'TimeoutError') return 'timeout';
  return err instanceof Error ? err.name : 'unknown';
}
