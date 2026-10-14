/**
 * What each tool of the `upstash-redis` provider does, in a few words a person reads at
 * a glance (`ProviderPlugin.toolTitles`) : the head of an approval request in
 * the web interface, before the resource the call resolves to. A verb and its
 * object, sentence case, no final period. For people only : never part of
 * `tools/list`, and the host decides nothing from it.
 *
 * A structural test of the gateway checks that every tool of a shipped plugin
 * has its title : a new tool is added here with its declaration.
 */

export const upstashRedisToolTitles: Readonly<Record<string, string>> = {
  upstash_redis__list_databases: 'List databases',
  upstash_redis__get_database: 'Read a database',
  upstash_redis__create_database: 'Create a database',
  upstash_redis__delete_database: 'Delete a database',
  upstash_redis__rename_database: 'Rename a database',
  upstash_redis__get_database_stats: 'Read the usage of a database',
  upstash_redis__execute: 'Run a Redis command',
  upstash_redis__get: 'Read a key',
  upstash_redis__set: 'Set a key',
  upstash_redis__del: 'Delete keys',
  upstash_redis__keys: 'Find keys by pattern',
  upstash_redis__scan: 'Scan the keys',
  upstash_redis__ttl: 'Read the time to live of a key',
  upstash_redis__expire: 'Set the expiry of a key',
  upstash_redis__hset: 'Set fields of a hash',
  upstash_redis__hgetall: 'Read a hash',
  upstash_redis__lpush: 'Prepend values to a list',
  upstash_redis__lrange: 'Read a range of a list',
  upstash_redis__sadd: 'Add members to a set',
  upstash_redis__smembers: 'Read the members of a set',
  upstash_redis__dbsize: 'Count the keys of a database',
};
