/**
 * Identity of the `miro` provider — the one place its ids and Miro's own
 * names are written.
 *
 * Handbook : docs/handbook/providers/miro.md §0, §2.
 * ADR      : docs/decisions/miro-rewraps-the-official-mcp-server.md.
 *
 * `PROVIDER_ID` is also written as `provider:` and as the prefix of every id
 * in `risk-catalog.yaml`, and in the package name. Everything else — the
 * plugin id, the data-model provider, the tool names, the resources
 * discovery returns — is derived from this module.
 */

import { toolPrefixFor } from '@vaubaan/plugin-sdk';

/** The provider id. */
export const PROVIDER_ID = 'miro';

/** `miro__` : prepended to the upstream tool names. */
export const TOOL_PREFIX = toolPrefixFor(PROVIDER_ID);

/**
 * Miro's official MCP server (Streamable HTTP). Its OAuth protected-resource
 * metadata (RFC 9728) names it as its own authorization server ; checked
 * unauthenticated on 2026-10-21.
 */
export const MIRO_MCP_URL = 'https://mcp.miro.com/';

/** The endpoints of `https://mcp.miro.com/.well-known/oauth-authorization-server` (RFC 8414), 2026-10-21. */
export const MIRO_OAUTH = {
  authorizationUrl: 'https://mcp.miro.com/authorize',
  tokenUrl: 'https://mcp.miro.com/token',
  registrationUrl: 'https://mcp.miro.com/register',
  /** The `resource` of the protected-resource metadata : the audience of the tokens (RFC 8707). */
  resource: 'https://mcp.miro.com/',
} as const;

/** Where a Miro board lives ; the MCP tools are addressed by such a URL. */
export const MIRO_BOARD_URL_BASE = 'https://miro.com/app/board/';

/**
 * The argument through which Miro's MCP tools are told which board (and, with
 * `moveToWidget`, which item) they act on. The gateway never forwards the
 * agent's value : it builds the URL itself from the `board` and `item_id` it
 * classified (`call.ts`). ⚠ The name is modelled from Miro's documentation
 * ("tools accept full Miro board URLs") ; the first `tools/list` capture
 * confirms or corrects it (handbook §6.5).
 */
export const BOARD_LOCATOR = 'miro_url';

/**
 * Arguments of an upstream tool whose name looks like a locator (`…url`,
 * `board…`, `…_id`) but that point outside the mission's boards, or that the
 * classifier reads itself : the image a new image item is made from, the
 * comment a reply or a resolution names. Any other such argument stops the
 * module at import (`tools.ts`) until it is modelled.
 */
export const MODELLED_LOCATING_ARGUMENTS: ReadonlySet<string> = new Set([
  'image_url',
  'comment_id',
]);

/**
 * The upstream tool names, as Miro's MCP server lists them
 * (`upstream-tools.json`). The gateway's names are these, prefixed, plus
 * `list_boards`, which the gateway answers itself.
 */
export const UPSTREAM_TOOL = {
  boardSearchBoards: 'board_search_boards',
  boardCreate: 'board_create',
  canvasSearch: 'canvas_search',
  canvasReadAsSvg: 'canvas_read_as_svg',
  canvasCreateFromSvg: 'canvas_create_from_svg',
  canvasUpdateFromSvg: 'canvas_update_from_svg',
  canvasComposerSkill: 'canvas_get_canvas_composer_skill',
  canvasFormatSkill: 'canvas_load_format_skill',
  commentListComments: 'comment_list_comments',
  commentCreate: 'comment_create',
  commentReply: 'comment_reply',
  commentResolve: 'comment_resolve',
  imageGetData: 'image_get_data',
  imageGetUrl: 'image_get_url',
  imageCreate: 'image_create',
  imageGetUploadUrl: 'image_get_upload_url',
  prototypeRead: 'prototype_read',
  prototypeCreate: 'prototype_create',
  tableCreate: 'table_create',
  tableListRows: 'table_list_rows',
  tableSyncRows: 'table_sync_rows',
  tableUpdateHistory: 'table_get_latest_update_history',
  tableUpdateView: 'table_update_view',
  userWhoAmI: 'user_who_am_i',
} as const;

export type UpstreamToolName = (typeof UPSTREAM_TOOL)[keyof typeof UPSTREAM_TOOL];

/**
 * Upstream tools the gateway does not offer to agents, each with the reason.
 * `board_search_boards` serves discovery only.
 */
export const LEFT_OUT_UPSTREAM_TOOLS: Readonly<Record<string, string>> = {
  [UPSTREAM_TOOL.boardSearchBoards]:
    "lists every board the person can open in the team, beyond the mission's ; discovery uses it, agents get list_boards",
  [UPSTREAM_TOOL.imageGetUploadUrl]:
    'hands the agent a presigned upload URL, a credential of its own (spec §2.4)',
  [UPSTREAM_TOOL.userWhoAmI]: "reads the connecting person's own profile ; no task needs it",
};

