/**
 * Classifier of the `upstash-redis` provider : `(tool, args, resources) → slices`.
 *
 * Spec     : docs/spec/gateway-risk-model.md §3, §7 ; docs/spec/vaubaan-gateway.md §10
 *            ("a classification error is a security hole").
 * Handbook : docs/handbook/providers/upstash-redis.md §2 (mapping), §3 (execute routing).
 *
 * Pure : no IO, no credential, no `Date`. Every known tool maps to exactly
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
 *   - keys are embedded as idents when slice-safe and replaced by `[*]`
 *     otherwise (glob patterns, multi-key DEL) — the catalog patterns match
 *     any ident there, so audit precision is all that is lost ;
 *   - `execute` is routed on its Redis verb : known reads → `R`, known
 *     writes → `W`, FLUSHDB / FLUSHALL → the `flush` marker, anything else →
 *     the `execute` marker (catch-all risk). A DEL through `execute` is a
 *     plain key-space write (the dedicated `del` tool carries the `delete`
 *     marker).
 */

import type { ClassifyOutcome, Resource, Slice, SliceSegment } from '@vaubaan/plugin-sdk';

export const PROVIDER = 'upstash-redis';

/**
 * Slice DSL ident characters (`slice-dsl.ts` bracket grammar). Database ids
 * are UUIDs ; Redis keys with `:` (`session:123`) are NOT slice-safe and
 * fall back to `[*]` — embedding them would produce slices the DSL cannot
 * parse back.
 */
const SAFE_IDENT = /^[a-zA-Z0-9_./~-]+$/;

/** Known Redis read commands (case-insensitive matching). */
export const KNOWN_READS: ReadonlySet<string> = new Set([
  'GET',
  'MGET',
  'KEYS',
  'SCAN',
  'TTL',
  'PTTL',
  'TYPE',
  'EXISTS',
  'HGET',
  'HGETALL',
  'HMGET',
  'HKEYS',
  'HVALS',
  'HLEN',
  'LRANGE',
  'LLEN',
  'LINDEX',
  'SMEMBERS',
  'SISMEMBER',
  'SCARD',
  'SRANDMEMBER',
  'ZRANGE',
  'ZSCORE',
  'ZRANK',
  'ZCARD',
  'ZRANGEBYSCORE',
  'DBSIZE',
  'STRLEN',
  'GETRANGE',
  'INFO',
  'PING',
]);

/** Known destructive Redis commands (whole key space). */
export const KNOWN_DESTRUCTIVE: ReadonlySet<string> = new Set(['FLUSHDB', 'FLUSHALL']);

/** Known Redis write commands. */
export const KNOWN_WRITES: ReadonlySet<string> = new Set([
  'SET',
  'DEL',
  'HSET',
  'LPUSH',
  'RPUSH',
  'SADD',
  'ZADD',
  'EXPIRE',
  'PEXPIRE',
  'SETEX',
  'SETNX',
  'INCR',
  'DECR',
  'APPEND',
  'MSET',
  'HDEL',
  'LREM',
  'LPOP',
  'RPOP',
  'SREM',
  'SPOP',
  'ZREM',
  'ZINCRBY',
  'INCRBY',
  'DECRBY',
  'GETSET',
  'PERSIST',
  'RENAME',
  'RENAMENX',
  'SORT',
]);

const ACCOUNT_TOOLS = new Set(['upstash_redis__list_databases', 'upstash_redis__create_database']);

const DATABASE_TOOLS = new Set([
  'upstash_redis__get_database',
  'upstash_redis__get_database_stats',
  'upstash_redis__delete_database',
  'upstash_redis__rename_database',
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
]);

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

