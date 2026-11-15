/**
 * Representative calls of every tool of the `notion` service
 * (`ServicePlugin.examples`) : the samples the plugin's tests run through the
 * kit (catalog coverage, identifier proof, catalog and data-model tests) and
 * the site classifies when it builds (ADR plugin-contract-and-credential-spec,
 * amendment 2026-11-05). One realistic call per tool, and the refused ones.
 */
import { samplesOn, type Resource, type ToolSamples } from '@vaubaan/plugin-sdk';

import { SERVICE_ID, TOOL } from './identity.ts';

const id = (digit: string) =>
  `${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}`;

/** The shared root page of the mission. */
export const ROOT = id('1');
export const PAGE = id('2');
export const BLOCK = id('4');
/** A shared root database. */
export const DB = id('5');
export const DS = id('6');
export const ENTRY = id('7');
/** Another root of the account, outside the mission. */
export const OTHER_ROOT = id('8');
export const DISCUSSION = id('a');

/** The root page the samples run on unless they name another resource. */
export const EXAMPLE_PAGE_ROOT: Resource = {
  service: SERVICE_ID,
  ref: ROOT,
  displayName: 'Handbook',
  metadata: { kind: 'page' },
};
/** The root database of the database samples. */
export const EXAMPLE_DB_ROOT: Resource = {
  service: SERVICE_ID,
  ref: DB,
  displayName: 'Tasks',
  metadata: { kind: 'database' },
};

const text = (content: string) => [{ type: 'text', text: { content } }];

export const notionExamples: ToolSamples = samplesOn([EXAMPLE_PAGE_ROOT], {
  [TOOL.listRoots]: [{ args: {}, resources: [EXAMPLE_PAGE_ROOT, EXAMPLE_DB_ROOT] }],
  [TOOL.searchContent]: [
    { args: { root: ROOT, query: 'roadmap', object: 'page' } },
    { args: { query: 'roadmap' } },
    { args: { root: OTHER_ROOT, query: 'roadmap' }, expectDenied: true },
  ],
  [TOOL.getPage]: [{ args: { root: ROOT, page_id: PAGE } }],
  [TOOL.listBlockChildren]: [{ args: { root: ROOT, block_id: PAGE, depth: 2 } }],
  [TOOL.getDatabase]: [{ args: { root: DB, database_id: DB }, resources: [EXAMPLE_DB_ROOT] }],
  [TOOL.getDataSource]: [{ args: { root: DB, data_source_id: DS }, resources: [EXAMPLE_DB_ROOT] }],
  [TOOL.queryDataSource]: [
    { args: { root: DB, data_source_id: DS, page_size: 10 }, resources: [EXAMPLE_DB_ROOT] },
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
      resources: [EXAMPLE_DB_ROOT],
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
      resources: [EXAMPLE_DB_ROOT],
    },
  ],
  [TOOL.listComments]: [{ args: { root: ROOT, block_id: PAGE } }],
  [TOOL.createComment]: [
    { args: { root: ROOT, block_id: PAGE, rich_text: text('Looks good') } },
    { args: { root: ROOT, block_id: PAGE, rich_text: text('Agreed'), discussion_id: DISCUSSION } },
  ],
});
