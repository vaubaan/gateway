/**
 * Unit tests for `classifyUpstashRedisV4` — the v4 risk-based classifier.
 *
 * Each test pins down :
 *   - the slice(s) emitted for a given (tool, args) call,
 *   - the execute tool's smart routing (read / write / destructive / unknown),
 *   - binding enforcement (denial for an unbound databaseId).
 */
import { describe, expect, test } from 'vitest';
import type { ProviderBinding } from '@vaubaan/shared';
import { serializeSlice } from '@vaubaan/policy-engine';

import { classifyUpstashRedisV4 } from '../../src/risk-classifier.ts';

const binding: ProviderBinding = {
  id: 'b1',
  project_id: 'p1',
  provider: 'upstash-redis',
  resource_ref: 'db-abc-123',
  display_name: null,
  created_at: '2026-01-01',
};

function classify(tool: string, args: Record<string, unknown> = {}) {
  const result = classifyUpstashRedisV4(tool, args, [binding]);
  if ('denied' in result) {
    throw new Error(`unexpected denial: ${result.denied}`);
  }
  return result.slices.map((s) => serializeSlice(s));
}

describe('classifyUpstashRedisV4 — management reads', () => {
  test('list_databases -> account.database[*].R', () => {
    expect(classify('upstash_redis__list_databases')).toEqual([
      'upstash-redis.account.database[*].R',
    ]);
  });

  test('get_database -> database[db-abc-123].R', () => {
    expect(classify('upstash_redis__get_database', { databaseId: 'db-abc-123' })).toEqual([
      'upstash-redis.database[db-abc-123].R',
    ]);
  });

  test('get_database_stats -> database[db-abc-123].stats.R', () => {
    expect(classify('upstash_redis__get_database_stats', { databaseId: 'db-abc-123' })).toEqual([
      'upstash-redis.database[db-abc-123].stats.R',
    ]);
  });
});

describe('classifyUpstashRedisV4 — management writes', () => {
  test('create_database -> account.database.W', () => {
    expect(
      classify('upstash_redis__create_database', { name: 'test', region: 'us-east-1' }),
    ).toEqual(['upstash-redis.account.database.W']);
  });

  test('delete_database -> account.database[db-abc-123].delete.W', () => {
    expect(classify('upstash_redis__delete_database', { databaseId: 'db-abc-123' })).toEqual([
      'upstash-redis.account.database[db-abc-123].delete.W',
    ]);
  });

  test('rename_database -> database[db-abc-123].credentials.W', () => {
    expect(
      classify('upstash_redis__rename_database', { databaseId: 'db-abc-123', name: 'new' }),
    ).toEqual(['upstash-redis.database[db-abc-123].credentials.W']);
  });
});

describe('classifyUpstashRedisV4 — data reads', () => {
  test('get -> database[db-abc-123].key-space[mykey].R', () => {
    expect(classify('upstash_redis__get', { databaseId: 'db-abc-123', key: 'mykey' })).toEqual([
      'upstash-redis.database[db-abc-123].key-space[mykey].R',
    ]);
  });

  test('keys -> database[db-abc-123].key-space[*].R (pattern not ident-safe)', () => {
    expect(
      classify('upstash_redis__keys', { databaseId: 'db-abc-123', pattern: 'user:*' }),
    ).toEqual(['upstash-redis.database[db-abc-123].key-space[*].R']);
  });

  test('scan -> database[db-abc-123].key-space[*].R', () => {
    expect(classify('upstash_redis__scan', { databaseId: 'db-abc-123', cursor: 0 })).toEqual([
      'upstash-redis.database[db-abc-123].key-space[*].R',
    ]);
  });

  test('ttl -> database[db-abc-123].key-space[mykey].R', () => {
    expect(classify('upstash_redis__ttl', { databaseId: 'db-abc-123', key: 'mykey' })).toEqual([
      'upstash-redis.database[db-abc-123].key-space[mykey].R',
    ]);
  });

  test('hgetall -> database[db-abc-123].key-space[myhash].R', () => {
    expect(classify('upstash_redis__hgetall', { databaseId: 'db-abc-123', key: 'myhash' })).toEqual(
      ['upstash-redis.database[db-abc-123].key-space[myhash].R'],
    );
  });

  test('lrange -> database[db-abc-123].key-space[mylist].R', () => {
    expect(
      classify('upstash_redis__lrange', {
        databaseId: 'db-abc-123',
        key: 'mylist',
        start: 0,
        stop: -1,
      }),
    ).toEqual(['upstash-redis.database[db-abc-123].key-space[mylist].R']);
  });

  test('smembers -> database[db-abc-123].key-space[myset].R', () => {
    expect(classify('upstash_redis__smembers', { databaseId: 'db-abc-123', key: 'myset' })).toEqual(
      ['upstash-redis.database[db-abc-123].key-space[myset].R'],
    );
  });

  test('dbsize -> database[db-abc-123].key-space[*].R', () => {
    expect(classify('upstash_redis__dbsize', { databaseId: 'db-abc-123' })).toEqual([
      'upstash-redis.database[db-abc-123].key-space[*].R',
    ]);
  });

  test('data read without explicit databaseId uses first binding', () => {
    expect(classify('upstash_redis__get', { key: 'mykey' })).toEqual([
      'upstash-redis.database[db-abc-123].key-space[mykey].R',
    ]);
  });
});

