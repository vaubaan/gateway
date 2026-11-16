/**
 * Identity of the `github-projects` service — the one place its ids are
 * written. Everything else (the plugin id, the data-model service, the tool
 * names, the resources discovery returns, the credential fields) is derived
 * from this module.
 *
 * ADR : github-projects-is-its-own-plugin.
 */

import { toolPrefixFor } from '@vaubaan/plugin-sdk';

/** The service id. Tool prefix : `github_projects__`. */
export const SERVICE_ID = 'github-projects';

const prefix = toolPrefixFor(SERVICE_ID);

/** The MCP tool names. Declared in `tools.ts`, dispatched in `classify.ts` and `execute.ts`. */
export const TOOL = {
  getProject: `${prefix}get_project`,
  listProjectFields: `${prefix}list_project_fields`,
  getProjectField: `${prefix}get_project_field`,
  listProjectItems: `${prefix}list_project_items`,
  getProjectItem: `${prefix}get_project_item`,
  listProjectViewItems: `${prefix}list_project_view_items`,
  addProjectItem: `${prefix}add_project_item`,
  addProjectDraft: `${prefix}add_project_draft`,
  updateProjectItem: `${prefix}update_project_item`,
  deleteProjectItem: `${prefix}delete_project_item`,
  createProjectField: `${prefix}create_project_field`,
  createProjectView: `${prefix}create_project_view`,
} as const;

/**
 * Tools of the service left out on purpose (`excludedTools`), refused by name
 * in `classify` and `execute`.
 */
export const EXCLUDED_TOOL = {
  listProjects: `${prefix}list_projects`,
} as const;
