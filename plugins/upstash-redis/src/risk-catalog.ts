/**
 * Upstash Redis — risk catalog (TS export, 1:1 with `risk-catalog.yaml`).
 *
 * Spec : docs/spec/gateway-risk-model.md §4.
 *
 * The YAML sibling is the canonical reviewable form ; this TS module is
 * what the runtime imports (no YAML dep at runtime — Vercel does not bundle
 * `.yaml` files in the Lambda). Keep both in sync — a CI test in
 * `tests/unit/risk-catalog-sync.test.ts` diffs the two structures.
 *
 * 10 named risks + 1 fallback = 11 total.
 */

import type { RiskCatalog } from '@vaubaan/shared';

export const upstashRedisRiskCatalog: RiskCatalog = {
  provider: 'upstash-redis',
  risks: [
    // ─── READS ─────────────────────────────────────────────────────────────
    {
      id: 'upstash-redis.read-database-metadata',
      label: 'Read database list / details / stats (Management API reads)',
      reason:
        'Inventory of databases, their configuration, endpoints, and usage ' +
        'statistics. Surface of attack is negligible : metadata only, no ' +
        'data or credential leaks. This risk is the always-on baseline.',
      matches: 'upstash-redis.[**].R',
      vector: {
        reversibility: 'reversible',
        blast: 'single',
        data: 'metadata',
        cost: 'free',
        visibility: 'internal',
        persistence: 'stateless',
      },
    },
    {
      id: 'upstash-redis.read-data',
      label: 'Read Redis data (GET, KEYS, SCAN, HGETALL, LRANGE, SMEMBERS, TTL, DBSIZE)',
      reason:
        'Read operations on the key-value data stored in a database. May ' +
        'expose application secrets if stored in Redis (session tokens, ' +
        'cached credentials). Standard posture for a coding agent in debug ' +
        'mode.',
      matches: 'upstash-redis.database[**].key-space[**].R',
      vector: {
        reversibility: 'reversible',
        blast: 'single',
        data: 'data',
        cost: 'free',
        visibility: 'internal',
        persistence: 'stateless',
      },
    },

    // ─── WRITES — DATA ─────────────────────────────────────────────────────
    {
      id: 'upstash-redis.write-data',
      label: 'Write Redis data (SET, HSET, LPUSH, SADD, EXPIRE)',
      reason:
        'Write operations on individual keys. Reversible (overwrite or ' +
        'delete the key). Affects application state if the app reads from ' +
        'Redis at runtime.',
      matches: 'upstash-redis.database[**].key-space[**].W',
      vector: {
        reversibility: 'reversible',
        blast: 'single',
        data: 'data',
        cost: 'free',
        visibility: 'internal',
        persistence: 'session',
      },
    },
    {
      id: 'upstash-redis.delete-data',
      label: 'Delete specific keys (DEL)',
      reason:
        'Targeted deletion of one or more keys. Costly to reverse if the ' +
        'data is not backed up elsewhere. May break application state.',
      matches: 'upstash-redis.database[**].key-space[**].delete.W',
      vector: {
        reversibility: 'costly',
        blast: 'single',
        data: 'data',
        cost: 'free',
        visibility: 'internal',
        persistence: 'session',
      },
    },
    {
      id: 'upstash-redis.flush-database',
      label: 'FLUSHDB — mass data deletion via execute tool',
      reason:
        'FLUSHDB / FLUSHALL wipes all keys in the database. Irreversible ' +
        'without a backup. Only reachable via the generic `execute` tool ' +
        '(not exposed as a dedicated tool).',
      matches: 'upstash-redis.database[**].key-space.flush.W',
      vector: {
        reversibility: 'irreversible',
        blast: 'account',
        data: 'data',
        cost: 'free',
        visibility: 'internal',
        persistence: 'posture',
      },
    },
    {
      id: 'upstash-redis.execute-arbitrary',
      label: 'Generic execute — catch-all for uncategorized Redis commands',
      reason:
        'The `execute` tool can run any Redis command. When the command is ' +
        'not specifically categorized as a known read or write, it falls ' +
        'into this catch-all. Costly because the blast radius is unknown.',
      matches: 'upstash-redis.database[**].key-space[**].execute.W',
      vector: {
        reversibility: 'costly',
        blast: 'env',
        data: 'data',
        cost: 'free',
        visibility: 'internal',
        persistence: 'session',
      },
    },

    // ─── WRITES — MANAGEMENT ───────────────────────────────────────────────
    {
      id: 'upstash-redis.create-database',
      label: 'Create a new database (Management API)',
      reason:
        'Creates a new Redis database in the Upstash account. Reversible ' +
        '(can delete it). May incur costs if the account has a paid plan.',
      matches: 'upstash-redis.account.database.W',
      vector: {
        reversibility: 'reversible',
        blast: 'account',
        data: 'metadata',
        cost: 'moderate',
        visibility: 'internal',
        persistence: 'posture',
      },
    },
    {
      id: 'upstash-redis.delete-database',
      label: 'Delete an entire database (Management API)',
      reason:
        'Permanently deletes a Redis database and all its data. Irreversible ' +
        'without a backup. Equivalent to dropping a production data store.',
      matches: 'upstash-redis.account.database[**].delete.W',
      vector: {
        reversibility: 'irreversible',
        blast: 'account',
        data: 'data',
        cost: 'free',
        visibility: 'internal',
        persistence: 'posture',
      },
    },
    {
      id: 'upstash-redis.modify-database',
      label: 'Rename database (Management API)',
      reason:
        'Modifies database metadata (currently: rename). Rename can break ' +
        'any downstream reference that uses the old name. Classified as ' +
        'credentials touch because it affects the database identity.',
      matches: 'upstash-redis.database[**].credentials.W',
      vector: {
        reversibility: 'costly',
        blast: 'single',
        data: 'secret',
        cost: 'free',
        visibility: 'internal',
        persistence: 'posture',
      },
    },
    {
      id: 'upstash-redis.read-stats',
      label: 'Read usage statistics',
      reason:
        'Read-only access to database usage statistics (commands processed, ' +
        'memory usage, throughput). No data or credential exposure.',
      matches: 'upstash-redis.database[**].stats.R',
      vector: {
        reversibility: 'reversible',
        blast: 'single',
        data: 'metadata',
        cost: 'free',
        visibility: 'internal',
        persistence: 'stateless',
      },
    },

    // ─── FALLBACK (required) ───────────────────────────────────────────────
    {
      id: 'upstash-redis.uncategorized-write',
      label: 'Uncategorized Upstash Redis write',
      reason:
        'Catch-all for writes that have not been explicitly categorised. If ' +
        'observed in production, signals that a tool was added without a ' +
        'matching catalog entry — operators must opt in explicitly (no ' +
        'implicit accept).',
      matches: 'upstash-redis.[**].W',
      vector: {
        reversibility: 'costly',
        blast: 'env',
        data: 'data',
        cost: 'free',
        visibility: 'internal',
        persistence: 'session',
      },
    },
  ],
};
