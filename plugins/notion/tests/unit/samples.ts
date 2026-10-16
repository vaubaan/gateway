/**
 * One realistic call (or a refused one) per tool : the table the catalog
 * coverage, the identifier proof and the catalog tests run on.
 */
import type { ToolSamples } from '@vaubaan/plugin-sdk/testing';

import { TOOL } from '../../src/identity.ts';
import {
  BLOCK,
  DB,
  DISCUSSION,
  DS,
  ENTRY,
  OTHER_ROOT,
  PAGE,
  ROOT,
  dbRoot,
  pageRoot,
} from './fixtures.ts';

const text = (content: string) => [{ type: 'text', text: { content } }];

export const SAMPLES: ToolSamples = {
  [TOOL.listRoots]: [{ args: {}, resources: [pageRoot, dbRoot] }],
  [TOOL.searchContent]: [
    { args: { root: ROOT, query: 'roadmap', object: 'page' } },
    { args: { query: 'roadmap' } },
    { args: { root: OTHER_ROOT, query: 'roadmap' }, expectDenied: true },
  ],
  [TOOL.getPage]: [{ args: { root: ROOT, page_id: PAGE } }],
  [TOOL.listBlockChildren]: [{ args: { root: ROOT, block_id: PAGE, depth: 2 } }],
  [TOOL.getDatabase]: [{ args: { root: DB, database_id: DB }, resources: [dbRoot] }],
  [TOOL.getDataSource]: [{ args: { root: DB, data_source_id: DS }, resources: [dbRoot] }],
  [TOOL.queryDataSource]: [
    { args: { root: DB, data_source_id: DS, page_size: 10 }, resources: [dbRoot] },
  ],
  [TOOL.createPage]: [{ args: { root: ROOT, parent_page_id: PAGE, title: 'Weekly plan' } }],
  [TOOL.updatePage]: [{ args: { root: ROOT, page_id: PAGE, title: 'Renamed plan' } }],
  [TOOL.appendBlocks]: [
    {
      args: {
        root: ROOT,
        block_id: PAGE,
        children: [{ type: 'paragraph', paragraph: { rich_text: text('Hello') } }],
        position: 'start',
      },
    },
  ],
  [TOOL.updateBlock]: [
    {
      args: {
        root: ROOT,
        block_id: BLOCK,
        type: 'paragraph',
        content: { rich_text: text('Rewritten') },
      },
    },
    { args: { root: ROOT, block_id: ROOT, type: 'paragraph', content: {} }, expectDenied: true },
  ],
  [TOOL.deleteBlock]: [{ args: { root: ROOT, block_id: BLOCK } }],
  [TOOL.trashPage]: [
    { args: { root: ROOT, page_id: PAGE } },
    // The root page itself : `page-trash` and `root-trash`.
    { args: { root: ROOT, page_id: ROOT } },
  ],
  [TOOL.restorePage]: [{ args: { root: ROOT, page_id: PAGE } }],
  [TOOL.createEntry]: [
    {
      args: { root: DB, data_source_id: DS, properties: { Name: { title: text('Task') } } },
      resources: [dbRoot],
    },
  ],
  [TOOL.updateEntry]: [
    {
      args: {
        root: DB,
        data_source_id: DS,
        page_id: ENTRY,
        properties: { Status: { status: { name: 'Done' } } },
      },
      resources: [dbRoot],
    },
  ],
  [TOOL.listComments]: [{ args: { root: ROOT, block_id: PAGE } }],
  [TOOL.createComment]: [
    { args: { root: ROOT, block_id: PAGE, rich_text: text('Looks good') } },
    { args: { root: ROOT, block_id: PAGE, rich_text: text('Agreed'), discussion_id: DISCUSSION } },
  ],
};
