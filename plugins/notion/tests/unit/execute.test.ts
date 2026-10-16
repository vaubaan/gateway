/**
 * `executeNotion` against `mockFetch` : the request each tool sends
 * (method, URL, headers, body), silent notifications where Notion accepts
 * them, the declines that send nothing, and the ceilings.
 */
import { describe, expect, test } from 'vitest';

import { mockFetch, refusalText, type RecordedCall } from '@vaubaan/plugin-sdk/testing';

import { NOTION_API_BASE, NOTION_VERSION } from '../../src/api.ts';
import { MAX_CHILD_REQUESTS, MAX_SEARCH_VERIFY_REQUESTS } from '../../src/execute.ts';
import { TOOL } from '../../src/identity.ts';
import { notionPlugin } from '../../src/index.ts';
import {
  BLOCK,
  CHILD,
  DB,
  DISCUSSION,
  DS,
  ENTRY,
  ORIGINAL,
  PAGE,
  ROOT,
  SYNCED,
  TOKEN,
  block,
  ctx,
  dbRoot,
  otherRoot,
  page,
  pageParent,
  pageRoot,
  payload,
  served,
  worldFetch,
  writes,
} from './fixtures.ts';

const execute = notionPlugin.execute.bind(notionPlugin);
const text = (content: string) => [{ type: 'text', text: { content } }];
const paragraph = (content: string) => ({
  type: 'paragraph',
  paragraph: { rich_text: text(content) },
});
const SILENT = { mode: 'silent' };

async function only(
  tool: string,
  args: Record<string, unknown>,
  resources = [pageRoot],
): Promise<RecordedCall> {
  const fetch = worldFetch(
    {
      method: 'GET',
      url: /\/comments\?/,
      body: { results: [{ discussion_id: DISCUSSION }], has_more: false },
    },
    { method: 'GET', url: /\/children\?/, body: { object: 'list', results: [], has_more: false } },
  );
  const result = await execute(ctx(fetch, resources), tool, args);
  expect(result.isError, JSON.stringify(result.content)).toBeUndefined();
  const sent = writes(fetch);
  expect(sent).toHaveLength(1);
  return sent[0]!;
}

