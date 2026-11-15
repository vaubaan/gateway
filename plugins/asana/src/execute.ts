/**
 * Execution of the `asana` tools.
 *
 * Handbook : docs/handbook/services/asana.md.
 *
 * Order, for every tool :
 *   1. `readCall`, the classifier's own reader : the requests are built from
 *      what it returned, field by field, never from `args` (safe when called
 *      without `classify`) ;
 *   2. the membership proof (`membership.ts`) for every task, parent and
 *      section the call names — reads included, the project of a mission
 *      being a confidentiality boundary — before anything is written or
 *      returned ;
 *   3. the request.
 *
 * What a task answer says about other projects is cut out : a task may live
 * in several projects, and the names of the others (or of their sections)
 * are not the mission's to read. Declines are `ExecutorRefusal` under
 * `declining` ; service failures are thrown (`api.ts`).
 */

import {
  ExecutorRefusal,
  UpstreamProtocolError,
  anyJson,
  declining,
  isList,
  isRecord,
  jsonResult,
  type ExecuteContext,
  type McpToolResult,
  type Resource,
} from '@vaubaan/plugin-sdk';

import {
  getObject,
  isDataList,
  isDataObject,
  nextOffsetOf,
  request,
  type DataList,
  type Json,
} from './api.ts';
import { readCall, type AsanaCall } from './call.ts';
import { offsetToken } from './ids.ts';
import { proveSectionInProject, proveTaskInProject } from './membership.ts';

/** The fields of a project `get_project` returns. */
export const PROJECT_FIELDS = [
  'name',
  'notes',
  'archived',
  'due_on',
  'start_on',
  'owner.name',
  'team.name',
  'workspace.name',
  'modified_at',
  'permalink_url',
] as const;

/**
 * The fields of a task every task tool returns. People are named, never
 * addressed : no email is asked. `memberships` comes with its project gid so
 * the memberships of other projects can be cut out (`shapeTask`).
 */
export const TASK_FIELDS = [
  'name',
  'completed',
  'due_on',
  'due_at',
  'assignee.name',
  'notes',
  'num_subtasks',
  'parent.gid',
  'memberships.project.gid',
  'memberships.section.name',
  'modified_at',
  'permalink_url',
] as const;

/** The fields of a comment `list_comments` and `add_comment` return. */
export const COMMENT_FIELDS = [
  'created_at',
  'created_by.name',
  'text',
  'resource_subtype',
] as const;

/** Pages of sections `list_sections` reads (100 each). */
export const MAX_SECTION_PAGES = 5;
/** Pages of comments `list_comments` reads (100 each). */
export const MAX_COMMENT_PAGES = 5;

const fields = (list: readonly string[]) => list.join(',');

/**
 * A task record as the agent reads it : `projects` dropped, `memberships`
 * kept for this project only and reduced to the section names.
 */
export function shapeTask(task: unknown, project: string): Json {
  if (!isRecord(task)) throw new UpstreamProtocolError('Asana: unexpected task in the answer');
  const { projects: _projects, memberships, ...rest } = task;
  const sections = isList(memberships)
    ? memberships.flatMap((m) => {
        if (!isRecord(m) || !isRecord(m.project) || m.project.gid !== project) return [];
        return isRecord(m.section) && typeof m.section.name === 'string' ? [m.section.name] : [];
      })
    : [];
  return { ...rest, sections };
}

/** The offset of the next page, through the grammar the agent's `offset` will meet. */
function nextOffset(list: DataList): string | null {
  const raw = nextOffsetOf(list);
  if (raw === null) return null;
  const offset = offsetToken(raw);
  if (!offset) throw new UpstreamProtocolError('Asana: unexpected next_page offset');
  return offset;
}

function projectsResult(projects: readonly Resource[]) {
  return projects.map((p) => ({
    gid: p.ref,
    name: p.displayName,
    workspace: p.metadata?.workspace_name ?? null,
    team: p.metadata?.team_name ?? null,
  }));
}

export function executeAsana(
  ctx: ExecuteContext,
  tool: string,
  args: Readonly<Record<string, unknown>>,
): Promise<McpToolResult> {
  return declining(async () => {
    const call = readCall(tool, args, ctx.resources);
    if ('denied' in call) throw new ExecutorRefusal(call.denied);
    return jsonResult(await run(ctx, call));
  });
}

async function readAll(
  ctx: ExecuteContext,
  path: string,
  query: URLSearchParams,
  maxPages: number,
  what: string,
): Promise<unknown[]> {
  const items: unknown[] = [];
  let offset: string | null = null;
  for (let page = 0; page < maxPages; page += 1) {
    const q = new URLSearchParams(query);
    q.set('limit', '100');
    if (offset) q.set('offset', offset);
    const list = await request(ctx, 'GET', path, isDataList, { query: q });
    items.push(...list.data);
    offset = nextOffset(list);
    if (!offset) return items;
  }
  throw new ExecutorRefusal(`more than ${maxPages * 100} ${what}: not read`);
}

