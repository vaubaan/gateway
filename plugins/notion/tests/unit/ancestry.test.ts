/**
 * The ancestry check (handbook) : every id a call acts on is walked up
 * to the call's root before anything is written or returned.
 */
import { describe, expect, test } from 'vitest';

import { UpstreamProtocolError } from '@vaubaan/plugin-sdk';
import { mockFetch, refusalText } from '@vaubaan/plugin-sdk/testing';

import { MAX_ANCESTRY_DEPTH } from '../../src/ancestry.ts';
import { NOTION_API_BASE } from '../../src/api.ts';
import { TOOL } from '../../src/identity.ts';
import { notionPlugin } from '../../src/index.ts';
import {
  BLOCK,
  CHILD,
  DB,
  DISCUSSION,
  DS,
  ENTRY,
  FOREIGN,
  ORIGINAL,
  PAGE,
  ROOT,
  SYNCED,
  block,
  blockParent,
  ctx,
  dataSource,
  dbRoot,
  echoWrites,
  hidden,
  page,
  pageParent,
  served,
  sourceParent,
  workspace,
  worldFetch,
  writes,
} from './fixtures.ts';

const execute = notionPlugin.execute.bind(notionPlugin);
const gets = (fetch: ReturnType<typeof worldFetch>) =>
  fetch.calls.filter((c) => c.method === 'GET').map((c) => c.url.replace(NOTION_API_BASE, ''));
const hex = (n: number) => `${n.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`;
const text = (content: string) => [{ type: 'text', text: { content } }];

describe('proven', () => {
  test('the root itself : no hop beyond its own read', async () => {
    const fetch = worldFetch();
    await execute(ctx(fetch), TOOL.getPage, { page_id: ROOT });
    expect(gets(fetch)).toEqual([`/pages/${ROOT}`]);
  });

  test('one and two levels down', async () => {
    const one = worldFetch();
    expect((await execute(ctx(one), TOOL.getPage, { page_id: PAGE })).isError).toBeUndefined();
    expect(gets(one)).toEqual([`/pages/${PAGE}`]);
    const two = worldFetch();
    await execute(ctx(two), TOOL.getPage, { page_id: CHILD });
    expect(gets(two)).toEqual([`/pages/${CHILD}`, `/pages/${PAGE}`]);
  });

  test('a block through its page', async () => {
    const fetch = worldFetch();
    await execute(ctx(fetch), TOOL.deleteBlock, { block_id: BLOCK });
    expect(gets(fetch)).toEqual([`/blocks/${BLOCK}`, `/pages/${PAGE}`]);
    expect(writes(fetch).map((c) => `${c.method} ${c.url}`)).toEqual([
      `DELETE ${NOTION_API_BASE}/blocks/${BLOCK}`,
    ]);
  });

  test('an entry of a database root in one request, through the database_id its parent carries', async () => {
    const fetch = worldFetch();
    await execute(ctx(fetch, [dbRoot]), TOOL.getPage, { page_id: ENTRY });
    expect(gets(fetch)).toEqual([`/pages/${ENTRY}`]);
  });

  test("a data source proven two levels up in one request, through its database's parent", async () => {
    const inline = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    const source = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    const fetch = worldFetch(served('data_sources', dataSource(source, inline, pageParent(ROOT))));
    await execute(ctx(fetch), TOOL.getDataSource, { data_source_id: source });
    expect(gets(fetch)).toEqual([`/data_sources/${source}`]);
  });
});

