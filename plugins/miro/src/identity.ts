/**
 * Identity of the `miro` provider — the one place its ids are written.
 *
 * Handbook : docs/handbook/providers/miro.md.
 *
 * `PROVIDER_ID` is also written as `provider:` and as the prefix of every id
 * in `risk-catalog.yaml`, and in the package name. Everything else — the
 * plugin id, the data-model provider, the tool names, the resources
 * discovery returns, the credential field — is derived from this module.
 */

import { toolPrefixFor } from '@vaubaan/plugin-sdk';

/** The provider id. */
export const PROVIDER_ID = 'miro';

/** Name of the secret field of the `api-key` credential : the access token of a Miro app. */
export const ACCESS_TOKEN_FIELD = 'access_token';

const prefix = toolPrefixFor(PROVIDER_ID);

/** The MCP tool names, `<prefix><verb>_<noun>`. Declared in `tools.ts`, read in `call.ts`. */
export const TOOL = {
  listBoards: `${prefix}list_boards`,
  getBoard: `${prefix}get_board`,
  listItems: `${prefix}list_items`,
  getItem: `${prefix}get_item`,
  listConnectors: `${prefix}list_connectors`,
  getConnector: `${prefix}get_connector`,
  listTags: `${prefix}list_tags`,
  listItemTags: `${prefix}list_item_tags`,
  createStickyNote: `${prefix}create_sticky_note`,
  updateStickyNote: `${prefix}update_sticky_note`,
  deleteStickyNote: `${prefix}delete_sticky_note`,
  createShape: `${prefix}create_shape`,
  updateShape: `${prefix}update_shape`,
  deleteShape: `${prefix}delete_shape`,
  createText: `${prefix}create_text`,
  updateText: `${prefix}update_text`,
  deleteText: `${prefix}delete_text`,
  createCard: `${prefix}create_card`,
  updateCard: `${prefix}update_card`,
  deleteCard: `${prefix}delete_card`,
  createFrame: `${prefix}create_frame`,
  updateFrame: `${prefix}update_frame`,
  deleteFrame: `${prefix}delete_frame`,
  createConnector: `${prefix}create_connector`,
  updateConnector: `${prefix}update_connector`,
  deleteConnector: `${prefix}delete_connector`,
  createTag: `${prefix}create_tag`,
  attachTag: `${prefix}attach_tag`,
  removeTag: `${prefix}remove_tag`,
  createItems: `${prefix}create_items`,
} as const;