describe('requests', () => {
  test('headers : the token, the pinned version', async () => {
    const fetch = worldFetch();
    await execute(ctx(fetch), TOOL.getPage, { page_id: PAGE });
    expect(fetch.calls[0]!.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(fetch.calls[0]!.headers['notion-version']).toBe(NOTION_VERSION);
    expect(NOTION_VERSION).toBe('2026-03-11');
  });

  test('create_page : a page parent, the title, silent', async () => {
    const call = await only(TOOL.createPage, {
      parent_page_id: PAGE,
      title: 'Weekly plan',
      children: [paragraph('Hi')],
      icon: { type: 'emoji', emoji: '🗓' },
    });
    expect([call.method, call.url]).toEqual(['POST', `${NOTION_API_BASE}/pages`]);
    expect(call.json).toEqual({
      parent: { type: 'page_id', page_id: PAGE },
      properties: { title: { title: [{ type: 'text', text: { content: 'Weekly plan' } }] } },
      children: [paragraph('Hi')],
      icon: { type: 'emoji', emoji: '🗓' },
      notifications: SILENT,
    });
  });

  test('update_page : the title only when given, silent', async () => {
    const call = await only(TOOL.updatePage, {
      page_id: PAGE,
      cover: { type: 'external', external: { url: 'https://img.example.org/c.png' } },
    });
    expect([call.method, call.url]).toEqual(['PATCH', `${NOTION_API_BASE}/pages/${PAGE}`]);
    expect(call.json).toEqual({
      cover: { type: 'external', external: { url: 'https://img.example.org/c.png' } },
      notifications: SILENT,
    });
  });

  test('append_blocks : the three positions, silent', async () => {
    const children = [paragraph('x')];
    const end = await only(TOOL.appendBlocks, { block_id: PAGE, children });
    expect([end.method, end.url]).toEqual(['PATCH', `${NOTION_API_BASE}/blocks/${PAGE}/children`]);
    expect(end.json).toEqual({ children, notifications: SILENT });
    const start = await only(TOOL.appendBlocks, { block_id: PAGE, children, position: 'start' });
    expect(start.json).toEqual({ children, position: { type: 'start' }, notifications: SILENT });
    const after = await only(TOOL.appendBlocks, {
      block_id: PAGE,
      children,
      position: 'after_block',
      after_block_id: BLOCK,
    });
    expect(after.json).toEqual({
      children,
      position: { type: 'after_block', after_block: { id: BLOCK } },
      notifications: SILENT,
    });
  });

  test('update_block : the object keyed by its type ; no notifications field (not documented there)', async () => {
    const call = await only(TOOL.updateBlock, {
      block_id: BLOCK,
      type: 'paragraph',
      content: { rich_text: text('New') },
    });
    expect([call.method, call.url]).toEqual(['PATCH', `${NOTION_API_BASE}/blocks/${BLOCK}`]);
    expect(call.json).toEqual({ paragraph: { rich_text: text('New') } });
  });

  test('delete_block : DELETE, no body', async () => {
    const call = await only(TOOL.deleteBlock, { block_id: BLOCK });
    expect([call.method, call.url, call.body]).toEqual([
      'DELETE',
      `${NOTION_API_BASE}/blocks/${BLOCK}`,
      null,
    ]);
  });

  test('trash and restore : in_trash, silent', async () => {
    const trash = await only(TOOL.trashPage, { page_id: CHILD });
    expect([trash.method, trash.url]).toEqual(['PATCH', `${NOTION_API_BASE}/pages/${CHILD}`]);
    expect(trash.json).toEqual({ in_trash: true, notifications: SILENT });
    const restore = await only(TOOL.restorePage, { page_id: CHILD });
    expect(restore.json).toEqual({ in_trash: false, notifications: SILENT });
  });

  test('entries : a data source parent, the values as given, silent', async () => {
    const properties = { Name: { title: text('Task') }, Project: { relation: [{ id: ENTRY }] } };
    const create = await only(TOOL.createEntry, { data_source_id: DS, properties }, [dbRoot]);
    expect([create.method, create.url]).toEqual(['POST', `${NOTION_API_BASE}/pages`]);
    expect(create.json).toEqual({
      parent: { type: 'data_source_id', data_source_id: DS },
      properties,
      notifications: SILENT,
    });
    const update = await only(
      TOOL.updateEntry,
      { data_source_id: DS, page_id: ENTRY, properties: { Done: { checkbox: true } } },
      [dbRoot],
    );
    expect([update.method, update.url]).toEqual(['PATCH', `${NOTION_API_BASE}/pages/${ENTRY}`]);
    expect(update.json).toEqual({
      properties: { Done: { checkbox: true } },
      notifications: SILENT,
    });
  });

  test('query : pages only, the page size always sent', async () => {
    const call = await only(
      TOOL.queryDataSource,
      { data_source_id: DS, filter: { property: 'Done', checkbox: { equals: false } } },
      [dbRoot],
    );
    expect([call.method, call.url]).toEqual([
      'POST',
      `${NOTION_API_BASE}/data_sources/${DS}/query`,
    ]);
    expect(call.json).toEqual({
      filter: { property: 'Done', checkbox: { equals: false } },
      page_size: 50,
      result_type: 'page',
    });
  });

  test('comments : a page parent or a block parent from the walked target ; a reply by discussion', async () => {
    const onPage = await only(TOOL.createComment, { block_id: PAGE, rich_text: text('x') });
    expect(onPage.json).toEqual({ parent: { page_id: PAGE }, rich_text: text('x') });
    const onBlock = await only(TOOL.createComment, { block_id: BLOCK, rich_text: text('x') });
    expect(onBlock.json).toEqual({ parent: { block_id: BLOCK }, rich_text: text('x') });
    const reply = await only(TOOL.createComment, {
      block_id: PAGE,
      rich_text: text('x'),
      discussion_id: DISCUSSION.replaceAll('-', ''),
    });
    expect(reply.json).toEqual({ discussion_id: DISCUSSION, rich_text: text('x') });
  });

  test('list_comments and search : query string and body', async () => {
    const fetch = worldFetch({
      method: 'GET',
      url: /\/comments\?/,
      body: { results: [], has_more: false },
    });
    await execute(ctx(fetch), TOOL.listComments, { block_id: PAGE, start_cursor: 'abc-123' });
    expect(fetch.calls.at(-1)!.url).toBe(
      `${NOTION_API_BASE}/comments?block_id=${PAGE}&page_size=20&start_cursor=abc-123`,
    );
    const search = mockFetch([
      { method: 'POST', url: `${NOTION_API_BASE}/search`, body: { results: [], has_more: false } },
    ]);
    await execute(ctx(search), TOOL.searchContent, {
      query: 'plan',
      object: 'page',
      sort: { direction: 'descending', timestamp: 'last_edited_time' },
    });
    expect(search.calls[0]!.json).toEqual({
      query: 'plan',
      sort: { direction: 'descending', timestamp: 'last_edited_time' },
      filter: { property: 'object', value: 'page' },
      page_size: 20,
    });
  });

  test('list_roots sends nothing', async () => {
    const fetch = mockFetch([]);
    const result = await execute(ctx(fetch, [pageRoot, dbRoot, otherRoot]), TOOL.listRoots, {});
    expect(payload(result)).toEqual({
      roots: [
        { id: ROOT, title: 'Handbook', kind: 'page' },
        { id: DB, title: 'Tasks', kind: 'database' },
        { id: otherRoot.ref, title: 'Board', kind: 'page' },
      ],
    });
    expect(fetch.calls).toEqual([]);
  });
});

describe('declined by the executor : nothing is sent', () => {
  test('an undeclared argument, a malformed id, a root outside the mission', async () => {
    const fetch = mockFetch([]);
    expect(
      await refusalText(
        execute(ctx(fetch), TOOL.updatePage, { page_id: PAGE, title: 't', erase_content: true }),
      ),
    ).toMatch(/^erase_content: not an argument/);
    expect(
      await refusalText(
        execute(ctx(fetch), TOOL.trashPage, { page_id: PAGE, notifications: { mode: 'default' } }),
      ),
    ).toMatch(/^notifications: not an argument/);
    expect(await refusalText(execute(ctx(fetch), TOOL.getPage, { page_id: '..' }))).toMatch(
      /malformed Notion id/,
    );
    expect(
      await refusalText(execute(ctx(fetch), TOOL.getPage, { root: otherRoot.ref, page_id: PAGE })),
    ).toMatch(/not selected in this mission/);
    expect(await refusalText(execute(ctx(fetch), 'notion__nope', {}))).toBe(
      "unknown tool 'notion__nope'",
    );
    expect(fetch.calls).toEqual([]);
  });

  test('update_block of another type, delete_block of a page or a database', async () => {
    const fetch = worldFetch();
    expect(
      await refusalText(
        execute(ctx(fetch), TOOL.updateBlock, { block_id: BLOCK, type: 'to_do', content: {} }),
      ),
    ).toBe(`notion: block '${BLOCK}' is a 'paragraph', not a 'to_do' — give its own type`);
    expect(await refusalText(execute(ctx(fetch), TOOL.deleteBlock, { block_id: PAGE }))).toMatch(
      /is a page — move it to the trash with notion__trash_page/,
    );
    const db = worldFetch(served('blocks', block(CHILD, 'child_database', pageParent(PAGE))));
    expect(await refusalText(execute(ctx(db), TOOL.deleteBlock, { block_id: CHILD }))).toMatch(
      /is a database/,
    );
    expect([...writes(fetch), ...writes(db)]).toEqual([]);
  });

  test('a credential without its token field is refused before any request', async () => {
    const fetch = mockFetch([]);
    await expect(
      execute(
        { ...ctx(fetch), credential: { kind: 'api-key', fields: {}, metadata: {} } },
        TOOL.getPage,
        { page_id: PAGE },
      ),
    ).rejects.toThrow(/'api_token'/);
    expect(fetch.calls).toEqual([]);
  });
});

describe('ceilings', () => {
  test(`search proves at most ${MAX_SEARCH_VERIFY_REQUESTS} ancestors ; the rest is hidden and counted`, async () => {
    const results = Array.from({ length: 30 }, (_, i) =>
      page(
        `${(i + 1).toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`,
        pageParent(`${(i + 101).toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`),
      ),
    );
    const parents = Array.from({ length: 30 }, (_, i) =>
      served(
        'pages',
        page(
          `${(i + 101).toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`,
          pageParent(ROOT),
        ),
      ),
    );
    const fetch = mockFetch([
      {
        method: 'POST',
        url: `${NOTION_API_BASE}/search`,
        body: { results, has_more: true, next_cursor: 'next-1' },
      },
      ...parents,
    ]);
    const body = payload(await execute(ctx(fetch), TOOL.searchContent, { query: 'x' }));
    expect((body.results as unknown[]).length).toBe(MAX_SEARCH_VERIFY_REQUESTS);
    expect(body.results_hidden).toBe(30 - MAX_SEARCH_VERIFY_REQUESTS);
    expect(body).toMatchObject({ next_cursor: 'next-1', has_more: true });
  });

  test(`depth expands nested blocks, sub-pages excepted, at most ${MAX_CHILD_REQUESTS} listings`, async () => {
    const toggles = Array.from({ length: MAX_CHILD_REQUESTS + 2 }, (_, i) =>
      block(
        `${(i + 1).toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`,
        'toggle',
        pageParent(PAGE),
        { has_children: true },
      ),
    );
    const sub = block(CHILD, 'child_page', pageParent(PAGE), { has_children: true });
    const fetch = worldFetch(
      {
        method: 'GET',
        url: `${NOTION_API_BASE}/blocks/${PAGE}/children?page_size=50`,
        body: { object: 'list', results: [sub, ...toggles], has_more: false },
      },
      {
        method: 'GET',
        url: /\/children\?page_size=100$/,
        body: {
          object: 'list',
          results: [block(BLOCK, 'paragraph', pageParent(PAGE))],
          has_more: false,
        },
      },
    );
    const body = payload(
      await execute(ctx(fetch), TOOL.listBlockChildren, { block_id: PAGE, depth: 2 }),
    );
    const listed = body.results as { id: string; children?: unknown[] }[];
    expect(listed[0]!.children).toBeUndefined();
    expect(listed.filter((b) => b.children).length).toBe(MAX_CHILD_REQUESTS);
    const notExpanded = body.not_expanded as { id: string; reason: string }[];
    expect(notExpanded[0]).toEqual({
      id: CHILD,
      reason: 'a sub-page or a database: read it with its own call',
    });
    expect(notExpanded.slice(1).every((n) => /listings in one call/.test(n.reason))).toBe(true);
    expect(notExpanded).toHaveLength(3);
  });

  test('a synced copy is expanded only when its original is under the root', async () => {
    const copy = block(SYNCED, 'synced_block', pageParent(PAGE), {
      has_children: true,
      synced_block: { synced_from: { type: 'block_id', block_id: ORIGINAL } },
    });
    const fetch = worldFetch(
      {
        method: 'GET',
        url: `${NOTION_API_BASE}/blocks/${PAGE}/children?page_size=50`,
        body: { object: 'list', results: [copy], has_more: false },
      },
      served('blocks', block(ORIGINAL, 'synced_block', pageParent(otherRoot.ref))),
    );
    const body = payload(
      await execute(ctx(fetch), TOOL.listBlockChildren, { block_id: PAGE, depth: 3 }),
    );
    expect(body.not_expanded).toEqual([
      { id: SYNCED, reason: 'a synced copy whose original is not under this root' },
    ]);
    expect(fetch.calls.some((c) => c.url.includes(`/blocks/${SYNCED}/children`))).toBe(false);
  });
});
