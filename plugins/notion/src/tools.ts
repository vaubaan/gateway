/**
 * MCP tools of the `notion` provider.
 *
 * Handbook : docs/handbook/providers/notion.md §2.
 *
 * Every tool that acts on content takes `root`, the id of one of the
 * mission's Notion resources (a top-level page or database shared with the
 * connection) ; it may be omitted when the mission selects exactly one. The
 * `properties` of each schema are the whole argument surface of the tool :
 * any other argument is refused (`undeclaredArgument` in `classify.ts`).
 */

import type { McpToolDeclaration } from '@vaubaan/plugin-sdk';

import { TOOL } from './identity.ts';

const ID_HELP = 'A Notion id: 32 hexadecimal characters, with or without dashes.';

const root = {
  root: {
    type: 'string',
    description:
      'Id of the shared root (page or database) the call works in, one of the roots of the mission (notion__list_roots). May be omitted when the mission has one root.',
  },
};
const id = (description: string) => ({ type: 'string', description: `${description} ${ID_HELP}` });
const pageSize = (fallback: number) => ({
  type: 'integer',
  minimum: 1,
  maximum: 100,
  description: `Results per page, 1 to 100 (default ${fallback}).`,
});
const startCursor = {
  type: 'string',
  description: "The previous answer's next_cursor, to read the next page.",
};
const richText = {
  type: 'array',
  description: 'Notion rich text objects, at most 100, each text at most 2000 characters.',
  items: { type: 'object' },
};
const children = {
  type: 'array',
  description:
    'Notion block objects ({ type, [type]: {...} }), at most 100, two levels of nesting, no file upload, no synced copy, no child_page or child_database.',
  items: { type: 'object' },
};
const icon = {
  type: 'object',
  description:
    'Page icon: { type: "emoji", emoji }, { type: "icon", icon: { name, color } } or { type: "external", external: { url } } (https).',
};
const cover = {
  type: 'object',
  description: 'Page cover: { type: "external", external: { url } } (https).',
};

const SILENT =
  ' Sent silently: Notion notifies nobody of the change (database automations still run).';