describe('classifyUpstashRedisV4 — data writes', () => {
  test('set -> database[db-abc-123].key-space[mykey].W', () => {
    expect(
      classify('upstash_redis__set', { databaseId: 'db-abc-123', key: 'mykey', value: 'v' }),
    ).toEqual(['upstash-redis.database[db-abc-123].key-space[mykey].W']);
  });

  test('hset -> database[db-abc-123].key-space[myhash].W', () => {
    expect(
      classify('upstash_redis__hset', {
        databaseId: 'db-abc-123',
        key: 'myhash',
        fields: { f: 'v' },
      }),
    ).toEqual(['upstash-redis.database[db-abc-123].key-space[myhash].W']);
  });

  test('lpush -> database[db-abc-123].key-space[mylist].W', () => {
    expect(
      classify('upstash_redis__lpush', {
        databaseId: 'db-abc-123',
        key: 'mylist',
        values: ['a'],
      }),
    ).toEqual(['upstash-redis.database[db-abc-123].key-space[mylist].W']);
  });

  test('sadd -> database[db-abc-123].key-space[myset].W', () => {
    expect(
      classify('upstash_redis__sadd', {
        databaseId: 'db-abc-123',
        key: 'myset',
        members: ['x'],
      }),
    ).toEqual(['upstash-redis.database[db-abc-123].key-space[myset].W']);
  });

  test('expire -> database[db-abc-123].key-space[mykey].W', () => {
    expect(
      classify('upstash_redis__expire', {
        databaseId: 'db-abc-123',
        key: 'mykey',
        seconds: 60,
      }),
    ).toEqual(['upstash-redis.database[db-abc-123].key-space[mykey].W']);
  });

  test('del -> database[db-abc-123].key-space[k1].delete.W', () => {
    expect(classify('upstash_redis__del', { databaseId: 'db-abc-123', keys: ['k1'] })).toEqual([
      'upstash-redis.database[db-abc-123].key-space[k1].delete.W',
    ]);
  });

  test('del with multiple keys -> database[db-abc-123].key-space[*].delete.W', () => {
    expect(
      classify('upstash_redis__del', { databaseId: 'db-abc-123', keys: ['k1', 'k2'] }),
    ).toEqual(['upstash-redis.database[db-abc-123].key-space[*].delete.W']);
  });
});

describe('classifyUpstashRedisV4 — execute smart routing', () => {
  test('execute with known read (GET) -> key-space[*].R', () => {
    expect(
      classify('upstash_redis__execute', { databaseId: 'db-abc-123', command: ['GET', 'k'] }),
    ).toEqual(['upstash-redis.database[db-abc-123].key-space[*].R']);
  });

  test('execute with known write (SET) -> key-space[*].W', () => {
    expect(
      classify('upstash_redis__execute', {
        databaseId: 'db-abc-123',
        command: ['SET', 'k', 'v'],
      }),
    ).toEqual(['upstash-redis.database[db-abc-123].key-space[*].W']);
  });

  test('execute with FLUSHDB -> key-space.flush.W', () => {
    expect(
      classify('upstash_redis__execute', { databaseId: 'db-abc-123', command: ['FLUSHDB'] }),
    ).toEqual(['upstash-redis.database[db-abc-123].key-space.flush.W']);
  });

  test('execute with FLUSHALL -> key-space.flush.W', () => {
    expect(
      classify('upstash_redis__execute', { databaseId: 'db-abc-123', command: ['FLUSHALL'] }),
    ).toEqual(['upstash-redis.database[db-abc-123].key-space.flush.W']);
  });

  test('execute with unknown command -> key-space[*].execute.W', () => {
    expect(
      classify('upstash_redis__execute', {
        databaseId: 'db-abc-123',
        command: ['CUSTOM_CMD', 'arg'],
      }),
    ).toEqual(['upstash-redis.database[db-abc-123].key-space[*].execute.W']);
  });

  test('execute is case-insensitive on command verb', () => {
    expect(
      classify('upstash_redis__execute', { databaseId: 'db-abc-123', command: ['get', 'k'] }),
    ).toEqual(['upstash-redis.database[db-abc-123].key-space[*].R']);
  });
});

describe('classifyUpstashRedisV4 — denials', () => {
  test('unknown tool -> denied', () => {
    const result = classifyUpstashRedisV4('upstash_redis__bogus', {}, [binding]);
    expect(result).toEqual({ denied: "unknown upstash-redis tool 'upstash_redis__bogus'." });
  });

  test('unbound databaseId -> denied', () => {
    const result = classifyUpstashRedisV4(
      'upstash_redis__get_database',
      { databaseId: 'db-unbound' },
      [binding],
    );
    expect(result).toEqual({
      denied: "upstash-redis database 'db-unbound' is not bound to this project.",
    });
  });
});
