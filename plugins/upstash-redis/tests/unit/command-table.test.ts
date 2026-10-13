/**
 * Adversarial table of the generic `execute` tool : what each Redis command
 * costs, whichever spelling carries it.
 *
 * The rule under test : the same upstream command costs the same risk
 * whichever tool carries it, and a command the classifier cannot read is
 * never cheaper than the catch-all. Slices are compared in their serialized
 * form ; the risks they touch are checked through the engine in
 * `policy.test.ts`.
 */
import { describe, expect, test } from 'vitest';
import type { Resource } from '@vaubaan/plugin-sdk';
import { serializeSlice } from '@vaubaan/policy-engine';

import {
  classifyRedisCommands,
  classifyUpstashRedis,
  KNOWN_ADMIN,
  KNOWN_ARBITRARY,
  KNOWN_DELETES,
  KNOWN_DESTRUCTIVE,
  KNOWN_READS,
  KNOWN_WRITES,
  redisCommandClass,
  redisCommandOf,
  TRANSACTION_CONTROL,
  type RedisCommandClass,
} from '../../src/index.ts';

const database: Resource = { provider: 'upstash-redis', ref: 'db-1', displayName: 'db-1' };

const KS = 'upstash-redis.database[db-1].key-space';
const READ = `${KS}[*].R`;
const WRITE = `${KS}[*].W`;
const DELETE = `${KS}[*].delete.W`;
const FLUSH = `${KS}.flush.W`;
const ARBITRARY = `${KS}[*].execute.W`;

function execute(command: unknown): string[] {
  const out = classifyUpstashRedis('upstash_redis__execute', { command }, [database]);
  if ('denied' in out) throw new Error(`unexpected denial: ${out.denied}`);
  return out.slices.map(serializeSlice);
}

