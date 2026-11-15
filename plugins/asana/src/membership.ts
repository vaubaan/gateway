/**
 * The proof that a task or a section is in the project the call names.
 *
 * Handbook : docs/handbook/services/asana.md, "Edge cases".
 *
 * Classification is pure and a gid says nothing about its project, so the
 * classifier names the project the caller claims and the executor checks the
 * claim before anything else is sent or returned. A task is in the project
 * when the project is one of its `projects` / `memberships`, or one of its
 * ancestors' (a subtask inherits the projects of its ancestors), up to
 * `MAX_PARENT_DEPTH` parents. A refusal says only that the object is not in
 * the project, nothing about where it is.
 */

import { ExecutorRefusal, UpstreamProtocolError, isList, isRecord } from '@vaubaan/plugin-sdk';
import type { AccountContext } from '@vaubaan/plugin-sdk';

import { getObject, type Json } from './api.ts';
import { asanaGid } from './ids.ts';

/** Parents walked above a task to find its project. */
export const MAX_PARENT_DEPTH = 5;

/** What the walk asks of each task. */
export const MEMBERSHIP_FIELDS = ['projects.gid', 'memberships.project.gid', 'parent.gid'] as const;

export function notInProject(kind: 'task' | 'section', gid: string, project: string): string {
  return `${kind} '${gid}' is not in project '${project}'`;
}

function gidOf(value: unknown): string | null {
  return isRecord(value) ? asanaGid(value.gid) : null;
}

/** The project gids a task record carries, directly. */
export function projectGidsOf(task: Json): Set<string> {
  const found = new Set<string>();
  if (isList(task.projects)) {
    for (const p of task.projects) {
      const gid = gidOf(p);
      if (gid) found.add(gid);
    }
  }
  if (isList(task.memberships)) {
    for (const m of task.memberships) {
      const gid = isRecord(m) ? gidOf(m.project) : null;
      if (gid) found.add(gid);
    }
  }
  return found;
}

/**
 * Proves `task` is in `project` and returns the task's own record, read with
 * `fields` added to the walk's fields. Throws `ExecutorRefusal` otherwise ;
 * a service failure is thrown as it is.
 */
export async function proveTaskInProject(
  ctx: AccountContext,
  task: string,
  project: string,
  fields: readonly string[] = [],
): Promise<Json> {
  const first = await getObject(ctx, `/tasks/${task}`, [...MEMBERSHIP_FIELDS, ...fields]);
  let current = first;
  for (let depth = 0; ; depth += 1) {
    if (projectGidsOf(current).has(project)) return first;
    if (current.parent === null || current.parent === undefined) break;
    const parent = gidOf(current.parent);
    if (!parent) throw new UpstreamProtocolError('Asana: unexpected parent in a task answer');
    if (depth >= MAX_PARENT_DEPTH) break;
    current = await getObject(ctx, `/tasks/${parent}`, MEMBERSHIP_FIELDS);
  }
  throw new ExecutorRefusal(notInProject('task', task, project));
}

/** Proves `section` is a section of `project` ; throws `ExecutorRefusal` otherwise. */
export async function proveSectionInProject(
  ctx: AccountContext,
  section: string,
  project: string,
): Promise<void> {
  const answer = await getObject(ctx, `/sections/${section}`, ['project.gid']);
  if (gidOf(answer.project) !== project) {
    throw new ExecutorRefusal(notInProject('section', section, project));
  }
}
