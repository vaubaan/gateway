/**
 * Execution of the `notion` tools.
 *
 * Handbook : docs/handbook/providers/notion.md.
 *
 * Order, for every tool :
 *   1. the undeclared-argument rule and `readCall`, the classifier's own
 *      reader : the request is built from what it returned, never from
 *      `args` (safe when called without `classify`) ;
 *   2. the ancestry walk (`ancestry.ts`) for every id the call acts on —
 *      reads included, the boundary of a mission being a confidentiality
 *      boundary — before anything is written or returned, and before
 *      anything is said about the object (its kind, its type, its parent) ;
 *      the pages and databases a written value links to or mentions are
 *      walked too, within one budget per call ; a deletion first lists what
 *      is nested in the block and refuses one that holds a page or a
 *      database ;
 *   3. the request. Every write whose endpoint accepts it is sent with
 *      `notifications: { mode: "silent" }` (product owner, 2026-10-16) :
 *      create a page, update a page (trash and restore included), append
 *      block children. Update a block, delete a block and create a comment
 *      document no such field.
 *
 * Declines are `ExecutorRefusal` under `declining` ; provider failures are
 * thrown (`api.ts`).
 */

import {
  ExecutorRefusal,
  declining,
  refusalResult,
  type ExecuteContext,
  type McpToolResult,
  type Resource,
} from '@vaubaan/plugin-sdk';

import { Ancestry, type WalkBudget } from './ancestry.ts';
import { request } from './api.ts';
import { readCall, undeclaredArgument, type NotionCall } from './classify.ts';
import { CONTAINER_BLOCK_TYPES, type References } from './content.ts';
import { cursor, notionId } from './ids.ts';
import { PROVIDER_ID } from './identity.ts';
import { isObject, type Json } from './json.ts';

/** Extra requests a search may spend proving its results under the root. */
export const MAX_SEARCH_VERIFY_REQUESTS = 25;
/** Blocks one `list_block_children` call returns at most, nested ones included. */
export const MAX_BLOCKS_PER_CALL = 500;
/** Child listings one `list_block_children` call makes at most with `depth` > 1. */
export const MAX_CHILD_REQUESTS = 20;
/** Pages of comments read to find the discussion a reply names. */
export const MAX_REPLY_LOOKUP_PAGES = 5;
/** Requests one write may spend proving the pages and databases its values point at. */
export const MAX_REFERENCE_WALK_REQUESTS = 50;
/** Child listings read before a deletion, to find a page or a database nested in the block. */
export const MAX_DELETE_SCAN_REQUESTS = 20;

const SILENT = { mode: 'silent' } as const;

type CallOf<Op extends NotionCall['op']> = Extract<NotionCall, { op: Op }>;

function text(payload: unknown): McpToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
}

function paging(pageSize: number, startCursor: string | null): Record<string, unknown> {
  return { page_size: pageSize, ...(startCursor ? { start_cursor: startCursor } : {}) };
}

function pagingQuery(pageSize: number, startCursor: string | null): URLSearchParams {
  const query = new URLSearchParams({ page_size: String(pageSize) });
  if (startCursor) query.set('start_cursor', startCursor);
  return query;
}

function commentQuery(
  blockId: string,
  pageSize: number,
  startCursor: string | null,
): URLSearchParams {
  const query = new URLSearchParams({ block_id: blockId });
  for (const [key, value] of pagingQuery(pageSize, startCursor)) query.set(key, value);
  return query;
}

/** Only the fields the agent gave : an absent value is not sent. */
function given(fields: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== undefined && value !== null),
  );
}

function titleProperty(title: string): Json {
  return { title: { title: [{ type: 'text', text: { content: title } }] } };
}

export function executeNotion(
  ctx: ExecuteContext,
  tool: string,
  args: Readonly<Record<string, unknown>>,
): Promise<McpToolResult> {
  return declining(async () => {
    const undeclared = undeclaredArgument(tool, args);
    if (undeclared) return refusalResult(undeclared);
    const call = readCall(tool, args, ctx.resources);
    if ('denied' in call) return refusalResult(call.denied);
    if (call.op === 'listRoots') return text({ roots: rootsOf(ctx.resources) });
    const walk = new Ancestry(ctx, call.root.ref);
    return text(await run(ctx, walk, call));
  });
}

