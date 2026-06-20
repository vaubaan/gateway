/**
 * Railway tool dispatcher — JSON-RPC forward to the official Railway MCP server.
 *
 * Spec : docs/spec/vaubaan-gateway.md §5, §7.4.
 * ADR  : docs/decisions/railway-rewrap-remote-mcp.md.
 *
 * The upstream serves at https://mcp.railway.com/ via Streamable HTTP (SSE
 * frames). The server is stateless per Bearer token — each request is
 * authenticated independently, no Mcp-Session-Id, no initialize handshake
 * required before tools/call. We forward our own `tools/call` payload (with the
 * `railway__` prefix stripped) and parse the SSE-framed JSON response.
 */

import { toUpstreamName } from './tools.ts';
import {
  CUSTOM_TOOL_NAMES,
  DELETE_VARIABLE,
  LIST_VARIABLES,
  UPSERT_VARIABLE,
  UPSERT_VARIABLES,
} from './custom-tools.ts';

export type FetchImpl = typeof fetch;

const UPSTREAM = 'https://mcp.railway.com/';
const BACKBOARD = 'https://backboard.railway.com/graphql/v2';

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
 * payload whose id matches (or is null). The Railway MCP server emits one frame
 * per response.
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
      'MCP-Protocol-Version': '2025-06-18',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Railway MCP upstream ${res.status}: ${errText.slice(0, 300)}`);
  }
  const body = await res.text();
  const frame = parseFirstJsonRpcFrame(body, id);
  if ('error' in frame) {
    throw new Error(`Railway MCP upstream error ${frame.error.code}: ${frame.error.message}`);
  }
  return frame.result;
}

export async function executeCall(
  fetchImpl: FetchImpl,
  token: string,
  tool: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  if (CUSTOM_TOOL_NAMES.has(tool)) {
    return executeCustom(fetchImpl, token, tool, args);
  }
  // The upstream tool name (without the railway__ prefix).
  const name = toUpstreamName(tool);
  return callUpstream(fetchImpl, token, 'tools/call', { name, arguments: args });
}

/**
 * Custom GraphQL tools (env vars). The OAuth token is audience-bound to
 * mcp.railway.com — if Railway rejects it for backboard, the 401 surfaces here
 * with the exact upstream message.
 */
async function executeCustom(
  fetchImpl: FetchImpl,
  token: string,
  tool: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  switch (tool) {
    case LIST_VARIABLES: {
      const variables = {
        projectId: args.projectId as string,
        environmentId: args.environmentId as string,
        serviceId: (args.serviceId as string | undefined) ?? null,
        unrendered: (args.unrendered as boolean | undefined) ?? false,
      };
      const data = await callGraphql<{ variables: Record<string, string> }>(
        fetchImpl,
        token,
        /* GraphQL */ `
          query variables(
            $projectId: String!
            $environmentId: String!
            $serviceId: String
            $unrendered: Boolean
          ) {
            variables(
              projectId: $projectId
              environmentId: $environmentId
              serviceId: $serviceId
              unrendered: $unrendered
            )
          }
        `,
        variables,
      );
      return data.variables;
    }
    case UPSERT_VARIABLE: {
      const input = stripUndefined({
        projectId: args.projectId as string,
        environmentId: args.environmentId as string,
        serviceId: args.serviceId as string | undefined,
        name: args.name as string,
        value: args.value as string,
        skipDeploys: args.skipDeploys as boolean | undefined,
      });
      const data = await callGraphql<{ variableUpsert: boolean }>(
        fetchImpl,
        token,
        /* GraphQL */ `
          mutation variableUpsert($input: VariableUpsertInput!) {
            variableUpsert(input: $input)
          }
        `,
        { input },
      );
      return { ok: data.variableUpsert === true };
    }
    case UPSERT_VARIABLES: {
      const input = stripUndefined({
        projectId: args.projectId as string,
        environmentId: args.environmentId as string,
        serviceId: args.serviceId as string | undefined,
        variables: args.variables as Record<string, string>,
        replace: args.replace as boolean | undefined,
        skipDeploys: args.skipDeploys as boolean | undefined,
      });
      const data = await callGraphql<{ variableCollectionUpsert: boolean }>(
        fetchImpl,
        token,
        /* GraphQL */ `
          mutation variableCollectionUpsert($input: VariableCollectionUpsertInput!) {
            variableCollectionUpsert(input: $input)
          }
        `,
        { input },
      );
      return { ok: data.variableCollectionUpsert === true };
    }
    case DELETE_VARIABLE: {
      const input = stripUndefined({
        projectId: args.projectId as string,
        environmentId: args.environmentId as string,
        serviceId: args.serviceId as string | undefined,
        name: args.name as string,
      });
      const data = await callGraphql<{ variableDelete: boolean }>(
        fetchImpl,
        token,
        /* GraphQL */ `
          mutation variableDelete($input: VariableDeleteInput!) {
            variableDelete(input: $input)
          }
        `,
        { input },
      );
      return { ok: data.variableDelete === true };
    }
    default:
      throw new Error(`Unknown Railway custom tool: ${tool}`);
  }
}

export async function callGraphql<T>(
  fetchImpl: FetchImpl,
  token: string,
  query: string,
  variables: Record<string, unknown>,
): Promise<T> {
  const res = await fetchImpl(BACKBOARD, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Railway GraphQL ${res.status}: ${errText.slice(0, 300)}`);
  }
  const body = (await res.json()) as { data?: T; errors?: Array<{ message: string }> };
  if (body.errors && body.errors.length > 0) {
    throw new Error(`Railway GraphQL errors: ${body.errors.map((e) => e.message).join('; ')}`);
  }
  if (!body.data) {
    throw new Error('Railway GraphQL: empty data response.');
  }
  return body.data;
}

function stripUndefined<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}
