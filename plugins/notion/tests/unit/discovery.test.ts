/**
 * Discovery (top-level detection, ceilings, unknown payloads) and the check
 * of a pasted token (`verify` : internal connections only).
 */
import { describe, expect, test } from 'vitest';

import { mockFetch, type MockRoute } from '@vaubaan/plugin-sdk/testing';

import { NOTION_API_BASE } from '../../src/api.ts';
import { notionCredential } from '../../src/credential.ts';
import { MAX_SEARCH_PAGES } from '../../src/discovery.ts';
import { notionPlugin } from '../../src/index.ts';
import {
  BLOCK,
  CHILD,
  DB,
  DS,
  ENTRY,
  FOREIGN,
  OTHER_ROOT,
  PAGE,
  ROOT,
  blockParent,
  ctx,
  dataSource,
  hidden,
  page,
  pageParent,
  sourceParent,
  workspace,
} from './fixtures.ts';

const searchFor = (
  value: 'page' | 'data_source',
  results: unknown[],
  extra: Record<string, unknown> = {},
): MockRoute => ({
  method: 'POST',
  url: `${NOTION_API_BASE}/search`,
  respond: (call) =>
    (call.json as { filter: { value: string } }).filter.value === value
      ? { results, has_more: false, next_cursor: null, ...extra }
      : { results: [], has_more: false, next_cursor: null },
  times: 1,
});

function discovery(routes: MockRoute[]) {
  const fetch = mockFetch(routes);
  return { fetch, run: () => notionPlugin.discoverResources(ctx(fetch)) };
}

describe('discoverResources', () => {
  test('keeps the top of the workspace and objects whose parent this token cannot read', async () => {
    const pages = [
      page(ROOT, workspace, 'Handbook'),
      page(PAGE, pageParent(ROOT)),
      page(OTHER_ROOT, pageParent(FOREIGN), 'Board'), // shared alone, its parent is not
      page(CHILD, blockParent(BLOCK)), // under a block of a shared page : not a root
      page(ENTRY, sourceParent(DS, DB)), // an entry of a shared database
      { ...page(FOREIGN, workspace), in_trash: true }, // in the trash : ignored
    ];
    const pageSearch: MockRoute = {
      method: 'POST',
      url: `${NOTION_API_BASE}/search`,
      body: { results: pages, has_more: false, next_cursor: null },
      times: 1,
    };
    const { fetch, run } = discovery([
      pageSearch,
      searchFor('data_source', [dataSource(DS, DB, workspace)]),
      hidden('pages', FOREIGN),
      {
        method: 'GET',
        url: `${NOTION_API_BASE}/blocks/${BLOCK}`,
        body: { object: 'block', id: BLOCK },
      },
    ]);
    expect(await run()).toEqual([
      { provider: 'notion', ref: ROOT, displayName: 'Handbook', metadata: { kind: 'page' } },
      { provider: 'notion', ref: OTHER_ROOT, displayName: 'Board', metadata: { kind: 'page' } },
      { provider: 'notion', ref: DB, displayName: 'Tasks', metadata: { kind: 'database' } },
    ]);
    expect(fetch.calls.map((c) => c.json)).toContainEqual({
      filter: { property: 'object', value: 'page' },
      page_size: 100,
    });
  });

  test('a database inside a shared page is not a root ; its parent read when the data source omits it', async () => {
    const source = { ...dataSource(DS, DB, undefined), database_parent: undefined };
    const { run } = discovery([
      searchFor('page', [page(ROOT, workspace, 'Handbook')]),
      searchFor('data_source', [source]),
      {
        method: 'GET',
        url: `${NOTION_API_BASE}/databases/${DB}`,
        body: { object: 'database', id: DB, parent: pageParent(ROOT) },
      },
    ]);
    expect((await run()).map((r) => r.ref)).toEqual([ROOT]);
  });

  test('pages through search, and fails rather than truncating', async () => {
    let n = 0;
    const endless: MockRoute = {
      method: 'POST',
      url: `${NOTION_API_BASE}/search`,
      respond: () => ({ results: [], has_more: true, next_cursor: `c-${(n += 1)}` }),
    };
    const { fetch, run } = discovery([endless]);
    await expect(run()).rejects.toThrow(/more than 2000 pages/);
    expect(fetch.calls).toHaveLength(MAX_SEARCH_PAGES);
    expect(fetch.calls[1]!.json).toMatchObject({ start_cursor: 'c-1' });
  });

  test('refuses a payload it does not recognise', async () => {
    const odd = discovery([
      { method: 'POST', url: `${NOTION_API_BASE}/search`, body: { data: [] } },
    ]);
    await expect(odd.run()).rejects.toThrow(/unexpected search answer/);
    const badId = discovery([
      searchFor('page', [{ object: 'page', id: '../x', parent: workspace }]),
    ]);
    await expect(badId.run()).rejects.toThrow(/unexpected page/);
    const badCursor = discovery([
      {
        method: 'POST',
        url: `${NOTION_API_BASE}/search`,
        body: { results: [], has_more: true, next_cursor: 'a/b' },
      },
    ]);
    await expect(badCursor.run()).rejects.toThrow(/next_cursor/);
  });

  test('a provider failure while probing a parent is thrown', async () => {
    const { run } = discovery([
      searchFor('page', [page(CHILD, pageParent(FOREIGN))]),
      searchFor('data_source', []),
      { method: 'GET', url: `${NOTION_API_BASE}/pages/${FOREIGN}`, status: 503, body: {} },
    ]);
    await expect(run()).rejects.toMatchObject({ name: 'UpstreamHttpError', status: 503 });
  });
});