function rootsOf(resources: readonly Resource[]) {
  return resources
    .filter((r) => r.provider === PROVIDER_ID)
    .map((r) => ({
      id: notionId(r.ref),
      title: r.displayName,
      kind: typeof r.metadata?.kind === 'string' ? r.metadata.kind : null,
    }));
}

async function run(
  ctx: ExecuteContext,
  walk: Ancestry,
  call: Exclude<NotionCall, { op: 'listRoots' }>,
): Promise<unknown> {
  switch (call.op) {
    case 'searchContent':
      return search(ctx, walk, call);
    case 'getPage': {
      const page = await walk.fetch('page', call.pageId);
      await walk.prove('page', call.pageId, page);
      return page;
    }
    case 'getDatabase': {
      const database = await walk.fetch('database', call.databaseId);
      await walk.prove('database', call.databaseId, database);
      return database;
    }
    case 'getDataSource': {
      const source = await walk.fetch('data_source', call.dataSourceId);
      await walk.prove('data_source', call.dataSourceId, source);
      return source;
    }
    case 'listBlockChildren':
      return listChildren(ctx, walk, call);
    case 'queryDataSource':
      await walk.prove('data_source', call.dataSourceId);
      return request(ctx, 'POST', `/data_sources/${call.dataSourceId}/query`, {
        body: {
          ...given({ filter: call.filter, sorts: call.sorts }),
          ...paging(call.pageSize, call.startCursor),
          result_type: 'page',
        },
      });
    case 'createPage':
      await walk.prove('page', call.parentPageId);
      await proveReferences(walk, call.references);
      return request(ctx, 'POST', '/pages', {
        body: {
          parent: { type: 'page_id', page_id: call.parentPageId },
          properties: titleProperty(call.title),
          ...given({ children: call.children, icon: call.icon, cover: call.cover }),
          notifications: SILENT,
        },
      });
    case 'updatePage': {
      // Proven first : nothing is said of an object outside the root, its kind included.
      const page = await walk.fetch('page', call.pageId);
      await walk.prove('page', call.pageId, page);
      const parent = isObject(page.parent) ? page.parent.type : undefined;
      if (parent === 'data_source_id' || parent === 'database_id') {
        throw new ExecutorRefusal(
          `notion: page '${call.pageId}' is an entry of a database — change it with notion__update_entry`,
        );
      }
      return request(ctx, 'PATCH', `/pages/${call.pageId}`, {
        body: {
          ...(call.title !== null ? { properties: titleProperty(call.title) } : {}),
          ...given({ icon: call.icon, cover: call.cover }),
          notifications: SILENT,
        },
      });
    }
    case 'appendBlocks': {
      await proveBlockAndOriginal(walk, call.blockId);
      if (call.position.type === 'after_block')
        await walk.prove('block', call.position.afterBlockId);
      await proveReferences(walk, call.references);
      const position =
        call.position.type === 'end'
          ? {}
          : call.position.type === 'start'
            ? { position: { type: 'start' } }
            : {
                position: { type: 'after_block', after_block: { id: call.position.afterBlockId } },
              };
      return request(ctx, 'PATCH', `/blocks/${call.blockId}/children`, {
        body: { children: call.children, ...position, notifications: SILENT },
      });
    }
    case 'updateBlock': {
      const block = await walk.fetch('block', call.blockId);
      await walk.prove('block', call.blockId, block);
      if (block.type !== call.type) {
        throw new ExecutorRefusal(
          `notion: block '${call.blockId}' is a '${String(block.type)}', not a '${call.type}' — give its own type`,
        );
      }
      await proveReferences(walk, call.references);
      return request(ctx, 'PATCH', `/blocks/${call.blockId}`, {
        body: { [call.type]: call.content },
      });
    }
    case 'deleteBlock': {
      const block = await walk.fetch('block', call.blockId);
      await walk.prove('block', call.blockId, block);
      if (typeof block.type === 'string' && CONTAINER_BLOCK_TYPES.has(block.type)) {
        throw new ExecutorRefusal(
          block.type === 'child_page'
            ? `notion: block '${call.blockId}' is a page — move it to the trash with notion__trash_page`
            : `notion: block '${call.blockId}' is a database, which this plugin does not delete`,
        );
      }
      // A synced copy shows its original's content without holding it : deleting the
      // copy trashes nothing of the original, whose tree is never read from here.
      // Absent `has_children` is read as "may have some" (fail closed).
      if (block.has_children !== false && syncedOriginOf(block) === null) {
        await refuseNestedContainers(ctx, call.blockId);
      }
      return request(ctx, 'DELETE', `/blocks/${call.blockId}`);
    }
    case 'trashPage':
    case 'restorePage': {
      const page = await walk.fetch('page', call.pageId);
      await walk.prove('page', call.pageId, page);
      return request(ctx, 'PATCH', `/pages/${call.pageId}`, {
        body: { in_trash: call.op === 'trashPage', notifications: SILENT },
      });
    }
    case 'createEntry':
      await walk.prove('data_source', call.dataSourceId);
      await proveReferences(walk, call.references);
      return request(ctx, 'POST', '/pages', {
        body: {
          parent: { type: 'data_source_id', data_source_id: call.dataSourceId },
          properties: call.properties,
          ...given({ children: call.children, icon: call.icon }),
          notifications: SILENT,
        },
      });
    case 'updateEntry': {
      const page = await walk.fetch('page', call.pageId);
      await walk.prove('page', call.pageId, page);
      const parent = isObject(page.parent) ? page.parent : {};
      if (
        parent.type !== 'data_source_id' ||
        notionId(parent.data_source_id) !== call.dataSourceId
      ) {
        throw new ExecutorRefusal(
          `notion: page '${call.pageId}' is not an entry of the data source '${call.dataSourceId}'`,
        );
      }
      await proveReferences(walk, call.references);
      return request(ctx, 'PATCH', `/pages/${call.pageId}`, {
        body: { properties: call.properties, ...given({ icon: call.icon }), notifications: SILENT },
      });
    }
    case 'listComments':
      await walk.prove('block', call.blockId);
      return request(ctx, 'GET', '/comments', {
        query: commentQuery(call.blockId, call.pageSize, call.startCursor),
      });
    case 'createComment':
      return comment(ctx, walk, call);
  }
}

