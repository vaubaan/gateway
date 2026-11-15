/**
 * Data model of the `notion` service.
 *
 * Spec     : docs/spec/gateway-risk-model.md §2.
 * Handbook : docs/handbook/services/notion.md.
 *
 * One plane, `content`. Notion's tree is recursive (pages hold blocks, blocks
 * hold blocks and sub-pages, to any depth) and a slice cannot say "any depth
 * below", so the model is **flat under the resource** : every page, block,
 * database and data source of a root is a direct child of `root` in the
 * slice, whatever its real depth. The real depth is proven at run time by
 * the executor (the ancestry walk, `ancestry.ts`).
 *
 * No entity carries an environment (product owner, 2026-10-16) : a root is
 * written whatever its owner's label, and the destructive operations are
 * gated by their row instead.
 */

import type { DataModel } from '@vaubaan/plugin-sdk';

import { SERVICE_ID } from './identity.ts';

const leaf = (name: string, parent: string, description: string) => ({
  name,
  parent,
  cardinalities: ['one'] as const,
  description,
});

export const notionDataModel: DataModel = {
  service: SERVICE_ID,
  planes: [
    {
      slug: 'content',
      description:
        'The pages and databases shared with the account, their content, entries and comments.',
      entities: [
        {
          name: 'root',
          parent: null,
          cardinalities: ['one'],
          description:
            'The resource : one top-level page or database shared with the account, and everything under it.',
        },
        {
          name: 'page',
          parent: 'root',
          cardinalities: ['one', 'unbounded'],
          description: 'Any page under the root, the root page itself included.',
        },
        leaf('subpage', 'page', 'Verb leaf : create a page under this page.'),
        leaf('properties', 'page', "Verb leaf : overwrite the page's title, icon or cover."),
        leaf('trash', 'page', 'Verb leaf : move the page, and everything under it, to the trash.'),
        leaf('restore', 'page', 'Verb leaf : bring the page back from the trash.'),
        {
          name: 'block',
          parent: 'root',
          cardinalities: ['one'],
          description:
            'Any block under the root (a page id is a block id too). A write on the block itself overwrites its content.',
        },
        leaf('children', 'block', 'Verb leaf : append blocks under this block.'),
        leaf('delete', 'block', 'Verb leaf : move the block to the trash.'),
        {
          name: 'comment',
          parent: 'block',
          cardinalities: ['one', 'unbounded'],
          description:
            'Comments on a block or a page ; identified by its discussion id for a reply, absent for a new discussion.',
        },
        {
          name: 'database',
          parent: 'root',
          cardinalities: ['one'],
          description: 'A database container under the root, or the root itself.',
        },
        {
          name: 'data-source',
          parent: 'root',
          cardinalities: ['one', 'unbounded'],
          description: 'A data source (schema and entries) of a database under the root.',
        },
        {
          name: 'entry',
          parent: 'data-source',
          cardinalities: ['one', 'unbounded'],
          description: 'An entry (row) of a data source ; absent for a creation.',
        },
        leaf('root-trash', 'root', 'Verb leaf : the shared root page itself goes to the trash.'),
      ],
    },
  ],
};