/** How a tool is told where it acts (`tools.ts` builds the gateway's schema from it). */
export type Locator =
  /** No board : a format guide, a new board. */
  | 'none'
  /** A board ; no item. */
  | 'board'
  /** A board, optionally one item of it. */
  | 'board-item'
  /** A board and one item of it. */
  | 'board-item-required';

/** The locator of each upstream tool the gateway offers. */
export const LOCATOR: Readonly<Record<string, Locator>> = {
  [UPSTREAM_TOOL.boardCreate]: 'none',
  [UPSTREAM_TOOL.canvasComposerSkill]: 'none',
  [UPSTREAM_TOOL.canvasFormatSkill]: 'none',
  [UPSTREAM_TOOL.canvasSearch]: 'board-item',
  [UPSTREAM_TOOL.canvasReadAsSvg]: 'board-item',
  [UPSTREAM_TOOL.canvasCreateFromSvg]: 'board-item',
  [UPSTREAM_TOOL.canvasUpdateFromSvg]: 'board-item',
  [UPSTREAM_TOOL.commentListComments]: 'board-item',
  [UPSTREAM_TOOL.commentCreate]: 'board-item',
  [UPSTREAM_TOOL.commentReply]: 'board',
  [UPSTREAM_TOOL.commentResolve]: 'board',
  [UPSTREAM_TOOL.imageGetData]: 'board-item-required',
  [UPSTREAM_TOOL.imageGetUrl]: 'board-item-required',
  [UPSTREAM_TOOL.imageCreate]: 'board-item',
  [UPSTREAM_TOOL.prototypeRead]: 'board-item',
  [UPSTREAM_TOOL.prototypeCreate]: 'board-item',
  [UPSTREAM_TOOL.tableCreate]: 'board-item',
  [UPSTREAM_TOOL.tableListRows]: 'board-item-required',
  [UPSTREAM_TOOL.tableSyncRows]: 'board-item-required',
  [UPSTREAM_TOOL.tableUpdateHistory]: 'board-item-required',
  [UPSTREAM_TOOL.tableUpdateView]: 'board-item-required',
};

/** The gateway's own arguments that locate a call : the board, and an item of it. */
export const BOARD_ARGUMENT = 'board';
export const ITEM_ARGUMENT = 'item_id';

/** The gateway's name of an upstream tool. */
export function toolNameOf(upstream: string): string {
  return `${TOOL_PREFIX}${upstream}`;
}

/** The MCP tool names of the plugin, in the order `tools/list` gives them. */
export const TOOL = {
  listBoards: `${TOOL_PREFIX}list_boards`,
  boardCreate: toolNameOf(UPSTREAM_TOOL.boardCreate),
  canvasSearch: toolNameOf(UPSTREAM_TOOL.canvasSearch),
  canvasReadAsSvg: toolNameOf(UPSTREAM_TOOL.canvasReadAsSvg),
  canvasCreateFromSvg: toolNameOf(UPSTREAM_TOOL.canvasCreateFromSvg),
  canvasUpdateFromSvg: toolNameOf(UPSTREAM_TOOL.canvasUpdateFromSvg),
  canvasComposerSkill: toolNameOf(UPSTREAM_TOOL.canvasComposerSkill),
  canvasFormatSkill: toolNameOf(UPSTREAM_TOOL.canvasFormatSkill),
  commentListComments: toolNameOf(UPSTREAM_TOOL.commentListComments),
  commentCreate: toolNameOf(UPSTREAM_TOOL.commentCreate),
  commentReply: toolNameOf(UPSTREAM_TOOL.commentReply),
  commentResolve: toolNameOf(UPSTREAM_TOOL.commentResolve),
  imageGetData: toolNameOf(UPSTREAM_TOOL.imageGetData),
  imageGetUrl: toolNameOf(UPSTREAM_TOOL.imageGetUrl),
  imageCreate: toolNameOf(UPSTREAM_TOOL.imageCreate),
  prototypeRead: toolNameOf(UPSTREAM_TOOL.prototypeRead),
  prototypeCreate: toolNameOf(UPSTREAM_TOOL.prototypeCreate),
  tableCreate: toolNameOf(UPSTREAM_TOOL.tableCreate),
  tableListRows: toolNameOf(UPSTREAM_TOOL.tableListRows),
  tableSyncRows: toolNameOf(UPSTREAM_TOOL.tableSyncRows),
  tableUpdateHistory: toolNameOf(UPSTREAM_TOOL.tableUpdateHistory),
  tableUpdateView: toolNameOf(UPSTREAM_TOOL.tableUpdateView),
} as const;
