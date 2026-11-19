/**
 * Identity of the `miro` service — the one place its ids and Miro's own
 * names are written.
 *
 * Handbook : docs/handbook/services/miro.md.
 *
 * `SERVICE_ID` is also written as `service:` and as the prefix of every id
 * in `risk-catalog.yaml`, and in the package name. Everything else — the
 * plugin id, the data-model service, the tool names, the resources
 * discovery returns — is derived from this module.
 */

import { toolPrefixFor, type UpstreamMcpServer } from '@vaubaan/plugin-sdk';

/** The service id. */
export const SERVICE_ID = 'miro';

/** `miro__` : prepended to the upstream tool names. */
export const TOOL_PREFIX = toolPrefixFor(SERVICE_ID);

/**
 * Miro's official MCP server (Streamable HTTP). Its OAuth protected-resource
 * metadata (RFC 9728) names it as its own authorization server ; checked
 * unauthenticated on 2026-10-21.
 */
export const MIRO_MCP_URL = 'https://mcp.miro.com/';

/**
 * Miro's MCP server for the SDK's client (`callUpstreamTool`, `mcpRequest`).
 * ⚠ Whether it needs an `initialize` first is not documented and could not
 * be checked without an account : with the client's default session mode it
 * is asked one only when it answers a bare request 400 or 404.
 */
export const MIRO_MCP_SERVER: UpstreamMcpServer = { url: MIRO_MCP_URL, name: 'Miro MCP server' };

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
 * classified (`call.ts`). Confirmed by the capture of 2026-10-23.
 */
export const BOARD_LOCATOR = 'miro_url';

/**
 * The tools whose locator has another name than `miro_url` : Miro's
 * `content_item_list_roles` takes a board (or a space) as
 * `content_item_url`. The gateway writes it the same way, from the
 * classified board.
 */
const LOCATOR_ARGUMENT: Readonly<Record<string, string>> = {
  content_item_list_roles: 'content_item_url',
};

/** The name of the argument through which an upstream tool is told its board. */
export function locatorArgumentOf(upstream: string): string {
  return LOCATOR_ARGUMENT[upstream] ?? BOARD_LOCATOR;
}

/**
 * Arguments every Miro tool declares that describe the agent's own
 * environment to Miro (captured 2026-10-23, "you must populate this
 * field", neither required) : `invocation_source` ('skill' | 'ui' | unset)
 * and `is_repository` (whether the agent runs in a source-control working
 * directory). Telemetry of the agent's host, not an argument of the task :
 * never offered to agents, never sent — Miro applies its defaults.
 */
export const TELEMETRY_ARGUMENTS: ReadonlySet<string> = new Set([
  'invocation_source',
  'is_repository',
]);

/**
 * Arguments of an offered tool the gateway does not offer, each with the
 * reason. An agent that sends one is refused (undeclared argument) ; the
 * executor never sends it.
 */
export const WITHHELD_ARGUMENTS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  board_create: {
    parent_space_url:
      'names a space of the team : spaces are outside the resource model, the board goes where Miro puts a new board',
  },
  image_create: {
    image_token: 'comes from image_get_upload_url, which is not offered',
  },
  prototype_create: {
    html_tokens: 'come from prototype_get_upload_url, which is not offered',
    image_tokens: 'come from image_get_upload_url, which is not offered',
  },
};

/**
 * Arguments the gateway requires where Miro's schema does not : for
 * `prototype_create`, Miro wants exactly one of `html_tokens` and
 * `html_contents` ; with the tokens withheld, the HTML is the one input.
 */
export const REQUIRED_BY_THE_GATEWAY: Readonly<Record<string, readonly string[]>> = {
  prototype_create: ['html_contents'],
};

/**
 * What the gateway adds to Miro's description of a tool, for what differs
 * through it. Miro's descriptions speak of `miro_url` and `moveToWidget` ;
 * the board-located tools get `BOARD_NOTE` too.
 */
export const DESCRIPTION_NOTES: Readonly<Record<string, string>> = {
  board_create:
    'Through this gateway the board is created where Miro puts a new board (parent_space_url is not offered).',
  image_create:
    'Through this gateway give image_url, a public http(s) address: image_token and image_get_upload_url are not offered.',
  prototype_create:
    'Through this gateway give the screens as html_contents: html_tokens, image_tokens and the upload URLs are not offered, so images in the HTML must be http(s) URLs.',
  table_create:
    'Through this gateway the table is always created on the board you name: no new board is created.',
};

export const BOARD_NOTE =
  'Through this gateway, name the board with board (a board of the mission) and, to target an item or a frame, its id with item_id: the gateway writes miro_url (and moveToWidget) itself.';

/**
 * Arguments of an upstream tool whose name looks like a locator (`…url`,
 * `board…`, `…_id`) but that point outside the mission's boards, or that the
 * classifier reads itself : the image a new image item is made from, the
 * comment a reply or a resolution names. Any other such argument stops the
 * module at import (`tools.ts`) until it is modelled.
 */
