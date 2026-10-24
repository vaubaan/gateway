/**
 * What the tests of the `context7` plugin share : the mission's resource, an
 * execution context around a recording `fetch`, and the answers of the two
 * upstreams as the live calls of 2026-10-16 showed them.
 */
import type { ExecuteContext, Resource } from '@vaubaan/plugin-sdk';
import type { MockFetch, MockRoute, RecordedCall } from '@vaubaan/plugin-sdk/testing';

import {
  API_KEY_FIELD,
  CONTEXT7_MCP_URL,
  CONTEXT7_USAGE_URL,
  PROVIDER_ID,
} from '../../src/index.ts';

/** A key of the documented shape ; never a real one. */
export const KEY = 'ctx7sk-test0123456789abcdefghijklmnopqrstu';

export const index: Resource = {
  provider: PROVIDER_ID,
  ref: 'docs',
  displayName: 'Context7 library index',
};

export function ctx(fetch: MockFetch, resources: readonly Resource[] = [index]): ExecuteContext {
  return {
    credential: { kind: 'api-key', fields: { [API_KEY_FIELD]: KEY }, metadata: {} },
    fetch,
    resources,
  };
}

/** The id of the JSON-RPC request a recorded call carried. */
function requestId(call: RecordedCall): unknown {
  return (call.json as { id?: unknown } | undefined)?.id;
}

/** One SSE `event: message` frame, as `mcp.context7.com` answers. */
export function sse(frame: unknown): string {
  return `event: message\ndata: ${JSON.stringify(frame)}\n\n`;
}

/** The MCP server answering `tools/call` with this tool result, echoing the request id. */
export function mcpAnswers(result: unknown, times?: number): MockRoute {
  return {
    method: 'POST',
    url: CONTEXT7_MCP_URL,
    headers: { 'content-type': 'text/event-stream' },
    respond: (call) => sse({ result, jsonrpc: '2.0', id: requestId(call) }),
    ...(times !== undefined ? { times } : {}),
  };
}

/** A successful documentation answer. */
export const DOCS_RESULT = {
  content: [
    { type: 'text', text: 'Available Libraries:\n- Title: Next.js\n- Library ID: /vercel/next.js' },
  ],
};

/** What the MCP server answers for a bad key (live, 2026-10-16) : HTTP 200, `isError`. */
export const INVALID_KEY_RESULT = {
  content: [
    {
      type: 'text',
      text: "Invalid API key. Please check your API key. API keys should start with 'ctx7sk' prefix.",
    },
  ],
  isError: true,
};

/**
 * The answer of `GET /v2/usage` for a valid Pro key, as the live call of
 * 2026-10-16 returned it ; `member` and `teamspace` fields overridable.
 */
export function usageBody(
  plan: string,
  member: Record<string, unknown> = {},
  teamspace: Record<string, unknown> = {},
): unknown {
  return {
    plan,
    usageResetsAt: '2026-11-01T00:00:00.000Z',
    member: { requests: 25, includedInPlan: 2000, ...member },
    teamspace: {
      extraRequests: 0,
      extraCostUsd: 0,
      spendingLimitUsd: null,
      daily: [
        { date: '2026-10-16', requests: 0, searchRequests: 0, docsRequests: 0, extraCostUsd: 0 },
      ],
      ...teamspace,
    },
  };
}

/** `GET /v2/usage` answering with a status, and a documented body on 200. */
export function usageAnswers(status: number, body: unknown = { plan: 'free' }): MockRoute {
  return { method: 'GET', url: CONTEXT7_USAGE_URL, status, body };
}
