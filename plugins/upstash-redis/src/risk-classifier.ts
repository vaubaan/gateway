/**
 * Upstash Redis v4 risk-based classifier — maps a concrete `(tool, args)`
 * call to the set of slices the runtime intersects with the risk catalog.
 *
 * Spec : docs/spec/gateway-risk-model.md §3, §7.
 *
 * The classifier distinguishes :
 *   - Management API reads  → account / database-level metadata slices
 *   - Management API writes → account-level mutation slices
 *   - Data API reads        → database.key-space read slices
 *   - Data API writes       → database.key-space write slices
 *   - `execute` tool        → smart routing based on the command verb
 */

import type { ProviderBinding, Slice, SliceSegment } from '@vaubaan/shared';

export type ClassifyResult = { slices: Slice[] } | { denied: string };

const PROVIDER = 'upstash-redis';

/** Known Redis read commands (case-insensitive matching). */
const KNOWN_READS = new Set([
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

/** Known destructive Redis commands. */
const KNOWN_DESTRUCTIVE = new Set(['FLUSHDB', 'FLUSHALL']);

/** Known Redis write commands. */
const KNOWN_WRITES = new Set([
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

/** Build a slice from its components. */
function slice(action: 'R' | 'W', segments: readonly SliceSegment[]): Slice {
  return { provider: PROVIDER, path: segments, action };
}

/** Convenience : a name segment (entity slug). */
function name(value: string): SliceSegment {
  return { kind: 'name', value };
}

/** Convenience : a bracketed identifier. */
function ident(value: string): SliceSegment {
  return { kind: 'ident', value };
}

/** Convenience : a `[*]` placeholder ident. */
const ANY_IDENT: SliceSegment = { kind: 'ident', value: '*' };

/** Read a `databaseId` arg uniformly. */
function databaseIdOf(args: Record<string, unknown>): string | null {
  const v = args.databaseId ?? args.database_id;
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/** The set of upstash-redis database refs currently bound. */
function boundDatabases(bindings: ReadonlyArray<ProviderBinding>): Set<string> {
  return new Set(bindings.filter((b) => b.provider === PROVIDER).map((b) => b.resource_ref));
}

/** Resolve the database id: from args, or from the first binding. */
function resolveDatabaseId(
  args: Record<string, unknown>,
  bindings: ReadonlyArray<ProviderBinding>,
): string | null {
  const explicit = databaseIdOf(args);
  if (explicit) return explicit;
  // For data tools that don't carry an explicit databaseId, use first binding.
  const first = bindings.find((b) => b.provider === PROVIDER);
  return first?.resource_ref ?? null;
}

/** Build the ident segment for a database id. */
function dbSeg(dbId: string | null): SliceSegment {
  return dbId !== null ? ident(dbId) : ANY_IDENT;
}

/** Extract a key ident from args. */
function keyIdentOf(args: Record<string, unknown>): SliceSegment {
  const v = args.key;
  if (typeof v === 'string' && v.length > 0 && /^[a-zA-Z0-9_:/-]+$/.test(v)) return ident(v);
  return ANY_IDENT;
}

/**
 * Classify an Upstash Redis tool call into the slice(s) it touches.
 */
export function classifyUpstashRedisV4(
  tool: string,
  args: Record<string, unknown>,
  bindings: ReadonlyArray<ProviderBinding>,
): ClassifyResult {
  // Binding check: if the args carry a databaseId, it must be one we hold.
  const explicitDbId = databaseIdOf(args);
  if (explicitDbId !== null) {
    if (!boundDatabases(bindings).has(explicitDbId)) {
      return { denied: `upstash-redis database '${explicitDbId}' is not bound to this project.` };
    }
  }

  switch (tool) {
    // ─── Management reads ────────────────────────────────────────────────

    case 'upstash_redis__list_databases':
      return { slices: [slice('R', [name('account'), name('database'), ANY_IDENT])] };

    case 'upstash_redis__get_database': {
      const dbId = databaseIdOf(args);
      return { slices: [slice('R', [name('database'), dbSeg(dbId)])] };
    }

    case 'upstash_redis__get_database_stats': {
      const dbId = databaseIdOf(args);
      return { slices: [slice('R', [name('database'), dbSeg(dbId), name('stats')])] };
    }

    // ─── Management writes ───────────────────────────────────────────────

    case 'upstash_redis__create_database':
      return { slices: [slice('W', [name('account'), name('database')])] };

    case 'upstash_redis__delete_database': {
      const dbId = databaseIdOf(args);
      return {
        slices: [slice('W', [name('account'), name('database'), dbSeg(dbId), name('delete')])],
      };
    }

    case 'upstash_redis__rename_database': {
      const dbId = databaseIdOf(args);
      return { slices: [slice('W', [name('database'), dbSeg(dbId), name('credentials')])] };
    }

    // ─── Data reads ──────────────────────────────────────────────────────

    case 'upstash_redis__get':
    case 'upstash_redis__keys':
    case 'upstash_redis__scan':
    case 'upstash_redis__ttl':
    case 'upstash_redis__hgetall':
    case 'upstash_redis__lrange':
    case 'upstash_redis__smembers':
    case 'upstash_redis__dbsize': {
      const dbId = resolveDatabaseId(args, bindings);
      const keySeg = tool === 'upstash_redis__dbsize' ? ANY_IDENT : keyIdentOf(args);
      return {
        slices: [slice('R', [name('database'), dbSeg(dbId), name('key-space'), keySeg])],
      };
    }

    // ─── Data writes ─────────────────────────────────────────────────────

    case 'upstash_redis__set':
    case 'upstash_redis__hset':
    case 'upstash_redis__lpush':
    case 'upstash_redis__sadd':
    case 'upstash_redis__expire': {
      const dbId = resolveDatabaseId(args, bindings);
      return {
        slices: [slice('W', [name('database'), dbSeg(dbId), name('key-space'), keyIdentOf(args)])],
      };
    }

    case 'upstash_redis__del': {
      const dbId = resolveDatabaseId(args, bindings);
      // DEL gets the `delete` marker so it matches the delete-data risk.
      const keys = Array.isArray(args.keys) ? (args.keys as string[]) : [];
      const keySeg =
        keys.length === 1 && /^[a-zA-Z0-9_:/-]+$/.test(keys[0]!) ? ident(keys[0]!) : ANY_IDENT;
      return {
        slices: [
          slice('W', [name('database'), dbSeg(dbId), name('key-space'), keySeg, name('delete')]),
        ],
      };
    }

    // ─── Execute — smart routing ─────────────────────────────────────────

    case 'upstash_redis__execute': {
      const dbId = resolveDatabaseId(args, bindings);
      const command = Array.isArray(args.command) ? (args.command as string[]) : [];
      const verb = (command[0] ?? '').toUpperCase();

      if (KNOWN_READS.has(verb)) {
        return {
          slices: [slice('R', [name('database'), dbSeg(dbId), name('key-space'), ANY_IDENT])],
        };
      }
      if (KNOWN_DESTRUCTIVE.has(verb)) {
        return {
          slices: [slice('W', [name('database'), dbSeg(dbId), name('key-space'), name('flush')])],
        };
      }
      if (KNOWN_WRITES.has(verb)) {
        return {
          slices: [slice('W', [name('database'), dbSeg(dbId), name('key-space'), ANY_IDENT])],
        };
      }
      // Unknown command → arbitrary execute fallback.
      return {
        slices: [
          slice('W', [
            name('database'),
            dbSeg(dbId),
            name('key-space'),
            ANY_IDENT,
            name('execute'),
          ]),
        ],
      };
    }

    default:
      return { denied: `unknown upstash-redis tool '${tool}'.` };
  }
}
