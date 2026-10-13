/**
 * Classifier of the `upstash-redis` provider : `(tool, args, resources) → slices`.
 *
 * Spec     : docs/spec/gateway-risk-model.md §3, §7 ; docs/spec/vaubaan-gateway.md §10
 *            ("a classification error is a security hole").
 * Handbook : docs/handbook/providers/upstash-redis.md §2 (mapping), §3 (execute routing).
 *
 * Pure : no IO, no credential, no `Date`. A dedicated tool maps to exactly
 * one slice ; an unknown tool, a database the mission does not hold, or an
 * ambiguous database is `denied` — never mapped to a broad slice.
 *
 * Conventions :
 *   - the database ref comes from `databaseId` (or `database_id`) and must be
 *     a resource of the mission ; absent, it falls back to the mission's
 *     single Upstash database, and is refused when the mission holds several ;
 *   - two account-level tools need no database (`list_databases`,
 *     `create_database`) but still refuse a foreign `databaseId` ;
 *   - the environment is the owner's label on the database resource : the
 *     slice carries `database[<id>]`, which the host's default
 *     `resourceEnvResolver` maps to the label — no plugin hook needed ;
 *   - the database ref is a segment of the Management API path : it goes
 *     through `pathIdent` (one path segment, no dot, no separator), whether
 *     it comes from the argument or from the mission's single database, and
 *     `execute` resolves it with the same `resolveDatabase` ;
 *   - keys are embedded as idents when slice-safe and replaced by `[*]`
 *     otherwise (glob patterns, multi-key DEL) — the catalog patterns match
 *     any ident there, so audit precision is all that is lost. A key never
 *     reaches a URL : the command travels as a JSON array in the body ;
 *   - `keys`, `scan` and `dbsize` read the whole key space : `[*]`, whatever
 *     else the call carries ;
 *   - `execute` is routed on the Redis command it carries (the command
 *     table below) : every command belongs to exactly one class — read,
 *     write, delete, flush, arbitrary execution, administration — and the
 *     same command costs the same risk whichever tool carries it (a DEL
 *     through `execute` carries the `delete` marker of the `del` tool) ;
 *   - a command the classifier cannot read (unknown verb, empty or
 *     non-string verb, an argument that is neither a string nor a finite
 *     number, a `command` that is not an array) is the `execute` marker,
 *     the catch-all risk — never a narrower class ;
 *   - a `command` made of commands (a pipeline, a MULTI / EXEC body) is
 *     classified command by command and costs the union of their classes.
 */

import type { ClassifyOutcome, Resource, Slice, SliceSegment } from '@vaubaan/plugin-sdk';

import { ACCOUNT_TOOL_NAMES, DATA_TOOL_NAMES, MANAGEMENT_TOOL_NAMES } from './tools.ts';

export const PROVIDER = 'upstash-redis';

/**
 * A database ref (Upstash database ids are UUIDs) : one path segment, no dot,
 * no separator, no escape. It lands in a slice **and** in the Management API
 * path (`/redis/database/{id}`), so one grammar serves both. A wider class is
 * not safe for a URL : `encodeURIComponent` leaves `.` and `..` untouched and
 * every URL parser then removes them, so `/redis/database/..` would be sent
 * as `/redis/`. Anything outside the grammar is refused, never escaped.
 */
export const PATH_IDENT = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * The value as a path-safe identifier, or `null`. The one check `classify`
 * and `execute` share : what is classified is what is sent.
 */
export function pathIdent(value: unknown): string | null {
  return typeof value === 'string' && PATH_IDENT.test(value) ? value : null;
}

/**
 * A Redis key that may be embedded in a slice : slice DSL ident characters
 * (`slice-dsl.ts` bracket grammar), 128 at most. A key is never part of a
 * URL — the command travels as a JSON array — so this grammar decides only
 * what the audit shows : a key with `:` (`session:123`), a pattern or an
 * overlong key is NOT slice-safe and falls back to `[*]`.
 */
const KEY_IDENT = /^[a-zA-Z0-9_./~-]{1,128}$/;

// ─────────────────────────────────────────────────────────────────────────────
// The command table
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What a Redis command does to a database, least severe first. `arbitrary`
 * and `admin` both cost the catch-all risk (`execute-arbitrary`) ; they are
 * kept apart so the table says why a verb is there.
 */
export type RedisCommandClass = 'read' | 'write' | 'delete' | 'flush' | 'arbitrary' | 'admin';

