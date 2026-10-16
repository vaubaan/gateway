/**
 * Data model of the `miro` provider.
 *
 * Spec     : docs/spec/gateway-risk-model.md §2.
 * Handbook : docs/handbook/providers/miro.md §1.
 *
 * One plane, `board`. The board is the resource ; no entity carries an
 * environment (a Miro board has none). Items, frames, connectors and tags
 * live under a board ; `delete` is a verb leaf under the three entities that
 * can be deleted, `bulk-create` a verb leaf under the item collection (the
 * bulk call), `tag-link` a tag attached to an item.
 */

import type { DataModel } from '@vaubaan/plugin-sdk';

import { PROVIDER_ID } from './identity.ts';

export const miroDataModel: DataModel = {
  provider: PROVIDER_ID,
  planes: [
    {
      slug: 'board',
      description: 'A Miro board and what is drawn on it.',
      entities: [
        {
          name: 'board',
          parent: null,
          cardinalities: ['one'],
          description: 'The resource a connection exposes : one Miro board.',
        },
        {
          name: 'item',
          parent: 'board',
          cardinalities: ['one', 'unbounded'],
          description: 'A sticky note, shape, text or card (and, read-only, any other item type).',
        },
        {
          name: 'frame',
          parent: 'board',
          cardinalities: ['one'],
          description: 'A frame : the parent item that groups other items.',
        },
        {
          name: 'connector',
          parent: 'board',
          cardinalities: ['one', 'unbounded'],
          description: 'A line between two items.',
        },
        {
          name: 'tag',
          parent: 'board',
          cardinalities: ['one', 'unbounded'],
          description: 'A tag of the board.',
        },
        {
          name: 'tag-link',
          parent: 'item',
          cardinalities: ['one', 'unbounded'],
          description: 'A tag attached to an item.',
        },
        {
          name: 'delete',
          parent: 'item',
          cardinalities: ['one'],
          description: 'Verb leaf : deleting an item.',
        },
        {
          name: 'delete',
          parent: 'frame',
          cardinalities: ['one'],
          description: 'Verb leaf : deleting a frame.',
        },
        {
          name: 'delete',
          parent: 'connector',
          cardinalities: ['one'],
          description: 'Verb leaf : deleting a connector.',
        },
        {
          name: 'bulk-create',
          parent: 'item',
          cardinalities: ['one'],
          description: 'Verb leaf on the item collection : up to 20 items created in one call.',
        },
      ],
    },
  ],
};
