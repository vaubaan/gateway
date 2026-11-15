/**
 * MCP tools of the `upstash-redis` service — all custom, no upstream MCP
 * server to rewrap.
 *
 * Handbook : docs/handbook/services/upstash-redis.md.
 *
 * 21 tools :
 *   - 6 management tools (Management API, api.upstash.com/v2, Basic auth) ;
 *   - 15 data tools (per-database REST endpoint, Bearer token).
 *
 * Names are `TOOL` (`identity.ts`), prefixed `upstash_redis__` (the SDK
 * prefix rule : `-` → `_`, then `__`). Every database-scoped tool takes the database id as the
 * explicit `databaseId` argument, which must be a resource of the mission ;
 * absent, the mission's single Upstash database applies.
 */

import type { McpToolDeclaration } from '@vaubaan/plugin-sdk';

import { TOOL } from './identity.ts';

// ─── Management tools ────────────────────────────────────────────────────────

const MANAGEMENT_TOOLS: readonly McpToolDeclaration[] = [
  {
    name: TOOL.listDatabases,
    description:
      'List all Redis databases in the Upstash account. Backed by GET /v2/redis/databases.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: TOOL.getDatabase,
    description:
      'Get details of a specific Redis database (name, endpoint, region, state, etc.). Backed by GET /v2/redis/database/{id}.',
    inputSchema: {
      type: 'object',
      properties: {
        databaseId: {
          type: 'string',
          description: 'The Upstash database id.',
        },
      },
      required: ['databaseId'],
    },
  },
  {
    name: TOOL.createDatabase,
    description: 'Create a new Redis database. Backed by POST /v2/redis/database.',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Name for the new database.',
        },
        region: {
          type: 'string',
          description: 'Primary region (e.g. "us-east-1", "eu-west-1").',
        },
        primary_region: {
          type: 'string',
          description: 'Primary region for global databases (optional, overrides region).',
        },
        read_regions: {
          type: 'array',
          items: { type: 'string' },
          description: 'Additional read regions for global databases.',
        },
        tls: {
          type: 'boolean',
          description: 'Enable TLS (default true).',
        },
        eviction: {
          type: 'boolean',
          description: 'Enable eviction when memory is full.',
        },
      },
      required: ['name', 'region'],
    },
  },
  {
    name: TOOL.deleteDatabase,
    description: 'Delete a Redis database permanently. Backed by DELETE /v2/redis/database/{id}.',
    inputSchema: {
      type: 'object',
      properties: {
        databaseId: {
          type: 'string',
          description: 'The Upstash database id to delete.',
        },
      },
      required: ['databaseId'],
    },
  },
  {
    name: TOOL.renameDatabase,
    description: 'Rename a Redis database. Backed by POST /v2/redis/rename/{id}.',
    inputSchema: {
      type: 'object',
      properties: {
        databaseId: {
          type: 'string',
          description: 'The Upstash database id to rename.',
        },
        name: {
          type: 'string',
          description: 'The new name for the database.',
        },
      },
      required: ['databaseId', 'name'],
    },
  },
  {
    name: TOOL.getDatabaseStats,
    description: 'Get usage statistics for a Redis database. Backed by GET /v2/redis/stats/{id}.',
    inputSchema: {
      type: 'object',
      properties: {
        databaseId: {
          type: 'string',
          description: 'The Upstash database id.',
        },
      },
      required: ['databaseId'],
    },
  },
];

// ─── Data tools ──────────────────────────────────────────────────────────────