describe('the command table — every command sits in exactly one class', () => {
  const classes: ReadonlyArray<readonly [RedisCommandClass, ReadonlySet<string>]> = [
    ['read', KNOWN_READS],
    ['write', KNOWN_WRITES],
    ['delete', KNOWN_DELETES],
    ['flush', KNOWN_DESTRUCTIVE],
    ['arbitrary', KNOWN_ARBITRARY],
    ['admin', KNOWN_ADMIN],
  ];

  test('the six sets are pairwise disjoint', () => {
    const owner = new Map<string, string>();
    const twice: string[] = [];
    for (const [cls, verbs] of classes) {
      for (const verb of verbs) {
        const first = owner.get(verb);
        if (first !== undefined) twice.push(`${verb}: ${first} and ${cls}`);
        owner.set(verb, cls);
      }
    }
    expect(twice).toEqual([]);
  });

  test('every listed verb is upper-case and resolves to its own class when it stands alone', () => {
    for (const [cls, verbs] of classes) {
      for (const verb of verbs) {
        expect(verb).toBe(verb.toUpperCase());
        expect(redisCommandClass([verb]), verb).toBe(cls);
        expect(redisCommandClass([verb.toLowerCase()]), verb.toLowerCase()).toBe(cls);
      }
    }
  });

  test('no command that gives a key a time to live, or moves data out of a key, is a plain write', () => {
    // Orchestrator's decision of 2026-10-13 (finding B-M1): a one-second TTL and a
    // RENAME are deletions in all but name.
    const expiries = ['EXPIRE', 'PEXPIRE', 'HEXPIRE', 'HPEXPIRE', 'SETEX', 'PSETEX', 'GETEX'];
    const absolute = ['EXPIREAT', 'PEXPIREAT', 'HEXPIREAT', 'HPEXPIREAT'];
    const moves = ['RENAME', 'RENAMENX', 'LMOVE', 'RPOPLPUSH', 'BLMOVE', 'BRPOPLPUSH', 'SMOVE'];
    for (const verb of [...expiries, ...absolute, ...moves]) {
      expect(KNOWN_DELETES.has(verb), verb).toBe(true);
      expect(KNOWN_WRITES.has(verb), verb).toBe(false);
      expect(redisCommandClass([verb, 'a', 'b', '60']), verb).toBe('delete');
    }
  });

  test('no command that removes a key, a field, a member or an entry is a plain write or a read', () => {
    const removers = [
      'DEL',
      'UNLINK',
      'GETDEL',
      'GETEX',
      'EXPIREAT',
      'PEXPIREAT',
      'HDEL',
      'HGETDEL',
      'HEXPIREAT',
      'HPEXPIREAT',
      'LPOP',
      'RPOP',
      'LREM',
      'LTRIM',
      'BLPOP',
      'BRPOP',
      'LMPOP',
      'BLMPOP',
      'SREM',
      'SPOP',
      'ZREM',
      'ZREMRANGEBYRANK',
      'ZREMRANGEBYSCORE',
      'ZREMRANGEBYLEX',
      'ZPOPMIN',
      'ZPOPMAX',
      'BZPOPMIN',
      'BZPOPMAX',
      'ZMPOP',
      'BZMPOP',
      'XDEL',
      'XTRIM',
      'JSON.DEL',
      'JSON.FORGET',
      'JSON.CLEAR',
      'JSON.ARRPOP',
      'JSON.ARRTRIM',
      'SINTERSTORE',
      'SDIFFSTORE',
      'SUNIONSTORE',
      'ZRANGESTORE',
      'ZINTERSTORE',
      'ZUNIONSTORE',
      'ZDIFFSTORE',
      'GEOSEARCHSTORE',
      'BITOP',
    ];
    for (const verb of removers) {
      expect(KNOWN_READS.has(verb), `${verb} in KNOWN_READS`).toBe(false);
      expect(KNOWN_WRITES.has(verb), `${verb} in KNOWN_WRITES`).toBe(false);
      expect(KNOWN_DELETES.has(verb), `${verb} in KNOWN_DELETES`).toBe(true);
      expect(execute([verb, 'k']), verb).toEqual([DELETE]);
    }
  });

  test('scripting, modules and transaction control are arbitrary execution, never read or write', () => {
    for (const verb of [
      'EVAL',
      'EVALSHA',
      'EVAL_RO',
      'EVALSHA_RO',
      'FCALL',
      'FCALL_RO',
      'FUNCTION',
      'SCRIPT',
      'MODULE',
      'MULTI',
      'EXEC',
      'DISCARD',
      'WATCH',
      'UNWATCH',
    ]) {
      expect(KNOWN_ARBITRARY.has(verb), verb).toBe(true);
      expect(execute([verb, 'x']), verb).toEqual([ARBITRARY]);
    }
    for (const verb of TRANSACTION_CONTROL) expect(KNOWN_ARBITRARY.has(verb), verb).toBe(true);
  });

  test('server administration costs the catch-all', () => {
    for (const verb of ['CONFIG', 'ACL', 'SHUTDOWN', 'DEBUG', 'REPLICAOF', 'SWAPDB', 'MIGRATE']) {
      expect(KNOWN_ADMIN.has(verb), verb).toBe(true);
      expect(execute([verb, 'x']), verb).toEqual([ARBITRARY]);
    }
  });
});