const DATA_WRITES = new Set([
  'upstash_redis__set',
  'upstash_redis__hset',
  'upstash_redis__lpush',
  'upstash_redis__sadd',
  'upstash_redis__expire',
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

/** The `databaseId` argument (snake_case accepted), `undefined` when absent. */
function databaseArg(args: Readonly<Record<string, unknown>>): unknown {
  return args.databaseId ?? args.database_id;
}

/**
 * Resolve the database a call touches. The explicit argument wins and must be
 * one of the mission's Upstash databases ; absent, the mission's single
 * database applies ; anything else is a refusal.
 */
export function resolveDatabase(
  args: Readonly<Record<string, unknown>>,
  resources: readonly Resource[],
  required: boolean,
): { ref: string | null } | { denied: string } {
  const own = resources.filter((r) => r.provider === PROVIDER);
  const raw = databaseArg(args);
  if (raw !== undefined) {
    if (typeof raw !== 'string' || raw.length === 0 || !SAFE_IDENT.test(raw)) {
      return { denied: 'databaseId: malformed database ref' };
    }
    if (!own.some((r) => r.ref === raw)) {
      return { denied: `upstash-redis database '${raw}' is not a resource of this mission.` };
    }
    return { ref: raw };
  }
  if (!required) return { ref: null };
  if (own.length === 1) return { ref: own[0]!.ref };
  return {
    denied:
      own.length === 0
        ? 'databaseId: argument missing and the mission touches no Upstash database'
        : `databaseId: argument missing and the mission touches ${own.length} Upstash databases — name one`,
  };
}

/** The Redis verb of an `execute` call, upper-cased ; `''` when absent. */
export function redisVerbOf(args: Readonly<Record<string, unknown>>): string {
  const command = Array.isArray(args.command) ? (args.command as unknown[]) : [];
  const verb = command[0];
  return typeof verb === 'string' ? verb.toUpperCase() : '';
}

/**
 * Classify an Upstash Redis tool call into the slice it touches.
 */
export function classifyUpstashRedis(
  tool: string,
  args: Readonly<Record<string, unknown>>,
  resources: readonly Resource[],
): ClassifyOutcome {
  const isAccountTool = ACCOUNT_TOOLS.has(tool);
  if (!isAccountTool && !DATABASE_TOOLS.has(tool)) {
    return { denied: `unknown upstash-redis tool '${tool}'.` };
  }

  // Account tools accept a databaseId too (it is then checked, not used).
  const database = resolveDatabase(args, resources, !isAccountTool);
  if ('denied' in database) return database;
  const dbSeg: SliceSegment = database.ref !== null ? ident(database.ref) : ANY_IDENT;

  // ─── Data tools ────────────────────────────────────────────────────
  if (DATA_READS.has(tool)) {
    const keySeg = tool === 'upstash_redis__dbsize' ? ANY_IDENT : keyIdent(args.key);
    return { slices: [slice('R', [name('database'), dbSeg, name('key-space'), keySeg])] };
  }
  if (DATA_WRITES.has(tool)) {
    return {
      slices: [slice('W', [name('database'), dbSeg, name('key-space'), keyIdent(args.key)])],
    };
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
      return {
        slices: [slice('W', [name('database'), dbSeg, name('key-space'), keySeg, name('delete')])],
      };
    }

    // ─── Execute — routed on the Redis verb ──────────────────────────
    case 'upstash_redis__execute': {
      const verb = redisVerbOf(args);
      const keySpace = [name('database'), dbSeg, name('key-space')];
      if (KNOWN_READS.has(verb)) return { slices: [slice('R', [...keySpace, ANY_IDENT])] };
      if (KNOWN_DESTRUCTIVE.has(verb)) {
        return { slices: [slice('W', [...keySpace, name('flush')])] };
      }
      if (KNOWN_WRITES.has(verb)) return { slices: [slice('W', [...keySpace, ANY_IDENT])] };
      return { slices: [slice('W', [...keySpace, ANY_IDENT, name('execute')])] };
    }

    default:
      return { denied: `unknown upstash-redis tool '${tool}'.` };
  }
}

/** A key as an ident segment when slice-safe, `[*]` otherwise. */
function keyIdent(value: unknown): SliceSegment {
  if (typeof value === 'string' && value.length > 0 && SAFE_IDENT.test(value)) return ident(value);
  return ANY_IDENT;
}