describe('refused, before any write and before any result leaves', () => {
  test('a page of another root : the chain reaches the workspace', async () => {
    const fetch = worldFetch();
    expect(await refusalText(execute(ctx(fetch), TOOL.getPage, { page_id: FOREIGN }))).toBe(
      `notion: page '${FOREIGN}' is not under the shared root '${ROOT}' of this call`,
    );
    const write = worldFetch();
    await refusalText(execute(ctx(write), TOOL.trashPage, { page_id: FOREIGN }));
    expect(writes(write)).toEqual([]);
  });

  test('an agent instruction page, a parent kind not known', async () => {
    const agentPage = page(CHILD, { type: 'agent_id', agent_id: PAGE });
    const fetch = mockFetch([served('pages', agentPage)]);
    expect(await refusalText(execute(ctx(fetch), TOOL.getPage, { page_id: CHILD }))).toMatch(
      /is not under the shared root/,
    );
    const odd = mockFetch([served('pages', page(CHILD, { type: 'team_id', team_id: PAGE }))]);
    expect(await refusalText(execute(ctx(odd), TOOL.getPage, { page_id: CHILD }))).toMatch(
      /is not under the shared root/,
    );
  });

  test('an ancestor this token cannot read (404) is outside every root', async () => {
    const fetch = mockFetch([
      served('pages', page(CHILD, pageParent(FOREIGN))),
      hidden('pages', FOREIGN),
      echoWrites,
    ]);
    expect(
      await refusalText(
        execute(ctx(fetch), TOOL.createPage, { parent_page_id: CHILD, title: 'x' }),
      ),
    ).toMatch(/is not under the shared root/);
    expect(writes(fetch)).toEqual([]);
  });

  test('a malformed parent id is refused ; an answer that is not the object asked for is Notion’s failure', async () => {
    const bad = mockFetch([served('pages', page(CHILD, { type: 'page_id', page_id: '../x' }))]);
    expect(await refusalText(execute(ctx(bad), TOOL.getPage, { page_id: CHILD }))).toMatch(
      /not under/,
    );
    const swapped = mockFetch([
      {
        method: 'GET',
        url: `${NOTION_API_BASE}/pages/${CHILD}`,
        body: page(FOREIGN, pageParent(ROOT)),
      },
    ]);
    const failure = execute(ctx(swapped), TOOL.getPage, { page_id: CHILD });
    await expect(failure).rejects.toBeInstanceOf(UpstreamProtocolError);
    await expect(failure).rejects.toThrow(/is not that page/);
  });

  test('a cycle', async () => {
    const fetch = mockFetch([
      served('pages', page(CHILD, pageParent(PAGE))),
      served('pages', page(PAGE, pageParent(CHILD))),
    ]);
    expect(await refusalText(execute(ctx(fetch), TOOL.getPage, { page_id: CHILD }))).toMatch(
      /not under/,
    );
  });

  test(`deeper than ${MAX_ANCESTRY_DEPTH} levels`, async () => {
    const chain = Array.from({ length: MAX_ANCESTRY_DEPTH + 2 }, (_, i) =>
      served(
        'pages',
        page(hex(i + 1), i === MAX_ANCESTRY_DEPTH + 1 ? pageParent(ROOT) : pageParent(hex(i + 2))),
      ),
    );
    const fetch = mockFetch(chain);
    expect(await refusalText(execute(ctx(fetch), TOOL.getPage, { page_id: hex(1) }))).toBe(
      `notion: page '${hex(1)}' could not be shown to be under the shared root '${ROOT}' of this call within ${MAX_ANCESTRY_DEPTH} levels`,
    );
    const shallow = mockFetch(chain.slice(2));
    expect(
      (await execute(ctx(shallow), TOOL.getPage, { page_id: hex(3) })).isError,
    ).toBeUndefined();
  });

  test('a relation target outside the root', async () => {
    const fetch = worldFetch();
    const result = execute(ctx(fetch, [dbRoot]), TOOL.createEntry, {
      data_source_id: DS,
      properties: { Project: { relation: [{ id: FOREIGN }] } },
    });
    expect(await refusalText(result)).toMatch(
      new RegExp(`page '${FOREIGN}' is not under the shared root '${DB}'`),
    );
    expect(writes(fetch)).toEqual([]);
  });

  test('an entry is not a page, and an entry of another data source is not this one', async () => {
    const asPage = worldFetch();
    expect(
      await refusalText(
        execute(ctx(asPage, [dbRoot]), TOOL.updatePage, { page_id: ENTRY, title: 'x' }),
      ),
    ).toMatch(/entry of a database — change it with notion__update_entry/);
    const other = worldFetch();
    expect(
      await refusalText(
        execute(ctx(other), TOOL.updateEntry, {
          data_source_id: DS,
          page_id: PAGE,
          properties: {},
        }),
      ),
    ).toMatch(new RegExp(`page '${PAGE}' is not an entry of the data source '${DS}'`));
    expect([...writes(asPage), ...writes(other)]).toEqual([]);
  });

  test('a reply to a discussion that is not an open discussion of the block', async () => {
    const fetch = worldFetch({
      method: 'GET',
      url: /\/comments\?/,
      body: { results: [{ id: BLOCK, discussion_id: BLOCK }], has_more: false },
    });
    const result = execute(ctx(fetch), TOOL.createComment, {
      block_id: PAGE,
      rich_text: text('x'),
      discussion_id: DISCUSSION,
    });
    expect(await refusalText(result)).toBe(
      `notion: discussion '${DISCUSSION}' is not an open discussion of '${PAGE}'`,
    );
    expect(writes(fetch)).toEqual([]);
  });

  test('a synced copy whose original lives elsewhere', async () => {
    const copy = block(SYNCED, 'synced_block', pageParent(PAGE), {
      synced_block: { synced_from: { type: 'block_id', block_id: ORIGINAL } },
    });
    const fetch = worldFetch(
      served('blocks', copy),
      served('blocks', block(ORIGINAL, 'synced_block', pageParent(FOREIGN))),
    );
    expect(
      await refusalText(
        execute(ctx(fetch), TOOL.appendBlocks, {
          block_id: SYNCED,
          children: [{ type: 'paragraph', paragraph: { rich_text: text('x') } }],
        }),
      ),
    ).toMatch(new RegExp(`block '${ORIGINAL}' is not under the shared root`));
    expect(writes(fetch)).toEqual([]);
  });
});