export const notionTools: readonly McpToolDeclaration[] = [
  {
    name: TOOL.listRoots,
    description:
      'List the shared roots of this mission: the top-level pages and databases the agent may work in, with their id, title and kind. Sends no request to Notion.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: TOOL.searchContent,
    description:
      "Search page and database titles within one root. Notion's search matches titles only, is not exhaustive and lags behind recent changes; results outside the root are hidden (results_hidden). To find entries of a database, query its data source instead.",
    inputSchema: {
      type: 'object',
      properties: {
        ...root,
        query: { type: 'string', description: 'Text to look for in titles.' },
        object: {
          type: 'string',
          enum: ['page', 'data_source'],
          description: 'Only pages, or only data sources (databases).',
        },
        sort: {
          type: 'object',
          description:
            'Notion sort: { direction: "ascending" | "descending", timestamp: "last_edited_time" }.',
        },
        page_size: pageSize(20),
        start_cursor: startCursor,
      },
    },
  },
  {
    name: TOOL.getPage,
    description:
      "Read a page's properties (title, icon, cover, database values). Its content is read with notion__list_block_children. A relation or a rollup may look empty when the related pages are not shared with the connection.",
    inputSchema: {
      type: 'object',
      properties: { ...root, page_id: id('The page.') },
      required: ['page_id'],
    },
  },
  {
    name: TOOL.listBlockChildren,
    description:
      'Read the content of a page or a block: its child blocks, and with depth 2 or 3 their nested blocks in the same call (at most 500 blocks, 20 listings). Sub-pages are listed, not expanded.',
    inputSchema: {
      type: 'object',
      properties: {
        ...root,
        block_id: id('The page or block whose content is read.'),
        depth: {
          type: 'integer',
          minimum: 1,
          maximum: 3,
          description: 'Levels to read, 1 to 3 (default 1).',
        },
        page_size: pageSize(50),
        start_cursor: startCursor,
      },
      required: ['block_id'],
    },
  },
  {
    name: TOOL.getDatabase,
    description: 'Read a database: its title, its parent and the list of its data sources.',
    inputSchema: {
      type: 'object',
      properties: { ...root, database_id: id('The database.') },
      required: ['database_id'],
    },
  },
  {
    name: TOOL.getDataSource,
    description: "Read a data source's schema: its properties and their types.",
    inputSchema: {
      type: 'object',
      properties: { ...root, data_source_id: id('The data source.') },
      required: ['data_source_id'],
    },
  },
  {
    name: TOOL.queryDataSource,
    description:
      'Query the entries of a data source with a Notion filter and sorts. Returns pages (entries) only.',
    inputSchema: {
      type: 'object',
      properties: {
        ...root,
        data_source_id: id('The data source.'),
        filter: { type: 'object', description: 'Notion filter object.' },
        sorts: { type: 'array', description: 'Notion sort objects.', items: { type: 'object' } },
        page_size: pageSize(50),
        start_cursor: startCursor,
      },
      required: ['data_source_id'],
    },
  },
  {
    name: TOOL.createPage,
    description: `Create a page under an existing page of the root, with a title and optional first content.${SILENT}`,
    inputSchema: {
      type: 'object',
      properties: {
        ...root,
        parent_page_id: id('The page the new page goes under.'),
        title: { type: 'string', description: 'Title of the new page (at most 2000 characters).' },
        children,
        icon,
        cover,
      },
      required: ['parent_page_id', 'title'],
    },
  },
  {
    name: TOOL.updatePage,
    description: `Change the title, icon or cover of a page (not a database entry: use notion__update_entry).${SILENT}`,
    inputSchema: {
      type: 'object',
      properties: {
        ...root,
        page_id: id('The page.'),
        title: { type: 'string', description: 'New title (at most 2000 characters).' },
        icon,
        cover,
      },
      required: ['page_id'],
    },
  },
  {
    name: TOOL.appendBlocks,
    description: `Add blocks to a page or a block, at the end (default), at the start or after a given child block.${SILENT}`,
    inputSchema: {
      type: 'object',
      properties: {
        ...root,
        block_id: id('The page or block that receives the new blocks.'),
        children,
        position: {
          type: 'string',
          enum: ['end', 'start', 'after_block'],
          description: 'Where the blocks go (default end).',
        },
        after_block_id: id('With position after_block: the child block the new blocks follow.'),
      },
      required: ['block_id', 'children'],
    },
  },
  {
    name: TOOL.updateBlock,
    description:
      "Rewrite the content of one block (a paragraph, a heading, a to-do, a table row…): give its type and the new object for that type. The block's children are not changed. Notion offers no silent mode here: a mention in the new text notifies the person it names.",
    inputSchema: {
      type: 'object',
      properties: {
        ...root,
        block_id: id('The block.'),
        type: {
          type: 'string',
          description: 'The type of the block, as Notion reports it (paragraph, to_do…).',
        },
        content: {
          type: 'object',
          description:
            'The new object for that type, e.g. { rich_text: [...], checked: true } for a to_do.',
        },
      },
      required: ['block_id', 'type', 'content'],
    },
  },
  {
    name: TOOL.deleteBlock,
    description:
      'Move one block of a page (with the blocks nested in it) to the trash. Not a page: use notion__trash_page.',
    inputSchema: {
      type: 'object',
      properties: { ...root, block_id: id('The block.') },
      required: ['block_id'],
    },
  },
  {
    name: TOOL.trashPage,
    description: `Move a page, and everything under it, to the trash. It can be restored with notion__restore_page.${SILENT}`,
    inputSchema: {
      type: 'object',
      properties: { ...root, page_id: id('The page.') },
      required: ['page_id'],
    },
  },
  {
    name: TOOL.restorePage,
    description: `Bring a page back from the trash, with everything under it.${SILENT}`,
    inputSchema: {
      type: 'object',
      properties: { ...root, page_id: id('The page.') },
      required: ['page_id'],
    },
  },
  {
    name: TOOL.createEntry,
    description: `Add an entry to a database: its data source and the property values. Relation targets must be under the same root.${SILENT}`,
    inputSchema: {
      type: 'object',
      properties: {
        ...root,
        data_source_id: id('The data source of the database.'),
        properties: {
          type: 'object',
          description: 'Notion property values, keyed by property name.',
        },
        children,
        icon,
      },
      required: ['data_source_id', 'properties'],
    },
  },
  {
    name: TOOL.updateEntry,
    description: `Change property values of a database entry; a list value replaces the whole list. Relation targets must be under the same root.${SILENT}`,
    inputSchema: {
      type: 'object',
      properties: {
        ...root,
        data_source_id: id('The data source the entry belongs to.'),
        page_id: id('The entry.'),
        properties: {
          type: 'object',
          description: 'Notion property values, keyed by property name.',
        },
        icon,
      },
      required: ['data_source_id', 'page_id', 'properties'],
    },
  },
  {
    name: TOOL.listComments,
    description: 'Read the open (unresolved) comments on a page or a block.',
    inputSchema: {
      type: 'object',
      properties: {
        ...root,
        block_id: id('The page or block.'),
        page_size: pageSize(20),
        start_cursor: startCursor,
      },
      required: ['block_id'],
    },
  },
  {
    name: TOOL.createComment,
    description:
      'Open a discussion on a page or a block, or reply to an open discussion of that page or block. Signed by the connection; notifies the people it mentions.',
    inputSchema: {
      type: 'object',
      properties: {
        ...root,
        block_id: id('The page or block the comment is on.'),
        rich_text: richText,
        discussion_id: id('To reply: an open discussion of that page or block.'),
      },
      required: ['block_id', 'rich_text'],
    },
  },
];

/** What each tool does, in a few words : the head of an approval request. */
export const notionToolTitles: Readonly<Record<string, string>> = {
  [TOOL.listRoots]: 'List the shared roots',
  [TOOL.searchContent]: 'Search pages and databases',
  [TOOL.getPage]: 'Read a page',
  [TOOL.listBlockChildren]: "Read a page's content",
  [TOOL.getDatabase]: 'Read a database',
  [TOOL.getDataSource]: "Read a database's schema",
  [TOOL.queryDataSource]: 'Query a database',
  [TOOL.createPage]: 'Create a page',
  [TOOL.updatePage]: 'Update a page',
  [TOOL.appendBlocks]: 'Add content to a page',
  [TOOL.updateBlock]: 'Rewrite a block of a page',
  [TOOL.deleteBlock]: 'Delete a block of a page',
  [TOOL.trashPage]: 'Move a page to the trash',
  [TOOL.restorePage]: 'Bring a page back from the trash',
  [TOOL.createEntry]: 'Add a database entry',
  [TOOL.updateEntry]: 'Update a database entry',
  [TOOL.listComments]: 'Read comments',
  [TOOL.createComment]: 'Add a comment',
};
