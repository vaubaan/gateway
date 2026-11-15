/**
 * The one reader of an `asana` call, shared by `classify` and `execute`
 * (ADR plugin-identifiers-one-grammar-for-classify-and-execute).
 *
 * Handbook : docs/handbook/services/asana.md.
 *
 * `readCall` turns the arguments into a typed call — the project resolved
 * against the mission, every identifier and value through its grammar — or
 * a refusal. `execute` builds its requests from what it returned, field by
 * field, never from `args` : an argument the tool does not declare is never
 * read, so it is never sent.
 */

import type { Resource } from '@vaubaan/plugin-sdk';

import {
  MAX_LONG_TEXT,
  MAX_NAME,
  MAX_SEARCH_TEXT,
  asanaGid,
  assigneeIdent,
  boundedInt,
  completedSince,
  isoDate,
  lineText,
  longText,
  offsetToken,
} from './ids.ts';
import { SERVICE_ID, TOOL } from './identity.ts';

/** Page size sent when the agent gives none. */
export const DEFAULT_LIMIT = 50;

/** The key of `TOOL` naming a tool : what a call is discriminated on. */
export type ToolOp = keyof typeof TOOL;

const OPS: ReadonlyMap<string, ToolOp> = new Map(
  (Object.entries(TOOL) as [ToolOp, string][]).map(([op, name]) => [name, op]),
);

/** A project of the mission, as the call names it. */
export interface ResolvedProject {
  readonly ref: string;
  readonly resource: Resource;
}

/** Fields `update_task` may change ; `undefined` means "not given", `null` clears. */
export interface TaskChanges {
  readonly name?: string;
  readonly notes?: string;
  readonly assignee?: string | null;
  readonly due_on?: string | null;
  readonly completed?: boolean;
}

export type AsanaCall =
  | { readonly op: 'listProjects'; readonly projects: readonly Resource[] }
  | { readonly op: 'getProject'; readonly project: string }
  | { readonly op: 'listSections'; readonly project: string }
  | {
      readonly op: 'listTasks';
      readonly project: string;
      readonly section: string | null;
      readonly completedSince: string | null;
      readonly limit: number;
      readonly offset: string | null;
    }
  | {
      readonly op: 'searchTasks';
      readonly project: string;
      readonly workspace: string;
      readonly text: string;
      readonly completed: boolean | null;
      readonly assignee: string | null;
      readonly limit: number;
    }
  | { readonly op: 'getTask'; readonly project: string; readonly task: string }
  | { readonly op: 'listComments'; readonly project: string; readonly task: string }
  | {
      readonly op: 'createTask';
      readonly project: string;
      readonly name: string;
      readonly notes: string | null;
      readonly assignee: string | null;
      readonly dueOn: string | null;
      readonly section: string | null;
      readonly parent: string | null;
    }
  | {
      readonly op: 'updateTask';
      readonly project: string;
      readonly task: string;
      readonly changes: TaskChanges;
      readonly section: string | null;
    }
  | {
      readonly op: 'addComment';
      readonly project: string;
      readonly task: string;
      readonly text: string;
    }
  | { readonly op: 'deleteTask'; readonly project: string; readonly task: string };

export type ReadOutcome = AsanaCall | { readonly denied: string };

/** The refusal sentence of an identifier or value outside its grammar. */
export function malformed(argument: string, expected: string): string {
  return `${argument}: missing or malformed (${expected})`;
}

const GID_WORDS = 'an Asana gid, digits only';

/**
 * The project a call is on :
 *   - `args.project` given : a gid AND one of the mission's Asana projects —
 *     anything else is refused, never substituted ;
 *   - absent : the mission's single Asana project, or a refusal when it holds
 *     none or several.
 */
