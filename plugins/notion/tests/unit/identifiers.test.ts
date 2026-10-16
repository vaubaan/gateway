/**
 * Hostile identifiers in every id position of `classify` and of `execute`
 * (ADR plugin-identifiers-one-grammar-for-classify-and-execute) : top-level
 * ids, the root, and the ids nested in bodies (relation targets, mentions,
 * links to pages, the block an append follows, a discussion). A refused value
 * sends nothing ; an accepted spelling is named in its one canonical form.
 */
import { describe, expect, test } from 'vitest';

import { declaredOnly, mockFetch } from '@vaubaan/plugin-sdk/testing';

import { classifyNotion } from '../../src/classify.ts';
import { executeNotion } from '../../src/execute.ts';
import { TOOL } from '../../src/identity.ts';
import { notionPlugin } from '../../src/index.ts';
import { BLOCK, DS, PAGE, ROOT, ctx, dbRoot, pageRoot, worldFetch, writes } from './fixtures.ts';

const HOSTILE = [
  '..',
  '.',
  'a/../b',
  '%2e%2e',
  '..%2f',
  '%2f',
  `${PAGE}/x`,
  `${PAGE}/..`,
  `${PAGE}\n`,
  `${PAGE}?x=1#y`,
  `${PAGE.replaceAll('-', '')}0`,
  '',
  'x'.repeat(300),
];
const text = (content: string) => [{ type: 'text', text: { content } }];

/** Every top-level id argument, with a call that is otherwise valid. */
const POSITIONS: readonly (readonly [string, string, Record<string, unknown>])[] = [
  [TOOL.getPage, 'page_id', {}],
  [TOOL.listBlockChildren, 'block_id', {}],
  [TOOL.getDatabase, 'database_id', {}],
  [TOOL.getDataSource, 'data_source_id', {}],
  [TOOL.queryDataSource, 'data_source_id', {}],
  [TOOL.createPage, 'parent_page_id', { title: 't' }],
  [TOOL.updatePage, 'page_id', { title: 't' }],
  [TOOL.appendBlocks, 'block_id', { children: [] }],
  [TOOL.appendBlocks, 'after_block_id', { block_id: PAGE, children: [], position: 'after_block' }],
  [TOOL.updateBlock, 'block_id', { type: 'paragraph', content: { rich_text: [] } }],
  [TOOL.deleteBlock, 'block_id', {}],
  [TOOL.trashPage, 'page_id', {}],
  [TOOL.restorePage, 'page_id', {}],
  [TOOL.createEntry, 'data_source_id', { properties: {} }],
  [TOOL.updateEntry, 'data_source_id', { page_id: PAGE, properties: {} }],
  [TOOL.updateEntry, 'page_id', { data_source_id: DS, properties: {} }],
  [TOOL.listComments, 'block_id', {}],
  [TOOL.createComment, 'block_id', { rich_text: text('x') }],
  [TOOL.createComment, 'discussion_id', { block_id: PAGE, rich_text: text('x') }],
];

describe('top-level ids', () => {
  test.each(POSITIONS)(
    '%s — %s : refused by classify and by execute, nothing sent',
    async (tool, argument, rest) => {
      for (const hostile of HOSTILE) {
        const args = declaredOnly(notionPlugin, tool, {
          root: ROOT,
          page_id: PAGE,
          block_id: BLOCK,
          data_source_id: DS,
          ...rest,
          [argument]: hostile,
        });
        const outcome = classifyNotion(tool, args, [pageRoot]);
        expect(
          'denied' in outcome ? outcome.denied : '',
          `${tool} ${argument}=${JSON.stringify(hostile)}`,
        ).toMatch(new RegExp(`^${argument}: malformed Notion id`));
        const fetch = mockFetch([]);
        const result = await executeNotion(ctx(fetch), tool, args);
        expect(result.isError).toBe(true);
        expect(fetch.calls).toEqual([]);
      }
    },
  );

  test('the root : refused when malformed, whatever the mission holds', async () => {
    for (const hostile of HOSTILE) {
      expect(classifyNotion(TOOL.getPage, { root: hostile, page_id: PAGE }, [pageRoot])).toEqual({
        denied: 'root: malformed Notion id',
      });
      const fetch = mockFetch([]);
      expect(
        (await executeNotion(ctx(fetch), TOOL.getPage, { root: hostile, page_id: PAGE })).isError,
      ).toBe(true);
      expect(fetch.calls).toEqual([]);
    }
    const dotted = { ...pageRoot, ref: '..' };
    expect(classifyNotion(TOOL.getPage, { page_id: PAGE }, [dotted])).toEqual({
      denied: 'root: the mission resource is not a Notion id',
    });
  });

  test('the undashed spelling is named in the canonical form, in the slice and in the path', async () => {
    const undashed = PAGE.replaceAll('-', '').toUpperCase();
    const outcome = classifyNotion(TOOL.trashPage, { page_id: undashed }, [pageRoot]);
    expect(JSON.stringify(outcome)).toContain(PAGE);
    const fetch = worldFetch();
    await executeNotion(ctx(fetch), TOOL.trashPage, { page_id: undashed });
    expect(writes(fetch).map((c) => c.url)).toEqual([`https://api.notion.com/v1/pages/${PAGE}`]);
  });
});

describe('ids nested in bodies', () => {
  const nested: readonly (readonly [string, string, Record<string, unknown>])[] = [
    [
      'a relation target',
      TOOL.createEntry,
      { root: dbRoot.ref, data_source_id: DS, properties: { P: { relation: [{ id: '%2e%2e' }] } } },
    ],
    [
      'a person',
      TOOL.updateEntry,
      {
        root: dbRoot.ref,
        data_source_id: DS,
        page_id: PAGE,
        properties: { O: { people: [{ id: '..' }] } },
      },
    ],
    [
      'a mention in a comment',
      TOOL.createComment,
      {
        root: dbRoot.ref,
        block_id: PAGE,
        rich_text: [{ type: 'mention', mention: { type: 'page', page: { id: '../x' } } }],
      },
    ],
    [
      'a link to a page in new content',
      TOOL.appendBlocks,
      {
        root: dbRoot.ref,
        block_id: PAGE,
        children: [{ type: 'link_to_page', link_to_page: { type: 'page_id', page_id: '%2f' } }],
      },
    ],
  ];

  test.each(nested)(
    '%s : refused by classify and by execute, nothing sent',
    async (_, tool, args) => {
      const outcome = classifyNotion(tool, args, [dbRoot]);
      expect('denied' in outcome ? outcome.denied : '').toMatch(/malformed Notion id/);
      const fetch = mockFetch([]);
      expect((await executeNotion(ctx(fetch, [dbRoot]), tool, args)).isError).toBe(true);
      expect(fetch.calls).toEqual([]);
    },
  );

  test('a cursor : refused when it could split the query string', async () => {
    for (const hostile of ['a&b=c', '..', '%2f', 'x\ny']) {
      expect(
        classifyNotion(TOOL.listComments, { block_id: PAGE, start_cursor: hostile }, [pageRoot]),
      ).toEqual({
        denied: 'start_cursor: malformed',
      });
      const fetch = mockFetch([]);
      expect(
        (
          await executeNotion(ctx(fetch), TOOL.listComments, {
            block_id: PAGE,
            start_cursor: hostile,
          })
        ).isError,
      ).toBe(true);
      expect(fetch.calls).toEqual([]);
    }
  });
});
