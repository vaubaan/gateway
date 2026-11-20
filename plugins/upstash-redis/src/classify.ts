/**
 * Classifier of the `upstash-redis` service : `(tool, args, resources) → slices`.
 *
 * Spec     : docs/spec/gateway-risk-model.md §3, §7 ; docs/spec/vaubaan-gateway.md §10
 *            ("a classification error is a security hole").
 * Handbook : docs/handbook/services/upstash-redis.md.
 *
 * Pure : no IO, no credential, no `Date`. A dedicated tool maps to exactly
 * one slice ; an unknown tool, a database the mission does not hold, or an
 * ambiguous database is `denied` — never mapped to a broad slice.
 *
 * Conventions :
 *   - the database ref comes from `databaseId` (or `database_id`), the id or
 *     the exact name of a resource of the mission, and the slice names its
 *     id ; absent, it falls back to the mission's single Upstash database,
 *     and is refused when the mission holds several ;
 *   - two account-level tools need no database (`list_databases`,
 *     `create_database`) but still refuse a foreign `databaseId` ;
 *     `list_databases` answers the mission's databases alone (`execute`),
 *     so its `account.database[*]` slice is an upper bound ;
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
 *   - **whatever makes data go away is a deletion**, at once or later : a
 *     key given a time to live (EXPIRE, SETEX, SET … EX) is removed when it
 *     elapses, and a move (RENAME, LMOVE, SMOVE…) takes a key or an element
 *     out of its source. All carry the `delete` marker, which the catalog
 *     prices as `write-data` AND `delete-data` : a mission that accepted
 *     writes alone cannot delete by setting a one-second TTL ;
 *   - a command the classifier cannot read (unknown verb, empty or
 *     non-string verb, an argument that is neither a string nor a finite
 *     number, a `command` that is not an array) is the `execute` marker,
 *     the catch-all risk — never a narrower class ;
 *   - a `command` made of commands (a pipeline, a MULTI / EXEC body) is
 *     classified command by command and costs the union of their classes.
 */

import {
  ANY_IDENT,
  isList,
  type ClassifyOutcome,
  type Resource,
  type Slice,
  type SliceSegment,
  PATH_IDENT,
  pathIdent,
} from '@vaubaan/plugin-sdk';

import { SERVICE_ID, TOOL } from './identity.ts';
import { ACCOUNT_TOOL_NAMES, DATA_TOOL_NAMES, MANAGEMENT_TOOL_NAMES } from './tools.ts';

/** The SDK's path identifier grammar, re-exported for this plugin's modules. */
export { PATH_IDENT, pathIdent };

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
 * Some of them turn into a deletion on some arguments — see `ESCALATIONS`.
 * No command here sets a time to live or moves data out of a key : those are
 * deletions (`KNOWN_DELETES`).
 */
