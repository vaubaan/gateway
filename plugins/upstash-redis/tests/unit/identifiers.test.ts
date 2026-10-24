/**
 * Identifier positions of the `upstash-redis` plugin :
 *
 *   - the database ref (`databaseId` / `database_id`, or the mission's single
 *     database) is a segment of the Management API path : one grammar
 *     (`pathIdent`), one resolution (`resolveDatabase`), shared by `classify`
 *     and `execute` ;
 *   - Redis keys, patterns, values and the words of an `execute` command
 *     travel in the JSON body of a POST to the database's REST endpoint :
 *     they never reach a URL, so any string is a key. A key is embedded in a
 *     slice only when it is slice-safe (`keyIdent`), the glob otherwise.
 *
 * The cases are the ones that turn an identifier into something else : dot
 * segments (`encodeURIComponent` leaves them and URL parsers collapse them),
 * separators, percent-escapes, query and fragment delimiters, control
 * characters, an overlong value. A refused value reaches no request.
 */
import { describe, expect, test } from 'vitest';

import { serializeSlice, type ExecuteContext, type Resource } from '@vaubaan/plugin-sdk';
import { mockFetch, type MockFetch } from '@vaubaan/plugin-sdk/testing';

import { classifyUpstashRedis, pathIdent, resolveDatabase } from '../../src/classify.ts';
import { upstashRedisPlugin, UPSTASH_MANAGEMENT_API } from '../../src/index.ts';

const HOSTILE: readonly string[] = [
  '..',
  '.',
  'a/../b',
  'a/b',
  '%2e%2e',
  '%2f',
  '..%2f',
  'x'.repeat(5000),
  'db\nx',
  'db?x=1#y',
  'db\\x',
  'db 1',
  'a.b',
  '*',
  'db１',
];

const DATABASE_ID = '96ad0856-03b1-4ee7-9666-e81abd0349e1';
const REST_URL = 'https://us1-app-cache.upstash.io';

const database: Resource = {
  provider: 'upstash-redis',
  ref: DATABASE_ID,
  env: 'staging',
  displayName: 'app-cache',
};

/** An Upstash that answers anything : a refusal shows as "no call", not as a mock error. */
function permissiveFetch(): MockFetch {
  return mockFetch([
    {
      url: () => true,
      body: { database_id: DATABASE_ID, rest_url: REST_URL, rest_token: 'tok', result: 'OK' },
    },
  ]);
}

function ctx(fetch: MockFetch, resources: readonly Resource[] = [database]): ExecuteContext {
  return {
    credential: {
      kind: 'api-key',
      fields: { email: 'ops@acme.com', api_key: 'upstash_key_123' },
      metadata: {},
    },
    fetch,
    resources,
  };
}

function classify(
  tool: string,
  args: Record<string, unknown>,
  resources: readonly Resource[] = [database],
): string[] | { denied: string } {
  const outcome = classifyUpstashRedis(tool, args, resources);
  return 'denied' in outcome ? outcome : outcome.slices.map((s) => serializeSlice(s));
}

/** Tools that run on a database, with arguments that make the call well-formed. */
const DATABASE_TOOLS: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
  ['upstash_redis__get_database', {}],
  ['upstash_redis__delete_database', {}],
  ['upstash_redis__rename_database', { name: 'new-name' }],
  ['upstash_redis__get_database_stats', {}],
  ['upstash_redis__get', { key: 'k' }],
  ['upstash_redis__set', { key: 'k', value: 'v' }],
  ['upstash_redis__del', { keys: ['k'] }],
  ['upstash_redis__execute', { command: ['GET', 'k'] }],
];

/** Classify refuses with `reason` ; execute declines with it (an `isError` result) and sends nothing. */
async function expectRefused(
  tool: string,
  args: Record<string, unknown>,
  reason: string,
  resources: readonly Resource[] = [database],
): Promise<void> {
  const label = `${tool} ${JSON.stringify(args).slice(0, 80)}`;
  expect(classify(tool, args, resources), label).toEqual({ denied: reason });
  const fetch = permissiveFetch();
  const result = await upstashRedisPlugin.execute(ctx(fetch, resources), tool, args);
  expect(result.isError, label).toBe(true);
  expect((result.content[0] as { text: string }).text, label).toContain(reason);
  expect(fetch.calls, label).toHaveLength(0);
}

