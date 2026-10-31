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

import { TOOL } from './identity.ts';

export const upstashRedisToolTitles: Readonly<Record<string, string>> = {
  [TOOL.listDatabases]: 'List databases',
  [TOOL.getDatabase]: 'Read a database',
  [TOOL.createDatabase]: 'Create a database',
  [TOOL.deleteDatabase]: 'Delete a database',
  [TOOL.renameDatabase]: 'Rename a database',
  [TOOL.getDatabaseStats]: 'Read the usage of a database',
  [TOOL.execute]: 'Run a Redis command',
  [TOOL.get]: 'Read a key',
  [TOOL.set]: 'Set a key',
  [TOOL.del]: 'Delete keys',
  [TOOL.keys]: 'Find keys by pattern',
  [TOOL.scan]: 'Scan the keys',
  [TOOL.ttl]: 'Read the time to live of a key',
  [TOOL.expire]: 'Set the expiry of a key',
  [TOOL.hset]: 'Set fields of a hash',
  [TOOL.hgetall]: 'Read a hash',
  [TOOL.lpush]: 'Prepend values to a list',
  [TOOL.lrange]: 'Read a range of a list',
  [TOOL.sadd]: 'Add members to a set',
  [TOOL.smembers]: 'Read the members of a set',
  [TOOL.dbsize]: 'Count the keys of a database',
};
