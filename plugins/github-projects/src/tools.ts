/**
 * MCP tools of the `github-projects` service, synthesised over GitHub's REST
 * API for organization projects (`/orgs/{org}/projectsV2/{number}/…`).
 *
 * Every tool takes `project`, `<organization>/<number>` ; absent, the
 * mission's single project. Ids are positive integers, as a number or as its
 * digits. Left out : `list_projects` (`excludedTools`, `identity.ts`).
 */

import type { McpToolDeclaration } from '@vaubaan/plugin-sdk';

import { MAX_FIELDS_PER_CALL, MAX_PER_PAGE } from './call.ts';
import { TOOL } from './identity.ts';

const id = (description: string) => ({ type: ['integer', 'string'], description });

const projectArg = {
  project: {
    type: 'string',
    description:
      "The project, '<organization>/<number>' (e.g. 'acme/12'). Optional when the mission holds one project.",
  },
};

const pageArgs = {
  per_page: { type: 'integer', minimum: 1, maximum: MAX_PER_PAGE },
  after: {
    type: 'string',
    description: "Cursor of the next page: the 'next' of the previous answer.",
  },
  before: {
    type: 'string',
    description: "Cursor of the previous page: the 'previous' of an answer.",
  },
};

const fieldsArg = {
  fields: {
    type: 'array',
    maxItems: MAX_FIELDS_PER_CALL,
    items: id('A field id.'),
    description: 'Field ids whose values the answer carries; without it, the title only.',
  },
};