describe('the grammar of a database ref', () => {
  test('pathIdent accepts the ids Upstash issues and refuses anything else', () => {
    for (const id of [DATABASE_ID, 'db-abc-123', 'a'.repeat(64)]) expect(pathIdent(id)).toBe(id);
    for (const value of [...HOSTILE, '', 'a'.repeat(65), '~', 42, null, undefined, [DATABASE_ID]]) {
      expect(pathIdent(value)).toBeNull();
    }
  });

  test('resolveDatabase never returns a ref that is not one path segment', () => {
    for (const ref of HOSTILE) {
      const poisoned: Resource = { ...database, ref };
      for (const args of [{}, { databaseId: ref }, { database_id: ref }]) {
        expect(resolveDatabase(args, [poisoned], true)).toEqual({
          denied: 'databaseId: malformed database ref',
        });
      }
    }
  });
});

describe('the database — a segment of the Management API path', () => {
  for (const [tool, rest] of DATABASE_TOOLS) {
    test(`${tool} : a hostile databaseId is refused by classify and reaches no request`, async () => {
      for (const id of [...HOSTILE, '']) {
        await expectRefused(
          tool,
          { ...rest, databaseId: id },
          'databaseId: malformed database ref',
        );
        await expectRefused(
          tool,
          { ...rest, database_id: id },
          'databaseId: malformed database ref',
        );
      }
    });

    test(`${tool} : a hostile ref is refused even when the mission database carries it`, async () => {
      for (const ref of ['..', '.', 'a/../b', `${DATABASE_ID}/..`, '%2e%2e', 'a.b']) {
        const poisoned: Resource = { ...database, ref };
        for (const args of [rest, { ...rest, databaseId: ref }]) {
          await expectRefused(tool, args, 'databaseId: malformed database ref', [poisoned]);
        }
      }
    });

    test(`${tool} : a well-formed database outside the mission is refused by both`, async () => {
      await expectRefused(
        tool,
        { ...rest, databaseId: 'db-other' },
        "upstash-redis database 'db-other' is not a resource of this mission.",
      );
    });

    test(`${tool} : every Management API request names the database the slices name`, async () => {
      const args = { ...rest, databaseId: DATABASE_ID };
      const slices = classify(tool, args);
      expect(
        Array.isArray(slices) && slices.every((s) => s.includes(`database[${DATABASE_ID}]`)),
      ).toBe(true);
      const fetch = permissiveFetch();
      const result = await upstashRedisPlugin.execute(ctx(fetch), tool, args);
      expect(result.isError).toBeUndefined();
      const management = fetch.calls.filter((c) => c.url.startsWith(UPSTASH_MANAGEMENT_API));
      expect(management).toHaveLength(1);
      expect(management[0]!.url).toMatch(
        new RegExp(
          `^${UPSTASH_MANAGEMENT_API}/redis/(database|rename|stats)/${DATABASE_ID}(\\?credentials=hide)?$`,
        ),
      );
      // What a URL parser resolves is what was written : nothing is collapsed.
      expect(new URL(management[0]!.url).href).toBe(management[0]!.url);
    });
  }

  test('`databaseId` wins over `database_id`, for classify and execute alike', async () => {
    const other: Resource = { ...database, ref: 'db-other' };
    const args = { databaseId: DATABASE_ID, database_id: 'db-other' };
    expect(classify('upstash_redis__get_database', args, [database, other])).toEqual([
      `upstash-redis.database[${DATABASE_ID}].R`,
    ]);
    const fetch = permissiveFetch();
    await upstashRedisPlugin.execute(
      ctx(fetch, [database, other]),
      'upstash_redis__get_database',
      args,
    );
    expect(fetch.calls.map((c) => c.url)).toEqual([
      `${UPSTASH_MANAGEMENT_API}/redis/database/${DATABASE_ID}?credentials=hide`,
    ]);
  });

  test('account-level tools refuse a hostile databaseId too, without a request', async () => {
    for (const tool of ['upstash_redis__list_databases', 'upstash_redis__create_database']) {
      for (const id of HOSTILE) {
        await expectRefused(
          tool,
          { name: 'n', region: 'r', databaseId: id },
          'databaseId: malformed database ref',
        );
      }
    }
  });
});

