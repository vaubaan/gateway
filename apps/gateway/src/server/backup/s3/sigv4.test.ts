/**
 * SigV4 against the examples of the S3 documentation, "Signature Calculations for the
 * Authorization Header: Transferring Payload in a Single Chunk" (examplebucket,
 * 2013-05-24, the documentation's example credentials — not a real key).
 */
import { describe, expect, it } from 'vitest';

import {
  EMPTY_PAYLOAD_SHA256,
  canonicalQuery,
  encodeKeyPath,
  sha256Hex,
  signRequest,
  signingKey,
  type SigV4Credentials,
} from './sigv4';

const AWS_EXAMPLE: SigV4Credentials = {
  accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  region: 'us-east-1',
  service: 's3',
};
const AT = new Date('2013-05-24T00:00:00Z');
const HOST = 'examplebucket.s3.amazonaws.com';

describe('SigV4 — the S3 documentation examples', () => {
  it('GET Object with a Range header', () => {
    const signed = signRequest(
      {
        method: 'GET',
        host: HOST,
        path: `/${encodeKeyPath('test.txt')}`,
        headers: { range: 'bytes=0-9' },
        payloadHash: EMPTY_PAYLOAD_SHA256,
      },
      AWS_EXAMPLE,
      AT,
    );
    expect(signed.headers.authorization).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request,' +
        'SignedHeaders=host;range;x-amz-content-sha256;x-amz-date,' +
        'Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41',
    );
  });

  it('PUT Object: the key path encoded once ($ → %24), signed payload and extra headers', () => {
    const body = 'Welcome to Amazon S3.';
    const payloadHash = sha256Hex(body);
    expect(payloadHash).toBe('44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072');
    const signed = signRequest(
      {
        method: 'PUT',
        host: HOST,
        path: `/${encodeKeyPath('test$file.text')}`,
        headers: {
          Date: 'Fri, 24 May 2013 00:00:00 GMT',
          'x-amz-storage-class': 'REDUCED_REDUNDANCY',
        },
        payloadHash,
      },
      AWS_EXAMPLE,
      AT,
    );
    expect(signed.canonicalRequest.split('\n')[1]).toBe('/test%24file.text');
    expect(signed.stringToSign.split('\n')[3]).toBe(
      '9e0e90d9c76de8fa5b200d8c849cd5b8dc7a3be3951ddb7f6a76b4158342019d',
    );
    expect(signed.signature).toBe(
      '98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd',
    );
  });

  it('GET Bucket (List Objects) with a query string', () => {
    const signed = signRequest(
      {
        method: 'GET',
        host: HOST,
        path: '/',
        query: [
          ['prefix', 'J'],
          ['max-keys', '2'],
        ],
        payloadHash: EMPTY_PAYLOAD_SHA256,
      },
      AWS_EXAMPLE,
      AT,
    );
    expect(signed.canonicalRequest.split('\n')[2]).toBe('max-keys=2&prefix=J');
    expect(signed.signature).toBe(
      '34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7',
    );
  });

  it('the signing key of the IAM documentation example', () => {
    // "Examples of how to derive a signing key for Signature Version 4".
    expect(
      signingKey(
        'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
        '20120215',
        'us-east-1',
        'iam',
      ).toString('hex'),
    ).toBe('f4780e2d9f65fa895f9c67b32ce1baf0b0d8a43505a000a1a9e090d414db404d');
  });
});

describe('SigV4 — encoding rules', () => {
  it('encodes each key segment with RFC 3986 and keeps the slashes', () => {
    expect(encodeKeyPath("gateway/vaubaan backup (1)*!'.vbk")).toBe(
      'gateway/vaubaan%20backup%20%281%29%2A%21%27.vbk',
    );
  });

  it('sorts the query by encoded key and gives a parameter without value an empty one', () => {
    expect(
      canonicalQuery([
        ['uploads', ''],
        ['a b', 'x/y'],
      ]),
    ).toBe('a%20b=x%2Fy&uploads=');
  });
});
