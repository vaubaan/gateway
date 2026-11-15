/**
 * The client of an upstream MCP server over Streamable HTTP, for a plugin
 * that rewraps a service's official server (ADR rewrap-official-mcps) : one
 * JSON-RPC request per call, the OAuth or API token as a bearer.
 *
 * Sessions : a stateless server (Railway's, Context7's) answers a bare
 * request. A server that wants a session answers it 400 or 404 ; with
 * `session: 'when-asked'` (the default) the client then initializes once
 * (`initialize`, then `notifications/initialized`), keeps the
 * `Mcp-Session-Id` the server returned, and sends the request again with it.
 *
 * Failures, all typed (`http.ts` for the table) : 401 / 403
 * `UpstreamAuthError`, another failed status `UpstreamHttpError`, a JSON-RPC
 * error frame or an answer with no frame for the request
 * `UpstreamProtocolError`. The server's text goes to the agent only (ADR
 * provider-error-text-stays-with-the-agent).
 */

import type { McpToolResult } from '@vaubaan/shared';

import { UpstreamProtocolError } from './errors.ts';
import { upstreamFailure, type UpstreamIo } from './http.ts';
import { firstJsonRpcFrame } from './json-rpc-frame.ts';
import { DEFAULT_MAX_ANSWER_BYTES, readBoundedText } from './read-bounded.ts';
import { upstreamToolResult } from './upstream-tool-result.ts';

/** The MCP revision the client speaks. */
export const MCP_PROTOCOL_VERSION = '2025-06-18';

const SESSION_HEADER = 'mcp-session-id';

/** One upstream MCP server, as a plugin declares it in its `identity.ts`. */
export interface UpstreamMcpServer {
  /** The endpoint (`https://mcp.miro.com/`). Requests are never redirected. */
  readonly url: string;
  /** How messages name it (`Miro MCP server`). */
  readonly name: string;
  /** Headers the service asks for besides the protocol's (`user-agent`). */
  readonly headers?: Readonly<Record<string, string>>;
  /** `'when-asked'` (default) initializes a session on a 400 / 404 ; `'never'` does not. */
  readonly session?: 'when-asked' | 'never';
  /** The bound of an answer ; `DEFAULT_MAX_ANSWER_BYTES` when absent. */
  readonly maxBytes?: number;
}

let nextId = 1;

/**
 * One JSON-RPC request to `server` with `token` as the bearer ; the `result`
 * of its answer, untrusted (read it through a guard, or `callUpstreamTool`).
 */
export async function mcpRequest(
  io: UpstreamIo,
  server: UpstreamMcpServer,
  token: string,
  method: string,
  params: Readonly<Record<string, unknown>>,
): Promise<unknown> {
  let session: string | null = null;
  for (let attempt = 0; ; attempt++) {
    const id = nextId++;
    const res = await post(io, server, token, { jsonrpc: '2.0', id, method, params }, session);
    const wantsSession = res.status === 400 || res.status === 404;
    if (wantsSession && attempt === 0 && server.session !== 'never') {
      await res.body?.cancel().catch(() => undefined);
      session = await initialize(io, server, token);
      continue;
    }
    return resultOf(await answerOf(res, server, method), id, server, method);
  }
}

/**
 * `tools/call` of the upstream tool `name` ; its answer read as a tool result
 * (`upstreamToolResult`), the service's own `isError` passed through.
 */
export async function callUpstreamTool(
  io: UpstreamIo,
  server: UpstreamMcpServer,
  token: string,
  name: string,
  args: Readonly<Record<string, unknown>>,
): Promise<McpToolResult> {
  const result = await mcpRequest(io, server, token, 'tools/call', { name, arguments: args });
  return upstreamToolResult(result, `${server.name}, tool ${name}`);
}

/** Opens a session : `initialize`, then `notifications/initialized`. Returns the session id, if any. */
async function initialize(
  io: UpstreamIo,
  server: UpstreamMcpServer,
  token: string,
): Promise<string | null> {
  const id = nextId++;
  const params = {
    protocolVersion: MCP_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: 'vaubaan-gateway', version: '1' },
  };
  const res = await post(io, server, token, { jsonrpc: '2.0', id, method: 'initialize', params });
  const session = res.headers.get(SESSION_HEADER);
  resultOf(await answerOf(res, server, 'initialize'), id, server, 'initialize');
  const done = await post(
    io,
    server,
    token,
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    session,
  );
  // A notification is answered 202 without a body ; anything but a refused credential is tolerated.
  if (done.status === 401 || done.status === 403) {
    throw await upstreamFailure(done, `${server.name} initialized`);
  }
  await done.body?.cancel().catch(() => undefined);
  return session;
}

async function post(
  io: UpstreamIo,
  server: UpstreamMcpServer,
  token: string,
  body: Readonly<Record<string, unknown>>,
  session: string | null = null,
): Promise<Response> {
  return io.fetch(server.url, {
    method: 'POST',
    headers: {
      ...server.headers,
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': MCP_PROTOCOL_VERSION,
      ...(session ? { 'mcp-session-id': session } : {}),
    },
    body: JSON.stringify(body),
    redirect: 'error',
    ...(io.signal ? { signal: io.signal } : {}),
  });
}

/** The body of a successful answer, bounded ; the typed failure otherwise. */
async function answerOf(res: Response, server: UpstreamMcpServer, method: string): Promise<string> {
  const what = `${server.name}, ${method}`;
  if (!res.ok) throw await upstreamFailure(res, what);
  return readBoundedText(res, server.maxBytes ?? DEFAULT_MAX_ANSWER_BYTES, what);
}

function resultOf(body: string, id: number, server: UpstreamMcpServer, method: string): unknown {
  const frame = firstJsonRpcFrame(body, id);
  if (frame === null) {
    throw new UpstreamProtocolError(
      `${server.name}, ${method}: no JSON-RPC frame answered the request`,
    );
  }
  if ('error' in frame) {
    throw new UpstreamProtocolError(
      `${server.name}, ${method}: JSON-RPC error ${frame.error.code}: ${frame.error.message}`,
    );
  }
  return frame.result;
}
