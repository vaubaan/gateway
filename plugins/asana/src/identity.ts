/**
 * Identity of the `asana` service — the one place its ids are written.
 *
 * Handbook : docs/handbook/services/asana.md.
 *
 * Everything else — the plugin id, the data-model service, the tool names,
 * the resources `discoverResources` returns, the credential field — is
 * derived from this module.
 */

import { toolPrefixFor } from '@vaubaan/plugin-sdk';

/** The service id. */
export const SERVICE_ID = 'asana';

/** The prefix of every tool name, `asana__`. */
export const TOOL_PREFIX = toolPrefixFor(SERVICE_ID);

/** Name of the secret field of the `api-key` credential : the personal access token. */
export const PAT_FIELD = 'personal_access_token';

/** The MCP tool names, `asana__<verb>_<noun>`. */
export const TOOL = {
  listProjects: `${TOOL_PREFIX}list_projects`,
  getProject: `${TOOL_PREFIX}get_project`,
  listSections: `${TOOL_PREFIX}list_sections`,
  listTasks: `${TOOL_PREFIX}list_tasks`,
  searchTasks: `${TOOL_PREFIX}search_tasks`,
  getTask: `${TOOL_PREFIX}get_task`,
  listComments: `${TOOL_PREFIX}list_comments`,
  createTask: `${TOOL_PREFIX}create_task`,
  updateTask: `${TOOL_PREFIX}update_task`,
  addComment: `${TOOL_PREFIX}add_comment`,
  deleteTask: `${TOOL_PREFIX}delete_task`,
} as const;
