/**
 * Identity of the `notion` service — the one place its ids are written.
 *
 * Handbook : docs/handbook/services/notion.md.
 *
 * Everything else — the plugin id, the data-model service, the tool names,
 * the resources `discoverResources` returns, the credential field — is
 * derived from this module.
 */

import { toolPrefixFor } from '@vaubaan/plugin-sdk';

/** The service id. */
export const SERVICE_ID = 'notion';

/** Name of the secret field of the `api-key` credential : the internal account token. */
export const API_TOKEN_FIELD = 'api_token';

const prefix = toolPrefixFor(SERVICE_ID);

/** The MCP tool names, `notion__<verb>_<noun>`. */
export const TOOL = {
  listRoots: `${prefix}list_roots`,
  searchContent: `${prefix}search_content`,
  getPage: `${prefix}get_page`,
  listBlockChildren: `${prefix}list_block_children`,
  getDatabase: `${prefix}get_database`,
  getDataSource: `${prefix}get_data_source`,
  queryDataSource: `${prefix}query_data_source`,
  createPage: `${prefix}create_page`,
  updatePage: `${prefix}update_page`,
  appendBlocks: `${prefix}append_blocks`,
  updateBlock: `${prefix}update_block`,
  deleteBlock: `${prefix}delete_block`,
  trashPage: `${prefix}trash_page`,
  restorePage: `${prefix}restore_page`,
  createEntry: `${prefix}create_entry`,
  updateEntry: `${prefix}update_entry`,
  listComments: `${prefix}list_comments`,
  createComment: `${prefix}create_comment`,
} as const;
