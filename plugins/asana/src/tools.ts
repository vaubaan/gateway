/**
 * MCP tools of the `asana` provider : our own schemas on Asana's REST API.
 *
 * Handbook : docs/handbook/providers/asana.md.
 *
 * Every tool but `list_projects` takes `project`, a project of the mission ;
 * every task tool takes `task_gid` too, because a task gid says nothing about
 * its project : the classifier names the project the caller claims, and the
 * executor proves the task belongs to it before acting.
 */

import type { McpToolDeclaration } from '@vaubaan/plugin-sdk';

import { MAX_LONG_TEXT, MAX_NAME, MAX_SEARCH_TEXT } from './ids.ts';
import { TOOL } from './identity.ts';

const gid = (description: string) => ({ type: 'string', pattern: '^[0-9]{1,32}$', description });

const project = {
  project: gid(
    'Project gid, one of the projects of the mission (asana__list_projects lists them).',
  ),
};
const task = { task_gid: gid('Task gid ; the task, or one of its ancestors, is in the project.') };
const assignee = (extra: string) => ({
  type: ['string', 'null'],
  description: `'me' (the connected account) or a user gid; never an email address.${extra}`,
});
const paging = {
  limit: {
    type: 'integer',
    minimum: 1,
    maximum: 100,
    description: 'Results per page (default 50).',
  },
  offset: { type: 'string', description: 'The next_offset of the previous page.' },
};

export const asanaTools: readonly McpToolDeclaration[] = [
  {
    name: TOOL.listProjects,
    description:
      'List the Asana projects of this mission (gid, name, workspace, team). Answered by the gateway; tasks outside these projects are out of reach.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: TOOL.getProject,
    description: 'Read one project: name, description, owner, team, dates, link.',
    inputSchema: { type: 'object', properties: { ...project }, required: ['project'] },
  },
  {
    name: TOOL.listSections,
    description: 'List the sections (board columns) of a project.',
    inputSchema: { type: 'object', properties: { ...project }, required: ['project'] },
  },
  {
    name: TOOL.listTasks,
    description:
      'List the tasks of a project, or of one of its sections, with their name, status, assignee, due date, description and link. Paged: pass next_offset back as offset.',
    inputSchema: {
      type: 'object',
      properties: {
        ...project,
        section: gid('Only the tasks of this section of the project.'),
        completed_since: {
          type: 'string',
          description:
            "'now' for incomplete tasks only, or an ISO-8601 timestamp: incomplete tasks and those completed since then.",
        },
        ...paging,
      },
      required: ['project'],
    },
  },
  {
    name: TOOL.searchTasks,
    description:
      "Full-text search in the names and descriptions of a project's tasks (subtasks included). Asana Premium only; Asana allows 60 searches a minute.",
    inputSchema: {
      type: 'object',
      properties: {
        ...project,
        text: { type: 'string', maxLength: MAX_SEARCH_TEXT, description: 'Text to search for.' },
        completed: {
          type: 'boolean',
          description: 'Only completed (true) or incomplete (false) tasks.',
        },
        assignee: { ...assignee(''), type: 'string' },
        limit: paging.limit,
      },
      required: ['project', 'text'],
    },
  },
  {
    name: TOOL.getTask,
    description:
      'Read one task of a project: name, status, assignee, dates, description, section, link.',
    inputSchema: {
      type: 'object',
      properties: { ...project, ...task },
      required: ['project', 'task_gid'],
    },
  },
  {
    name: TOOL.listComments,
    description: 'Read the comments of a task (activity such as assignments is left out).',
    inputSchema: {
      type: 'object',
      properties: { ...project, ...task },
      required: ['project', 'task_gid'],
    },
  },
  {
    name: TOOL.createTask,
    description:
      'Create a task in a project, optionally in one of its sections, or a subtask under a task of the project (parent). Assigning someone notifies them.',
    inputSchema: {
      type: 'object',
      properties: {
        ...project,
        name: { type: 'string', maxLength: MAX_NAME, description: 'The task name.' },
        notes: {
          type: 'string',
          maxLength: MAX_LONG_TEXT,
          description: 'The description, plain text.',
        },
        assignee: { ...assignee(''), type: 'string' },
        due_on: { type: 'string', description: 'Due date, YYYY-MM-DD.' },
        section: gid('A section of the project to put the task in (not with parent).'),
        parent: gid('Create a subtask of this task of the project.'),
      },
      required: ['project', 'name'],
    },
  },
  {
    name: TOOL.updateTask,
    description:
      'Change a task of a project: name, description (replaced, Asana keeps no history of it), assignee, due date, completion, or its section. At least one of them.',
    inputSchema: {
      type: 'object',
      properties: {
        ...project,
        ...task,
        name: { type: 'string', maxLength: MAX_NAME },
        notes: {
          type: 'string',
          maxLength: MAX_LONG_TEXT,
          description: 'Replaces the description.',
        },
        assignee: assignee(' null unassigns.'),
        due_on: { type: ['string', 'null'], description: 'Due date, YYYY-MM-DD; null clears it.' },
        completed: { type: 'boolean' },
        section: gid('Move the task to this section of the project.'),
      },
      required: ['project', 'task_gid'],
    },
  },
  {
    name: TOOL.addComment,
    description:
      'Comment on a task of a project, signed by the connected account; notifies its followers.',
    inputSchema: {
      type: 'object',
      properties: {
        ...project,
        ...task,
        text: { type: 'string', maxLength: MAX_LONG_TEXT, description: 'The comment, plain text.' },
      },
      required: ['project', 'task_gid', 'text'],
    },
  },
  {
    name: TOOL.deleteTask,
    description:
      "Delete a task of a project: it goes to the account's trash, recoverable there for 30 days.",
    inputSchema: {
      type: 'object',
      properties: { ...project, ...task },
      required: ['project', 'task_gid'],
    },
  },
];

/** What each tool does, in a few words : the head of an approval request. */
export const asanaToolTitles: Readonly<Record<string, string>> = {
  [TOOL.listProjects]: 'List the projects',
  [TOOL.getProject]: 'Read a project',
  [TOOL.listSections]: "List a project's sections",
  [TOOL.listTasks]: "List a project's tasks",
  [TOOL.searchTasks]: 'Search tasks',
  [TOOL.getTask]: 'Read a task',
  [TOOL.listComments]: "Read a task's comments",
  [TOOL.createTask]: 'Create a task',
  [TOOL.updateTask]: 'Change a task',
  [TOOL.addComment]: 'Comment on a task',
  [TOOL.deleteTask]: 'Delete a task',
};
