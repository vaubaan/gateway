/**
 * `createdResources` of the Upstash Redis plugin (ADR
 * created-resources-join-the-mission): the database read from the Management
 * API's answer (credentials already stripped), described as discovery does.
 */
import { describe, expect, test } from 'vitest';

import { createdUpstashRedisResources } from '../../src/created.ts';
import { upstashRedisPlugin } from '../../src/index.ts';

const TOOL = 'upstash_redis__create_database';
const answer = (payload: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
});

describe('upstash-redis createdResources', () => {
  test('the database, ref = database_id, the non-secret metadata discovery keeps', () => {
    expect(
      createdUpstashRedisResources(
        TOOL,
        { name: 'cache', region: 'global' },
        answer({
          database_id: '96ad0856-03b1-4ee7-9666-e81abd0349e1',
          database_name: 'cache',
          database_type: 'Pay as You Go',
          region: 'global',
          primary_region: 'us-east-1',
          endpoint: 'cute-mole-12345.upstash.io',
          state: 'active',
          tls: true,
        }),
      ),
    ).toEqual([
      {
        service: 'upstash-redis',
        ref: '96ad0856-03b1-4ee7-9666-e81abd0349e1',
        displayName: 'cache',
        metadata: {
          region: 'global',
          primary_region: 'us-east-1',
          endpoint: 'cute-mole-12345.upstash.io',
          state: 'active',
          database_type: 'Pay as You Go',
          tls: true,
        },
      },
    ]);
    expect(upstashRedisPlugin.createdResources).toBe(createdUpstashRedisResources);
  });

  test('nothing from an id outside the grammar, a missing id, or another tool', () => {
    expect(createdUpstashRedisResources(TOOL, {}, answer({ database_id: 'a/b' }))).toEqual([]);
    expect(createdUpstashRedisResources(TOOL, {}, answer({ database_name: 'x' }))).toEqual([]);
    expect(
      createdUpstashRedisResources(
        'upstash_redis__rename_database',
        {},
        answer({ database_id: 'abc' }),
      ),
    ).toEqual([]);
  });
});
