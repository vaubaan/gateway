/**
 * `classifyNotion`, branch by branch : root resolution, the slice of every
 * tool, every refusal (undeclared argument, malformed id, request limits,
 * refused block types and property values, the root itself).
 */
import { describe, expect, test } from 'vitest';

import { serializeSlice, type Resource } from '@vaubaan/plugin-sdk';

import { classifyNotion } from '../../src/classify.ts';
import { MAX_ARRAY_ITEMS } from '../../src/content.ts';
import { TOOL } from '../../src/identity.ts';
import {
  BLOCK,
  CHILD,
  DB,
  DISCUSSION,
  DS,
  ENTRY,
  OTHER_ROOT,
  PAGE,
  ROOT,
  dbRoot,
  otherRoot,
  pageRoot,
} from './fixtures.ts';

const slices = (
  tool: string,
  args: Record<string, unknown>,
  resources: readonly Resource[] = [pageRoot],
) => {
  const out = classifyNotion(tool, args, resources);
  if ('denied' in out) throw new Error(out.denied);
  return out.slices.map(serializeSlice);
};
const denial = (
  tool: string,
  args: Record<string, unknown>,
  resources: readonly Resource[] = [pageRoot],
) => {
  const out = classifyNotion(tool, args, resources);
  return 'denied' in out ? out.denied : null;
};
const text = (content: string) => [{ type: 'text', text: { content } }];
const paragraph = (content = 'x') => ({
  type: 'paragraph',
  paragraph: { rich_text: text(content) },
});