/** Severity order of the classes ; also the order of the slices of a pipeline. */
const CLASS_ORDER: readonly RedisCommandClass[] = [
  'read',
  'write',
  'delete',
  'flush',
  'arbitrary',
  'admin',
];

/** Commands that change nothing (matched case-insensitively). */
export const KNOWN_READS: ReadonlySet<string> = new Set([
  // strings and keys
  'GET',
  'MGET',
  'STRLEN',
  'GETRANGE',
  'SUBSTR',
  'LCS',
  'EXISTS',
  'TYPE',
  'TTL',
  'PTTL',
  'EXPIRETIME',
  'PEXPIRETIME',
  'KEYS',
  'SCAN',
  'RANDOMKEY',
  'DBSIZE',
  'DUMP',
  'OBJECT',
  // hashes
  'HGET',
  'HMGET',
  'HGETALL',
  'HKEYS',
  'HVALS',
  'HLEN',
  'HEXISTS',
  'HSTRLEN',
  'HSCAN',
  'HRANDFIELD',
  'HTTL',
  'HPTTL',
  'HEXPIRETIME',
  'HPEXPIRETIME',
  // lists
  'LRANGE',
  'LLEN',
  'LINDEX',
  'LPOS',
  // sets
  'SMEMBERS',
  'SISMEMBER',
  'SMISMEMBER',
  'SCARD',
  'SRANDMEMBER',
  'SSCAN',
  'SDIFF',
  'SINTER',
  'SUNION',
  'SINTERCARD',
  // sorted sets
  'ZRANGE',
  'ZRANGEBYSCORE',
  'ZRANGEBYLEX',
  'ZREVRANGE',
  'ZREVRANGEBYSCORE',
  'ZREVRANGEBYLEX',
  'ZSCORE',
  'ZMSCORE',
  'ZRANK',
  'ZREVRANK',
  'ZCARD',
  'ZCOUNT',
  'ZLEXCOUNT',
  'ZSCAN',
  'ZRANDMEMBER',
  'ZDIFF',
  'ZINTER',
  'ZUNION',
  'ZINTERCARD',
  // bitmaps, HyperLogLog, geo
  'GETBIT',
  'BITCOUNT',
  'BITPOS',
  'BITFIELD_RO',
  'PFCOUNT',
  'GEOPOS',
  'GEODIST',
  'GEOHASH',
  'GEOSEARCH',
  'GEORADIUS_RO',
  'GEORADIUSBYMEMBER_RO',
  // streams
  'XRANGE',
  'XREVRANGE',
  'XLEN',
  'XREAD',
  'XPENDING',
  'XINFO',
  // JSON
  'JSON.GET',
  'JSON.MGET',
  'JSON.TYPE',
  'JSON.STRLEN',
  'JSON.ARRLEN',
  'JSON.OBJLEN',
  'JSON.OBJKEYS',
  'JSON.ARRINDEX',
  'JSON.RESP',
  // misc
  'SORT_RO',
  'INFO',
  'PING',
  'ECHO',
  'TIME',
]);

/**
 * Commands that create, overwrite or modify a value and remove nothing. An
 * overwrite destroys the previous value : that is what `write-data` accepts.
 * Four of them turn into a deletion on some arguments — see `ESCALATIONS`.
 */
export const KNOWN_WRITES: ReadonlySet<string> = new Set([
  // strings and keys
  'SET',
  'SETEX',
  'PSETEX',
  'SETNX',
  'MSET',
  'MSETNX',
  'GETSET',
  'APPEND',
  'SETRANGE',
  'INCR',
  'DECR',
  'INCRBY',
  'DECRBY',
  'INCRBYFLOAT',
  'EXPIRE',
  'PEXPIRE',
  'PERSIST',
  'RENAME',
  'RENAMENX',
  'COPY',
  'TOUCH',
  // hashes
  'HSET',
  'HSETNX',
  'HMSET',
  'HINCRBY',
  'HINCRBYFLOAT',
  'HEXPIRE',
  'HPEXPIRE',
  'HPERSIST',
  // lists
  'LPUSH',
  'RPUSH',
  'LPUSHX',
  'RPUSHX',
  'LSET',
  'LINSERT',
  'LMOVE',
  'RPOPLPUSH',
  'BLMOVE',
  'BRPOPLPUSH',
  // sets and sorted sets
  'SADD',
  'SMOVE',
  'ZADD',
  'ZINCRBY',
  // bitmaps, HyperLogLog, geo
  'SETBIT',
  'BITFIELD',
  'PFADD',
  'PFMERGE',
  'GEOADD',
  'GEORADIUS',
  'GEORADIUSBYMEMBER',
  // streams
  'XADD',
  // JSON
  'JSON.SET',
  'JSON.MSET',
  'JSON.NUMINCRBY',
  'JSON.NUMMULTBY',
  'JSON.STRAPPEND',
  'JSON.ARRAPPEND',
  'JSON.ARRINSERT',
  'JSON.TOGGLE',
  // misc
  'SORT',
]);