describe('execute — one command', () => {
  const table: ReadonlyArray<readonly [string, unknown, readonly string[]]> = [
    // reads
    ['GET', ['GET', 'k'], [READ]],
    ['lower-case verb', ['hgetall', 'h'], [READ]],
    ['mixed-case verb', ['ScAn', '0'], [READ]],
    ['PING', ['PING'], [READ]],
    // writes
    ['SET', ['SET', 'k', 'v'], [WRITE]],
    ['SET that keeps the TTL it has', ['SET', 'k', 'v', 'KEEPTTL'], [WRITE]],
    ['SET with conditions only', ['SET', 'k', 'v', 'NX', 'GET'], [WRITE]],
    ['SET of a value that reads like an option', ['SET', 'k', 'EXAT'], [WRITE]],
    ['SET of a value that reads like a TTL option', ['SET', 'k', 'EX'], [WRITE]],
    ['PERSIST removes a TTL, nothing else', ['PERSIST', 'k'], [WRITE]],
    ['COPY leaves its source', ['COPY', 'a', 'b', 'REPLACE'], [WRITE]],
    ['XADD without trimming', ['XADD', 's', '*', 'f', 'v'], [WRITE]],
    ['SORT without STORE', ['SORT', 'l'], [WRITE]],
    ['GEORADIUS without STORE', ['GEORADIUS', 'g', '0', '0', '1', 'km'], [WRITE]],
    // deletes — the same command as the dedicated `del` tool
    ['DEL', ['DEL', 'k'], [DELETE]],
    ['DEL of several keys', ['DEL', 'a', 'b', 'c'], [DELETE]],
    ['del, lower case', ['del', 'k'], [DELETE]],
    ['UNLINK', ['UNLINK', 'k'], [DELETE]],
    ['GETDEL', ['GETDEL', 'k'], [DELETE]],
    // a time to live removes the key when it elapses : one second is a deletion
    ['SET with a relative TTL', ['SET', 'k', 'v', 'EX', '60'], [DELETE]],
    ['SET with a one-second TTL', ['SET', 'k', 'v', 'EX', '1'], [DELETE]],
    ['SET with a TTL in milliseconds, lower case', ['set', 'k', 'v', 'px', '1'], [DELETE]],
    ['SET with a TTL after other options', ['SET', 'k', 'v', 'NX', 'EX', '60'], [DELETE]],
    ['SETEX', ['SETEX', 'k', '1', 'v'], [DELETE]],
    ['PSETEX', ['PSETEX', 'k', '1', 'v'], [DELETE]],
    ['EXPIRE with a positive TTL', ['EXPIRE', 'k', '60'], [DELETE]],
    ['EXPIRE with a one-second TTL', ['EXPIRE', 'k', '1'], [DELETE]],
    ['EXPIRE with a numeric positive TTL', ['EXPIRE', 'k', 60], [DELETE]],
    ['PEXPIRE with a positive TTL', ['pexpire', 'k', '1500', 'NX'], [DELETE]],
    ['HEXPIRE with a positive TTL', ['HEXPIRE', 'h', '60', 'FIELDS', '1', 'f'], [DELETE]],
    // a move takes the key, or the element, out of its source
    ['RENAME', ['RENAME', 'a', 'b'], [DELETE]],
    ['RENAMENX', ['renamenx', 'a', 'b'], [DELETE]],
    ['LMOVE', ['LMOVE', 'a', 'b', 'LEFT', 'RIGHT'], [DELETE]],
    ['RPOPLPUSH', ['RPOPLPUSH', 'a', 'b'], [DELETE]],
    ['BLMOVE', ['BLMOVE', 'a', 'b', 'LEFT', 'RIGHT', '0'], [DELETE]],
    ['SMOVE', ['SMOVE', 'a', 'b', 'm'], [DELETE]],
    ['EXPIRE to zero', ['EXPIRE', 'k', '0'], [DELETE]],
    ['EXPIRE to zero, numeric', ['EXPIRE', 'k', 0], [DELETE]],
    ['EXPIRE negative', ['EXPIRE', 'k', '-1'], [DELETE]],
    ['EXPIRE with no TTL', ['EXPIRE', 'k'], [DELETE]],
    ['EXPIRE with an unreadable TTL', ['EXPIRE', 'k', ' 5'], [DELETE]],
    ['EXPIRE with a signed TTL', ['EXPIRE', 'k', '+5'], [DELETE]],
    ['EXPIRE with a fractional TTL', ['EXPIRE', 'k', 0.5], [DELETE]],
    ['EXPIRE with an exponent TTL', ['EXPIRE', 'k', 1e21], [DELETE]],
    ['PEXPIRE to zero', ['PEXPIRE', 'k', '0'], [DELETE]],
    ['HEXPIRE to zero', ['HEXPIRE', 'h', '0', 'FIELDS', '1', 'f'], [DELETE]],
    ['EXPIREAT (no clock : a past instant deletes)', ['EXPIREAT', 'k', '1'], [DELETE]],
    ['PEXPIREAT', ['PEXPIREAT', 'k', '9999999999999'], [DELETE]],
    ['SET with an absolute expiry', ['SET', 'k', 'v', 'EXAT', '1'], [DELETE]],
    ['SET with an absolute expiry, lower case', ['set', 'k', 'v', 'pxat', '1'], [DELETE]],
    ['XADD with MAXLEN', ['XADD', 's', 'MAXLEN', '0', '*', 'f', 'v'], [DELETE]],
    ['XADD with MINID', ['XADD', 's', 'minid', '~', '5', '*', 'f', 'v'], [DELETE]],
    ['SORT with STORE', ['SORT', 'l', 'STORE', 'victim'], [DELETE]],
    ['GEORADIUS with STORE', ['GEORADIUS', 'g', '0', '0', '1', 'km', 'store', 'victim'], [DELETE]],
    ['HDEL', ['HDEL', 'h', 'f'], [DELETE]],
    ['LPOP', ['LPOP', 'l'], [DELETE]],
    // flush
    ['FLUSHDB', ['FLUSHDB'], [FLUSH]],
    ['FLUSHALL ASYNC', ['flushall', 'ASYNC'], [FLUSH]],
    // arbitrary / admin / unknown
    ['EVAL', ['EVAL', "return redis.call('FLUSHALL')", '0'], [ARBITRARY]],
    ['CONFIG SET', ['CONFIG', 'SET', 'maxmemory', '0'], [ARBITRARY]],
    ['an unknown verb', ['FROBNICATE', 'k'], [ARBITRARY]],
    ['a verb with a trailing space', ['DEL ', 'k'], [ARBITRARY]],
    ['a verb with a leading space', [' GET', 'k'], [ARBITRARY]],
    ['two words in the verb', ['GET k'], [ARBITRARY]],
    ['a verb with a newline', ['GET\r\nFLUSHALL'], [ARBITRARY]],
    ['a dotless-i verb that upper-cases to INFO', ['ınfo'], [ARBITRARY]],
    ['a long-s verb that upper-cases to SET', ['ſet', 'k', 'v'], [ARBITRARY]],
    ['a sharp-s verb that upper-cases to two letters', ['flußhdb'], [ARBITRARY]],
    ['an empty verb', ['', 'GET', 'k'], [ARBITRARY]],
    ['an empty command', [], [ARBITRARY]],
    ['a numeric verb', [42, 'k'], [ARBITRARY]],
    ['a null verb', [null, 'GET'], [ARBITRARY]],
    ['an object verb', [{ toString: 'GET' }, 'k'], [ARBITRARY]],
    ['a read with an object argument', ['GET', { k: 1 }], [ARBITRARY]],
    ['a read with a null argument', ['GET', null], [ARBITRARY]],
    ['a read with a boolean argument', ['GET', true], [ARBITRARY]],
    ['a read with a NaN argument', ['GET', Number.NaN], [ARBITRARY]],
    ['a command given as a string', 'GET k', [ARBITRARY]],
    ['a command given as an object', { 0: 'GET', length: 1 }, [ARBITRARY]],
    ['a missing command', undefined, [ARBITRARY]],
    ['a null command', null, [ARBITRARY]],
    ['a mix of a command and a nested command', ['GET', ['FLUSHALL']], [ARBITRARY]],
  ];

  for (const [title, command, expected] of table) {
    test(`${title} -> ${expected.map((s) => s.slice(KS.length)).join(' + ')}`, () => {
      expect(execute(command)).toEqual(expected);
    });
  }
});

