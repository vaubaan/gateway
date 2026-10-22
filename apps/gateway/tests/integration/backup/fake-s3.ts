/**
 * An in-process S3-compatible server for the scheduled backup's tests: path-style
 * addressing, one bucket, objects in memory. It checks every request's SigV4 signature
 * against the secret it was given (recomputed from what it received, so a header or a
 * query the client sends differently from what it signed is refused), and the
 * payload's SHA-256 against `x-amz-content-sha256`.
 *
 * Calls: PutObject, CreateMultipartUpload, UploadPart, CompleteMultipartUpload,
 * AbortMultipartUpload, ListObjectsV2 (two keys a page, to exercise the continuation),
 * DeleteObject. `failNext` answers the next call of one operation with an S3 error.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { sha256Hex, signRequest, type SigV4Credentials } from '../../../src/server/backup/s3/sigv4';

export interface StoredObject {
  readonly body: Buffer;
  readonly metadata: Record<string, string>;
}

export interface FakeS3 {
  readonly endpoint: string;
  readonly bucket: string;
  readonly objects: Map<string, StoredObject>;
  readonly operations: string[];
  failNext(operation: string, status: number, code: string): void;
  close(): Promise<void>;
}

const PAGE = 2;

export async function startFakeS3(credentials: SigV4Credentials, bucket: string): Promise<FakeS3> {
  const objects = new Map<string, StoredObject>();
  const uploads = new Map<
    string,
    { key: string; metadata: Record<string, string>; parts: Map<number, Buffer> }
  >();
  const operations: string[] = [];
  const failures = new Map<string, { status: number; code: string }>();
  let nextUpload = 1;

  function error(res: ServerResponse, status: number, code: string): void {
    res.writeHead(status, { 'content-type': 'application/xml' });
    res.end(`<?xml version="1.0"?><Error><Code>${code}</Code><Message>no</Message></Error>`);
  }

  function verified(req: IncomingMessage, url: URL, body: Buffer): boolean {
    const auth = req.headers.authorization ?? '';
    const signedHeaders = /SignedHeaders=([^,]+)/.exec(auth)?.[1]?.split(';') ?? [];
    const signature = /Signature=([0-9a-f]+)/.exec(auth)?.[1];
    const payloadHash = String(req.headers['x-amz-content-sha256'] ?? '');
    if (sha256Hex(body) !== payloadHash) return false;
    const headers: Record<string, string> = {};
    for (const name of signedHeaders) {
      if (['host', 'x-amz-date', 'x-amz-content-sha256'].includes(name)) continue;
      headers[name] = String(req.headers[name] ?? '');
    }
    const stamp = String(req.headers['x-amz-date'] ?? '');
    const at = new Date(
      `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}T${stamp.slice(9, 11)}:${stamp.slice(11, 13)}:${stamp.slice(13, 15)}Z`,
    );
    const expected = signRequest(
      {
        method: req.method ?? 'GET',
        host: String(req.headers.host ?? ''),
        path: url.pathname,
        query: [...url.searchParams.entries()],
        headers,
        payloadHash,
      },
      credentials,
      at,
    );
    return expected.signature === signature;
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks);
    const url = new URL(req.url ?? '/', 'http://fake');
    if (!verified(req, url, body)) return error(res, 403, 'SignatureDoesNotMatch');
    const [, bucketPart = '', ...rest] = url.pathname.split('/');
    if (decodeURIComponent(bucketPart) !== bucket) return error(res, 404, 'NoSuchBucket');
    const key = rest.map(decodeURIComponent).join('/');
    const q = url.searchParams;
    const operation =
      req.method === 'PUT' && q.has('partNumber')
        ? 'UploadPart'
        : req.method === 'PUT'
          ? 'PutObject'
          : req.method === 'POST' && q.has('uploads')
            ? 'CreateMultipartUpload'
            : req.method === 'POST' && q.has('uploadId')
              ? 'CompleteMultipartUpload'
              : req.method === 'DELETE' && q.has('uploadId')
                ? 'AbortMultipartUpload'
                : req.method === 'DELETE'
                  ? 'DeleteObject'
                  : req.method === 'GET' && q.get('list-type') === '2'
                    ? 'ListObjectsV2'
                    : 'Unknown';
    operations.push(operation);
    const failure = failures.get(operation);
    if (failure) {
      failures.delete(operation);
      return error(res, failure.status, failure.code);
    }
    const metadata: Record<string, string> = {};
    for (const [name, value] of Object.entries(req.headers)) {
      if (name.startsWith('x-amz-meta-'))
        metadata[name.slice('x-amz-meta-'.length)] = String(value);
    }
    switch (operation) {
      case 'PutObject':
        objects.set(key, { body, metadata });
        res.writeHead(200, { etag: '"put"' });
        return void res.end();
      case 'CreateMultipartUpload': {
        const id = `upload-${nextUpload++}`;
        uploads.set(id, { key, metadata, parts: new Map() });
        res.writeHead(200, { 'content-type': 'application/xml' });
        return void res.end(
          `<InitiateMultipartUploadResult><Bucket>${bucket}</Bucket><Key>${key}</Key><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`,
        );
      }
      case 'UploadPart': {
        const upload = uploads.get(q.get('uploadId') ?? '');
        if (!upload) return error(res, 404, 'NoSuchUpload');
        const n = Number(q.get('partNumber'));
        upload.parts.set(n, body);
        res.writeHead(200, { etag: `"part-${n}"` });
        return void res.end();
      }
      case 'CompleteMultipartUpload': {
        const id = q.get('uploadId') ?? '';
        const upload = uploads.get(id);
        if (!upload) return error(res, 404, 'NoSuchUpload');
        const numbers = [...body.toString('utf8').matchAll(/<PartNumber>(\d+)<\/PartNumber>/g)].map(
          (m) => Number(m[1]),
        );
        objects.set(upload.key, {
          body: Buffer.concat(numbers.map((n) => upload.parts.get(n) ?? Buffer.alloc(0))),
          metadata: upload.metadata,
        });
        uploads.delete(id);
        res.writeHead(200, { 'content-type': 'application/xml' });
        return void res.end(
          '<CompleteMultipartUploadResult><ETag>"done"</ETag></CompleteMultipartUploadResult>',
        );
      }
      case 'AbortMultipartUpload':
        uploads.delete(q.get('uploadId') ?? '');
        res.writeHead(204);
        return void res.end();
      case 'DeleteObject':
        objects.delete(key);
        res.writeHead(204);
        return void res.end();
      case 'ListObjectsV2': {
        const prefix = q.get('prefix') ?? '';
        const all = [...objects.keys()].filter((k) => k.startsWith(prefix)).sort();
        const start = Number(q.get('continuation-token') ?? 0);
        const page = all.slice(start, start + PAGE);
        const truncated = start + PAGE < all.length;
        res.writeHead(200, { 'content-type': 'application/xml' });
        return void res.end(
          '<ListBucketResult>' +
            page
              .map(
                (k) =>
                  `<Contents><Key>${k}</Key><Size>${objects.get(k)?.body.length ?? 0}</Size></Contents>`,
              )
              .join('') +
            `<IsTruncated>${truncated}</IsTruncated>` +
            (truncated ? `<NextContinuationToken>${start + PAGE}</NextContinuationToken>` : '') +
            '</ListBucketResult>',
        );
      }
      default:
        return error(res, 400, 'NotImplemented');
    }
  }

  const server: Server = createServer((req, res) => {
    handle(req, res).catch(() => error(res, 500, 'InternalError'));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    endpoint: `http://127.0.0.1:${port}`,
    bucket,
    objects,
    operations,
    failNext(operation, status, code) {
      failures.set(operation, { status, code });
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
