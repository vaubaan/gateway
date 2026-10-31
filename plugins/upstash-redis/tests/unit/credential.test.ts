/**
 * The Upstash Developer API key (`credential.ts`) against `mockFetch` : the
 * guide the connect page shows and the check at paste.
 */
import { describe, expect, test } from 'vitest';

import { UpstreamAuthError, type ConnectionContext } from '@vaubaan/plugin-sdk';
import { guideText, mockFetch } from '@vaubaan/plugin-sdk/testing';

import {
  UPSTASH_API_KEYS_URL,
  UPSTASH_MANAGEMENT_API,
  upstashRedisCredential,
  upstashRedisTools,
  verifyUpstashKey,
} from '../../src/index.ts';

const TEAMS = `${UPSTASH_MANAGEMENT_API}/teams`;

const ctx = (fetch: typeof globalThis.fetch): ConnectionContext => ({
  credential: {
    kind: 'api-key',
    fields: { email: 'ops@acme.example', api_key: 'key-0123' },
    metadata: {},
  },
  fetch,
});

describe('upstash-redis key — the guide', () => {
  test('the Developer API page, Read/Write for every tool, an expiry the person types', () => {
    expect(upstashRedisCredential.createUrl).toBe(UPSTASH_API_KEYS_URL);
    expect(guideText(upstashRedisCredential.guide!)).toMatch(/native Upstash account/);
    expect(upstashRedisCredential.guide!.permissions).toEqual([
      {
        name: 'Read/Write',
        access: 'read-write',
        tools: upstashRedisTools.map((tool) => tool.name),
      },
    ]);
    expect(upstashRedisCredential.guide!.expiry).toEqual({
      kind: 'person-types',
      recommendedDays: 90,
    });
  });
});

describe('upstash-redis key — verify at paste', () => {
  test('asks the Developer API with Basic auth and names the account by its email', async () => {
    const fetch = mockFetch([{ method: 'GET', url: TEAMS, body: [] }]);
    expect(await verifyUpstashKey(ctx(fetch))).toEqual({
      account: 'ops@acme.example',
      expiresAt: null,
    });
    const basic = Buffer.from('ops@acme.example:key-0123').toString('base64');
    expect(fetch.calls[0]!.headers.authorization).toBe(`Basic ${basic}`);
  });

  test('a rejected key is an UpstreamAuthError', async () => {
    const fetch = mockFetch([{ method: 'GET', url: TEAMS, status: 401, body: {} }]);
    await expect(verifyUpstashKey(ctx(fetch))).rejects.toBeInstanceOf(UpstreamAuthError);
  });
});