describe('execute — a pipeline or a MULTI / EXEC body costs the union of its commands', () => {
  const table: ReadonlyArray<readonly [string, unknown, readonly string[]]> = [
    ['one nested read', [['GET', 'k']], [READ]],
    ['a nested flush is a flush, not the catch-all it used to be', [['FLUSHALL']], [FLUSH]],
    [
      'reads and a write',
      [
        ['GET', 'a'],
        ['SET', 'b', 'v'],
        ['GET', 'c'],
      ],
      [READ, WRITE],
    ],
    [
      'a delete hidden behind reads',
      [
        ['GET', 'a'],
        ['GET', 'b'],
        ['del', 'c'],
      ],
      [READ, DELETE],
    ],
    [
      'every class at once, least severe first',
      [['EVAL', 'x', '0'], ['FLUSHDB'], ['DEL', 'k'], ['SET', 'k', 'v'], ['GET', 'k']],
      [READ, WRITE, DELETE, FLUSH, ARBITRARY],
    ],
    [
      'a transaction body : MULTI and EXEC add nothing to what they wrap',
      [['MULTI'], ['SET', 'k', 'v'], ['DEL', 'j'], ['EXEC']],
      [WRITE, DELETE],
    ],
    ['a transaction with no body', [['MULTI'], ['EXEC']], [ARBITRARY]],
    ['an unknown verb in the body', [['GET', 'k'], ['FROBNICATE']], [READ, ARBITRARY]],
    ['an unreadable command in the body', [['GET', 'k'], []], [READ, ARBITRARY]],
    ['a doubly nested command', [[['FLUSHALL']]], [ARBITRARY]],
    ['a body with a non-array entry', [['GET', 'k'], 'FLUSHALL'], [ARBITRARY]],
  ];

  for (const [title, command, expected] of table) {
    test(title, () => {
      expect(execute(command)).toEqual(expected);
    });
  }

  test('classifyRedisCommands returns the classes, deduplicated, least severe first', () => {
    expect(
      classifyRedisCommands([
        ['DEL', 'a'],
        ['GET', 'b'],
        ['UNLINK', 'c'],
      ]),
    ).toEqual(['read', 'delete']);
    expect(classifyRedisCommands([['CONFIG', 'GET', 'x'], ['EVAL', 'x', '0'], ['NOPE']])).toEqual([
      'arbitrary',
      'admin',
    ]);
    expect(classifyRedisCommands([])).toEqual(['arbitrary']);
  });
});

