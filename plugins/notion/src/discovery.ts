/**
 * Resource discovery of the `notion` provider : one resource per top-level
 * page or database shared with the connection.
 *
 * Handbook : docs/handbook/providers/notion.md.
 *
 * Search cannot enumerate everything a connection reaches, but "any pages
 * or databases that are directly shared with a connection are guaranteed to
 * be returned" — and a root is directly shared by definition. Discovery
 * pages through search for pages, then for data sources (a database is
 * found through its data sources), and keeps an object whose parent is the
 * workspace, or whose parent is neither in what search returned nor readable
 * with this token (a `GET` answering 404). Every payload goes through a type
 * guard, every id through `notionId` ; a payload it does not recognise, or a
 * search that does not end within the ceilings, fails the discovery.
 */

import type { ConnectionContext, Resource } from '@vaubaan/plugin-sdk';

import { failureOf, request, send } from './api.ts';
import { cursor, notionId } from './ids.ts';
import { PROVIDER_ID } from './identity.ts';
import { isObject, type Json } from './json.ts';
import { ENDPOINT, parentRef } from './parents.ts';

/** Search pages read per kind of object (100 objects each). */
export const MAX_SEARCH_PAGES = 20;
/** Most roots one connection exposes. */
export const MAX_DISCOVERED_ROOTS = 200;

function fail(message: string): never {
  throw new Error(`${PROVIDER_ID}: ${message}`);
}

async function searchAll(ctx: ConnectionContext, value: 'page' | 'data_source'): Promise<Json[]> {
  const found: Json[] = [];
  let next: string | null = null;
  for (let page = 0; page < MAX_SEARCH_PAGES; page += 1) {
    const answer = await request(ctx, 'POST', '/search', {
      body: {
        filter: { property: 'object', value },
        page_size: 100,
        ...(next ? { start_cursor: next } : {}),
      },
    });
    if (
      !isObject(answer) ||
      !Array.isArray(answer.results) ||
      typeof answer.has_more !== 'boolean'
    ) {
      return fail('unexpected search answer (expected { results, has_more })');
    }
    for (const result of answer.results) {
      if (!isObject(result) || result.object !== value || !notionId(result.id)) {
        return fail(`unexpected ${value} in the search answer`);
      }
      if (result.in_trash !== true) found.push(result);
    }
    if (!answer.has_more) return found;
    next = cursor(answer.next_cursor) ?? fail('unexpected next_cursor in the search answer');
  }
  return fail(
    `search returned more than ${MAX_SEARCH_PAGES * 100} ${value === 'page' ? 'pages' : 'data sources'}: share fewer top-level pages with the connection`,
  );
}

/** True when an object with this parent is a root : the workspace, or a parent this token neither found nor reads. */
async function isTopLevel(
  ctx: ConnectionContext,
  parent: unknown,
  found: ReadonlySet<string>,
): Promise<boolean> {
  const ref = parentRef(parent);
  if ('end' in ref) {
    if (ref.end === 'workspace') return true;
    if (ref.end === 'agent') return false; // an agent's instruction page : under no shared page
    return fail('unexpected parent in the search answer');
  }
  const { kind, id } = ref.node;
  if (found.has(id) || (ref.database !== undefined && found.has(ref.database))) return false;
  const path = `${ENDPOINT[kind]}/${id}`;
  const answer = await send(ctx, 'GET', path);
  if (answer.status === 404) return true;
  if (answer.status < 200 || answer.status >= 300) throw failureOf('GET', path, answer);
  return false;
}

function plainText(value: unknown): string {
  if (!Array.isArray(value)) return '';
  return value
    .map((item) => (isObject(item) && typeof item.plain_text === 'string' ? item.plain_text : ''))
    .join('')
    .trim();
}

function pageTitle(page: Json): string {
  const properties = isObject(page.properties) ? Object.values(page.properties) : [];
  const title = properties.find((p) => isObject(p) && p.type === 'title');
  return (isObject(title) && plainText(title.title)) || 'Untitled';
}

export async function discoverNotionResources(
  ctx: ConnectionContext,
): Promise<readonly Resource[]> {
  const pages = await searchAll(ctx, 'page');
  const sources = await searchAll(ctx, 'data_source');
  const databases = new Map<string, { readonly source: Json; readonly databaseParent: unknown }>();
  for (const source of sources) {
    const parent = isObject(source.parent) ? source.parent : {};
    const database = parent.type === 'database_id' ? notionId(parent.database_id) : null;
    if (!database) return fail('unexpected data source parent (expected a database)');
    if (!databases.has(database)) {
      databases.set(database, { source, databaseParent: source.database_parent });
    }
  }
  const found = new Set<string>([
    ...pages.map((p) => notionId(p.id)!),
    ...sources.map((s) => notionId(s.id)!),
    ...databases.keys(),
  ]);

  const roots: Resource[] = [];
  for (const page of pages) {
    if (await isTopLevel(ctx, page.parent, found)) {
      roots.push({
        provider: PROVIDER_ID,
        ref: notionId(page.id)!,
        displayName: pageTitle(page),
        metadata: { kind: 'page' },
      });
    }
  }
  for (const [database, { source, databaseParent }] of databases) {
    const parent = databaseParent ?? (await databaseParentOf(ctx, database));
    if (await isTopLevel(ctx, parent, found)) {
      roots.push({
        provider: PROVIDER_ID,
        ref: database,
        displayName: plainText(source.title) || 'Untitled',
        metadata: { kind: 'database' },
      });
    }
  }
  if (roots.length > MAX_DISCOVERED_ROOTS) {
    return fail(
      `more than ${MAX_DISCOVERED_ROOTS} top-level pages and databases are shared with the connection`,
    );
  }
  return roots;
}

/** A database's own parent, when its data source did not carry it. */
async function databaseParentOf(ctx: ConnectionContext, database: string): Promise<unknown> {
  const answer = await request(ctx, 'GET', `/databases/${database}`);
  if (!isObject(answer) || notionId(answer.id) !== database)
    return fail('unexpected database answer');
  return answer.parent;
}