export const MODELLED_LOCATING_ARGUMENTS: ReadonlySet<string> = new Set([
  // The public image a new image item is made from : fetched by Miro, not a board.
  'image_url',
  // A comment thread of the classified board (grammar in identifiers.ts).
  'comment_id',
  // Items of the classified board : canvas_read_as_svg's selection, an earlier
  // search result of canvas_search, a screen of prototype_read, a row of the
  // table item. Miro resolves them inside the board of miro_url.
  'widget_ids',
  'target_id',
  'screen_id',
  'row_id',
  // The person or group board_share / board_role_update grant a role to : not a
  // board ; what sharing allows is the risk `board-share`.
  'subject_id',
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
  boardUpdateMetadata: 'board_update_metadata',
  boardGetSpace: 'board_get_space',
  contentItemListRoles: 'content_item_list_roles',
  boardShare: 'board_share',
  boardRoleUpdate: 'board_role_update',
  createBoardcast: 'create_boardcast',
} as const;

export type UpstreamToolName = (typeof UPSTREAM_TOOL)[keyof typeof UPSTREAM_TOOL];

const UPLOAD_URL = 'hands the agent a presigned upload URL, a credential of its own (spec §2.4)';
const SPACE = 'acts on a space of the team : spaces are outside the resource model (one board)';
const BLOG_POST = 'acts on the blog posts of a space : outside the resource model (one board)';

/**
 * Upstream tools the gateway does not offer to agents, each with the reason
 * (captured list of 2026-10-23). `board_search_boards` serves discovery only.
 */
export const LEFT_OUT_UPSTREAM_TOOLS: Readonly<Record<string, string>> = {
  [UPSTREAM_TOOL.boardSearchBoards]:
    "lists every board the person can open in the team, beyond the mission's ; discovery uses it, agents get list_boards",
  [UPSTREAM_TOOL.imageGetUploadUrl]: UPLOAD_URL,
  canvas_get_html_upload_url: UPLOAD_URL,
  prototype_get_upload_url: UPLOAD_URL,
  [UPSTREAM_TOOL.userWhoAmI]: "reads the connecting person's own profile ; no task needs it",
  content_search:
    "searches every board, space and call recording the person can open, beyond the mission's ; agents get list_boards",
  user_search_organization_users:
    'searches the people of the whole organisation (names, emails) : no resource of the mission bounds it',
  get_brand_context:
    "reads the organisation's brand theme and guidelines : no resource of the mission bounds it",
  board_create_format:
    'creates a new content item (embed, table, kanban, document…) in a space, not on a board of the mission',
  board_move:
    'moves a board into another space or folder : the destination is outside the resource model',
  board_move_to_team:
    'moves a board to another team : it leaves the account that reaches it, and its new team is outside the mission',
  board_restore:
    'restores boards from the trash by URL : a board in the trash is not a resource of the mission',
  space_create: SPACE,
  space_update_metadata: SPACE,
  space_list: SPACE,
  space_list_boards: SPACE,
  space_list_children: SPACE,
  space_share: SPACE,
  space_role_update: SPACE,
  section_create: SPACE,
  section_delete: SPACE,
  section_update_metadata: SPACE,
  blog_post_create: BLOG_POST,
  blog_post_list: BLOG_POST,
  blog_post_update: BLOG_POST,
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
  [UPSTREAM_TOOL.boardUpdateMetadata]: 'board',
  [UPSTREAM_TOOL.boardGetSpace]: 'board',
  [UPSTREAM_TOOL.contentItemListRoles]: 'board',
  [UPSTREAM_TOOL.boardShare]: 'board',
  [UPSTREAM_TOOL.boardRoleUpdate]: 'board',
  [UPSTREAM_TOOL.createBoardcast]: 'board',
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
  boardGetSpace: toolNameOf(UPSTREAM_TOOL.boardGetSpace),
  boardUpdateMetadata: toolNameOf(UPSTREAM_TOOL.boardUpdateMetadata),
  contentItemListRoles: toolNameOf(UPSTREAM_TOOL.contentItemListRoles),
  boardShare: toolNameOf(UPSTREAM_TOOL.boardShare),
  boardRoleUpdate: toolNameOf(UPSTREAM_TOOL.boardRoleUpdate),
  createBoardcast: toolNameOf(UPSTREAM_TOOL.createBoardcast),
} as const;

/** One reason of `LEFT_OUT_UPSTREAM_TOOLS` as the sentence a public page shows. */
function asSentence(reason: string): string {
  const text = reason.replaceAll(' ; ', '; ').replaceAll(' : ', ': ');
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;
}

/**
 * The left-out upstream tools under the gateway's names, one sentence each :
 * the plugin's `excludedTools`. None is declared, so `classify` refuses each
 * as an unknown tool.
 */
export const EXCLUDED_TOOLS: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(LEFT_OUT_UPSTREAM_TOOLS).map(([upstream, reason]) => [
    toolNameOf(upstream),
    asSentence(reason),
  ]),
);