describe('the dedicated tools cost what the same command costs through execute', () => {
  const slicesOf = (tool: string, args: Record<string, unknown>) => {
    const out = classifyUpstashRedis(tool, args, [database]);
    if ('denied' in out) throw new Error(out.denied);
    return out.slices.map(serializeSlice);
  };

  test('del is the delete marker', () => {
    expect(slicesOf('upstash_redis__del', { keys: ['a', 'b'] })).toEqual(
      execute(['DEL', 'a', 'b']),
    );
  });

  test('set without a time to live is a write ; with one, the delete marker, like SET … EX through execute', () => {
    expect(slicesOf('upstash_redis__set', { key: 'k', value: 'v' })).toEqual([`${KS}[k].W`]);
    expect(slicesOf('upstash_redis__set', { key: 'k', value: 'v', nx: true })).toEqual([
      `${KS}[k].W`,
    ]);
    // Whatever the value: the executor appends EX / PX whenever the argument is present.
    for (const ttl of [60, 1, 0, -1, '60', null, 'soon', Number.NaN]) {
      for (const option of ['ex', 'px']) {
        expect(
          slicesOf('upstash_redis__set', { key: 'k', value: 'v', [option]: ttl }),
          `${option}=${String(ttl)}`,
        ).toEqual([`${KS}[k].delete.W`]);
      }
    }
    expect(execute(['SET', 'k', 'v', 'EX', '60'])).toEqual([`${KS}[*].delete.W`]);
  });

  test('expire is the delete marker whatever the TTL : positive, zero, negative, missing or unreadable', () => {
    for (const seconds of [60, 1, 0, -1, '0', '-5', undefined, null, 1.5, 'soon', Number.NaN]) {
      expect(slicesOf('upstash_redis__expire', { key: 'k', seconds }), String(seconds)).toEqual([
        `${KS}[k].delete.W`,
      ]);
    }
  });
});

describe('redisCommandOf — the one reading of `command` the classifier and the executor share', () => {
  test('a flat, non-empty array of strings and finite numbers, numbers rendered as text', () => {
    expect(redisCommandOf(['SET', 'k', 'v'])).toEqual(['SET', 'k', 'v']);
    expect(redisCommandOf(['EXPIRE', 'k', 60])).toEqual(['EXPIRE', 'k', '60']);
    expect(redisCommandOf(['SET', 'k', ''])).toEqual(['SET', 'k', '']);
  });

  test('anything else is unreadable', () => {
    for (const bad of [
      [],
      'GET k',
      null,
      undefined,
      [42, 'k'],
      [''],
      ['GET', null],
      ['GET', ['k']],
      ['GET', { k: 1 }],
      ['GET', true],
      ['GET', Number.POSITIVE_INFINITY],
      [['GET', 'k']],
    ]) {
      expect(redisCommandOf(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});
