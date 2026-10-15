/**
 * Request shapes of the `upstash-redis` plugin : the method, URL and body
 * `upstashRedisPlugin.execute` sends to the Management API for each
 * management tool, and the Redis command array it posts to the per-database
 * REST endpoint for the data tools.
 *
 * Complements `plugin.test.ts`, which covers authentication, redaction of
 * the list answer, the GET / SET commands, refusals and error mapping.
 * No network : an unmatched request fails the test.
 */
import { describe, expect, test } from 'vitest';

import type { ExecuteContext, Resource } from '@vaubaan/plugin-sdk';
import { mockFetch, type MockRoute } from '@vaubaan/plugin-sdk/testing';

import { upstashRedisPlugin, UPSTASH_MANAGEMENT_API } from '../../src/index.ts';

const DATABASE_ID = 'db-abc-123';
const REST_URL = 'https://us1-app-cache.upstash.io';

const database: Resource = {
  provider: 'upstash-redis',
  ref: DATABASE_ID,
  env: 'staging',
  displayName: 'app-cache',
};

const ctx = (fetch: typeof globalThis.fetch): ExecuteContext => ({
  credential: {
    kind: 'api-key',
    fields: { email: 'ops@acme.com', api_key: 'upstash_key_123' },
    metadata: {},
  },
  appConfig: {},
  fetch,
  resources: [database],
});

const textOf = (result: { content: readonly unknown[] }) =>
  JSON.parse((result.content[0] as { text: string }).text) as unknown;

/** Run one management tool against a single-route mock ; returns the recorded call and the result. */
async function runManagement(route: MockRoute, tool: string, args: Record<string, unknown>) {
  const fetch = mockFetch([{ ...route, times: 1 }]);
  const result = await upstashRedisPlugin.execute(ctx(fetch), tool, args);
  expect(result.isError).toBeUndefined();
  expect(fetch.calls).toHaveLength(1);
  return { call: fetch.calls[0]!, result };
}

/** Run one data tool on the mission's single database ; returns the command posted to the REST endpoint. */
async function commandOf(tool: string, args: Record<string, unknown>, answer: unknown) {
  const fetch = mockFetch([
    {
      method: 'GET',
      url: `${UPSTASH_MANAGEMENT_API}/redis/database/${DATABASE_ID}`,
      body: { database_id: DATABASE_ID, rest_url: REST_URL, rest_token: 'tok' },
      times: 1,
    },
    { method: 'POST', url: REST_URL, body: { result: answer }, times: 1 },
  ]);
  const result = await upstashRedisPlugin.execute(ctx(fetch), tool, args);
  expect(result.isError).toBeUndefined();
  expect(fetch.pending()).toEqual([]);
  expect(textOf(result)).toEqual({ result: answer });
  return fetch.calls[1]!.json;
}

describe('executeUpstashRedis — management tools', () => {
  test('get_database GETs /redis/database/{id} and redacts the REST token', async () => {
    const { call, result } = await runManagement(
      {
        method: 'GET',
        url: `${UPSTASH_MANAGEMENT_API}/redis/database/${DATABASE_ID}?credentials=hide`,
        body: {
          database_id: DATABASE_ID,
          database_name: 'my-cache',
          rest_token: 'secret',
          nested: { credentials: { password: 'nested-secret' } },
        },
      },
      'upstash_redis__get_database',
      { databaseId: DATABASE_ID },
    );
    expect(call.method).toBe('GET');
    expect(textOf(result)).toEqual({
      database_id: DATABASE_ID,
      database_name: 'my-cache',
      // A nested credential is dropped by its name too.
      nested: { credentials: {} },
    });
  });

  test('create_database POSTs /redis/database with name, region and the optional fields given', async () => {
    const { call } = await runManagement(
      {
        method: 'POST',
        url: `${UPSTASH_MANAGEMENT_API}/redis/database`,
        body: { database_id: 'new-db', database_name: 'test-db' },
      },
      'upstash_redis__create_database',
      { name: 'test-db', region: 'us-east-1', tls: true },
    );
    expect(call.json).toEqual({ name: 'test-db', region: 'us-east-1', tls: true });
    expect(call.headers['content-type']).toBe('application/json');
  });

  test('delete_database DELETEs /redis/database/{id}', async () => {
    const { call, result } = await runManagement(
      {
        method: 'DELETE',
        url: `${UPSTASH_MANAGEMENT_API}/redis/database/${DATABASE_ID}`,
        body: '"OK"',
      },
      'upstash_redis__delete_database',
      { databaseId: DATABASE_ID },
    );
    expect(call.body).toBeNull();
    expect((result.content[0] as { text: string }).text).toBe('OK');
  });

  test('rename_database POSTs /redis/rename/{id} with the new name', async () => {
    const { call } = await runManagement(
      {
        method: 'POST',
        url: `${UPSTASH_MANAGEMENT_API}/redis/rename/${DATABASE_ID}`,
        body: { database_name: 'new-name' },
      },
      'upstash_redis__rename_database',
      { databaseId: DATABASE_ID, name: 'new-name' },
    );
    expect(call.json).toEqual({ name: 'new-name' });
  });
});