const DATA_TOOLS: readonly McpToolDeclaration[] = [
  {
    name: TOOL.execute,
    description:
      'Execute one generic Redis command. The command is an array of strings (e.g. ["SET", "key", "value"]). Use this for commands not covered by specific tools. The command is authorized as what it does: a read, a write, a deletion (DEL, UNLINK, EXPIRE with a TTL of 0…), a flush, or — for scripts, administration and any command the gateway does not know — arbitrary execution.',
    inputSchema: {
      type: 'object',
      properties: {
        databaseId: {
          type: 'string',
          description:
            'The Upstash database id — a resource of the mission. Defaults to the single database of the mission.',
        },
        command: {
          type: 'array',
          items: { type: 'string' },
          description: 'Redis command as an array of strings (e.g. ["SET", "mykey", "myvalue"]).',
        },
      },
      required: ['command'],
    },
  },
  {
    name: TOOL.get,
    description: 'GET a key from Redis. Returns the value or null if the key does not exist.',
    inputSchema: {
      type: 'object',
      properties: {
        databaseId: {
          type: 'string',
          description:
            'The Upstash database id — a resource of the mission. Defaults to the single database of the mission.',
        },
        key: {
          type: 'string',
          description: 'The Redis key to retrieve.',
        },
      },
      required: ['key'],
    },
  },
  {
    name: TOOL.set,
    description: 'SET a key in Redis with optional TTL and conditional flags.',
    inputSchema: {
      type: 'object',
      properties: {
        databaseId: {
          type: 'string',
          description:
            'The Upstash database id — a resource of the mission. Defaults to the single database of the mission.',
        },
        key: {
          type: 'string',
          description: 'The Redis key to set.',
        },
        value: {
          type: 'string',
          description: 'The value to store.',
        },
        ex: {
          type: 'number',
          description: 'TTL in seconds.',
        },
        px: {
          type: 'number',
          description: 'TTL in milliseconds.',
        },
        nx: {
          type: 'boolean',
          description: 'Only set if the key does not already exist.',
        },
        xx: {
          type: 'boolean',
          description: 'Only set if the key already exists.',
        },
      },
      required: ['key', 'value'],
    },
  },
  {
    name: TOOL.del,
    description: 'DEL one or more keys from Redis.',
    inputSchema: {
      type: 'object',
      properties: {
        databaseId: {
          type: 'string',
          description:
            'The Upstash database id — a resource of the mission. Defaults to the single database of the mission.',
        },
        keys: {
          type: 'array',
          items: { type: 'string' },
          description: 'Array of Redis keys to delete.',
        },
      },
      required: ['keys'],
    },
  },
  {
    name: TOOL.keys,
    description: 'KEYS — find all keys matching a glob-style pattern.',
    inputSchema: {
      type: 'object',
      properties: {
        databaseId: {
          type: 'string',
          description:
            'The Upstash database id — a resource of the mission. Defaults to the single database of the mission.',
        },
        pattern: {
          type: 'string',
          description: 'Glob-style pattern (e.g. "user:*").',
        },
      },
      required: ['pattern'],
    },
  },
  {
    name: TOOL.scan,
    description:
      'SCAN — incrementally iterate through the key space. Returns a cursor and a list of keys.',
    inputSchema: {
      type: 'object',
      properties: {
        databaseId: {
          type: 'string',
          description:
            'The Upstash database id — a resource of the mission. Defaults to the single database of the mission.',
        },
        cursor: {
          type: 'number',
          description: 'Cursor position (start with 0).',
        },
        match: {
          type: 'string',
          description: 'Optional glob-style pattern to filter keys.',
        },
        count: {
          type: 'number',
          description: 'Hint for how many keys to return per iteration.',
        },
      },
      required: ['cursor'],
    },
  },
  {
    name: TOOL.ttl,
    description:
      'TTL — get the time-to-live of a key in seconds. Returns -1 if no TTL, -2 if key does not exist.',
    inputSchema: {
      type: 'object',
      properties: {
        databaseId: {
          type: 'string',
          description:
            'The Upstash database id — a resource of the mission. Defaults to the single database of the mission.',
        },
        key: {
          type: 'string',
          description: 'The Redis key.',
        },
      },
      required: ['key'],
    },
  },
  {
    name: TOOL.expire,
    description:
      'EXPIRE — set a timeout on a key in seconds. The key is removed when it elapses (at once for a TTL of 0 or less), so the call is authorized as a deletion, whatever the TTL.',
    inputSchema: {
      type: 'object',
      properties: {
        databaseId: {
          type: 'string',
          description:
            'The Upstash database id — a resource of the mission. Defaults to the single database of the mission.',
        },
        key: {
          type: 'string',
          description: 'The Redis key.',
        },
        seconds: {
          type: 'number',
          description: 'TTL in seconds.',
        },
      },
      required: ['key', 'seconds'],
    },
  },
  {
    name: TOOL.hset,
    description: 'HSET — set one or more field-value pairs in a hash.',
    inputSchema: {
      type: 'object',
      properties: {
        databaseId: {
          type: 'string',
          description:
            'The Upstash database id — a resource of the mission. Defaults to the single database of the mission.',
        },
        key: {
          type: 'string',
          description: 'The Redis hash key.',
        },
        fields: {
          type: 'object',
          description: 'Object of field-value pairs to set (e.g. {"name": "Alice", "age": "30"}).',
        },
      },
      required: ['key', 'fields'],
    },
  },
  {
    name: TOOL.hgetall,
    description: 'HGETALL — get all field-value pairs from a hash.',
    inputSchema: {
      type: 'object',
      properties: {
        databaseId: {
          type: 'string',
          description:
            'The Upstash database id — a resource of the mission. Defaults to the single database of the mission.',
        },
        key: {
          type: 'string',
          description: 'The Redis hash key.',
        },
      },
      required: ['key'],
    },
  },
  {
    name: TOOL.lpush,
    description: 'LPUSH — prepend one or more values to a list.',
    inputSchema: {
      type: 'object',
      properties: {
        databaseId: {
          type: 'string',
          description:
            'The Upstash database id — a resource of the mission. Defaults to the single database of the mission.',
        },
        key: {
          type: 'string',
          description: 'The Redis list key.',
        },
        values: {
          type: 'array',
          items: { type: 'string' },
          description: 'Values to prepend to the list.',
        },
      },
      required: ['key', 'values'],
    },
  },
  {
    name: TOOL.lrange,
    description: 'LRANGE — get a range of elements from a list.',
    inputSchema: {
      type: 'object',
      properties: {
        databaseId: {
          type: 'string',
          description:
            'The Upstash database id — a resource of the mission. Defaults to the single database of the mission.',
        },
        key: {
          type: 'string',
          description: 'The Redis list key.',
        },
        start: {
          type: 'number',
          description: 'Start index (0-based, negative for offset from end).',
        },
        stop: {
          type: 'number',
          description: 'Stop index (inclusive, negative for offset from end).',
        },
      },
      required: ['key', 'start', 'stop'],
    },
  },
  {
    name: TOOL.sadd,
    description: 'SADD — add one or more members to a set.',
    inputSchema: {
      type: 'object',
      properties: {
        databaseId: {
          type: 'string',
          description:
            'The Upstash database id — a resource of the mission. Defaults to the single database of the mission.',
        },
        key: {
          type: 'string',
          description: 'The Redis set key.',
        },
        members: {
          type: 'array',
          items: { type: 'string' },
          description: 'Members to add to the set.',
        },
      },
      required: ['key', 'members'],
    },
  },
  {
    name: TOOL.smembers,
    description: 'SMEMBERS — get all members of a set.',
    inputSchema: {
      type: 'object',
      properties: {
        databaseId: {
          type: 'string',
          description:
            'The Upstash database id — a resource of the mission. Defaults to the single database of the mission.',
        },
        key: {
          type: 'string',
          description: 'The Redis set key.',
        },
      },
      required: ['key'],
    },
  },
  {
    name: TOOL.dbsize,
    description: 'DBSIZE — get the number of keys in the database.',
    inputSchema: {
      type: 'object',
      properties: {
        databaseId: {
          type: 'string',
          description:
            'The Upstash database id — a resource of the mission. Defaults to the single database of the mission.',
        },
      },
    },
  },
];

/** Every tool the plugin declares, management first. */
export const upstashRedisTools: readonly McpToolDeclaration[] = [
  ...MANAGEMENT_TOOLS,
  ...DATA_TOOLS,
];

/** Management tool names (Management API routing in `execute.ts`). */
export const MANAGEMENT_TOOL_NAMES: ReadonlySet<string> = new Set(
  MANAGEMENT_TOOLS.map((t) => t.name),
);

/** Data tool names (Data API routing in `execute.ts`). */
export const DATA_TOOL_NAMES: ReadonlySet<string> = new Set(DATA_TOOLS.map((t) => t.name));

/** Management tools that need no database : account-rooted. */
export const ACCOUNT_TOOL_NAMES: ReadonlySet<string> = new Set([
  TOOL.listDatabases,
  TOOL.createDatabase,
]);