async function run(ctx: ExecuteContext, call: AsanaCall): Promise<unknown> {
  switch (call.op) {
    case 'listProjects':
      return { projects: projectsResult(call.projects) };

    case 'getProject':
      return getObject(ctx, `/projects/${call.project}`, PROJECT_FIELDS);

    case 'listSections': {
      const sections = await readAll(
        ctx,
        `/projects/${call.project}/sections`,
        new URLSearchParams({ opt_fields: 'name' }),
        MAX_SECTION_PAGES,
        'sections',
      );
      return { sections };
    }

    case 'listTasks': {
      if (call.section) await proveSectionInProject(ctx, call.section, call.project);
      const path = call.section
        ? `/sections/${call.section}/tasks`
        : `/projects/${call.project}/tasks`;
      const query = new URLSearchParams({
        opt_fields: fields(TASK_FIELDS),
        limit: String(call.limit),
      });
      if (call.completedSince) query.set('completed_since', call.completedSince);
      if (call.offset) query.set('offset', call.offset);
      const list = await request(ctx, 'GET', path, isDataList, { query });
      return {
        tasks: list.data.map((t) => shapeTask(t, call.project)),
        next_offset: nextOffset(list),
      };
    }

    case 'searchTasks': {
      const query = new URLSearchParams({
        'projects.any': call.project,
        text: call.text,
        limit: String(call.limit),
        opt_fields: fields(TASK_FIELDS),
      });
      if (call.completed !== null) query.set('completed', String(call.completed));
      if (call.assignee) query.set('assignee.any', call.assignee);
      const list = await request(
        ctx,
        'GET',
        `/workspaces/${call.workspace}/tasks/search`,
        isDataList,
        {
          query,
        },
      );
      return { tasks: list.data.map((t) => shapeTask(t, call.project)) };
    }

    case 'getTask': {
      const task = await proveTaskInProject(ctx, call.task, call.project, TASK_FIELDS);
      return shapeTask(task, call.project);
    }

    case 'listComments': {
      await proveTaskInProject(ctx, call.task, call.project);
      const stories = await readAll(
        ctx,
        `/tasks/${call.task}/stories`,
        new URLSearchParams({
          resource_subtype: 'comment_added',
          opt_fields: fields(COMMENT_FIELDS),
        }),
        MAX_COMMENT_PAGES,
        'stories',
      );
      // Filtered here too : stories carry system events, and only comments were asked for.
      const comments = stories.filter((s) => isRecord(s) && s.resource_subtype === 'comment_added');
      return { comments };
    }

    case 'createTask':
      return createTask(ctx, call);

    case 'updateTask':
      return updateTask(ctx, call);

    case 'addComment': {
      await proveTaskInProject(ctx, call.task, call.project);
      const answer = await request(ctx, 'POST', `/tasks/${call.task}/stories`, isDataObject, {
        query: new URLSearchParams({ opt_fields: fields(COMMENT_FIELDS) }),
        body: { text: call.text },
      });
      return answer.data;
    }

    case 'deleteTask': {
      await proveTaskInProject(ctx, call.task, call.project);
      await request(ctx, 'DELETE', `/tasks/${call.task}`, anyJson);
      return {
        deleted: call.task,
        note: "In the connected account's trash, recoverable there for 30 days.",
      };
    }
  }
}

async function createTask(
  ctx: ExecuteContext,
  call: Extract<AsanaCall, { op: 'createTask' }>,
): Promise<unknown> {
  const fieldsOfTask: Record<string, unknown> = { name: call.name };
  if (call.notes !== null) fieldsOfTask.notes = call.notes;
  if (call.assignee !== null) fieldsOfTask.assignee = call.assignee;
  if (call.dueOn !== null) fieldsOfTask.due_on = call.dueOn;
  const query = new URLSearchParams({ opt_fields: fields(TASK_FIELDS) });
  let answer;
  if (call.parent) {
    // A subtask joins the project through its parent : the parent is proven first.
    await proveTaskInProject(ctx, call.parent, call.project);
    answer = await request(ctx, 'POST', `/tasks/${call.parent}/subtasks`, isDataObject, {
      query,
      body: fieldsOfTask,
    });
  } else {
    if (call.section) {
      await proveSectionInProject(ctx, call.section, call.project);
      fieldsOfTask.memberships = [{ project: call.project, section: call.section }];
    } else {
      fieldsOfTask.projects = [call.project];
    }
    answer = await request(ctx, 'POST', '/tasks', isDataObject, { query, body: fieldsOfTask });
  }
  return shapeTask(answer.data, call.project);
}

async function updateTask(
  ctx: ExecuteContext,
  call: Extract<AsanaCall, { op: 'updateTask' }>,
): Promise<unknown> {
  await proveTaskInProject(ctx, call.task, call.project);
  if (call.section) await proveSectionInProject(ctx, call.section, call.project);
  let task: Json | null = null;
  if (Object.keys(call.changes).length > 0) {
    const answer = await request(ctx, 'PUT', `/tasks/${call.task}`, isDataObject, {
      query: new URLSearchParams({ opt_fields: fields(TASK_FIELDS) }),
      body: { ...call.changes },
    });
    task = shapeTask(answer.data, call.project);
  }
  if (call.section) {
    await request(ctx, 'POST', `/sections/${call.section}/addTask`, anyJson, {
      body: { task: call.task },
    });
  }
  return {
    ...(task ?? { gid: call.task }),
    ...(call.section ? { moved_to_section: call.section } : {}),
  };
}