describe('executeUpstashRedis — data tools build the Redis command', () => {
  test('del posts DEL with every key', async () => {
    expect(await commandOf('upstash_redis__del', { keys: ['key1', 'key2'] }, 2)).toEqual([
      'DEL',
      'key1',
      'key2',
    ]);
  });

  test('hset posts HSET with the field-value pairs flattened', async () => {
    expect(
      await commandOf(
        'upstash_redis__hset',
        { key: 'user:1', fields: { name: 'Alice', age: '30' } },
        2,
      ),
    ).toEqual(['HSET', 'user:1', 'name', 'Alice', 'age', '30']);
  });

  test('execute posts the raw command array unchanged', async () => {
    expect(await commandOf('upstash_redis__execute', { command: ['PING'] }, 'PONG')).toEqual([
      'PING',
    ]);
  });

  test('execute renders a finite number as text, exactly as the classifier read it', async () => {
    expect(await commandOf('upstash_redis__execute', { command: ['EXPIRE', 'k', 60] }, 1)).toEqual([
      'EXPIRE',
      'k',
      '60',
    ]);
  });

  test('execute refuses a command the classifier could not read as one command, before any network call', async () => {
    // `[["FLUSHALL"]]` used to be coerced to the single verb FLUSHALL after
    // being classified as something else : the executor now reads `command`
    // with the classifier's own function.
    for (const command of [
      [['FLUSHALL']],
      [
        ['GET', 'a'],
        ['DEL', 'a'],
      ],
      ['GET', ['k']],
      ['GET', { k: 1 }],
      ['GET', null],
      [42, 'k'],
      [''],
      [],
      'FLUSHALL',
      undefined,
    ]) {
      const fetch = mockFetch([]);
      const result = await upstashRedisPlugin.execute(ctx(fetch), 'upstash_redis__execute', {
        command,
      });
      expect(result.isError, JSON.stringify(command)).toBe(true);
      expect((result.content[0] as { text: string }).text).toMatch(/one Redis command/);
      expect(fetch.calls).toHaveLength(0);
    }
  });

  test('a database answer without a usable REST endpoint or token is an upstream failure, not a request', async () => {
    for (const body of [
      { database_id: DATABASE_ID, rest_url: 42, rest_token: 'tok' },
      { database_id: DATABASE_ID, rest_url: REST_URL, rest_token: { nested: true } },
      'not an object',
    ]) {
      const fetch = mockFetch([
        {
          method: 'GET',
          url: `${UPSTASH_MANAGEMENT_API}/redis/database/${DATABASE_ID}`,
          body,
          times: 1,
        },
      ]);
      // The provider's answer is unusable: an upstream failure, thrown for the host to record.
      await expect(
        upstashRedisPlugin.execute(ctx(fetch), 'upstash_redis__get', { key: 'k' }),
      ).rejects.toThrow(/REST endpoint\/token/);
      expect(fetch.calls).toHaveLength(1);
    }
  });

  test.each([
    ['another domain', { rest_url: 'https://collector.attacker.example' }],
    ['a look-alike suffix', { rest_url: 'https://us1-app-cache.upstash.io.attacker.example' }],
    ['a suffix without the dot', { rest_url: 'https://evilupstash.io' }],
    ['the bare suffix', { rest_url: 'https://upstash.io' }],
    ['a sub-domain chain', { rest_url: 'https://a.b.upstash.io' }],
    ['plain http', { rest_url: 'http://us1-app-cache.upstash.io' }],
    ['a port', { rest_url: 'https://us1-app-cache.upstash.io:8443' }],
    ['credentials in the URL', { rest_url: 'https://x:y@us1-app-cache.upstash.io' }],
    ['a host through userinfo', { rest_url: 'https://us1-app-cache.upstash.io@attacker.example' }],
    ['a path', { rest_url: 'https://us1-app-cache.upstash.io/pipeline' }],
    ['a query', { rest_url: 'https://us1-app-cache.upstash.io?x=1' }],
    ['a URL of another scheme', { rest_url: 'ftp://us1-app-cache.upstash.io' }],
    ['an empty label', { rest_url: 'https://.upstash.io' }],
    ['an endpoint on another domain', { endpoint: 'collector.attacker.example' }],
    ['an endpoint with a path', { endpoint: 'us1-app-cache.upstash.io/x' }],
    ['an endpoint with userinfo', { endpoint: 'us1-app-cache.upstash.io@attacker.example' }],
    ['an endpoint with a port', { endpoint: 'us1-app-cache.upstash.io:6379' }],
    ['an IP address', { endpoint: '169.254.169.254' }],
  ])(
    'the database token is never posted to %s: the call fails before any request',
    async (_what, where) => {
      const fetch = mockFetch([
        {
          method: 'GET',
          url: `${UPSTASH_MANAGEMENT_API}/redis/database/${DATABASE_ID}`,
          body: { database_id: DATABASE_ID, rest_token: 'tok-secret', ...where },
          times: 1,
        },
      ]);
      const attempt = upstashRedisPlugin.execute(ctx(fetch), 'upstash_redis__get', { key: 'k' });
      await expect(attempt).rejects.toThrow(/not an Upstash REST endpoint/);
      // The answer of the Management API was read; nothing else left the gateway.
      expect(fetch.calls).toHaveLength(1);
      await attempt.catch((error: unknown) => {
        expect(String(error)).not.toContain('tok-secret');
      });
    },
  );

  test.each([
    ['rest_url', { rest_url: 'https://us1-app-cache.upstash.io' }],
    ['rest_url in another case', { rest_url: 'https://US1-App-Cache.Upstash.IO/' }],
    ['a host in `endpoint`', { endpoint: 'us1-app-cache.upstash.io' }],
    ['a slug in `endpoint`', { endpoint: 'us1-app-cache' }],
  ])('posts to the Upstash host given as %s', async (_what, where) => {
    const fetch = mockFetch([
      {
        method: 'GET',
        url: `${UPSTASH_MANAGEMENT_API}/redis/database/${DATABASE_ID}`,
        body: { database_id: DATABASE_ID, rest_token: 'tok', ...where },
        times: 1,
      },
      { method: 'POST', url: REST_URL, body: { result: 'v' }, times: 1 },
    ]);
    const result = await upstashRedisPlugin.execute(ctx(fetch), 'upstash_redis__get', { key: 'k' });
    expect(result.isError).toBeUndefined();
    expect(fetch.pending()).toEqual([]);
    expect(fetch.calls[1]!.url).toBe(REST_URL);
  });
});

describe('upstash-redis plugin — declared tools', () => {
  test('exposes the 6 management tools and the 15 data tools', () => {
    expect(upstashRedisPlugin.tools.map((t) => t.name).sort()).toEqual(
      [
        // Management tools
        'upstash_redis__list_databases',
        'upstash_redis__get_database',
        'upstash_redis__create_database',
        'upstash_redis__delete_database',
        'upstash_redis__rename_database',
        'upstash_redis__get_database_stats',
        // Data tools
        'upstash_redis__execute',
        'upstash_redis__get',
        'upstash_redis__set',
        'upstash_redis__del',
        'upstash_redis__keys',
        'upstash_redis__scan',
        'upstash_redis__ttl',
        'upstash_redis__expire',
        'upstash_redis__hset',
        'upstash_redis__hgetall',
        'upstash_redis__lpush',
        'upstash_redis__lrange',
        'upstash_redis__sadd',
        'upstash_redis__smembers',
        'upstash_redis__dbsize',
      ].sort(),
    );
  });
});