export const githubProjectsTools: readonly McpToolDeclaration[] = [
  {
    name: TOOL.getProject,
    description: 'Get the project: title, description, state, owner.',
    inputSchema: { type: 'object', properties: { ...projectArg } },
  },
  {
    name: TOOL.listProjectFields,
    description:
      'List the fields of the project, with their ids, types, single-select options and iterations.',
    inputSchema: { type: 'object', properties: { ...projectArg, ...pageArgs } },
  },
  {
    name: TOOL.getProjectField,
    description: 'Get one field of the project.',
    inputSchema: {
      type: 'object',
      properties: { ...projectArg, field_id: id('The field id.') },
      required: ['field_id'],
    },
  },
  {
    name: TOOL.listProjectItems,
    description:
      "List the items of the project, filtered with GitHub's project filter syntax (q). Answers { items, next, previous }.",
    inputSchema: {
      type: 'object',
      properties: {
        ...projectArg,
        q: { type: 'string', description: 'Filter, e.g. "status:Todo assignee:@me".' },
        ...fieldsArg,
        ...pageArgs,
      },
    },
  },
  {
    name: TOOL.getProjectItem,
    description: 'Get one item of the project, with the values of the fields asked.',
    inputSchema: {
      type: 'object',
      properties: { ...projectArg, item_id: id('The project item id.'), ...fieldsArg },
      required: ['item_id'],
    },
  },
  {
    name: TOOL.listProjectViewItems,
    description:
      "List the items a saved view shows, with the view's filter applied. Answers { items, next, previous }.",
    inputSchema: {
      type: 'object',
      properties: {
        ...projectArg,
        view_number: id('The view number, as in the view address (/views/<number>).'),
        ...fieldsArg,
        ...pageArgs,
      },
      required: ['view_number'],
    },
  },
  {
    name: TOOL.addProjectItem,
    description:
      'Add an existing issue or pull request to the project, by owner + repo + number or by its id (content_id).',
    inputSchema: {
      type: 'object',
      properties: {
        ...projectArg,
        type: { type: 'string', enum: ['Issue', 'PullRequest'] },
        owner: { type: 'string', description: 'Owner of the repository.' },
        repo: { type: 'string', description: 'Repository name.' },
        number: id('Issue or pull request number.'),
        content_id: id('The issue or pull request id, instead of owner + repo + number.'),
      },
      required: ['type'],
    },
  },
  {
    name: TOOL.addProjectDraft,
    description: 'Add a draft issue to the project.',
    inputSchema: {
      type: 'object',
      properties: { ...projectArg, title: { type: 'string' }, body: { type: 'string' } },
      required: ['title'],
    },
  },
  {
    name: TOOL.updateProjectItem,
    description:
      'Set field values of an item: text, number and date (YYYY-MM-DD) directly, single select by option id, iteration by iteration id; null clears.',
    inputSchema: {
      type: 'object',
      properties: {
        ...projectArg,
        item_id: id('The project item id.'),
        fields: {
          type: 'array',
          minItems: 1,
          maxItems: MAX_FIELDS_PER_CALL,
          items: {
            type: 'object',
            properties: {
              id: id('The field id.'),
              value: { type: ['string', 'number', 'null'] },
            },
            required: ['id', 'value'],
          },
        },
      },
      required: ['item_id', 'fields'],
    },
  },
  {
    name: TOOL.deleteProjectItem,
    description:
      'Remove an item from the project. Its field values are lost; a draft is deleted. Cannot be undone.',
    inputSchema: {
      type: 'object',
      properties: { ...projectArg, item_id: id('The project item id.') },
      required: ['item_id'],
    },
  },
  {
    name: TOOL.createProjectField,
    description:
      'Create a field: text, number, date, single_select (with its options) or iteration (with its configuration).',
    inputSchema: {
      type: 'object',
      properties: {
        ...projectArg,
        name: { type: 'string' },
        data_type: {
          type: 'string',
          enum: ['text', 'number', 'date', 'single_select', 'iteration'],
        },
        single_select_options: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              color: {
                type: 'string',
                enum: ['GRAY', 'BLUE', 'GREEN', 'YELLOW', 'ORANGE', 'RED', 'PINK', 'PURPLE'],
              },
              description: { type: 'string' },
            },
            required: ['name', 'color'],
          },
        },
        iteration_configuration: {
          type: 'object',
          properties: {
            start_date: { type: 'string', description: 'YYYY-MM-DD' },
            duration: { type: 'integer', description: 'Days per iteration.' },
            iterations: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  title: { type: 'string' },
                  start_date: { type: 'string' },
                  duration: { type: 'integer' },
                },
                required: ['title', 'start_date', 'duration'],
              },
            },
          },
          required: ['start_date', 'duration'],
        },
      },
      required: ['name', 'data_type'],
    },
  },
  {
    name: TOOL.createProjectView,
    description: 'Create a saved view: table, board or roadmap.',
    inputSchema: {
      type: 'object',
      properties: {
        ...projectArg,
        name: { type: 'string' },
        layout: { type: 'string', enum: ['table', 'board', 'roadmap'] },
        filter: { type: 'string' },
        visible_fields: { type: 'array', items: id('A field id.') },
        sort_by: {
          type: 'array',
          items: { type: 'array', description: '[field id, "asc" | "desc"]' },
        },
        group_by: { type: 'array', maxItems: 1, items: id('A field id.') },
        vertical_group_by: { type: 'array', maxItems: 1, items: id('A field id.') },
      },
      required: ['name', 'layout'],
    },
  },
];

/** What each tool does, for people (the head of an approval request). */
export const githubProjectsToolTitles: Readonly<Record<string, string>> = {
  [TOOL.getProject]: 'Read the project',
  [TOOL.listProjectFields]: 'List the fields of the project',
  [TOOL.getProjectField]: 'Read a field',
  [TOOL.listProjectItems]: 'List the items of the project',
  [TOOL.getProjectItem]: 'Read an item',
  [TOOL.listProjectViewItems]: 'List the items of a view',
  [TOOL.addProjectItem]: 'Add an issue or pull request',
  [TOOL.addProjectDraft]: 'Add a draft issue',
  [TOOL.updateProjectItem]: "Change an item's fields",
  [TOOL.deleteProjectItem]: 'Remove an item from the project',
  [TOOL.createProjectField]: 'Create a field',
  [TOOL.createProjectView]: 'Create a view',
};