describe('root resolution', () => {
  test('a named root must be one of the mission roots', () => {
    expect(slices(TOOL.getPage, { root: ROOT, page_id: PAGE }, [pageRoot, otherRoot])).toEqual([
      `notion.root[${ROOT}].page[${PAGE}].R`,
    ]);
    expect(denial(TOOL.getPage, { root: OTHER_ROOT, page_id: PAGE })).toBe(
      `root '${OTHER_ROOT}' is not selected in this mission`,
    );
    const foreign: Resource = { provider: 'other', ref: OTHER_ROOT, displayName: 'x' };
    expect(denial(TOOL.getPage, { root: OTHER_ROOT, page_id: PAGE }, [pageRoot, foreign])).toMatch(
      /not selected/,
    );
  });

  test('absent : the single root ; none or several refused', () => {
    expect(slices(TOOL.getPage, { page_id: PAGE })).toEqual([
      `notion.root[${ROOT}].page[${PAGE}].R`,
    ]);
    expect(denial(TOOL.getPage, { page_id: PAGE }, [pageRoot, otherRoot])).toBe(
      'root: argument missing and the mission selects 2 Notion roots — name one',
    );
    expect(denial(TOOL.getPage, { page_id: PAGE }, [])).toMatch(/selects no Notion root/);
  });

  test('ids are read in one canonical form ; anything else is refused', () => {
    const undashed = PAGE.replaceAll('-', '').toUpperCase();
    expect(slices(TOOL.getPage, { root: ROOT.replaceAll('-', ''), page_id: undashed })).toEqual([
      `notion.root[${ROOT}].page[${PAGE}].R`,
    ]);
    expect(denial(TOOL.getPage, { root: 'nope', page_id: PAGE })).toBe('root: malformed Notion id');
    expect(
      denial(TOOL.getPage, { page_id: `https://www.notion.so/Plan-${PAGE.replaceAll('-', '')}` }),
    ).toMatch(/page_id: malformed Notion id \(a page URL is not an id/);
    for (const hostile of ['..', '%2e%2e', `${PAGE}/x`, `${PAGE}\n`, '', 42, null]) {
      expect(denial(TOOL.getPage, { page_id: hostile })).toMatch(/page_id: malformed Notion id/);
    }
  });
});

describe('slices, tool by tool', () => {
  const R = `notion.root[${ROOT}]`;
  const D = `notion.root[${DB}]`;

  test('reads', () => {
    expect(slices(TOOL.listRoots, {}, [pageRoot, dbRoot])).toEqual([`${R}.R`, `${D}.R`]);
    expect(slices(TOOL.searchContent, {})).toEqual([`${R}.page[*].R`, `${R}.data-source[*].R`]);
    expect(slices(TOOL.searchContent, { object: 'page' })).toEqual([`${R}.page[*].R`]);
    expect(slices(TOOL.searchContent, { object: 'data_source' })).toEqual([
      `${R}.data-source[*].R`,
    ]);
    expect(slices(TOOL.listBlockChildren, { block_id: PAGE, depth: 3 })).toEqual([
      `${R}.block[${PAGE}].R`,
    ]);
    expect(slices(TOOL.getDatabase, { database_id: DB }, [dbRoot])).toEqual([
      `${D}.database[${DB}].R`,
    ]);
    expect(slices(TOOL.getDataSource, { data_source_id: DS }, [dbRoot])).toEqual([
      `${D}.data-source[${DS}].R`,
    ]);
    expect(slices(TOOL.queryDataSource, { data_source_id: DS }, [dbRoot])).toEqual([
      `${D}.data-source[${DS}].entry[*].R`,
    ]);
    expect(slices(TOOL.listComments, { block_id: PAGE })).toEqual([
      `${R}.block[${PAGE}].comment[*].R`,
    ]);
  });

  test('page writes', () => {
    expect(slices(TOOL.createPage, { parent_page_id: PAGE, title: 't' })).toEqual([
      `${R}.page[${PAGE}].subpage.W`,
    ]);
    expect(
      slices(TOOL.updatePage, { page_id: PAGE, icon: { type: 'emoji', emoji: '📌' } }),
    ).toEqual([`${R}.page[${PAGE}].properties.W`]);
    expect(slices(TOOL.trashPage, { page_id: CHILD })).toEqual([`${R}.page[${CHILD}].trash.W`]);
    expect(slices(TOOL.restorePage, { page_id: CHILD })).toEqual([`${R}.page[${CHILD}].restore.W`]);
  });

  test('trashing the root page itself also emits the root-trash leaf', () => {
    expect(slices(TOOL.trashPage, { page_id: ROOT })).toEqual([
      `${R}.page[${ROOT}].trash.W`,
      `${R}.root-trash.W`,
    ]);
  });

  test('block writes', () => {
    expect(slices(TOOL.appendBlocks, { block_id: PAGE, children: [paragraph()] })).toEqual([
      `${R}.block[${PAGE}].children.W`,
    ]);
    expect(
      slices(TOOL.updateBlock, {
        block_id: BLOCK,
        type: 'to_do',
        content: { rich_text: text('x'), checked: true },
      }),
    ).toEqual([`${R}.block[${BLOCK}].W`]);
    expect(slices(TOOL.deleteBlock, { block_id: BLOCK })).toEqual([
      `${R}.block[${BLOCK}].delete.W`,
    ]);
  });

  test('entries and comments', () => {
    expect(slices(TOOL.createEntry, { data_source_id: DS, properties: {} }, [dbRoot])).toEqual([
      `${D}.data-source[${DS}].entry.W`,
    ]);
    expect(
      slices(TOOL.updateEntry, { data_source_id: DS, page_id: ENTRY, properties: {} }, [dbRoot]),
    ).toEqual([`${D}.data-source[${DS}].entry[${ENTRY}].W`]);
    expect(slices(TOOL.createComment, { block_id: PAGE, rich_text: text('x') })).toEqual([
      `${R}.block[${PAGE}].comment.W`,
    ]);
    expect(
      slices(TOOL.createComment, {
        block_id: PAGE,
        rich_text: text('x'),
        discussion_id: DISCUSSION,
      }),
    ).toEqual([`${R}.block[${PAGE}].comment[${DISCUSSION}].W`]);
  });
});

describe('refusals', () => {
  test('an unknown tool, an undeclared argument', () => {
    expect(denial('notion__delete_everything', {})).toBe(
      "unknown tool 'notion__delete_everything'",
    );
    expect(denial(TOOL.updatePage, { page_id: PAGE, title: 't', erase_content: true })).toBe(
      "erase_content: not an argument of 'notion__update_page' — nothing classifies it, so it is not sent.",
    );
    expect(
      denial(TOOL.createPage, {
        parent_page_id: PAGE,
        title: 't',
        notifications: { mode: 'default' },
      }),
    ).toMatch(/^notifications: not an argument/);
    expect(
      denial(TOOL.createComment, {
        block_id: PAGE,
        rich_text: text('x'),
        display_name: { type: 'custom' },
      }),
    ).toMatch(/^display_name: not an argument/);
    expect(denial(TOOL.listRoots, { root: ROOT })).toMatch(/^root: not an argument/);
  });

  test('list_roots with no Notion root', () => {
    expect(denial(TOOL.listRoots, {}, [])).toMatch(/selects no Notion root/);
  });

  test('pagination and depth', () => {
    expect(denial(TOOL.listComments, { block_id: PAGE, page_size: 0 })).toBe(
      'page_size: an integer from 1 to 100',
    );
    expect(denial(TOOL.listComments, { block_id: PAGE, page_size: 101 })).toBe(
      'page_size: an integer from 1 to 100',
    );
    expect(denial(TOOL.listComments, { block_id: PAGE, start_cursor: 'a/b' })).toBe(
      'start_cursor: malformed',
    );
    expect(denial(TOOL.listBlockChildren, { block_id: PAGE, depth: 4 })).toBe(
      'depth: an integer from 1 to 3',
    );
  });

  test('search arguments', () => {
    expect(denial(TOOL.searchContent, { object: 'database' })).toBe(
      "object: 'page' or 'data_source'",
    );
    expect(
      denial(TOOL.searchContent, { sort: { direction: 'up', timestamp: 'last_edited_time' } }),
    ).toMatch(/sort.direction/);
    expect(
      denial(TOOL.searchContent, { sort: { direction: 'ascending', timestamp: 'created_time' } }),
    ).toMatch(/sort.timestamp/);
    expect(
      denial(TOOL.searchContent, {
        sort: { direction: 'ascending', timestamp: 'last_edited_time', x: 1 },
      }),
    ).toMatch(/sort.x/);
    expect(denial(TOOL.searchContent, { query: 'q'.repeat(2001) })).toMatch(/longer than 2000/);
  });

  test("Notion's request limits, refused up front", () => {
    const many = Array.from({ length: MAX_ARRAY_ITEMS + 1 }, () => paragraph());
    expect(denial(TOOL.appendBlocks, { block_id: PAGE, children: many })).toMatch(
      /more than 100 items/,
    );
    expect(
      denial(TOOL.appendBlocks, { block_id: PAGE, children: [paragraph('x'.repeat(2001))] }),
    ).toMatch(/longer than 2000/);
    const nest = (level: number): Record<string, unknown> =>
      level === 0
        ? paragraph()
        : { type: 'toggle', toggle: { rich_text: text('t'), children: [nest(level - 1)] } };
    expect(denial(TOOL.appendBlocks, { block_id: PAGE, children: [nest(2)] })).toBeNull();
    expect(denial(TOOL.appendBlocks, { block_id: PAGE, children: [nest(3)] })).toMatch(
      /levels of nesting/,
    );
    const wide = (n: number) => ({
      type: 'toggle',
      toggle: {
        rich_text: text('t'),
        children: Array.from({ length: n }, () => ({
          type: 'toggle',
          toggle: {
            rich_text: text('t'),
            children: Array.from({ length: 100 }, () => paragraph()),
          },
        })),
      },
    });
    expect(denial(TOOL.appendBlocks, { block_id: PAGE, children: [wide(10), wide(1)] })).toMatch(
      /more than 1000 blocks/,
    );
  });

  test('block types that are not created here', () => {
    const refused = (child: unknown) =>
      denial(TOOL.appendBlocks, { block_id: PAGE, children: [child] });
    expect(refused({ type: 'child_page', child_page: { title: 'x' } })).toMatch(
      /notion__create_page/,
    );
    expect(refused({ type: 'child_database', child_database: {} })).toMatch(/not created/);
    for (const type of ['link_preview', 'meeting_notes', 'transcription', 'unsupported']) {
      expect(refused({ type, [type]: {} })).toMatch(/block endpoints/);
    }
    expect(refused({ type: 'mystery', mystery: {} })).toMatch(/unknown block type/);
    expect(refused({ paragraph: { rich_text: [] } })).toMatch(/type: required/);
    expect(refused({ type: 'paragraph', paragraph: { rich_text: [] }, heading_1: {} })).toMatch(
      /heading_1: not part of a 'paragraph' block/,
    );
    expect(
      refused({ type: 'synced_block', synced_block: { synced_from: { block_id: BLOCK } } }),
    ).toMatch(/synced copy/);
    expect(
      refused({
        type: 'synced_block',
        synced_block: { synced_from: null, children: [paragraph()] },
      }),
    ).toBeNull();
    expect(
      refused({ type: 'image', image: { type: 'file_upload', file_upload: { id: BLOCK } } }),
    ).toMatch(/file uploads/);
    expect(
      refused({ type: 'link_to_page', link_to_page: { type: 'page_id', page_id: 'x/..' } }),
    ).toMatch(/malformed Notion id/);
    expect(
      refused({
        type: 'paragraph',
        paragraph: {
          rich_text: [{ type: 'mention', mention: { type: 'page', page: { id: '..' } } }],
        },
      }),
    ).toMatch(/mention.page.id: malformed Notion id/);
  });

  test('update_block : the root itself, an updatable type, no children', () => {
    expect(denial(TOOL.updateBlock, { block_id: ROOT, type: 'paragraph', content: {} })).toMatch(
      /notion__update_page/,
    );
    expect(denial(TOOL.updateBlock, { block_id: BLOCK, type: 'child_page', content: {} })).toMatch(
      /notion__update_page/,
    );
    expect(
      denial(TOOL.updateBlock, { block_id: BLOCK, type: 'synced_block', content: {} }),
    ).toMatch(/cannot be rewritten/);
    expect(
      denial(TOOL.updateBlock, { block_id: BLOCK, type: 'paragraph', content: { children: [] } }),
    ).toMatch(/children are not rewritten/);
    expect(denial(TOOL.updateBlock, { block_id: BLOCK, type: 'paragraph', content: [] })).toMatch(
      /content: expected/,
    );
  });

  test('delete_block and trash_page on the root', () => {
    expect(denial(TOOL.deleteBlock, { block_id: ROOT })).toMatch(/notion__trash_page/);
    expect(denial(TOOL.trashPage, { root: DB, page_id: DB }, [dbRoot])).toMatch(/is a database/);
  });

  test('update_page needs something to change ; icons and covers are https images', () => {
    expect(denial(TOOL.updatePage, { page_id: PAGE })).toMatch(/give a title, an icon or a cover/);
    expect(
      denial(TOOL.updatePage, {
        page_id: PAGE,
        icon: { type: 'external', external: { url: 'http://x.io/a.png' } },
      }),
    ).toMatch(/must be https/);
    expect(
      denial(TOOL.updatePage, {
        page_id: PAGE,
        cover: { type: 'file_upload', file_upload: { id: PAGE } },
      }),
    ).toMatch(/file uploads/);
    expect(denial(TOOL.updatePage, { page_id: PAGE, icon: { type: 'custom_emoji' } })).toMatch(
      /icon.type/,
    );
    expect(denial(TOOL.updatePage, { page_id: PAGE, title: '' })).toMatch(/non-empty/);
  });

  test('append position', () => {
    const base = { block_id: PAGE, children: [paragraph()] };
    expect(denial(TOOL.appendBlocks, { ...base, position: 'after_block' })).toMatch(
      /after_block_id: required/,
    );
    expect(denial(TOOL.appendBlocks, { ...base, after_block_id: BLOCK })).toMatch(
      /only with position after_block/,
    );
    expect(denial(TOOL.appendBlocks, { ...base, position: 'middle' })).toMatch(/position: one of/);
    expect(
      denial(TOOL.appendBlocks, { ...base, position: 'after_block', after_block_id: '..' }),
    ).toMatch(/after_block_id: malformed/);
  });

  test('entry property values', () => {
    const entry = (properties: unknown) =>
      denial(TOOL.createEntry, { data_source_id: DS, properties }, [dbRoot]);
    for (const type of [
      'formula',
      'rollup',
      'unique_id',
      'created_time',
      'last_edited_by',
      'button',
    ]) {
      expect(entry({ X: { [type]: {} } })).toMatch(/computed by Notion/);
      expect(entry({ X: { type, [type]: {} } })).toMatch(/computed by Notion/);
    }
    expect(entry({ Owner: { people: [{ object: 'user', id: 'someone' }] } })).toMatch(
      /people\[0\]\.id: malformed/,
    );
    expect(entry({ Project: { relation: [{ id: PAGE }, { id: '%2f' }] } })).toMatch(
      /relation\[1\]\.id: malformed/,
    );
    expect(
      entry({ Files: { files: [{ type: 'file_upload', file_upload: { id: PAGE } }] } }),
    ).toMatch(/file uploads/);
    expect(entry('x')).toMatch(/expected an object/);
    expect(
      entry({
        Name: { title: [{ type: 'text', text: { content: 'ok' } }] },
        Project: { relation: [{ id: PAGE }] },
      }),
    ).toBeNull();
    expect(denial(TOOL.createEntry, { data_source_id: DS }, [dbRoot])).toBe('properties: required');
  });

  test('comments', () => {
    expect(denial(TOOL.createComment, { block_id: PAGE, rich_text: [] })).toBe(
      'rich_text: the comment is empty',
    );
    expect(denial(TOOL.createComment, { block_id: PAGE, rich_text: 'hello' })).toMatch(
      /expected an array/,
    );
    expect(
      denial(TOOL.createComment, { block_id: PAGE, rich_text: text('x'), discussion_id: 'd-1' }),
    ).toMatch(/discussion_id: malformed/);
  });

  test('query values are held to the limits', () => {
    expect(denial(TOOL.queryDataSource, { data_source_id: DS, filter: [] }, [dbRoot])).toBe(
      'filter: expected an object',
    );
    expect(denial(TOOL.queryDataSource, { data_source_id: DS, sorts: {} }, [dbRoot])).toBe(
      'sorts: expected an array',
    );
    expect(
      denial(
        TOOL.queryDataSource,
        { data_source_id: DS, filter: { or: Array.from({ length: 101 }, () => ({})) } },
        [dbRoot],
      ),
    ).toMatch(/more than 100 items/);
  });
});
