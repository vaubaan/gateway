/**
 * The boundaries a write must not cross beyond its own target (review of
 * 2026-10-16) : a deletion that would trash a nested page, a link or a
 * mention to another root, a refusal that would describe an object outside
 * the root, budgets shared by every walk of one call, and a data source
 * answered without `database_parent`.
 */
import { describe, expect, test } from 'vitest';

import { mockFetch, refusalText, type MockRoute } from '@vaubaan/plugin-sdk/testing';

import { NOTION_API_BASE } from '../../src/api.ts';
import {
  MAX_CHILD_REQUESTS,
  MAX_DELETE_SCAN_REQUESTS,
  MAX_REFERENCE_WALK_REQUESTS,
} from '../../src/execute.ts';
import { classifyNotion } from '../../src/classify.ts';
import { TOOL } from '../../src/identity.ts';
import { notionPlugin } from '../../src/index.ts';
import {
  BLOCK,
  CHILD,
  DS,
  FOREIGN,
  PAGE,
  ROOT,
  block,
  blockParent,
  ctx,
  dataSource,
  database,
  dbRoot,
  page,
  pageParent,
  pageRoot,
  served,
  sourceParent,
  worldFetch,
  writes,
} from './fixtures.ts';

const execute = notionPlugin.execute.bind(notionPlugin);
const hex = (n: number) => `${n.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`;
const text = (content: string) => [{ type: 'text', text: { content } }];
const children = (parentId: string, results: unknown[], has_more = false): MockRoute => ({
  method: 'GET',
  url: `${NOTION_API_BASE}/blocks/${parentId}/children?page_size=100`,
  body: { object: 'list', results, has_more, next_cursor: has_more ? 'more-1' : null },
});
const TOGGLE = hex(0x70);

describe('delete_block never trashes a page or a database nested in the block', () => {
  const toggle = block(TOGGLE, 'toggle', pageParent(PAGE), { has_children: true });

  test('a toggle holding a sub-page : refused, no DELETE sent', async () => {
    const fetch = worldFetch(
      served('blocks', toggle),
      children(TOGGLE, [block(CHILD, 'child_page', blockParent(TOGGLE))]),
    );
    expect(await refusalText(execute(ctx(fetch), TOOL.deleteBlock, { block_id: TOGGLE }))).toMatch(
      new RegExp(`contains a page \\('${CHILD}'\\), which deleting it would trash`),
    );
    expect(writes(fetch)).toEqual([]);
  });

  test('a database two levels down, under a column : refused', async () => {
    const column = hex(0x71);
    const fetch = worldFetch(
      served('blocks', toggle),
      children(TOGGLE, [block(column, 'column', blockParent(TOGGLE), { has_children: true })]),
      children(column, [block(hex(0x72), 'child_database', blockParent(column))]),
    );
    expect(await refusalText(execute(ctx(fetch), TOOL.deleteBlock, { block_id: TOGGLE }))).toMatch(
      /contains a database/,
    );
    expect(writes(fetch)).toEqual([]);
  });

  test(`a tree larger than ${MAX_DELETE_SCAN_REQUESTS} listings : refused (fail closed)`, async () => {
    const nested = Array.from({ length: MAX_DELETE_SCAN_REQUESTS + 1 }, (_, i) =>
      block(hex(0x100 + i), 'toggle', blockParent(TOGGLE), { has_children: true }),
    );
    const fetch = worldFetch(served('blocks', toggle), children(TOGGLE, nested), {
      method: 'GET',
      url: /\/children\?page_size=100$/,
      body: { object: 'list', results: [], has_more: false },
    });
    expect(await refusalText(execute(ctx(fetch), TOOL.deleteBlock, { block_id: TOGGLE }))).toMatch(
      /more nested content than one call checks/,
    );
    expect(writes(fetch)).toEqual([]);
  });

  test('a toggle holding text only, over two pages of children : deleted', async () => {
    const fetch = worldFetch(
      served('blocks', toggle),
      children(TOGGLE, [block(hex(0x73), 'paragraph', blockParent(TOGGLE))], true),
      {
        method: 'GET',
        url: `${NOTION_API_BASE}/blocks/${TOGGLE}/children?page_size=100&start_cursor=more-1`,
        body: {
          object: 'list',
          results: [block(hex(0x74), 'paragraph', blockParent(TOGGLE))],
          has_more: false,
        },
      },
    );
    expect((await execute(ctx(fetch), TOOL.deleteBlock, { block_id: TOGGLE })).isError).toBe(
      undefined,
    );
    expect(writes(fetch).map((c) => c.method)).toEqual(['DELETE']);
  });
});

