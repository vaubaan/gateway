/**
 * The addressing and the error reporting of the S3 client (the signatures are held to
 * the AWS examples by `sigv4.test.ts`, the calls by the fake server of the integration
 * tests). Credentials are made up.
 */
import { describe, expect, it } from 'vitest';

import type { BackupBucketConfig } from '../../config/types';
import { S3Client, S3Error, tagValue } from './client';

function bucketOf(overrides: Partial<BackupBucketConfig> = {}): BackupBucketConfig {
  return {
    endpoint: new URL('https://storage.example.com'),
    region: 'auto',
    bucket: 'acme-backups',
    prefix: '',
    pathStyle: false,
    accessKeyId: 'TESTKEY',
    secretAccessKey: 'test-secret-not-real',
    ...overrides,
  };
}

function recording(response: () => Response) {
  const seen: { url: string; init: RequestInit | undefined }[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen.push({ url: String(input), init });
    return response();
  }) as typeof fetch;
  return { impl, seen };
}

describe('the S3 client', () => {
  it('virtual-hosted: the bucket in the host, the key encoded in the path, the payload signed', async () => {
    const { impl, seen } = recording(() => new Response(null, { status: 200 }));
    await new S3Client(bucketOf(), { fetch: impl }).putObject(
      'acme/vaubaan backup.vbk',
      Buffer.from('x'),
      { sha256: 'abc' },
    );
    expect(seen[0]?.url).toBe('https://acme-backups.storage.example.com/acme/vaubaan%20backup.vbk');
    const headers = seen[0]?.init?.headers as Record<string, string>;
    expect(headers.authorization).toMatch(
      /^AWS4-HMAC-SHA256 Credential=TESTKEY\/\d{8}\/auto\/s3\/aws4_request,SignedHeaders=host;x-amz-content-sha256;x-amz-date;x-amz-meta-sha256,Signature=[0-9a-f]{64}$/,
    );
    expect(headers['x-amz-meta-sha256']).toBe('abc');
    expect(headers.host).toBeUndefined();
    expect(headers.authorization).not.toContain('test-secret-not-real');
  });

  it('path-style: the bucket first in the path', async () => {
    const { impl, seen } = recording(
      () => new Response('<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>'),
    );
    await new S3Client(bucketOf({ pathStyle: true }), { fetch: impl }).listObjects('a/');
    expect(seen[0]?.url).toBe('https://storage.example.com/acme-backups?list-type=2&prefix=a%2F');
  });

  it('names the status and the S3 code of a refusal, nothing else of the body', async () => {
    const { impl } = recording(
      () =>
        new Response(
          '<Error><Code>NoSuchBucket</Code><Message>https://secret.example/x</Message></Error>',
          { status: 404 },
        ),
    );
    const err = await new S3Client(bucketOf(), { fetch: impl }).deleteObject('k').then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(S3Error);
    expect((err as S3Error).message).toBe('DeleteObject: the storage answered 404 NoSuchBucket');
  });

  it('a code that is not a word is not repeated', async () => {
    const { impl } = recording(
      () => new Response('<Error><Code>a b <c></Code></Error>', { status: 400 }),
    );
    const err = (await new S3Client(bucketOf(), { fetch: impl })
      .deleteObject('k')
      .catch((e: unknown) => e)) as S3Error;
    expect(err.message).toBe('DeleteObject: the storage answered 400');
  });

  it('a network failure is named by its code', async () => {
    const impl = (async () => {
      throw Object.assign(new TypeError('fetch failed'), {
        cause: { code: 'ECONNREFUSED', message: 'connect https://x' },
      });
    }) as typeof fetch;
    const err = (await new S3Client(bucketOf(), { fetch: impl })
      .deleteObject('k')
      .catch((e: unknown) => e)) as S3Error;
    expect(err.message).toBe('DeleteObject: no answer from the storage (ECONNREFUSED)');
  });

  it('reads XML values with their entities', () => {
    expect(tagValue('<Key>a&amp;b</Key>', 'Key')).toBe('a&b');
    expect(tagValue('<Key>a</Key>', 'Size')).toBeNull();
  });
});
