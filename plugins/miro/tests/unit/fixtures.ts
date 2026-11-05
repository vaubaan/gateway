/**
 * Shared fixtures of the `miro` tests : two boards, an execution context
 * with an OAuth credential, a mock of Miro's MCP server, and the plugin's own
 * samples (`src/examples.ts` ; the coverage kit and the identifier proof both
 * run on them). Ids follow the shapes of Miro's documentation.
 */
import type { ExecuteContext, Resource } from '@vaubaan/plugin-sdk';
import type { MockFetch, MockRoute, RecordedCall, ToolSamples } from '@vaubaan/plugin-sdk/testing';

import {
  BOARD,
  BOARD_ID,
  BOARD_URL,
  COMMENT,
  EXAMPLE_BOARD as workshop,
  EXAMPLE_OTHER_BOARD as retro,
  ITEM,
  OTHER_BOARD,
} from '../../src/examples.ts';
import { MIRO_MCP_URL } from '../../src/identity.ts';
import { miroPlugin } from '../../src/index.ts';

// The ids and boards the plugin's `examples` run on (`src/examples.ts`).
export { BOARD, BOARD_ID, BOARD_URL, COMMENT, ITEM, OTHER_BOARD, retro, workshop };

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

/** One table for the catalog coverage and the identifier proof : the plugin's `examples`. */
export const SAMPLES: ToolSamples = miroPlugin.examples;