describe('links and mentions in written content are walked like relation targets', () => {
  const foreignMention = [{ type: 'mention', mention: { type: 'page', page: { id: FOREIGN } } }];

  test.each([
    [
      'a mention in new content',
      TOOL.appendBlocks,
      {
        block_id: PAGE,
        children: [{ type: 'paragraph', paragraph: { rich_text: foreignMention } }],
      },
    ],
    [
      'a link to a page in a new page',
      TOOL.createPage,
      {
        parent_page_id: PAGE,
        title: 't',
        children: [{ type: 'link_to_page', link_to_page: { type: 'page_id', page_id: FOREIGN } }],
      },
    ],
    [
      'a mention in a rewritten block',
      TOOL.updateBlock,
      { block_id: BLOCK, type: 'paragraph', content: { rich_text: foreignMention } },
    ],
    ['a mention in a comment', TOOL.createComment, { block_id: PAGE, rich_text: foreignMention }],
  ])('%s outside the root : refused, nothing written', async (_, tool, args) => {
    const fetch = worldFetch();
    expect(await refusalText(execute(ctx(fetch), tool, args))).toMatch(
      new RegExp(`page '${FOREIGN}' is not under the shared root '${ROOT}'`),
    );
    expect(writes(fetch)).toEqual([]);
  });

  test('a mention in an entry title, and a database mention', async () => {
    const fetch = worldFetch();
    const result = execute(ctx(fetch, [dbRoot]), TOOL.createEntry, {
      data_source_id: DS,
      properties: {
        Name: {
          title: [{ type: 'mention', mention: { type: 'database', database: { id: FOREIGN } } }],
        },
      },
    });
    expect(await refusalText(result)).toMatch(/database '.*' is not under the shared root/);
    expect(writes(fetch)).toEqual([]);
  });

  test('a mention of a page under the root is written', async () => {
    const fetch = worldFetch();
    const mention = [{ type: 'mention', mention: { type: 'page', page: { id: PAGE } } }];
    const result = await execute(ctx(fetch), TOOL.createComment, {
      block_id: PAGE,
      rich_text: mention,
    });
    expect(result.isError).toBeUndefined();
    expect(writes(fetch)).toHaveLength(1);
  });

  test(`the walks of one write share ${MAX_REFERENCE_WALK_REQUESTS} requests ; beyond, refused`, async () => {
    // 51 relation targets, each one level under the root page : one request each.
    const targets = Array.from({ length: MAX_REFERENCE_WALK_REQUESTS + 1 }, (_, i) =>
      hex(0x200 + i),
    );
    const fetch = worldFetch(
      served('databases', database(hex(0x300), pageParent(ROOT))),
      served('data_sources', dataSource(hex(0x301), hex(0x300), pageParent(ROOT))),
      ...targets.map((id) => served('pages', page(id, pageParent(ROOT)))),
    );
    const result = execute(ctx(fetch), TOOL.createEntry, {
      data_source_id: hex(0x301),
      properties: { Links: { relation: targets.slice(0, 50).map((id) => ({ id })) } },
      children: [
        {
          type: 'paragraph',
          paragraph: {
            rich_text: [{ type: 'mention', mention: { type: 'page', page: { id: targets[50] } } }],
          },
        },
      ],
    });
    expect(await refusalText(result)).toMatch(/within the requests this call may spend/);
    expect(writes(fetch)).toEqual([]);
  });
});

describe('an object outside the root is described by nothing but that', () => {
  test('update_page on an entry of another root : "not under", not "an entry"', async () => {
    const foreignEntry = hex(0x400);
    const fetch = worldFetch(
      served('pages', page(foreignEntry, sourceParent(hex(0x401), hex(0x402)))),
      served('data_sources', dataSource(hex(0x401), hex(0x402), pageParent(FOREIGN))),
    );
    const refused = await refusalText(
      execute(ctx(fetch), TOOL.updatePage, { page_id: foreignEntry, title: 'x' }),
    );
    expect(refused).toMatch(/is not under the shared root/);
    expect(refused).not.toMatch(/entry/);
  });

  test('update_block and delete_block on a block of another root : no type is named', async () => {
    const foreignBlock = hex(0x403);
    const routes = [served('blocks', block(foreignBlock, 'child_page', pageParent(FOREIGN)))];
    const update = await refusalText(
      execute(ctx(worldFetch(...routes)), TOOL.updateBlock, {
        block_id: foreignBlock,
        type: 'paragraph',
        content: { rich_text: text('x') },
      }),
    );
    const remove = await refusalText(
      execute(ctx(worldFetch(...routes)), TOOL.deleteBlock, { block_id: foreignBlock }),
    );
    for (const refused of [update, remove]) {
      expect(refused).toMatch(/is not under the shared root/);
      expect(refused).not.toMatch(/child_page|is a page/);
    }
  });

  test('update_entry on a page of another root : "not under", not "not an entry", nothing sent', async () => {
    const fetch = worldFetch();
    const refused = await refusalText(
      execute(ctx(fetch, [dbRoot]), TOOL.updateEntry, {
        data_source_id: DS,
        page_id: FOREIGN,
        properties: { Done: { checkbox: true } },
      }),
    );
    expect(refused).toMatch(/is not under the shared root/);
    expect(refused).not.toMatch(/not an entry/);
    expect(writes(fetch)).toEqual([]);
  });
});