export const KNOWN_WRITES: ReadonlySet<string> = new Set([
  // strings and keys
  'SET',
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
  'PERSIST',
  'COPY',
  'TOUCH',
  // hashes
  'HSET',
  'HSETNX',
  'HMSET',
  'HINCRBY',
  'HINCRBYFLOAT',
  'HPERSIST',
  // lists
  'LPUSH',
  'RPUSH',
  'LPUSHX',
  'RPUSHX',
  'LSET',
  'LINSERT',
  // sets and sorted sets
  'SADD',
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
 * Commands that remove a key, a field, a member or an entry, at once or
 * later — the `delete` marker of the dedicated `del` tool. Listed here as well :
 *   - **every expiry**, relative (`EXPIRE`, `PEXPIRE`, `HEXPIRE`, `HPEXPIRE`,
 *     `SETEX`, `PSETEX`) or absolute (`EXPIREAT`, `PEXPIREAT`, `HEXPIREAT`,
 *     `HPEXPIREAT`, `GETEX`) : the key or the field is gone when the time
 *     elapses, and a time of one second is a deletion in all but name ;
 *   - **the moves** (`RENAME`, `RENAMENX`, `LMOVE`, `RPOPLPUSH`, `BLMOVE`,
 *     `BRPOPLPUSH`, `SMOVE`) : the source key, or the element taken from it,
 *     is no longer where it was ;
 *   - the `*STORE` family and `BITOP` : an empty result deletes the
 *     destination key.
 */
export const KNOWN_DELETES: ReadonlySet<string> = new Set([
  // keys
  'DEL',
  'UNLINK',
  'GETDEL',
  'GETEX',
  'EXPIRE',
  'PEXPIRE',
  'EXPIREAT',
  'PEXPIREAT',
  'SETEX',
  'PSETEX',
  'RENAME',
  'RENAMENX',
  // hashes
  'HDEL',
  'HGETDEL',
  'HEXPIRE',
  'HPEXPIRE',
  'HEXPIREAT',
  'HPEXPIREAT',
  // lists
  'LMOVE',
  'RPOPLPUSH',
  'BLMOVE',
  'BRPOPLPUSH',
  'LPOP',
  'RPOP',
  'LREM',
  'LTRIM',
  'BLPOP',
  'BRPOP',
  'LMPOP',
  'BLMPOP',
  // sets
  'SMOVE',
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

function hasOption(args: readonly string[], from: number, options: ReadonlySet<string>): boolean {
  return args.slice(from).some((a) => options.has(a.toUpperCase()));
}

/** The options of `SET` that give the key a time to live, relative or absolute. */
const EXPIRY_OPTIONS: ReadonlySet<string> = new Set(['EX', 'PX', 'EXAT', 'PXAT']);
const STREAM_TRIM: ReadonlySet<string> = new Set(['MAXLEN', 'MINID']);
const STORE: ReadonlySet<string> = new Set(['STORE', 'STOREDIST']);

/** `STORE` writes the result to a key, and deletes that key when the result is empty. */
const storesResult = (command: readonly string[]): boolean => hasOption(command, 2, STORE);

/**
 * Writes that are a deletion on some arguments. Each predicate reads the
 * whole command (verb first) and answers "this one removes data" ; it errs
 * towards yes — an option name found where a value may sit is a deletion.
 */
const ESCALATIONS: Readonly<Record<string, (command: readonly string[]) => boolean>> = {
  // SET key value [options] : any expiry removes the key when it elapses.
  SET: (command) => hasOption(command, 3, EXPIRY_OPTIONS),
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
  if (!isList(value) || value.length === 0) return null;
  const words: string[] = [];
  for (const element of value) {
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
  // nosemgrep: unsafe-dynamic-method -- verb is in COMMAND_CLASS (checked above), upper-cased; the table is an own-property literal
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

const DATA_READS: ReadonlySet<string> = new Set([
  TOOL.get,
  TOOL.keys,
  TOOL.scan,
  TOOL.ttl,
  TOOL.hgetall,
  TOOL.lrange,
  TOOL.smembers,
  TOOL.dbsize,
]);

/** Reads that send no `key` : they cover the key space, so no argument names a member. */
const KEY_SPACE_READS: ReadonlySet<string> = new Set([TOOL.keys, TOOL.scan, TOOL.dbsize]);

const DATA_WRITES: ReadonlySet<string> = new Set([TOOL.set, TOOL.hset, TOOL.lpush, TOOL.sadd]);

function slice(action: 'R' | 'W', segments: readonly SliceSegment[]): Slice {
  return { service: SERVICE_ID, path: segments, action };
}

function name(value: string): SliceSegment {
  return { kind: 'name', value };
}

function ident(value: string): SliceSegment {
  return { kind: 'ident', value };
}

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
 * The explicit argument wins and must name one of the mission's Upstash
 * databases, by its id or by its name (the resource's display name, Upstash's
 * `database_name`, matched exactly) : the answer is always the resource's id,
 * a `pathIdent`, whichever branch found it — it is a segment of the
 * Management API path, and the name is never sent. A name two mission
 * databases share is refused, asking for the id. Absent, the mission's single
 * database applies ; anything else is a refusal that names the mission's
 * databases, so the agent can pick one.
 */
export function resolveDatabase(
  args: Readonly<Record<string, unknown>>,
  resources: readonly Resource[],
  required: boolean,
): { ref: string | null } | { denied: string } {
  const own = resources.filter((r) => r.service === SERVICE_ID);
  const given = databaseArg(args);
  if (given !== undefined) {
    const byRef = own.find((r) => r.ref === given);
    if (byRef !== undefined) return refOf(byRef);
    const byName = own.filter((r) => r.displayName === given);
    if (byName.length === 1) return refOf(byName[0]!);
    if (byName.length > 1) {
      return {
        denied: `databaseId: ${byName.length} Upstash databases of this mission are named '${String(given)}' — name one by its id. ${missionDatabasesHint(own)}`,
      };
    }
    const explicit = pathIdent(given);
    if (explicit === null) return { denied: MALFORMED_DATABASE };
    return {
      denied: `upstash-redis database '${explicit}' is not a resource of this mission. ${missionDatabasesHint(own)}`,
    };
  }
  if (!required) return { ref: null };
  if (own.length === 1) return refOf(own[0]!);
  return {
    denied:
      own.length === 0
        ? 'databaseId: argument missing and the mission touches no Upstash database'
        : `databaseId: argument missing and the mission touches ${own.length} Upstash databases — name one by its id or its name. ${missionDatabasesHint(own)}`,
  };
}

/** The resource's id as the call sends it : it reaches the request path like an argument does. */
function refOf(resource: Resource): { ref: string } | { denied: string } {
  const ref = pathIdent(resource.ref);
  return ref === null ? { denied: MALFORMED_DATABASE } : { ref };
}

/** Most databases a refusal names ; `list_databases` lists them all. */
const HINT_MAX_DATABASES = 10;

/** The mission's databases, as a refusal names them : `name (id)`. */
function missionDatabasesHint(own: readonly Resource[]): string {
  if (own.length === 0) return 'The mission holds no Upstash database of this account.';
  const shown = own.slice(0, HINT_MAX_DATABASES).map((r) => `${r.displayName} (${r.ref})`);
  const more =
    own.length > HINT_MAX_DATABASES ? `, and ${own.length - HINT_MAX_DATABASES} more` : '';
  return `Databases of this mission: ${shown.join(', ')}${more} — ${TOOL.listDatabases} lists them.`;
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
    // `set` with a time to live : the executor appends `EX` / `PX` whenever the
    // argument is present, whatever its value, and so does this reading.
    const expires = tool === TOOL.set && (args.ex !== undefined || args.px !== undefined);
    return { slices: [keySpaceSlice(expires ? 'delete' : 'write', dbSeg, keyIdent(args.key))] };
  }

  switch (tool) {
    // ─── Management reads ────────────────────────────────────────────
    case TOOL.listDatabases:
      return { slices: [slice('R', [name('account'), name('database'), ANY_IDENT])] };

    case TOOL.getDatabase:
      return { slices: [slice('R', [name('database'), dbSeg])] };

    case TOOL.getDatabaseStats:
      return { slices: [slice('R', [name('database'), dbSeg, name('stats')])] };

    // ─── Management writes ───────────────────────────────────────────
    case TOOL.createDatabase:
      return { slices: [slice('W', [name('account'), name('database')])] };

    case TOOL.deleteDatabase:
      return {
        slices: [slice('W', [name('account'), name('database'), dbSeg, name('delete')])],
      };

    case TOOL.renameDatabase:
      return { slices: [slice('W', [name('database'), dbSeg, name('credentials')])] };

    // ─── DEL : the `delete` marker ───────────────────────────────────
    case TOOL.del: {
      const keys = isList(args.keys) ? args.keys : [];
      const keySeg = keys.length === 1 ? keyIdent(keys[0]) : ANY_IDENT;
      return { slices: [keySpaceSlice('delete', dbSeg, keySeg)] };
    }

    // ─── EXPIRE : a deletion, now (a TTL of zero or less) or when it elapses ───
    case TOOL.expire:
      return { slices: [keySpaceSlice('delete', dbSeg, keyIdent(args.key))] };

    // ─── Execute — routed on the command table ───────────────────────
    case TOOL.execute: {
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
