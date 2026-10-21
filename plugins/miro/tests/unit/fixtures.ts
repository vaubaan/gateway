/**
 * Shared fixtures of the `miro` tests : two boards, an execution context
 * with an OAuth credential, a mock of Miro's MCP server, and one realistic
 * sample per tool (the coverage kit and the identifier proof both run on
 * them). Ids follow the shapes of Miro's documentation.
 */
import type { ExecuteContext, Resource } from '@vaubaan/plugin-sdk';
import type { MockFetch, MockRoute, RecordedCall, ToolSamples } from '@vaubaan/plugin-sdk/testing';

import { MIRO_MCP_URL, PROVIDER_ID, TOOL } from '../../src/identity.ts';

/** Miro's documented example board id, and its ref. */
export const BOARD_ID = 'uXjVOD6LSME=';
export const BOARD = 'uXjVOD6LSME~';
export const BOARD_URL = 'https://miro.com/app/board/uXjVOD6LSME=/';
export const OTHER_BOARD = 'o9J_kzlUDmo~';
export const ITEM = '3458764517517819000';
export const COMMENT = '3458764517517819777';

export const workshop: Resource = {
  provider: PROVIDER_ID,
  ref: BOARD,
  displayName: 'Workshop',
  metadata: { url: BOARD_URL },
};
export const retro: Resource = { provider: PROVIDER_ID, ref: OTHER_BOARD, displayName: 'Retro' };

export const TOKEN = 'miro-access-token-1234567890';

export function context(
  fetch: MockFetch | typeof globalThis.fetch,
  resources: readonly Resource[] = [workshop],
): ExecuteContext {
  return {
    credential: {
      kind: 'oauth2',
      accessToken: TOKEN,
      refreshToken: 'miro-refresh-token',
      expiresAt: null,
      scopes: ['boards:read', 'boards:write'],
      metadata: {},
    },
    appConfig: {},
    fetch,
    resources,
  };
}

/** The JSON-RPC request a recorded call carried. */
export function rpcOf(call: RecordedCall): {
  readonly id?: number;
  readonly method: string;
  readonly params?: { readonly name?: string; readonly arguments?: Record<string, unknown> };
} {
  return call.json as ReturnType<typeof rpcOf>;
}

/** A route of Miro's MCP server answering every request with `result` (as SSE when asked). */
export function mcpRoute(
  result: (call: RecordedCall) => unknown,
  options: { readonly sse?: boolean; readonly times?: number } = {},
): MockRoute {
  return {
    method: 'POST',
    url: MIRO_MCP_URL,
    ...(options.times !== undefined ? { times: options.times } : {}),
    respond: (call) => {
      const frame = { jsonrpc: '2.0', id: rpcOf(call).id ?? null, result: result(call) };
      return options.sse ? `event: message\ndata: ${JSON.stringify(frame)}\n\n` : frame;
    },
  };
}

/** A tool result of one text block. */
export function textResult(text: string): { content: { type: 'text'; text: string }[] } {
  return { content: [{ type: 'text', text }] };
}

const svg = '<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"/></svg>';

/** One table for the catalog coverage and the identifier proof. */
export const SAMPLES: ToolSamples = {
  [TOOL.listBoards]: [{ args: {} }, { args: {}, resources: [workshop, retro] }],
  [TOOL.boardCreate]: [{ args: { name: 'Retro 2026-11', description: 'Sprint retro' } }],
  [TOOL.canvasSearch]: [
    { args: { board: BOARD, query: 'pricing', result_mode: 'overview' } },
    { args: { board: OTHER_BOARD, query: 'x' }, expectDenied: true },
  ],
  [TOOL.canvasReadAsSvg]: [{ args: { board: BOARD_URL, item_id: ITEM } }],
  [TOOL.canvasCreateFromSvg]: [{ args: { board: BOARD, svg } }],
  [TOOL.canvasUpdateFromSvg]: [{ args: { board: BOARD, item_id: ITEM, svg } }],
  [TOOL.canvasComposerSkill]: [{ args: {} }],
  [TOOL.canvasFormatSkill]: [{ args: { format: 'flowchart' } }],
  [TOOL.commentListComments]: [{ args: { board: BOARD } }],
  [TOOL.commentCreate]: [{ args: { board: BOARD, item_id: ITEM, content: 'Looks good' } }],
  [TOOL.commentReply]: [{ args: { board: BOARD, comment_id: COMMENT, content: 'Agreed' } }],
  [TOOL.commentResolve]: [{ args: { board: BOARD, comment_id: COMMENT, resolved: true } }],
  [TOOL.imageGetData]: [{ args: { board: BOARD, item_id: ITEM } }],
  [TOOL.imageGetUrl]: [{ args: { board: BOARD, item_id: ITEM } }],
  [TOOL.imageCreate]: [
    { args: { board: BOARD, image_url: 'https://example.com/logo.png', title: 'Logo' } },
  ],
  [TOOL.prototypeRead]: [{ args: { board: BOARD } }],
  [TOOL.prototypeCreate]: [{ args: { board: BOARD, screens: [{ html: '<p>Home</p>' }] } }],
  [TOOL.tableCreate]: [
    { args: { board: BOARD, title: 'Backlog', columns: [{ name: 'Task', type: 'text' }] } },
  ],
  [TOOL.tableListRows]: [{ args: { board: BOARD, item_id: ITEM, filter: { Status: 'Open' } } }],
  [TOOL.tableSyncRows]: [
    { args: { board: BOARD, item_id: ITEM, rows: [{ Task: 'Ship' }], key_column: 'Task' } },
  ],
  [TOOL.tableUpdateHistory]: [{ args: { board: BOARD, item_id: ITEM } }],
  [TOOL.tableUpdateView]: [{ args: { board: BOARD, item_id: ITEM, view: { sort: 'Task' } } }],
};