/**
 * Every page and database a written value points at — relation targets,
 * mentions, links to a page — is under the root, within one budget of
 * requests for the call ; a budget that runs out declines the call.
 */
async function proveReferences(walk: Ancestry, references: References): Promise<void> {
  const budget: WalkBudget = { left: MAX_REFERENCE_WALK_REQUESTS };
  for (const id of references.pages) await walk.prove('page', id, undefined, budget);
  for (const id of references.databases) await walk.prove('database', id, undefined, budget);
}

/**
 * Deleting a block trashes everything nested in it, pages and databases
 * included : the descendants are listed first, within a budget, and the
 * deletion is refused when one is a page or a database, or when the budget
 * runs out before the whole tree was seen (fail closed). A synced copy met on
 * the way is not descended into : its children are its original's, which may
 * live under another root and which deleting the copy does not trash. Every
 * block listed is therefore nested in the proven target, so naming one in a
 * refusal names an object under the root.
 */
async function refuseNestedContainers(ctx: ExecuteContext, blockId: string): Promise<void> {
  const queue: string[] = [blockId];
  let listings = 0;
  while (queue.length > 0) {
    const parent = queue.shift()!;
    let startCursor: string | null = null;
    do {
      if (listings >= MAX_DELETE_SCAN_REQUESTS) {
        throw new ExecutorRefusal(
          `notion: block '${blockId}' holds more nested content than one call checks (${MAX_DELETE_SCAN_REQUESTS} listings) — delete its parts one by one`,
        );
      }
      listings += 1;
      const listed = await request(ctx, 'GET', `/blocks/${parent}/children`, {
        query: pagingQuery(100, startCursor),
      });
      if (!isObject(listed) || !Array.isArray(listed.results)) {
        throw new ExecutorRefusal('notion: unexpected block list (expected { results })');
      }
      for (const child of listed.results) {
        const id = isObject(child) ? notionId(child.id) : null;
        if (!isObject(child) || !id) {
          throw new ExecutorRefusal('notion: unexpected block in a block list');
        }
        if (typeof child.type === 'string' && CONTAINER_BLOCK_TYPES.has(child.type)) {
          throw new ExecutorRefusal(
            `notion: block '${blockId}' contains ${child.type === 'child_page' ? 'a page' : 'a database'} ('${id}'), which deleting it would trash — move the page to the trash with notion__trash_page, or delete the other blocks one by one`,
          );
        }
        if (child.has_children !== false && syncedOriginOf(child) === null) queue.push(id);
      }
      startCursor = listed.has_more === true ? cursor(listed.next_cursor) : null;
      if (listed.has_more === true && !startCursor) {
        throw new ExecutorRefusal('notion: unexpected next_cursor in a block list');
      }
    } while (startCursor);
  }
}