export function resolveProject(
  args: Readonly<Record<string, unknown>>,
  resources: readonly Resource[],
): ResolvedProject | { readonly denied: string } {
  const own = resources.filter((r) => r.service === SERVICE_ID);
  if (args.project !== undefined) {
    const explicit = asanaGid(args.project);
    if (!explicit) return { denied: malformed('project', GID_WORDS) };
    const found = own.find((r) => r.ref === explicit);
    return found
      ? { ref: explicit, resource: found }
      : { denied: `project '${explicit}' is not selected in this mission` };
  }
  if (own.length === 1) {
    const only = asanaGid(own[0]!.ref);
    return only
      ? { ref: only, resource: own[0]! }
      : { denied: 'project: the mission resource is not an Asana gid' };
  }
  return {
    denied:
      own.length === 0
        ? 'project: argument missing and the mission selects no Asana project'
        : `project: argument missing and the mission selects ${own.length} Asana projects — name one`,
  };
}

/** The mission's projects whose ref is a gid : what `list_projects` answers. */
export function projectsOf(resources: readonly Resource[]): Resource[] {
  return resources.filter((r) => r.service === SERVICE_ID && asanaGid(r.ref) !== null);
}

/** An optional value : absent is `null`, present must pass `read`. */
function optional<T>(
  value: unknown,
  read: (v: unknown) => T | null,
  denial: string,
): { readonly value: T | null } | { readonly denied: string } {
  if (value === undefined) return { value: null };
  const read_ = read(value);
  return read_ === null ? { denied: denial } : { value: read_ };
}

export function readCall(
  tool: string,
  args: Readonly<Record<string, unknown>>,
  resources: readonly Resource[],
): ReadOutcome {
  const op = OPS.get(tool);
  if (!op) return { denied: `unknown tool '${tool}'` };
  if (op === 'listProjects') {
    const projects = projectsOf(resources);
    if (projects.length === 0) return { denied: 'the mission selects no Asana project' };
    return { op, projects };
  }
  const resolved = resolveProject(args, resources);
  if ('denied' in resolved) return resolved;
  const project = resolved.ref;

  if (op === 'getProject' || op === 'listSections') return { op, project };

  if (op === 'listTasks') {
    const section = optional(args.section, asanaGid, malformed('section', GID_WORDS));
    if ('denied' in section) return section;
    const since = optional(
      args.completed_since,
      completedSince,
      malformed('completed_since', "'now' or an ISO-8601 timestamp with its zone"),
    );
    if ('denied' in since) return since;
    const limit = optional(
      args.limit,
      (v) => boundedInt(v, 1, 100),
      malformed('limit', '1 to 100'),
    );
    if ('denied' in limit) return limit;
    const offset = optional(
      args.offset,
      offsetToken,
      malformed('offset', 'a next_offset of a previous page'),
    );
    if ('denied' in offset) return offset;
    return {
      op,
      project,
      section: section.value,
      completedSince: since.value,
      limit: limit.value ?? DEFAULT_LIMIT,
      offset: offset.value,
    };
  }

  if (op === 'searchTasks') {
    const workspace = asanaGid(resolved.resource.metadata?.workspace_gid);
    if (!workspace) {
      return { denied: `project '${project}': its workspace is unknown; refresh the account` };
    }
    const text = lineText(args.text, MAX_SEARCH_TEXT);
    if (!text)
      return { denied: malformed('text', `1 to ${MAX_SEARCH_TEXT} characters on one line`) };
    const completed = optional(
      args.completed,
      (v) => (typeof v === 'boolean' ? v : null),
      malformed('completed', 'true or false'),
    );
    if ('denied' in completed) return completed;
    const assignee = optional(
      args.assignee,
      assigneeIdent,
      malformed('assignee', `'me' or ${GID_WORDS}`),
    );
    if ('denied' in assignee) return assignee;
    const limit = optional(
      args.limit,
      (v) => boundedInt(v, 1, 100),
      malformed('limit', '1 to 100'),
    );
    if ('denied' in limit) return limit;
    return {
      op,
      project,
      workspace,
      text,
      completed: completed.value,
      assignee: assignee.value,
      limit: limit.value ?? DEFAULT_LIMIT,
    };
  }

  if (op === 'createTask') {
    const name = lineText(args.name, MAX_NAME);
    if (!name) return { denied: malformed('name', `1 to ${MAX_NAME} characters on one line`) };
    const notes = optional(
      args.notes,
      (v) => longText(v, MAX_LONG_TEXT),
      malformed('notes', 'text'),
    );
    if ('denied' in notes) return notes;
    const assignee = optional(
      args.assignee,
      assigneeIdent,
      malformed('assignee', `'me' or ${GID_WORDS}`),
    );
    if ('denied' in assignee) return assignee;
    const dueOn = optional(args.due_on, isoDate, malformed('due_on', 'YYYY-MM-DD'));
    if ('denied' in dueOn) return dueOn;
    const section = optional(args.section, asanaGid, malformed('section', GID_WORDS));
    if ('denied' in section) return section;
    const parent = optional(args.parent, asanaGid, malformed('parent', GID_WORDS));
    if ('denied' in parent) return parent;
    if (section.value !== null && parent.value !== null) {
      return {
        denied:
          'section and parent: a subtask lives under its parent, not in a section; give one of them',
      };
    }
    return {
      op,
      project,
      name,
      notes: notes.value,
      assignee: assignee.value,
      dueOn: dueOn.value,
      section: section.value,
      parent: parent.value,
    };
  }

  const task = asanaGid(args.task_gid);
  if (!task) return { denied: malformed('task_gid', GID_WORDS) };

  switch (op) {
    case 'getTask':
    case 'listComments':
    case 'deleteTask':
      return { op, project, task };
    case 'addComment': {
      const text = longText(args.text, MAX_LONG_TEXT);
      if (!text) return { denied: malformed('text', `1 to ${MAX_LONG_TEXT} characters`) };
      return { op, project, task, text };
    }
    case 'updateTask':
      return readUpdate(args, project, task);
  }
}

