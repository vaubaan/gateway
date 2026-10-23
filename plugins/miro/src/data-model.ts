/**
 * Data model of the `miro` provider.
 *
 * Spec     : docs/spec/gateway-risk-model.md §2.
 * Handbook : docs/handbook/providers/miro.md §1.
 *
 * One plane, `board`. The board is the resource ; no entity carries an
 * environment (a Miro board has none). Items, frames, connectors, tags and
 * comments live under a board ; `delete` is a verb leaf under the entities
 * that can be deleted, `bulk-create` a verb leaf under the item collection.
 * `format-guide` is Miro's documentation of the canvas formats, served by its
 * MCP server : nothing of the customer's. `metadata`, `access` and
 * `boardcast` (0.3.0) are the board's own details, who can open it, and the
 * narrated walkthroughs recorded on it.
 *
 * `connector`, `tag` and `tag-link` have no tool of their own since the
 * plugin rewraps Miro's MCP server (connectors are drawn as SVG lines, as
 * items) ; they stay because the catalog's patterns name them and a risk
 * is never narrowed silently.
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
          // `bounded` : `list_boards` names the boards it reads as a list.
          cardinalities: ['one', 'bounded'],
          description: 'The resource a connection exposes : one Miro board.',
        },
        {
          name: 'item',
          parent: 'board',
          cardinalities: ['one', 'unbounded'],
          description:
            'Anything drawn on a board : a sticky note, shape, text, card, image, document, table, diagram, prototype screen, line.',
        },
        {
          name: 'frame',
          parent: 'board',
          cardinalities: ['one', 'unbounded'],
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
          name: 'comment',
          parent: 'board',
          cardinalities: ['one', 'unbounded'],
          description: 'A comment thread on the board or on one of its items.',
        },
        {
          name: 'metadata',
          parent: 'board',
          cardinalities: ['one'],
          description:
            "The board's own details : its title, description and icon, and the space it is in.",
        },
        {
          name: 'access',
          parent: 'board',
          cardinalities: ['one'],
          description:
            'Who can open the board — people and groups, each with a role from viewer to owner.',
        },
        {
          name: 'boardcast',
          parent: 'board',
          cardinalities: ['one', 'unbounded'],
          description:
            'A boardcast : a narrated, replayable walkthrough of the board (a talktrack), with a playback link.',
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
          description: 'Verb leaf on the item collection : many items created in one call.',
        },
      ],
    },
    {
      slug: 'guide',
      description: "Miro's own documentation of the canvas formats.",
      entities: [
        {
          name: 'format-guide',
          parent: null,
          cardinalities: ['one'],
          description:
            'The format specifications the canvas tools read and write, as Miro serves them.',
        },
      ],
    },
  ],
};