/**
 * Commands that remove a key, a field, a member or an entry — the `delete`
 * marker of the dedicated `del` tool. Listed here as well :
 *   - the absolute expiries (`EXPIREAT`, `PEXPIREAT`, `HEXPIREAT`,
 *     `HPEXPIREAT`, `GETEX`) : an instant in the past deletes at once, and
 *     the classifier has no clock to tell ;
 *   - the `*STORE` family and `BITOP` : an empty result deletes the
 *     destination key.
 */
export const KNOWN_DELETES: ReadonlySet<string> = new Set([
  // keys
  'DEL',
  'UNLINK',
  'GETDEL',
  'GETEX',
  'EXPIREAT',
  'PEXPIREAT',
  // hashes
  'HDEL',
  'HGETDEL',
  'HEXPIREAT',
  'HPEXPIREAT',
  // lists
  'LPOP',
  'RPOP',
  'LREM',
  'LTRIM',
  'BLPOP',
  'BRPOP',
  'LMPOP',
  'BLMPOP',
  // sets
  'SREM',
  'SPOP',
  'SDIFFSTORE',
  'SINTERSTORE',
  'SUNIONSTORE',
  // sorted sets
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
  'ZRANGESTORE',
  'ZDIFFSTORE',
  'ZINTERSTORE',
  'ZUNIONSTORE',
  // bitmaps, geo
  'BITOP',
  'GEOSEARCHSTORE',
  // streams
  'XDEL',
  'XTRIM',
  // JSON
  'JSON.DEL',
  'JSON.FORGET',
  'JSON.CLEAR',
  'JSON.ARRPOP',
  'JSON.ARRTRIM',
  'JSON.MERGE',
]);

/** Commands that wipe the whole key space — the `flush` marker. */
export const KNOWN_DESTRUCTIVE: ReadonlySet<string> = new Set(['FLUSHDB', 'FLUSHALL']);

/**
 * Transaction control. Alone, such a verb says nothing of what it commits
 * or queues, so it is arbitrary execution ; inside a body it adds nothing
 * to the commands it wraps, which are classified one by one.
 */
export const TRANSACTION_CONTROL: ReadonlySet<string> = new Set([
  'MULTI',
  'EXEC',
  'DISCARD',
  'WATCH',
  'UNWATCH',
]);

/**
 * Commands that run code or a sequence the classifier does not see :
 * scripts, functions, modules, transaction control. A script can delete or
 * flush ; the catch-all risk is what accepts that.
 */
export const KNOWN_ARBITRARY: ReadonlySet<string> = new Set([
  'EVAL',
  'EVALSHA',
  'EVAL_RO',
  'EVALSHA_RO',
  'FCALL',
  'FCALL_RO',
  'FUNCTION',
  'SCRIPT',
  'MODULE',
  ...TRANSACTION_CONTROL,
]);

/** Server, connection and replication administration. Costs the catch-all risk. */
export const KNOWN_ADMIN: ReadonlySet<string> = new Set([
  'ACL',
  'AUTH',
  'BGREWRITEAOF',
  'BGSAVE',
  'CLIENT',
  'CLUSTER',
  'COMMAND',
  'CONFIG',
  'DEBUG',
  'FAILOVER',
  'HELLO',
  'LASTSAVE',
  'LATENCY',
  'MEMORY',
  'MIGRATE',
  'MONITOR',
  'MOVE',
  'PSYNC',
  'QUIT',
  'REPLICAOF',
  'RESET',
  'RESTORE',
  'ROLE',
  'SAVE',
  'SELECT',
  'SHUTDOWN',
  'SLAVEOF',
  'SLOWLOG',
  'SWAPDB',
  'SYNC',
  'WAIT',
  'WAITAOF',
]);

/**
 * Verb → class, built once. A verb listed in two classes is a table error
 * and fails the import (that is, the gateway boot) rather than silently
 * taking whichever class was read last.
 */