/** A synced copy shows its original's content : the original must be under the root too. */
type SyncedOrigin = { readonly original: string } | { readonly unreadable: true } | null;

function syncedOriginOf(block: Json): SyncedOrigin {
  if (block.type !== 'synced_block' || !isObject(block.synced_block)) return null;
  const from = block.synced_block.synced_from;
  if (from === null || from === undefined) return null;
  const original = isObject(from) ? notionId(from.block_id) : null;
  return original ? { original } : { unreadable: true };
}

async function proveBlockAndOriginal(walk: Ancestry, blockId: string): Promise<Json> {
  const block = await walk.fetch('block', blockId);
  await walk.prove('block', blockId, block);
  const origin = syncedOriginOf(block);
  if (origin && 'unreadable' in origin) {
    throw new ExecutorRefusal(
      `notion: block '${blockId}' is a synced copy whose original cannot be read`,
    );
  }
  if (origin) await walk.prove('block', origin.original);
  return block;
}

// ─── Search : results filtered to the root ───────────────────────────────────

async function search(ctx: ExecuteContext, walk: Ancestry, call: CallOf<'searchContent'>) {
  const answer = await request(ctx, 'POST', '/search', {
    body: {
      ...given({ query: call.query, sort: call.sort }),
      ...(call.object ? { filter: { property: 'object', value: call.object } } : {}),
      ...paging(call.pageSize, call.startCursor),
    },
  });
  if (!isObject(answer) || !Array.isArray(answer.results)) {
    throw new ExecutorRefusal('notion: unexpected search answer (expected { results })');
  }
  const budget: WalkBudget = { left: MAX_SEARCH_VERIFY_REQUESTS };
  const shown: unknown[] = [];
  for (const result of answer.results) {
    const kind = isObject(result)
      ? result.object === 'page'
        ? 'page'
        : result.object === 'data_source'
          ? 'data_source'
          : null
      : null;
    const id = isObject(result) ? notionId(result.id) : null;
    // A result not proven under the root is dropped silently : a count would tell of other roots.
    if (!kind || !id || !isObject(result)) continue;
    if ((await walk.check(kind, id, result, budget)) === 'in') shown.push(result);
  }
  return {
    results: shown,
    next_cursor: answer.next_cursor ?? null,
    has_more: answer.has_more ?? false,
    ...(answer.request_status !== undefined ? { request_status: answer.request_status } : {}),
  };
}

// ─── Block children, with depth ──────────────────────────────────────────────

interface Expansion {
  /** Listings and synced-original walks of the call, together. */
  readonly budget: WalkBudget;
  blocks: number;
  readonly notExpanded: { id: string; reason: string }[];
}

async function listChildren(
  ctx: ExecuteContext,
  walk: Ancestry,
  call: CallOf<'listBlockChildren'>,
) {
  await proveBlockAndOriginal(walk, call.blockId);
  const first = await request(ctx, 'GET', `/blocks/${call.blockId}/children`, {
    query: pagingQuery(call.pageSize, call.startCursor),
  });
  if (!isObject(first) || !Array.isArray(first.results)) {
    throw new ExecutorRefusal('notion: unexpected block list (expected { results })');
  }
  if (call.depth === 1) return first;
  const state: Expansion = {
    budget: { left: MAX_CHILD_REQUESTS },
    blocks: first.results.length,
    notExpanded: [],
  };
  const results = await expand(ctx, walk, first.results, call.depth - 1, state);
  return {
    ...first,
    results,
    ...(state.notExpanded.length > 0 ? { not_expanded: state.notExpanded } : {}),
  };
}