describe('verify : internal connection tokens only', () => {
  const verify = notionCredential.verify;
  const me = (body: unknown) =>
    mockFetch([{ method: 'GET', url: `${NOTION_API_BASE}/users/me`, body }]);

  test('a bot owned by the workspace : its workspace name, no expiry', async () => {
    const fetch = me({
      object: 'user',
      type: 'bot',
      bot: { owner: { type: 'workspace', workspace: true }, workspace_name: 'Acme' },
    });
    expect(await verify(ctx(fetch))).toEqual({ account: 'Acme', expiresAt: null });
    expect(fetch.calls[0]!.headers.authorization).toMatch(/^Bearer ntn_/);
  });

  test('a personal access token (a bot owned by a user) is refused', async () => {
    const fetch = me({
      object: 'user',
      type: 'bot',
      bot: { owner: { type: 'user', user: { id: PAGE } } },
    });
    const refused = verify(ctx(fetch));
    await expect(refused).rejects.toMatchObject({ name: 'CredentialRefusal' });
    await expect(refused).rejects.toThrow(/not a personal access token/);
  });

  test('a token Notion rejects', async () => {
    const fetch = mockFetch([
      { url: `${NOTION_API_BASE}/users/me`, status: 401, body: { code: 'unauthorized' } },
    ]);
    await expect(verify(ctx(fetch))).rejects.toMatchObject({
      name: 'UpstreamAuthError',
      upstreamStatus: 401,
    });
  });

  test('the field pattern accepts both token prefixes and refuses whitespace', () => {
    const field = notionCredential.fields[0]!;
    const pattern = new RegExp(field.pattern!);
    expect(pattern.test('ntn_0123456789abcdefghij')).toBe(true);
    expect(pattern.test('secret_0123456789abcdefghij')).toBe(true);
    expect(pattern.test('ntn_0123 456789abcdefghij')).toBe(false);
    expect(pattern.test('short')).toBe(false);
  });
});

describe('the guide : pages are shared before the paste', () => {
  test('the share step comes before the copy, so the first discovery finds the pages', () => {
    const steps = notionCredential.guide.steps.map((step) => step.do);
    const share = steps.findIndex((step) => step.startsWith('Share every top-level page'));
    expect(share).toBeGreaterThan(-1);
    expect(share).toBeLessThan(steps.length - 1);
    expect(steps.at(-1)).toMatch(/paste it here/);
    expect(notionCredential.guide.expiry.kind).toBe('none');
  });
});