const COMMAND_CLASS: ReadonlyMap<string, RedisCommandClass> = buildCommandTable([
  ['read', KNOWN_READS],
  ['write', KNOWN_WRITES],
  ['delete', KNOWN_DELETES],
  ['flush', KNOWN_DESTRUCTIVE],
  ['arbitrary', KNOWN_ARBITRARY],
  ['admin', KNOWN_ADMIN],
]);

function buildCommandTable(
  classes: ReadonlyArray<readonly [RedisCommandClass, ReadonlySet<string>]>,
): ReadonlyMap<string, RedisCommandClass> {
  const table = new Map<string, RedisCommandClass>();
  for (const [cls, verbs] of classes) {
    for (const verb of verbs) {
      const other = table.get(verb);
      if (other !== undefined) {
        throw new Error(`upstash-redis command table: '${verb}' is both ${other} and ${cls}.`);
      }
      table.set(verb, cls);
    }
  }
  return table;
}

/** A Redis command name : ASCII only, so upper-casing it cannot fold another script into a known verb. */
const VERB = /^[A-Za-z][A-Za-z0-9._-]*$/;

/** A strictly positive decimal integer, as Redis reads a relative TTL. */
const POSITIVE_INTEGER = /^[1-9][0-9]*$/;

function hasOption(args: readonly string[], from: number, options: ReadonlySet<string>): boolean {
  return args.slice(from).some((a) => options.has(a.toUpperCase()));
}

const ABSOLUTE_EXPIRY: ReadonlySet<string> = new Set(['EXAT', 'PXAT']);
const STREAM_TRIM: ReadonlySet<string> = new Set(['MAXLEN', 'MINID']);
const STORE: ReadonlySet<string> = new Set(['STORE', 'STOREDIST']);

/** A relative TTL (third word) that is not a strictly positive integer removes the key or the fields. */
const ttlRemoves = (command: readonly string[]): boolean =>
  !POSITIVE_INTEGER.test(command[2] ?? '');

/** `STORE` writes the result to a key, and deletes that key when the result is empty. */
const storesResult = (command: readonly string[]): boolean => hasOption(command, 2, STORE);

/**
 * Writes that are a deletion on some arguments. Each predicate reads the
 * whole command (verb first) and answers "this one removes data" ; it errs
 * towards yes — an option name found where a value may sit is a deletion.
 */
const ESCALATIONS: Readonly<Record<string, (command: readonly string[]) => boolean>> = {
  EXPIRE: ttlRemoves,
  PEXPIRE: ttlRemoves,
  HEXPIRE: ttlRemoves,
  HPEXPIRE: ttlRemoves,
  // SET key value [options] : an absolute expiry in the past deletes the key.
  SET: (command) => hasOption(command, 3, ABSOLUTE_EXPIRY),
  // XADD key [MAXLEN | MINID …] : trimming evicts entries.
  XADD: (command) => hasOption(command, 2, STREAM_TRIM),
  SORT: storesResult,
  GEORADIUS: storesResult,
  GEORADIUSBYMEMBER: storesResult,
};

/**
 * The one reading of a Redis command, shared by the classifier and the
 * executor so that what is classified is what is sent : a flat, non-empty
 * array whose first element is a non-empty string and whose other elements
 * are strings or finite numbers (rendered as text). `null` for anything
 * else — a nested array, an object, a boolean, `null`, a non-finite number.
 */
export function redisCommandOf(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const words: string[] = [];
  for (const element of value as readonly unknown[]) {
    if (typeof element === 'string') words.push(element);
    else if (typeof element === 'number' && Number.isFinite(element)) words.push(String(element));
    else return null;
  }
  if (typeof value[0] !== 'string' || value[0].length === 0) return null;
  return words;
}

/** The upper-cased verb of a readable command ; `''` when it is not a command name. */
function verbOf(command: readonly string[]): string {
  const verb = command[0] ?? '';
  return VERB.test(verb) ? verb.toUpperCase() : '';
}

/**
 * The class of one command (verb first, as `redisCommandOf` returns it).
 * A verb the table does not hold is `arbitrary` : the catch-all, never a
 * narrower class.
 */
export function redisCommandClass(command: readonly string[]): RedisCommandClass {
  const verb = verbOf(command);
  const cls = COMMAND_CLASS.get(verb);
  if (cls === undefined) return 'arbitrary';
  if (cls === 'write' && ESCALATIONS[verb]?.(command) === true) return 'delete';
  return cls;
}