describe('Redis keys and command words — the JSON body, never a URL', () => {
  const KEYS: readonly string[] = [...HOSTILE, 'session:123', 'k?x=1#y', '/', '?', '#'];

  test('any string is a key : it is sent as one element of the command array', async () => {
    for (const key of KEYS) {
      const fetch = permissiveFetch();
      const result = await upstashRedisPlugin.execute(ctx(fetch), 'upstash_redis__get', { key });
      expect(result.isError).toBeUndefined();
      expect(fetch.calls.map((c) => `${c.method} ${c.url}`)).toEqual([
        `GET ${UPSTASH_MANAGEMENT_API}/redis/database/${DATABASE_ID}`,
        `POST ${REST_URL}`,
      ]);
      expect(fetch.calls[1]!.json).toEqual(['GET', key]);
    }
  });

  test('every word of a command is sent in the body, verb included, exactly as classified', async () => {
    for (const key of KEYS) {
      for (const command of [
        ['SET', key, key],
        ['del', key],
        ['MGET', key, '..', '/'],
      ]) {
        const fetch = permissiveFetch();
        await upstashRedisPlugin.execute(ctx(fetch), 'upstash_redis__execute', { command });
        expect(fetch.calls[1]!.url).toBe(REST_URL);
        expect(fetch.calls[1]!.json).toEqual(command);
      }
    }
  });

  test('a verb that is not a command name is the catch-all, and is sent as given', async () => {
    for (const verb of [
      ' FLUSHALL',
      'FLUSHALL\n',
      'FLUSH\u0000ALL',
      'ＦＬＵＳＨＡＬＬ',
      '../FLUSHALL',
      'GET?x=1#y',
    ]) {
      expect(classify('upstash_redis__execute', { command: [verb] })).toEqual([
        `upstash-redis.database[${DATABASE_ID}].key-space[*].execute.W`,
      ]);
      const fetch = permissiveFetch();
      await upstashRedisPlugin.execute(ctx(fetch), 'upstash_redis__execute', { command: [verb] });
      expect(fetch.calls[1]!.url).toBe(REST_URL);
      expect(fetch.calls[1]!.json).toEqual([verb]);
    }
  });

  test('the case of a verb changes neither its class nor what is sent', async () => {
    for (const verb of ['flushall', 'FlushAll', 'FLUSHALL']) {
      expect(classify('upstash_redis__execute', { command: [verb] })).toEqual([
        `upstash-redis.database[${DATABASE_ID}].key-space.flush.W`,
      ]);
      const fetch = permissiveFetch();
      await upstashRedisPlugin.execute(ctx(fetch), 'upstash_redis__execute', { command: [verb] });
      expect(fetch.calls[1]!.json).toEqual([verb]);
    }
  });

  test('a key is embedded in a slice only when it is slice-safe and short ; the glob otherwise', () => {
    const root = `upstash-redis.database[${DATABASE_ID}].key-space`;
    expect(classify('upstash_redis__get', { key: 'user_42' })).toEqual([`${root}[user_42].R`]);
    for (const key of [
      'session:123',
      'a b',
      'k\nx',
      'k?x=1#y',
      '%2e%2e',
      '*',
      'x'.repeat(5000),
      '',
    ]) {
      expect(classify('upstash_redis__get', { key }), key.slice(0, 20)).toEqual([`${root}[*].R`]);
    }
  });

  test('keys and scan read the whole key space : a stray `key` argument names nothing', async () => {
    const root = `upstash-redis.database[${DATABASE_ID}].key-space`;
    expect(classify('upstash_redis__keys', { pattern: '*', key: 'harmless' })).toEqual([
      `${root}[*].R`,
    ]);
    expect(classify('upstash_redis__scan', { cursor: 0, key: 'harmless' })).toEqual([
      `${root}[*].R`,
    ]);
    const fetch = permissiveFetch();
    await upstashRedisPlugin.execute(ctx(fetch), 'upstash_redis__keys', {
      pattern: '*',
      key: 'harmless',
    });
    expect(fetch.calls[1]!.json).toEqual(['KEYS', '*']);
  });
});
