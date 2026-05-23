/**
 * Vercel tool dispatcher — JSON-RPC forward to the official Vercel MCP server.
 *
 * Spec : docs/spec/mcp-proxy.md §7.4.
 * ADR  : docs/decisions/rewrap-official-mcps.md.
 *
 * The upstream serves at https://mcp.vercel.com/ via HTTP+SSE. We forward our
 * own `tools/call` payload (with the `vercel__` prefix stripped) and parse the
 * SSE-framed JSON response.
 */

import { toUpstreamName } from './tools.ts';

export type FetchImpl = typeof fetch;

const UPSTREAM = 'https://mcp.vercel.com/';

interface JsonRpcSuccess {
  jsonrpc: '2.0';
  id: string | number | null;
  result: unknown;
}

interface JsonRpcError {
  jsonrpc: '2.0';
  id: string | number | null;
  error: { code: number; message: string; data?: unknown };
}

type JsonRpcResponse = JsonRpcSuccess | JsonRpcError;

/**
 * Parse a Server-Sent Events response body to extract the first `data:` JSON
 * payload that contains either a `result` or an `error` field with the matching
 * id. The Vercel MCP server emits one frame per response.
 */
function parseFirstJsonRpcFrame(body: string, id: number): JsonRpcResponse {
  const lines = body.split('\n');
  for (const line of lines) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice('data:'.length).trim();
    if (!payload) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      continue;
    }
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'jsonrpc' in parsed &&
      ((parsed as { id?: unknown }).id === id || (parsed as { id?: unknown }).id === null)
    ) {
      return parsed as JsonRpcResponse;
    }
  }
  throw new Error(`No JSON-RPC frame matched id ${id} in upstream SSE response.`);
}

async function callUpstream(
  fetchImpl: FetchImpl,
  token: string,
  method: string,
  params: Record<string, unknown> | undefined,
  id = Math.floor(Math.random() * 1_000_000_000),
): Promise<unknown> {
  const res = await fetchImpl(UPSTREAM, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Vercel MCP upstream ${res.status}: ${errText.slice(0, 300)}`);
  }
  const body = await res.text();
  const frame = parseFirstJsonRpcFrame(body, id);
  if ('error' in frame) {
    throw new Error(`Vercel MCP upstream error ${frame.error.code}: ${frame.error.message}`);
  }
  return frame.result;
}

export async function executeCall(
  fetchImpl: FetchImpl,
  token: string,
  teamId: string | null,
  tool: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  // The upstream tool name (without the vercel__ prefix).
  const name = toUpstreamName(tool);
  // Many tools require `teamId` ; inject from the admin's stored team_id when
  // the caller didn't pass one explicitly.
  const finalArgs = teamId && !('teamId' in args) ? { ...args, teamId } : args;
  return callUpstream(fetchImpl, token, 'tools/call', { name, arguments: finalArgs });
}