async function expand(
  ctx: ExecuteContext,
  walk: Ancestry,
  blocks: readonly unknown[],
  levels: number,
  state: Expansion,
): Promise<unknown[]> {
  const out: unknown[] = [];
  for (const block of blocks) {
    if (!isObject(block) || block.has_children !== true || levels <= 0) {
      out.push(block);
      continue;
    }
    const id = notionId(block.id);
    const why = await whyNotExpanded(walk, block, id, state);
    if (why || !id) {
      state.notExpanded.push({ id: String(block.id), reason: why ?? 'malformed id' });
      out.push(block);
      continue;
    }
    state.budget.left -= 1;
    const listed = await request(ctx, 'GET', `/blocks/${id}/children`, {
      query: pagingQuery(100, null),
    });
    if (!isObject(listed) || !Array.isArray(listed.results)) {
      throw new ExecutorRefusal('notion: unexpected block list (expected { results })');
    }
    const room = MAX_BLOCKS_PER_CALL - state.blocks;
    const kept = listed.results.slice(0, Math.max(0, room));
    state.blocks += kept.length;
    const nested = await expand(ctx, walk, kept, levels - 1, state);
    out.push({
      ...block,
      children: nested,
      ...(listed.has_more === true || kept.length < listed.results.length
        ? { children_has_more: true }
        : {}),
    });
  }
  return out;
}

async function whyNotExpanded(
  walk: Ancestry,
  block: Json,
  id: string | null,
  state: Expansion,
): Promise<string | null> {
  if (!id) return 'malformed id';
  if (typeof block.type === 'string' && CONTAINER_BLOCK_TYPES.has(block.type)) {
    return 'a sub-page or a database: read it with its own call';
  }
  if (state.budget.left <= 0) return `more than ${MAX_CHILD_REQUESTS} requests in one call`;
  if (state.blocks >= MAX_BLOCKS_PER_CALL)
    return `more than ${MAX_BLOCKS_PER_CALL} blocks in one call`;
  const origin = syncedOriginOf(block);
  if (origin && 'unreadable' in origin) return 'a synced copy whose original cannot be read';
  if (!origin) return null;
  const verdict = await walk.check('block', origin.original, undefined, state.budget);
  if (verdict === 'out') return 'a synced copy whose original is not under this root';
  if (verdict === 'unknown') return `more than ${MAX_CHILD_REQUESTS} requests in one call`;
  // The walk may have spent the last request : the listing needs one more.
  return state.budget.left <= 0 ? `more than ${MAX_CHILD_REQUESTS} requests in one call` : null;
}

// ─── Comments ────────────────────────────────────────────────────────────────

async function comment(ctx: ExecuteContext, walk: Ancestry, call: CallOf<'createComment'>) {
  const target = await walk.fetch('block', call.blockId);
  await walk.prove('block', call.blockId, target);
  await proveReferences(walk, call.references);
  if (call.discussionId) {
    await requireOpenDiscussion(ctx, call.blockId, call.discussionId);
    return request(ctx, 'POST', '/comments', {
      body: { discussion_id: call.discussionId, rich_text: call.richText },
    });
  }
  const parent =
    target.type === 'child_page' ? { page_id: call.blockId } : { block_id: call.blockId };
  return request(ctx, 'POST', '/comments', { body: { parent, rich_text: call.richText } });
}

/** A reply lands only on an open discussion of the block the walk proved. */
async function requireOpenDiscussion(
  ctx: ExecuteContext,
  blockId: string,
  discussionId: string,
): Promise<void> {
  let startCursor: string | null = null;
  for (let page = 0; page < MAX_REPLY_LOOKUP_PAGES; page += 1) {
    const query = commentQuery(blockId, 100, startCursor);
    const listed = await request(ctx, 'GET', '/comments', { query });
    if (!isObject(listed) || !Array.isArray(listed.results)) {
      throw new ExecutorRefusal('notion: unexpected comment list (expected { results })');
    }
    if (listed.results.some((c) => isObject(c) && notionId(c.discussion_id) === discussionId))
      return;
    const next = cursor(listed.next_cursor);
    if (listed.has_more !== true || !next) break;
    startCursor = next;
  }
  throw new ExecutorRefusal(
    `notion: discussion '${discussionId}' is not an open discussion of '${blockId}'`,
  );
}
