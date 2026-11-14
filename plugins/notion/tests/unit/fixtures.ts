/**
 * Test fixtures of the `notion` plugin : canonical ids, mission resources,
 * Notion objects shaped like the API reference (2026-03-11), and routes that
 * serve them to `mockFetch`. No test calls Notion.
 */
import type { ExecuteContext, Resource } from '@vaubaan/plugin-sdk';
import { mockFetch, type MockFetch, type MockRoute } from '@vaubaan/plugin-sdk/testing';

import { NOTION_API_BASE } from '../../src/api.ts';
import {
  BLOCK,
  DB,
  DISCUSSION,
  DS,
  ENTRY,
  EXAMPLE_DB_ROOT,
  EXAMPLE_PAGE_ROOT,
  OTHER_ROOT,
  PAGE,
  ROOT,
} from '../../src/examples.ts';
import { API_TOKEN_FIELD, PROVIDER_ID } from '../../src/identity.ts';

const id = (digit: string) =>
  `${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}`;

// The ids and roots the plugin's `examples` run on (`src/examples.ts`).
export { BLOCK, DB, DISCUSSION, DS, ENTRY, OTHER_ROOT, PAGE, ROOT };
export const CHILD = id('3');
export const FOREIGN = id('9');
export const SYNCED = id('b');
export const ORIGINAL = id('c');

export const TOKEN = 'ntn_test_token_0123456789';

export const pageRoot: Resource = EXAMPLE_PAGE_ROOT;
export const dbRoot: Resource = EXAMPLE_DB_ROOT;
export const otherRoot: Resource = {
  provider: PROVIDER_ID,
  ref: OTHER_ROOT,
  displayName: 'Board',
  metadata: { kind: 'page' },
};

export type Json = Record<string, unknown>;

export const workspace = { type: 'workspace', workspace: true };
export const pageParent = (pageId: string) => ({ type: 'page_id', page_id: pageId });
export const blockParent = (blockId: string) => ({ type: 'block_id', block_id: blockId });
export const sourceParent = (sourceId: string, databaseId: string) => ({
  type: 'data_source_id',
  data_source_id: sourceId,
  database_id: databaseId,
});

export function page(pageId: string, parent: unknown, title = 'A page'): Json {
  return {
    object: 'page',
    id: pageId,
    parent,
    in_trash: false,
    properties: { title: { id: 'title', type: 'title', title: [{ plain_text: title }] } },
  };
}

export function block(blockId: string, type: string, parent: unknown, extra: Json = {}): Json {
  return { object: 'block', id: blockId, type, parent, has_children: false, [type]: {}, ...extra };
}

export function dataSource(sourceId: string, databaseId: string, databaseParent: unknown): Json {
  return {
    object: 'data_source',
    id: sourceId,
    parent: { type: 'database_id', database_id: databaseId },
    database_parent: databaseParent,
    title: [{ plain_text: 'Tasks' }],
  };
}

export function database(databaseId: string, parent: unknown): Json {
  return { object: 'database', id: databaseId, parent, data_sources: [{ id: DS, name: 'Tasks' }] };
}

type Endpoint = 'pages' | 'blocks' | 'databases' | 'data_sources';

/** `GET /v1/<endpoint>/<id>` answering `body`. */
export const served = (endpoint: Endpoint, body: Json): MockRoute => ({
  method: 'GET',
  url: `${NOTION_API_BASE}/${endpoint}/${String(body.id)}`,
  body,
});

/** `GET /v1/<endpoint>/<id>` answering 404 `object_not_found`. */
export const hidden = (endpoint: Endpoint, objectId: string): MockRoute => ({
  method: 'GET',
  url: `${NOTION_API_BASE}/${endpoint}/${objectId}`,
  status: 404,
  body: { object: 'error', status: 404, code: 'object_not_found', message: 'Could not find it.' },
});

/**
 * The standard world : the root page at the top of the workspace, a page
 * under it, a paragraph in that page ; the root database with its data
 * source and one entry ; another root of the account with a page.
 */
export function world(): MockRoute[] {
  return [
    served('pages', page(ROOT, workspace, 'Handbook')),
    served('blocks', block(ROOT, 'child_page', workspace, { has_children: true })),
    served('pages', page(PAGE, pageParent(ROOT))),
    served('blocks', block(PAGE, 'child_page', pageParent(ROOT), { has_children: true })),
    served('pages', page(CHILD, pageParent(PAGE))),
    served('blocks', block(BLOCK, 'paragraph', pageParent(PAGE))),
    served('databases', database(DB, workspace)),
    served('data_sources', dataSource(DS, DB, workspace)),
    served('pages', page(ENTRY, sourceParent(DS, DB))),
    served('pages', page(OTHER_ROOT, workspace, 'Board')),
    served('pages', page(FOREIGN, pageParent(OTHER_ROOT))),
    served('blocks', block(FOREIGN, 'child_page', pageParent(OTHER_ROOT))),
  ];
}

/** Answers every write with its JSON body echoed, for the request tests. */
export const echoWrites: MockRoute = {
  url: (url) => url.startsWith(NOTION_API_BASE),
  respond: (call) => ({ object: 'echo', method: call.method, sent: call.json ?? null }),
};

export function ctx(fetch: MockFetch, resources: readonly Resource[] = [pageRoot]): ExecuteContext {
  return {
    credential: { kind: 'api-key', fields: { [API_TOKEN_FIELD]: TOKEN }, metadata: {} },
    fetch,
    resources,
  };
}

/** A fetch over the standard world plus `routes` (tried first), writes echoed. */
export function worldFetch(...routes: MockRoute[]): MockFetch {
  return mockFetch([...routes, ...world(), echoWrites]);
}

/** The requests other than the walk's `GET`s : what the call itself sent. */
export function writes(fetch: MockFetch) {
  return fetch.calls.filter((c) => c.method !== 'GET');
}

export function payload(result: { content: readonly { type: string; text?: string }[] }): Json {
  const [first] = result.content;
  return JSON.parse(first?.type === 'text' ? (first.text ?? '') : '') as Json;
}
