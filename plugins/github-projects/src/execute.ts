/**
 * Upstream calls of the `github-projects` service, and discovery.
 *
 * Handbook : docs/handbook/services/github-projects.md §6.
 *
 * - The call is read by `readProjectCall` (`call.ts`), the classifier's own
 *   reader : the request names the project and the ids the slices named, or
 *   is not sent. Requests are built field by field from the checked call ; an
 *   argument the reader does not read never leaves.
 * - Every request goes through `httpJson` : failures are thrown typed (401 /
 *   403 `UpstreamAuthError`, other statuses `UpstreamHttpError`), declines are
 *   `refusalResult`s.
 * - A list answers its page and the cursors GitHub gives in the `Link`
 *   header (`next`, `previous`), so an agent can ask for the following page.
 */

import {
  UpstreamProtocolError,
  anyJson,
  httpJson,
  isRecord,
  jsonResult,
  refusalResult,
  type AccountContext,
  type ExecuteContext,
  type McpToolResult,
  type Resource,
} from '@vaubaan/plugin-sdk';

import { GITHUB_API_BASE, githubApiHeaders } from './api.ts';
import { isDenied, orgLogin, readProjectCall, type Page, type ProjectCall } from './call.ts';
import { fetchAccountProject, githubProjectsTokenOf } from './credential.ts';
import { SERVICE_ID } from './identity.ts';

export async function executeGithubProjects(
  ctx: ExecuteContext,
  tool: string,
  args: Readonly<Record<string, unknown>>,
): Promise<McpToolResult> {
  const call = readProjectCall(tool, args, ctx.resources);
  if (isDenied(call)) return refusalResult(call.denied);
  const base = `/orgs/${encodeURIComponent(call.project.org)}/projectsV2/${call.project.number}`;

  switch (call.kind) {
    case 'get-project':
      return jsonResult(await request(ctx, 'GET', base));
    case 'list-fields':
      return jsonResult(await listPage(ctx, `${base}/fields`, call.page, []));
    case 'get-field':
      return jsonResult(await request(ctx, 'GET', `${base}/fields/${call.fieldId}`));
    case 'list-items':
      return jsonResult(await listPage(ctx, `${base}/items`, call.page, call.fields, call.q));
    case 'get-item':
      return jsonResult(
        await request(ctx, 'GET', `${base}/items/${call.itemId}${query({ fields: call.fields })}`),
      );
    case 'list-view-items':
      return jsonResult(
        await listPage(ctx, `${base}/views/${call.viewNumber}/items`, call.page, call.fields),
      );
    case 'add-item':
      return jsonResult(await request(ctx, 'POST', `${base}/items`, call.content));
    case 'add-draft':
      return jsonResult(
        await request(ctx, 'POST', `${base}/drafts`, {
          title: call.title,
          ...(call.body !== undefined ? { body: call.body } : {}),
        }),
      );
    case 'update-item':
      return jsonResult(
        await request(ctx, 'PATCH', `${base}/items/${call.itemId}`, {
          fields: call.values.map((v) => ({ id: v.id, value: v.value })),
        }),
      );
    case 'delete-item':
      await request(ctx, 'DELETE', `${base}/items/${call.itemId}`);
      return jsonResult({ removed: call.itemId, project: call.project.ref });
    case 'create-field':
      return jsonResult(await request(ctx, 'POST', `${base}/fields`, fieldBody(call)));
    case 'create-view':
      return jsonResult(await request(ctx, 'POST', `${base}/views`, viewBody(call)));
  }
}

function fieldBody(call: Extract<ProjectCall, { kind: 'create-field' }>): unknown {
  const f = call.field;
  switch (f.dataType) {
    case 'single_select':
      return {
        name: f.name,
        data_type: f.dataType,
        single_select_options: f.options.map((o) => ({
          name: o.name,
          color: o.color,
          description: o.description,
        })),
      };
    case 'iteration':
      return {
        name: f.name,
        data_type: f.dataType,
        iteration_configuration: {
          start_date: f.startDate,
          duration: f.duration,
          iterations: f.iterations.map((i) => ({
            title: i.title,
            start_date: i.startDate,
            duration: i.duration,
          })),
        },
      };
    default:
      return { name: f.name, data_type: f.dataType };
  }
}

