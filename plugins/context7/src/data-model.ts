/**
 * Data model of the `context7` provider.
 *
 * Spec     : docs/spec/gateway-risk-model.md §2.
 * Handbook : docs/handbook/providers/context7.md.
 *
 * One plane, `docs` : the library index one Context7 key can query (the
 * resource, one per connection) and the libraries in it. Libraries are
 * global at Context7 (`/vercel/next.js` is the same for everyone) ; what a
 * key reaches is decided by its teamspace's policies, which no answer of
 * Context7 names. Nothing is written, so there is no verb leaf, and Context7
 * has no notion of environment, so no entity is `envScopable`.
 */

import type { DataModel } from '@vaubaan/plugin-sdk';

import { PROVIDER_ID } from './identity.ts';

export const context7DataModel: DataModel = {
  provider: PROVIDER_ID,
  planes: [
    {
      slug: 'docs',
      description: 'The library documentation one Context7 key can query.',
      entities: [
        {
          name: 'index',
          parent: null,
          cardinalities: ['one'],
          description:
            "The resource : what the key's teamspace can query, the public libraries its policies admit and its private sources.",
        },
        {
          name: 'library',
          parent: 'index',
          cardinalities: ['one', 'unbounded'],
          description:
            'A Context7 library named by its id (`/vercel/next.js`), or every library of the index (a search).',
        },
      ],
    },
  ],
};
