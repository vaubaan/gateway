/**
 * Data model of the `upstash-redis` provider.
 *
 * Spec     : docs/spec/gateway-risk-model.md §2.
 * Handbook : docs/handbook/providers/upstash-redis.md.
 *
 * Upstash Redis exposes a single plane, `cache`. Every entity lives under
 * the `account` the Management API key belongs to, and every data operation
 * is scoped to a `database`. The **database** is the resource a connection
 * exposes and a mission selects (`ref` = Upstash database id) ; it carries
 * the environment label the owner sets, hence `envScopable`.
 *
 * Two API layers walk the same graph : the Management API
 * (`account.database[*]`, `database[D].stats`, `database[D].credentials`)
 * and the per-database Data API (`database[D].key-space[K]`). The classifier
 * adds three literal markers under `key-space` — `delete`, `flush`,
 * `execute` — so the catalog can grade deletions, FLUSHDB/FLUSHALL and
 * arbitrary commands (scripts, administration, unknown verbs) separately
 * from an ordinary key write.
 */

import type { DataModel } from '@vaubaan/plugin-sdk';

import { PROVIDER_ID } from './identity.ts';

export const upstashRedisDataModel: DataModel = {
  provider: PROVIDER_ID,
  planes: [
    {
      slug: 'cache',
      description:
        'The only Upstash Redis plane Vaubaan exposes — covers databases (Management API) ' +
        'and key-value data operations (Data API via REST).',
      entities: [
        {
          name: 'account',
          parent: null,
          cardinalities: ['one'],
          description:
            'The Upstash account behind the Management API key of a connection. One per connection.',
        },
        {
          name: 'database',
          parent: 'account',
          cardinalities: ['bounded'],
          envScopable: true,
          description:
            'An Upstash Redis database — the resource discovered at connection time (database id ' +
            'ref), labelled with an environment by the owner, selected by a mission.',
        },
        {
          name: 'key-space',
          parent: 'database',
          cardinalities: ['unbounded'],
          description:
            'The key-value data stored in a database. Covers all Redis data structures ' +
            '(strings, hashes, lists, sets, sorted sets). The classifier appends the literal ' +
            'markers `delete`, `flush` and `execute` for deletions, FLUSHDB/FLUSHALL and ' +
            'arbitrary commands (scripts, administration, unknown verbs).',
        },
        {
          name: 'credentials',
          parent: 'database',
          cardinalities: ['one'],
          description:
            'Per-database identity : name, tokens and passwords. Rename / password-reset ' +
            'operations touch this entity.',
        },
        {
          name: 'stats',
          parent: 'database',
          cardinalities: ['one'],
          description: 'Per-database usage statistics (commands, throughput, memory). Read-only.',
        },
        {
          name: 'backup',
          parent: 'database',
          cardinalities: ['bounded'],
          description:
            'Per-database backup snapshots. Not exposed as tools in the current surface but ' +
            'declared so a future tool lands on an existing entity.',
        },
      ],
    },
  ],
};
