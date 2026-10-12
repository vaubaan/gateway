/**
 * Upstash Redis data-model — declarative entity graph for the v4 risk-based engine.
 *
 * Spec : docs/spec/gateway-risk-model.md §2.
 *
 * Upstash Redis exposes a single plane (`cache`). Every entity lives under
 * an `account`, and data operations are scoped to a `database`. The
 * database is the binding unit (one Vaubaan binding = one Upstash database).
 *
 * This data-model is the canonical source for :
 *   - the mermaid diagram auto-rendered into the handbook (spec §2),
 *   - the catalog's `matches` patterns (each pattern must refer to entity
 *     slugs declared here — lint at CI),
 *   - the lint that every MCP tool exposed by this provider classifies
 *     into at least one slice rooted at a declared entity.
 */

import type { DataModel } from '@vaubaan/shared';

export const dataModel: DataModel = {
  provider: 'upstash-redis',
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
            'The Upstash account backing the Management API credentials used by Vaubaan. ' +
            'Singleton per ProviderAdmin row.',
        },
        {
          name: 'database',
          parent: 'account',
          cardinalities: ['bounded'],
          description:
            'An Upstash Redis database. The Vaubaan binding pins which database ids the ' +
            'access token can reach.',
        },
        {
          name: 'key-space',
          parent: 'database',
          cardinalities: ['unbounded'],
          description:
            'The key-value data stored in a database. Covers all Redis data structures ' +
            '(strings, hashes, lists, sets, sorted sets).',
        },
        {
          name: 'credentials',
          parent: 'database',
          cardinalities: ['one'],
          description:
            'Per-database tokens and passwords. Rename / password-reset operations touch ' +
            'this entity.',
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
            'Per-database backup snapshots. Not directly exposed as tools in the current ' +
            'surface but declared for completeness.',
        },
      ],
    },
  ],
};