/**
 * The classes of a pipeline or a MULTI / EXEC body : one class per command,
 * deduplicated, least severe first. An unreadable command is `arbitrary` ;
 * transaction-control verbs add nothing to the commands they wrap ; a body
 * with no command to classify (empty, or control verbs only) is `arbitrary`.
 */
export function classifyRedisCommands(commands: readonly unknown[]): RedisCommandClass[] {
  const found = new Set<RedisCommandClass>();
  for (const raw of commands) {
    const command = redisCommandOf(raw);
    if (command === null) {
      found.add('arbitrary');
      continue;
    }
    if (TRANSACTION_CONTROL.has(verbOf(command))) continue;
    found.add(redisCommandClass(command));
  }
  if (found.size === 0) return ['arbitrary'];
  return CLASS_ORDER.filter((cls) => found.has(cls));
}

/** The classes of the `command` argument of `execute` : one command, or a body of commands. */
function classesOfExecute(command: unknown): readonly RedisCommandClass[] {
  if (Array.isArray(command) && command.length > 0 && command.every((c) => Array.isArray(c))) {
    return classifyRedisCommands(command);
  }
  const single = redisCommandOf(command);
  return [single === null ? 'arbitrary' : redisCommandClass(single)];
}

/** The Redis verb of an `execute` call, upper-cased ; `''` when the command is unreadable. */
export function redisVerbOf(args: Readonly<Record<string, unknown>>): string {
  const command = redisCommandOf(args.command);
  return command === null ? '' : verbOf(command);
}

// ─────────────────────────────────────────────────────────────────────────────
// Slices
// ─────────────────────────────────────────────────────────────────────────────

const DATA_READS = new Set([
  'upstash_redis__get',
  'upstash_redis__keys',
  'upstash_redis__scan',
  'upstash_redis__ttl',
  'upstash_redis__hgetall',
  'upstash_redis__lrange',
  'upstash_redis__smembers',
  'upstash_redis__dbsize',
]);

/** Reads that send no `key` : they cover the key space, so no argument names a member. */
const KEY_SPACE_READS = new Set([
  'upstash_redis__keys',
  'upstash_redis__scan',
  'upstash_redis__dbsize',
]);

const DATA_WRITES = new Set([
  'upstash_redis__set',
  'upstash_redis__hset',
  'upstash_redis__lpush',
  'upstash_redis__sadd',
]);

function slice(action: 'R' | 'W', segments: readonly SliceSegment[]): Slice {
  return { provider: PROVIDER, path: segments, action };
}

function name(value: string): SliceSegment {
  return { kind: 'name', value };
}

function ident(value: string): SliceSegment {
  return { kind: 'ident', value };
}

/** Concrete placeholder for an unknown identifier : the matcher treats
 *  `ident('*')` on the concrete side as "any specific identifier". */
const ANY_IDENT: SliceSegment = { kind: 'ident', value: '*' };

/**
 * The key-space slice of a command class on a database. `arbitrary` and
 * `admin` share the `execute` marker ; a pipeline holding both yields it once.
 */
function keySpaceSlice(cls: RedisCommandClass, dbSeg: SliceSegment, keySeg: SliceSegment): Slice {
  const keySpace = [name('database'), dbSeg, name('key-space')];
  switch (cls) {
    case 'read':
      return slice('R', [...keySpace, keySeg]);
    case 'write':
      return slice('W', [...keySpace, keySeg]);
    case 'delete':
      return slice('W', [...keySpace, keySeg, name('delete')]);
    case 'flush':
      return slice('W', [...keySpace, name('flush')]);
    case 'arbitrary':
    case 'admin':
      return slice('W', [...keySpace, keySeg, name('execute')]);
  }
}

/** The `databaseId` argument (snake_case accepted), `undefined` when absent. */
export function databaseArg(args: Readonly<Record<string, unknown>>): unknown {
  return args.databaseId ?? args.database_id;
}

/** Refusal of a database ref that is not one path segment, shared with `execute`. */
const MALFORMED_DATABASE = 'databaseId: malformed database ref';

/**
 * Resolve the database a call touches, for `classify` and `execute` alike.
 * The explicit argument wins and must be one of the mission's Upstash
 * databases ; absent, the mission's single database applies ; anything else
 * is a refusal. The resolved ref is always a `pathIdent`, whichever branch
 * found it : it is a segment of the Management API path.
 */