describe('one budget for the listings and the synced-original walks of a call', () => {
  test(`expanding many synced copies spends at most ${MAX_CHILD_REQUESTS} requests`, async () => {
    const copies = Array.from({ length: 25 }, (_, i) =>
      block(hex(0x500 + i), 'synced_block', pageParent(PAGE), {
        has_children: true,
        synced_block: { synced_from: { type: 'block_id', block_id: hex(0x600 + i) } },
      }),
    );
    const originals = Array.from({ length: 25 }, (_, i) => [
      served('blocks', block(hex(0x600 + i), 'synced_block', pageParent(hex(0x700 + i)))),
      served('pages', page(hex(0x700 + i), pageParent(ROOT))),
    ]).flat();
    const fetch = mockFetch([
      served('blocks', block(PAGE, 'child_page', pageParent(ROOT), { has_children: true })),
      {
        method: 'GET',
        url: `${NOTION_API_BASE}/blocks/${PAGE}/children?page_size=50`,
        body: { object: 'list', results: copies, has_more: false },
      },
      ...originals,
      {
        method: 'GET',
        url: /\/children\?page_size=100$/,
        body: { object: 'list', results: [], has_more: false },
      },
    ]);
    const result = await execute(ctx(fetch), TOOL.listBlockChildren, { block_id: PAGE, depth: 2 });
    const body = JSON.parse((result.content[0] as { text: string }).text) as {
      not_expanded: unknown[];
    };
    // The target's read and its listing, then the shared budget.
    expect(fetch.calls.length).toBeLessThanOrEqual(2 + MAX_CHILD_REQUESTS);
    expect(body.not_expanded.length).toBeGreaterThan(0);
  });
});

describe('a data source answered without database_parent', () => {
  test('an entry proven through its database, read by its own GET, without a false cycle', async () => {
    const source = hex(0x800);
    const db = hex(0x801);
    const entry = hex(0x802);
    const fetch = mockFetch([
      served('pages', page(entry, sourceParent(source, db))),
      served('data_sources', { ...dataSource(source, db, undefined), database_parent: undefined }),
      served('databases', database(db, pageParent(ROOT))),
    ]);
    expect((await execute(ctx(fetch), TOOL.getPage, { page_id: entry })).isError).toBeUndefined();
    expect(fetch.calls.map((c) => c.url.replace(NOTION_API_BASE, ''))).toEqual([
      `/pages/${entry}`,
      `/data_sources/${source}`,
      `/databases/${db}`,
    ]);
  });
});