function viewBody(call: Extract<ProjectCall, { kind: 'create-view' }>): unknown {
  const v = call.view;
  return {
    name: v.name,
    layout: v.layout,
    ...(v.filter !== undefined ? { filter: v.filter } : {}),
    ...(v.visibleFields !== undefined ? { visible_fields: v.visibleFields } : {}),
    ...(v.sortBy !== undefined ? { sort_by: v.sortBy } : {}),
    ...(v.groupBy !== undefined ? { group_by: v.groupBy } : {}),
    ...(v.verticalGroupBy !== undefined ? { vertical_group_by: v.verticalGroupBy } : {}),
  };
}

/** A query string from checked values, built by `URLSearchParams` ; empty when there is nothing. */
function query(params: {
  readonly fields?: readonly number[];
  readonly q?: string;
  readonly page?: Page;
}): string {
  const search = new URLSearchParams();
  if (params.q !== undefined) search.set('q', params.q);
  if (params.fields !== undefined && params.fields.length > 0) {
    search.set('fields', params.fields.join(','));
  }
  if (params.page?.perPage !== undefined) search.set('per_page', String(params.page.perPage));
  if (params.page?.after !== undefined) search.set('after', params.page.after);
  if (params.page?.before !== undefined) search.set('before', params.page.before);
  const text = search.toString();
  return text === '' ? '' : `?${text}`;
}

/** One page of a list, with the cursors of the pages around it. */
export interface ListPage {
  readonly items: unknown;
  readonly next: string | null;
  readonly previous: string | null;
}

async function listPage(
  ctx: ExecuteContext,
  path: string,
  page: Page,
  fields: readonly number[],
  q?: string,
): Promise<ListPage> {
  let link: string | null = null;
  const fetchKeepingLink: typeof fetch = async (input, init) => {
    const res = await ctx.fetch(input, { ...init, redirect: 'error' });
    link = res.headers.get('link');
    return res;
  };
  const items = await request(
    { ...ctx, fetch: fetchKeepingLink },
    'GET',
    `${path}${query({ fields, page, ...(q !== undefined ? { q } : {}) })}`,
  );
  return {
    items,
    next: cursorOf(link, 'next', 'after'),
    previous: cursorOf(link, 'prev', 'before'),
  };
}

/**
 * The cursor GitHub puts in the `Link` header for `rel` : the `param` of that
 * URL (`<…?after=Y3Vy>; rel="next"`), or `null`.
 */
export function cursorOf(link: string | null, rel: string, param: string): string | null {
  if (!link) return null;
  for (const part of link.split(',')) {
    const m = /<([^>]*)>\s*;\s*rel="([^"]*)"/.exec(part);
    if (!m || m[2] !== rel) continue;
    try {
      return new URL(m[1]!).searchParams.get(param);
    } catch {
      return null;
    }
  }
  return null;
}

/** One call to GitHub with the account's token ; the answer is passed on as it is. */
async function request(
  ctx: AccountContext,
  method: string,
  path: string,
  body?: unknown,
): Promise<unknown> {
  return httpJson(
    ctx,
    {
      url: `${GITHUB_API_BASE}${path}`,
      method,
      headers: githubApiHeaders(githubProjectsTokenOf(ctx)),
      ...(body !== undefined ? { body } : {}),
      what: `${SERVICE_ID} ${method} ${path.split('?')[0] ?? path}`,
    },
    anyJson,
  );
}

// ─── discovery ─────────────────────────────────────────────────────────────

/**
 * The account's one project, in GitHub's spelling of the organization (its
 * `owner.login`) : a project the token no longer opens fails like `verify`.
 */
export async function discoverGithubProjectsResources(
  ctx: AccountContext,
): Promise<readonly Resource[]> {
  const project = await fetchAccountProject(ctx);
  const owner = isRecord(project.owner) ? orgLogin(project.owner.login) : null;
  const number =
    typeof project.number === 'number' && Number.isSafeInteger(project.number) && project.number > 0
      ? project.number
      : null;
  const title = typeof project.title === 'string' ? project.title : null;
  if (owner === null || number === null || title === null) {
    throw new UpstreamProtocolError(`${SERVICE_ID} GET project: unexpected answer`);
  }
  return [{ service: SERVICE_ID, ref: `${owner}/${number}`, displayName: title }];
}