function readUpdate(
  args: Readonly<Record<string, unknown>>,
  project: string,
  task: string,
): ReadOutcome {
  const changes: {
    name?: string;
    notes?: string;
    assignee?: string | null;
    due_on?: string | null;
    completed?: boolean;
  } = {};
  if (args.name !== undefined) {
    const name = lineText(args.name, MAX_NAME);
    if (!name) return { denied: malformed('name', `1 to ${MAX_NAME} characters on one line`) };
    changes.name = name;
  }
  if (args.notes !== undefined) {
    // An empty description is a legitimate change : it clears the notes.
    const notes = args.notes === '' ? '' : longText(args.notes, MAX_LONG_TEXT);
    if (notes === null) return { denied: malformed('notes', 'text') };
    changes.notes = notes;
  }
  if (args.assignee !== undefined) {
    const assignee = args.assignee === null ? null : assigneeIdent(args.assignee);
    if (assignee === null && args.assignee !== null) {
      return { denied: malformed('assignee', `'me', ${GID_WORDS}, or null`) };
    }
    changes.assignee = assignee;
  }
  if (args.due_on !== undefined) {
    const dueOn = args.due_on === null ? null : isoDate(args.due_on);
    if (dueOn === null && args.due_on !== null) {
      return { denied: malformed('due_on', 'YYYY-MM-DD or null') };
    }
    changes.due_on = dueOn;
  }
  if (args.completed !== undefined) {
    if (typeof args.completed !== 'boolean')
      return { denied: malformed('completed', 'true or false') };
    changes.completed = args.completed;
  }
  const section = optional(args.section, asanaGid, malformed('section', GID_WORDS));
  if ('denied' in section) return section;
  if (Object.keys(changes).length === 0 && section.value === null) {
    return {
      denied:
        'nothing to change: give at least one of name, notes, assignee, due_on, completed, section',
    };
  }
  return { op: 'updateTask', project, task, changes, section: section.value };
}