export function resolveDatabase(
  args: Readonly<Record<string, unknown>>,
  resources: readonly Resource[],
  required: boolean,
): { ref: string | null } | { denied: string } {
  const own = resources.filter((r) => r.provider === PROVIDER);
  const raw = databaseArg(args);
  if (raw !== undefined) {
    const explicit = pathIdent(raw);
    if (explicit === null) return { denied: MALFORMED_DATABASE };
    if (!own.some((r) => r.ref === explicit)) {
      return { denied: `upstash-redis database '${explicit}' is not a resource of this mission.` };
    }
    return { ref: explicit };
  }
  if (!required) return { ref: null };
  if (own.length === 1) {
    const only = pathIdent(own[0]!.ref);
    return only === null ? { denied: MALFORMED_DATABASE } : { ref: only };
  }
  return {
    denied:
      own.length === 0
        ? 'databaseId: argument missing and the mission touches no Upstash database'
        : `databaseId: argument missing and the mission touches ${own.length} Upstash databases — name one`,
  };
}

/**
 * Classify an Upstash Redis tool call into the slice(s) it touches.
 */
export function classifyUpstashRedis(
  tool: string,
  args: Readonly<Record<string, unknown>>,
  resources: readonly Resource[],
): ClassifyOutcome {
  if (!MANAGEMENT_TOOL_NAMES.has(tool) && !DATA_TOOL_NAMES.has(tool)) {
    return { denied: `unknown upstash-redis tool '${tool}'.` };
  }

  // Account tools accept a databaseId too (it is then checked, not used).
  const database = resolveDatabase(args, resources, !ACCOUNT_TOOL_NAMES.has(tool));
  if ('denied' in database) return database;
  const dbSeg: SliceSegment = database.ref !== null ? ident(database.ref) : ANY_IDENT;

  // ─── Data tools ────────────────────────────────────────────────────
  if (DATA_READS.has(tool)) {
    const keySeg = KEY_SPACE_READS.has(tool) ? ANY_IDENT : keyIdent(args.key);
    return { slices: [keySpaceSlice('read', dbSeg, keySeg)] };
  }
  if (DATA_WRITES.has(tool)) {
    return { slices: [keySpaceSlice('write', dbSeg, keyIdent(args.key))] };
  }

  switch (tool) {
    // ─── Management reads ────────────────────────────────────────────
    case 'upstash_redis__list_databases':
      return { slices: [slice('R', [name('account'), name('database'), ANY_IDENT])] };

    case 'upstash_redis__get_database':
      return { slices: [slice('R', [name('database'), dbSeg])] };

    case 'upstash_redis__get_database_stats':
      return { slices: [slice('R', [name('database'), dbSeg, name('stats')])] };

    // ─── Management writes ───────────────────────────────────────────
    case 'upstash_redis__create_database':
      return { slices: [slice('W', [name('account'), name('database')])] };

    case 'upstash_redis__delete_database':
      return {
        slices: [slice('W', [name('account'), name('database'), dbSeg, name('delete')])],
      };

    case 'upstash_redis__rename_database':
      return { slices: [slice('W', [name('database'), dbSeg, name('credentials')])] };

    // ─── DEL : the `delete` marker ───────────────────────────────────
    case 'upstash_redis__del': {
      const keys = Array.isArray(args.keys) ? (args.keys as unknown[]) : [];
      const keySeg = keys.length === 1 ? keyIdent(keys[0]) : ANY_IDENT;
      return { slices: [keySpaceSlice('delete', dbSeg, keySeg)] };
    }

    // ─── EXPIRE : a write, a deletion when the TTL is not positive ───
    // The executor sends `String(args.seconds)` ; the same text is classified.
    case 'upstash_redis__expire': {
      const cls = redisCommandClass(['EXPIRE', 'key', String(args.seconds)]);
      return { slices: [keySpaceSlice(cls, dbSeg, keyIdent(args.key))] };
    }

    // ─── Execute — routed on the command table ───────────────────────
    case 'upstash_redis__execute': {
      const slices: Slice[] = [];
      const seen = new Set<string>();
      for (const cls of classesOfExecute(args.command)) {
        const marker = cls === 'admin' ? 'arbitrary' : cls;
        if (seen.has(marker)) continue;
        seen.add(marker);
        slices.push(keySpaceSlice(cls, dbSeg, ANY_IDENT));
      }
      return { slices };
    }

    default:
      return { denied: `unknown upstash-redis tool '${tool}'.` };
  }
}

/** A key as an ident segment when slice-safe, `[*]` otherwise. */
function keyIdent(value: unknown): SliceSegment {
  if (typeof value === 'string' && KEY_IDENT.test(value)) return ident(value);
  return ANY_IDENT;
}