describe('a link or a mention says exactly what it points at', () => {
  const append = (child: unknown) => ({ block_id: PAGE, children: [child] });
  const mention = (value: unknown) => ({
    type: 'paragraph',
    paragraph: { rich_text: [{ type: 'mention', mention: value }] },
  });

  test.each([
    [
      'a database link carrying a page id too',
      { type: 'database_id', page_id: PAGE, database_id: FOREIGN },
    ],
    [
      'a page link carrying a database id too',
      { type: 'page_id', page_id: PAGE, database_id: FOREIGN },
    ],
    ['a page link whose type says database', { type: 'database_id', page_id: PAGE }],
    ['a link without a type', { page_id: PAGE }],
    ['a link with another key', { type: 'page_id', page_id: PAGE, url: 'https://x.io' }],
  ])('%s : refused by classify and by execute, nothing sent', async (_, link) => {
    const args = append({ type: 'link_to_page', link_to_page: link });
    expect('denied' in classifyNotion(TOOL.appendBlocks, args, [pageRoot])).toBe(true);
    const fetch = mockFetch([]);
    expect((await execute(ctx(fetch), TOOL.appendBlocks, args)).isError).toBe(true);
    expect(fetch.calls).toEqual([]);
  });

  test.each([
    ['data_source', { type: 'data_source', data_source: { id: FOREIGN } }],
    ['link_mention', { type: 'link_mention', link_mention: { href: 'https://x.io' } }],
    ['link_preview', { type: 'link_preview', link_preview: { url: 'https://x.io' } }],
    [
      'template_mention',
      { type: 'template_mention', template_mention: { type: 'template_mention_date' } },
    ],
    ['a kind not known', { type: 'custom', custom: {} }],
    ['no type', { page: { id: PAGE } }],
    ['a second target', { type: 'page', page: { id: PAGE }, database: { id: FOREIGN } }],
    ['an extra field on the target', { type: 'page', page: { id: PAGE, url: 'https://x.io' } }],
  ])('a mention of %s : refused by classify and by execute, nothing sent', async (_, value) => {
    const args = append(mention(value));
    const outcome = classifyNotion(TOOL.appendBlocks, args, [pageRoot]);
    expect('denied' in outcome ? outcome.denied : '').toMatch(/mention/);
    const fetch = mockFetch([]);
    expect((await execute(ctx(fetch), TOOL.appendBlocks, args)).isError).toBe(true);
    expect(fetch.calls).toEqual([]);
  });

  test('a user and a date mention are written ; a user is not walked', async () => {
    const fetch = worldFetch();
    const args = {
      block_id: PAGE,
      rich_text: [
        { type: 'mention', mention: { type: 'user', user: { object: 'user', id: FOREIGN } } },
        { type: 'mention', mention: { type: 'date', date: { start: '2026-10-16' } } },
      ],
    };
    expect((await execute(ctx(fetch), TOOL.createComment, args)).isError).toBeUndefined();
    expect(fetch.calls.some((c) => c.url.includes(FOREIGN))).toBe(false);
  });

  test('a reference that does not exist, or is not shared : the same refusal', async () => {
    const missing = hex(0x900);
    const fetch = worldFetch({
      method: 'GET',
      url: `${NOTION_API_BASE}/pages/${missing}`,
      status: 404,
      body: { object: 'error', code: 'object_not_found' },
    });
    const args = append(mention({ type: 'page', page: { id: missing } }));
    expect(await refusalText(execute(ctx(fetch), TOOL.appendBlocks, args))).toBe(
      `notion: page '${missing}' is not under the shared root '${ROOT}' of this call`,
    );
    expect(writes(fetch)).toEqual([]);
  });
});

describe('the pre-delete scan never reads a synced original', () => {
  const ORIGIN = hex(0xa00);
  const OUTSIDE_SUBPAGE = hex(0xa01);
  const COPY = hex(0xa02);
  const copy = (id: string, parent: unknown) =>
    block(id, 'synced_block', parent, {
      has_children: true,
      synced_block: { synced_from: { type: 'block_id', block_id: ORIGIN } },
    });
  const leaks = (fetch: ReturnType<typeof mockFetch>, text: string) =>
    [ORIGIN, OUTSIDE_SUBPAGE].some(
      (id) => text.includes(id) || fetch.calls.some((c) => c.url.includes(id)),
    );

  test('a toggle holding a synced copy of an outside original with a sub-page : deleted, nothing of the outside read or named', async () => {
    const toggle = block(TOGGLE, 'toggle', pageParent(PAGE), { has_children: true });
    // Strict : only these routes answer. The copy's children (the original's tree) have none.
    const fetch = mockFetch([
      served('blocks', toggle),
      served('pages', page(PAGE, pageParent(ROOT))),
      children(TOGGLE, [copy(COPY, blockParent(TOGGLE))]),
      {
        method: 'DELETE',
        url: `${NOTION_API_BASE}/blocks/${TOGGLE}`,
        body: { object: 'block', id: TOGGLE },
      },
    ]);
    const result = await execute(ctx(fetch), TOOL.deleteBlock, { block_id: TOGGLE });
    expect(result.isError).toBeUndefined();
    expect(writes(fetch).map((c) => c.method)).toEqual(['DELETE']);
    expect(leaks(fetch, JSON.stringify(result))).toBe(false);
  });

  test('deleting a synced copy itself : no scan, deleted', async () => {
    const fetch = mockFetch([
      served('blocks', copy(COPY, pageParent(PAGE))),
      served('pages', page(PAGE, pageParent(ROOT))),
      {
        method: 'DELETE',
        url: `${NOTION_API_BASE}/blocks/${COPY}`,
        body: { object: 'block', id: COPY },
      },
    ]);
    const result = await execute(ctx(fetch), TOOL.deleteBlock, { block_id: COPY });
    expect(result.isError).toBeUndefined();
    expect(leaks(fetch, JSON.stringify(result))).toBe(false);
  });

  test('a block whose has_children is absent is scanned (fail closed)', async () => {
    const quiet = { ...block(TOGGLE, 'toggle', pageParent(PAGE)), has_children: undefined };
    const fetch = worldFetch(
      served('blocks', quiet),
      children(TOGGLE, [block(CHILD, 'child_page', blockParent(TOGGLE))]),
    );
    expect(await refusalText(execute(ctx(fetch), TOOL.deleteBlock, { block_id: TOGGLE }))).toMatch(
      /contains a page/,
    );
    expect(writes(fetch)).toEqual([]);
  });
});