describe("the provider's failures are thrown, not refused", () => {
  test('the target itself not found (404) : the answer to the agent, thrown', async () => {
    const fetch = mockFetch([hidden('pages', CHILD)]);
    await expect(execute(ctx(fetch), TOOL.getPage, { page_id: CHILD })).rejects.toMatchObject({
      name: 'UpstreamHttpError',
      status: 404,
    });
    const walked = mockFetch([hidden('pages', CHILD)]);
    await expect(
      execute(ctx(walked), TOOL.createPage, { parent_page_id: CHILD, title: 'x' }),
    ).rejects.toMatchObject({ name: 'UpstreamHttpError', status: 404 });
  });

  test('401 and 403 on a hop are UpstreamAuthError ; 429 carries Retry-After', async () => {
    const unauthorized = mockFetch([
      { url: () => true, status: 401, body: { code: 'unauthorized' } },
    ]);
    await expect(execute(ctx(unauthorized), TOOL.getPage, { page_id: PAGE })).rejects.toMatchObject(
      {
        name: 'UpstreamAuthError',
        upstreamStatus: 401,
      },
    );
    const restricted = mockFetch([
      served('pages', page(CHILD, pageParent(PAGE))),
      {
        url: `${NOTION_API_BASE}/pages/${PAGE}`,
        status: 403,
        body: { code: 'restricted_resource' },
      },
    ]);
    await expect(execute(ctx(restricted), TOOL.getPage, { page_id: CHILD })).rejects.toMatchObject({
      name: 'UpstreamAuthError',
      upstreamStatus: 403,
    });
    const limited = mockFetch([
      {
        url: () => true,
        status: 429,
        headers: { 'retry-after': '3' },
        body: { code: 'rate_limited' },
      },
    ]);
    const thrown = execute(ctx(limited), TOOL.getPage, { page_id: PAGE });
    await expect(thrown).rejects.toMatchObject({ name: 'UpstreamHttpError', status: 429 });
    await expect(thrown).rejects.toThrow(/retry after 3 s/);
  });
});

describe('memo within one call', () => {
  test('search results that share ancestors walk them once ; results outside are dropped silently, never named or counted', async () => {
    const results = [
      page(CHILD, pageParent(PAGE)),
      page(BLOCK, pageParent(PAGE)),
      page(FOREIGN, { type: 'database_id', database_id: DB }),
    ];
    const fetch = mockFetch([
      {
        method: 'POST',
        url: `${NOTION_API_BASE}/search`,
        body: { results, has_more: false, next_cursor: null },
      },
      served('pages', page(PAGE, pageParent(ROOT))),
      served('databases', { object: 'database', id: DB, parent: workspace }),
    ]);
    const result = await execute(ctx(fetch), TOOL.searchContent, { query: 'plan' });
    const body = JSON.parse((result.content[0] as { text: string }).text) as Record<
      string,
      unknown
    >;
    expect((body.results as { id: string }[]).map((r) => r.id)).toEqual([CHILD, BLOCK]);
    expect('results_hidden' in body).toBe(false);
    expect(JSON.stringify(body)).not.toContain(FOREIGN);
    expect(gets(fetch)).toEqual([`/pages/${PAGE}`, `/databases/${DB}`]);
  });

  test('a block whose parent is a block', async () => {
    const nested = block(SYNCED, 'paragraph', blockParent(BLOCK));
    const fetch = worldFetch(served('blocks', nested));
    await execute(ctx(fetch), TOOL.listComments, { block_id: SYNCED });
    expect(gets(fetch).filter((u) => !u.startsWith('/comments'))).toEqual([
      `/blocks/${SYNCED}`,
      `/blocks/${BLOCK}`,
      `/pages/${PAGE}`,
    ]);
  });

  test('a page under a data source parent is followed through its data source', async () => {
    const source = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    const inline = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    const row = page(CHILD, sourceParent(source, inline));
    const fetch = mockFetch([
      served('pages', row),
      served('data_sources', dataSource(source, inline, pageParent(PAGE))),
      served('pages', page(PAGE, pageParent(ROOT))),
    ]);
    expect((await execute(ctx(fetch), TOOL.getPage, { page_id: CHILD })).isError).toBeUndefined();
    expect(gets(fetch)).toEqual([`/pages/${CHILD}`, `/data_sources/${source}`, `/pages/${PAGE}`]);
  });
});
