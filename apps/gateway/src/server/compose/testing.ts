/**
 * Test helpers for the composition root. Not for production.
 *
 * `memoryStoreDeps` swaps the SQLite file for the store's `:memory:` mode
 * (same schema, same repositories, gone on `close()`); `fakePlugin()` is the
 * smallest plugin `definePlugin` accepts, so registry-dependent behaviour
 * (provider-app check, catalog index) can be exercised without
 * real plugins.
 */
import { definePlugin, type ProviderPlugin } from '@vaubaan/plugin-sdk';
import { apiKeyCredentialFixture } from '@vaubaan/plugin-sdk/testing';
import { parseSlice } from '@vaubaan/policy-engine';
import type { RiskCatalog } from '@vaubaan/shared';

import { openMemoryStore } from '../store';
import type { RootDeps } from './root';

/** `RootDeps` slice that opens the store in memory instead of on disk. */
export const memoryStoreDeps: Pick<RootDeps, 'openStore'> = {
  openStore: async ({ encryptor, catalog }) => openMemoryStore({ encryptor, catalog }),
};

const FAKE_CATALOG: RiskCatalog = {
  provider: 'acme',
  risks: [
    {
      id: 'acme.read-things',
      label: 'Read things',
      reason: 'Reads leak nothing but the thing itself.',
      matches: 'acme.space[**].thing[**].R',
      vector: {
        reversibility: 'reversible',
        blast: 'single',
        data: 'data',
        cost: 'free',
        visibility: 'internal',
        persistence: 'stateless',
      },
    },
    {
      id: 'acme.thing-write',
      label: 'Write a thing',
      reason: 'Reversible edit of one thing.',
      matches: 'acme.space[**].thing[**].W',
      acceptable_in_envs: ['staging', 'prod'],
      vector: {
        reversibility: 'reversible',
        blast: 'single',
        data: 'data',
        cost: 'free',
        visibility: 'team',
        persistence: 'session',
      },
    },
    {
      id: 'acme.uncategorized-write',
      label: 'Uncategorized write',
      reason: 'Catch-all for writes the catalog does not name.',
      matches: 'acme.**.W',
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
  macro_actions: [
    {
      id: 'read',
      label: 'Read',
      description: 'Read things.',
      entries: [
        { risk_id: 'acme.read-things', quota: 100, rate_limit: { max: 60, window_seconds: 60 } },
      ],
    },
    {
      id: 'write',
      label: 'Write',
      description: 'Write things.',
      entries: [
        { risk_id: 'acme.thing-write', quota: 100, rate_limit: { max: 60, window_seconds: 60 } },
      ],
    },
  ],
};

/** A valid plugin with provider id `acme`, one tool, one env-scoped risk. */
export function fakePlugin(): ProviderPlugin {
  return definePlugin({
    id: 'acme',
    displayName: 'Acme',
    version: '0.0.1',
    tools: [
      {
        name: 'acme__list_things',
        description: 'List the things of a space.',
        inputSchema: { type: 'object', properties: { space: { type: 'string' } } },
      },
    ],
    dataModel: {
      provider: 'acme',
      planes: [
        {
          slug: 'space',
          entities: [
            {
              name: 'space',
              parent: null,
              cardinalities: ['one'],
              description: 'A space.',
              envScopable: true,
            },
            {
              name: 'thing',
              parent: 'space',
              cardinalities: ['one', 'unbounded'],
              description: 'A thing.',
            },
          ],
        },
      ],
    },
    catalog: FAKE_CATALOG,
    credential: apiKeyCredentialFixture([{ name: 'api_key', label: 'API key', secret: true }]),
    classify(_tool, args, resources) {
      const space =
        typeof args.space === 'string'
          ? args.space
          : resources.length === 1
            ? resources[0]!.ref
            : null;
      if (!space) return { denied: 'space: argument missing' };
      return { slices: [parseSlice(`acme.space[${space}].thing[*].R`)] };
    },
    async execute() {
      return { content: [{ type: 'text', text: '[]' }] };
    },
    async discoverResources() {
      return [];
    },
  });
}
