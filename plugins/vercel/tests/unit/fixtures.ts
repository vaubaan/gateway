/**
 * Shared fixtures of the `vercel` plugin tests : a mission resource, the
 * account credential, an `ExecuteContext` builder and the SSE framing of
 * the upstream MCP server. No fixture reaches the network.
 */
import type { ExecuteContext, Resource } from '@vaubaan/plugin-sdk';
import type { MockRoute, RecordedCall } from '@vaubaan/plugin-sdk/testing';

import { VERCEL_API_BASE, VERCEL_MCP_URL } from '../../src/index.ts';

export const TEAM = 'team_abc';
export const app: Resource = { service: 'vercel', ref: 'prj_abc', displayName: 'app' };
export const site: Resource = { service: 'vercel', ref: 'prj_site', displayName: 'site' };

export const credential = {
  kind: 'api-key' as const,
  fields: { token: 'vcp_secret', team_id: TEAM },
  metadata: {},
};

export function ctx(
  fetch: typeof globalThis.fetch,
  resources: readonly Resource[] = [app],
): ExecuteContext {
  return { credential, fetch, resources };
}

/** One SSE frame carrying the JSON-RPC answer to the recorded request. */
export function sseFrame(call: RecordedCall, result: unknown): string {
  const id = (call.json as { id: number }).id;
  return `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id, result })}\n\n`;
}

/** The upstream MCP server, answering every `tools/call` with a one-line result. */
export const mcpRoute: MockRoute = {
  method: 'POST',
  url: VERCEL_MCP_URL,
  respond: (c) => sseFrame(c, { content: [{ type: 'text', text: 'ok' }] }),
};

/** The REST lookup of one deployment under the pinned team ; `null` answers 404. */
export function deploymentRoute(
  key: string,
  deployment: Record<string, unknown> | null,
): MockRoute {
  return {
    method: 'GET',
    url: `${VERCEL_API_BASE}/v13/deployments/${key}?teamId=${TEAM}`,
    status: deployment === null ? 404 : 200,
    body: deployment ?? { error: { code: 'not_found' } },
  };
}

export const text = (result: { content: readonly unknown[] }): string =>
  (result.content[0] as { text: string }).text;

/** Arguments of the JSON-RPC `tools/call` a recorded request carries. */
export function forwardedArgs(call: RecordedCall): Record<string, unknown> {
  return (call.json as { params: { arguments: Record<string, unknown> } }).params.arguments;
}

export const isMcpCall = (c: RecordedCall): boolean => c.url === VERCEL_MCP_URL;
