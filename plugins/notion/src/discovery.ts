/**
 * Resource discovery of the `notion` service : one resource per top-level
 * page or database shared with the account.
 *
 * Handbook : docs/handbook/services/notion.md.
 *
 * Search cannot enumerate everything an account reaches, but "any pages
 * or databases that are directly shared with an account are guaranteed to
 * be returned" — and a root is directly shared by definition. Discovery
 * pages through search for pages, then for data sources (a database is
 * found through its data sources), and keeps an object whose parent is the
 * workspace, or whose parent is neither in what search returned nor readable
 * with this token (a `GET` answering 404). Every payload goes through a type
 * guard, every id through `notionId` ; a payload it does not recognise is
 * Notion's failure (`UpstreamProtocolError`), and a search that does not end
 * within the ceilings fails the discovery (a plain `Error`).
 */

import {
  UpstreamProtocolError,
  anyJson,
  isList,
  isRecord,
  type AccountContext,
  type Resource,
} from '@vaubaan/plugin-sdk';

import { readOrMissing, request } from './api.ts';
import { cursor, notionId } from './ids.ts';
import { SERVICE_ID } from './identity.ts';
import { isResultList, type Json, type ResultList } from './json.ts';
import { ENDPOINT, parentRef } from './parents.ts';

/** Search pages read per kind of object (100 objects each). */
export const MAX_SEARCH_PAGES = 20;
/** Most roots one account exposes. */
export const MAX_DISCOVERED_ROOTS = 200;

/** A ceiling of discovery reached : the account shares more than one discovery reads. */
function tooMany(message: string): never {
  throw new Error(`${SERVICE_ID}: ${message}`);
}

/** Notion answered something discovery does not recognise : its failure, not the plugin's. */
function unexpected(message: string): never {
  throw new UpstreamProtocolError(`Notion discovery: ${message}`);
}

/** A page of search results : `has_more` says whether to ask for the next one. */
interface SearchPage extends ResultList {
  readonly has_more: boolean;
}

function isSearchPage(value: unknown): value is SearchPage {
  return isResultList(value) && typeof value.has_more === 'boolean';
}

async function searchAll(ctx: AccountContext, value: 'page' | 'data_source'): Promise<Json[]> {
  const found: Json[] = [];
  let next: string | null = null;
  for (let page = 0; page < MAX_SEARCH_PAGES; page += 1) {
    // Shape : a search answer `{ results, has_more }`.
    const answer: SearchPage = await request(ctx, 'POST', '/search', isSearchPage, {
      body: {
        filter: { property: 'object', value },
        page_size: 100,
        ...(next ? { start_cursor: next } : {}),
      },
    });
    for (const result of answer.results) {
      if (!isRecord(result) || result.object !== value || !notionId(result.id)) {
        return unexpected(`unexpected ${value} in the search answer`);
      }
      if (result.in_trash !== true) found.push(result);
    }
    if (!answer.has_more) return found;
    next = cursor(answer.next_cursor) ?? unexpected('unexpected next_cursor in the search answer');
  }
  return tooMany(
    `search returned more than ${MAX_SEARCH_PAGES * 100} ${value === 'page' ? 'pages' : 'data sources'}: share fewer top-level pages with the account`,
  );
}

/** True when an object with this parent is a root : the workspace, or a parent this token neither found nor reads. */
async function isTopLevel(
  ctx: AccountContext,
  parent: unknown,
  found: ReadonlySet<string>,
): Promise<boolean> {
  const ref = parentRef(parent);
  if ('end' in ref) {
    if (ref.end === 'workspace') return true;
    if (ref.end === 'agent') return false; // an agent's instruction page : under no shared page
    return unexpected('unexpected parent in the search answer');
  }
  const { kind, id } = ref.node;
  if (found.has(id) || (ref.database !== undefined && found.has(ref.database))) return false;
  // Its body is not read : that the parent answers at all is the fact.
  return (await readOrMissing(ctx, `${ENDPOINT[kind]}/${id}`, anyJson)) === null;
}

function plainText(value: unknown): string {
  if (!isList(value)) return '';
  return value
    .map((item) => (isRecord(item) && typeof item.plain_text === 'string' ? item.plain_text : ''))
    .join('')
    .trim();
}

function pageTitle(page: Json): string {
  const properties = isRecord(page.properties) ? Object.values(page.properties) : [];
  const title = properties.find((p) => isRecord(p) && p.type === 'title');
  return (isRecord(title) && plainText(title.title)) || 'Untitled';
}

export async function discoverNotionResources(ctx: AccountContext): Promise<readonly Resource[]> {
  const pages = await searchAll(ctx, 'page');
  const sources = await searchAll(ctx, 'data_source');
  const databases = new Map<string, { readonly source: Json; readonly databaseParent: unknown }>();
  for (const source of sources) {
    const parent = isRecord(source.parent) ? source.parent : {};
    const database = parent.type === 'database_id' ? notionId(parent.database_id) : null;
    if (!database) return unexpected('unexpected data source parent (expected a database)');
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
        service: SERVICE_ID,
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
        service: SERVICE_ID,
        ref: database,
        displayName: plainText(source.title) || 'Untitled',
        metadata: { kind: 'database' },
      });
    }
  }
  if (roots.length > MAX_DISCOVERED_ROOTS) {
    return tooMany(
      `more than ${MAX_DISCOVERED_ROOTS} top-level pages and databases are shared with the account`,
    );
  }
  return roots;
}

/** A database's own parent, when its data source did not carry it. */
async function databaseParentOf(ctx: AccountContext, database: string): Promise<unknown> {
  const answer = await request(ctx, 'GET', `/databases/${database}`, isRecord);
  if (notionId(answer.id) !== database) return unexpected('unexpected database answer');
  return answer.parent;
}
