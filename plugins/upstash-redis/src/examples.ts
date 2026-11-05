/**
 * Representative calls of every tool of the `upstash-redis` provider
 * (`ProviderPlugin.examples`) : the samples the plugin's tests run through the
 * kit and the site classifies when it builds (ADR
 * plugin-contract-and-credential-spec, amendment 2026-11-05).
 *
 * Every sample runs on one staging database ; `execute` is sampled with a
 * read, writes, a delete, a flush, a configuration change, a script and a
 * transaction, so each named risk is reached.
 */
import { samplesOn, type Resource, type ToolSamples } from '@vaubaan/plugin-sdk';

import { PROVIDER_ID, TOOL } from './identity.ts';

/** The one database the samples run on, labelled staging. */
export const EXAMPLE_DATABASE: Resource = {
  provider: PROVIDER_ID,
  ref: 'db-abc-123',
  env: 'staging',
  displayName: 'app-cache',
};

const d = { databaseId: EXAMPLE_DATABASE.ref };

export const upstashRedisExamples: ToolSamples = samplesOn([EXAMPLE_DATABASE], {
  [TOOL.listDatabases]: [{ args: {} }],
  [TOOL.getDatabase]: [{ args: d }, { args: {} }],
  [TOOL.getDatabaseStats]: [{ args: d }],
  [TOOL.createDatabase]: [{ args: { name: 'new-cache', region: 'eu-west-1' } }],
  [TOOL.deleteDatabase]: [{ args: d }],
  [TOOL.renameDatabase]: [{ args: { ...d, name: 'renamed' } }],
  [TOOL.execute]: [
    { args: { ...d, command: ['GET', 'k'] } },
    { args: { ...d, command: ['SET', 'k', 'v'] } },
    { args: { ...d, command: ['DEL', 'k'] } },
    { args: { ...d, command: ['EXPIRE', 'k', '0'] } },
    { args: { ...d, command: ['FLUSHDB'] } },
    { args: { ...d, command: ['CONFIG', 'SET', 'maxmemory', '0'] } },
    { args: { ...d, command: ['EVAL', 'return 1', '0'] } },
    { args: { ...d, command: [['MULTI'], ['SET', 'k', 'v'], ['DEL', 'j'], ['EXEC']] } },
    { args: { ...d, command: [] } },
    { args: { command: ['PING'] } },
  ],
  [TOOL.get]: [{ args: { ...d, key: 'session:1' } }, { args: { key: 'k' } }],
  [TOOL.set]: [{ args: { ...d, key: 'k', value: 'v', ex: 60 } }],
  [TOOL.del]: [{ args: { ...d, keys: ['k1'] } }, { args: { ...d, keys: ['k1', 'k2'] } }],
  [TOOL.keys]: [{ args: { ...d, pattern: 'user:*' } }],
  [TOOL.scan]: [{ args: { ...d, cursor: 0 } }],
  [TOOL.ttl]: [{ args: { ...d, key: 'k' } }],
  [TOOL.expire]: [
    { args: { ...d, key: 'k', seconds: 60 } },
    { args: { ...d, key: 'k', seconds: 0 } },
  ],
  [TOOL.hset]: [{ args: { ...d, key: 'h', fields: { f: 'v' } } }],
  [TOOL.hgetall]: [{ args: { ...d, key: 'h' } }],
  [TOOL.lpush]: [{ args: { ...d, key: 'l', values: ['a'] } }],
  [TOOL.lrange]: [{ args: { ...d, key: 'l', start: 0, stop: -1 } }],
  [TOOL.sadd]: [{ args: { ...d, key: 's', members: ['x'] } }],
  [TOOL.smembers]: [{ args: { ...d, key: 's' } }],
  [TOOL.dbsize]: [{ args: d }],
});
