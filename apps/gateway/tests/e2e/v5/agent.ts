/**
 * The executor's side of the browser tests: an agent runtime that holds a
 * mission token and nothing else, and talks to the execution door over real
 * HTTP on `/mcp` — the official MCP client (what a coding agent's runtime
 * embeds), plus the plain JSON-RPC `tools/list` of the bootstrap kit's
 * verification `curl`.
 *
 * It reaches the instance on its local listener, as the manual check of the
 * execution-door handbook does: the door reads the bearer and never the host.
 */
import { Client, ProtocolError, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

import { localOrigin } from './instance';

const MCP_PATH = '/mcp';

export interface Refusal {
  readonly code: string;
  readonly hint: string;
  readonly [field: string]: unknown;
}

export type CallOutcome =
  | { readonly outcome: 'allowed'; readonly text: string }
  | { readonly outcome: 'refused'; readonly refusal: Refusal };

export interface Agent {
  listTools(): Promise<string[]>;
  call(tool: string, args: Record<string, unknown>): Promise<CallOutcome>;
  close(): Promise<void>;
}

/** Connects an MCP client with the mission token; `label` is the optional agent label. */
export async function connectAgent(token: string, label?: string): Promise<Agent> {
  const transport = new StreamableHTTPClientTransport(new URL(`${localOrigin()}${MCP_PATH}`), {
    requestInit: {
      headers: {
        Authorization: `Bearer ${token}`,
        ...(label ? { 'X-Vaubaan-Agent': label } : {}),
      },
    },
  });
  const client = new Client({ name: 'e2e-agent', version: '1.0.0' });
  await client.connect(transport);
  return {
    async listTools() {
      const { tools } = await client.listTools();
      return tools.map((tool) => tool.name);
    },
    async call(tool, args) {
      try {
        const result = await client.callTool({ name: tool, arguments: args });
        const content = (result.content ?? []) as { type: string; text?: string }[];
        if (result.isError) {
          throw new Error(`${tool} failed upstream: ${JSON.stringify(content)}`);
        }
        return { outcome: 'allowed', text: content.map((part) => part.text ?? '').join('') };
      } catch (err) {
        // A refusal is a JSON-RPC error whose `data` is the whole refusal object.
        const data = err instanceof ProtocolError ? (err.data as Refusal | undefined) : undefined;
        if (data && typeof data.code === 'string') return { outcome: 'refused', refusal: data };
        throw err;
      }
    },
    close: () => client.close(),
  };
}

/** The bootstrap kit's verification: `curl … -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'`. */
export async function kitToolsList(
  token: string | null,
): Promise<{ status: number; tools: string[] }> {
  const response = await fetch(`${localOrigin()}${MCP_PATH}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
  if (!response.ok) return { status: response.status, tools: [] };
  const body = (await response.json()) as { result?: { tools?: { name: string }[] } };
  return { status: response.status, tools: (body.result?.tools ?? []).map((tool) => tool.name) };
}
