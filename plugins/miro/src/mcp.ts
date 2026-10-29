/**
 * The JSON-RPC client of Miro's MCP server (Streamable HTTP), for the
 * executor, discovery and the capture script.
 *
 * Handbook : docs/handbook/providers/miro.md.
 *
 * One request per call when the server is stateless, as Railway's and
 * Context7's are. ⚠ Whether Miro's server needs an `initialize` first is not
 * documented and could not be checked without an account : when a request
 * without a session is answered 400 or 404, the client initializes once
 * (`initialize`, then `notifications/initialized`), keeps the
 * `Mcp-Session-Id` the server returned, and sends the request again with it.
 *
 * Failures : 401 and 403 throw `UpstreamAuthError` (the host refreshes the
 * token and tries again, then marks the account "needs reconnecting") ; any
 * other failed status `UpstreamHttpError` ; a JSON-RPC error frame a plain
 * `Error` with Miro's message, for the agent. Miro's text goes to the agent
 * only (ADR provider-error-text-stays-with-the-agent).
 */

import { UpstreamAuthError, UpstreamHttpError } from '@vaubaan/plugin-sdk';

import { MIRO_MCP_URL, PROVIDER_ID } from './identity.ts';

/** The protocol revision sent, as the other rewraps send it. */
export const MCP_PROTOCOL_VERSION = '2025-06-18';
/** Longest excerpt of an upstream body quoted in an error (for the agent). */
const QUOTED_LENGTH = 300;
const SESSION_HEADER = 'mcp-session-id';

export interface McpIo {
  readonly fetch: typeof fetch;
  readonly signal?: AbortSignal;
}

type JsonRpcFrame =
  | { readonly result: unknown }
  | { readonly error: { readonly code: number; readonly message: string } };

let nextId = 1;

function headers(token: string, session: string | null): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    'MCP-Protocol-Version': MCP_PROTOCOL_VERSION,
    ...(session ? { 'Mcp-Session-Id': session } : {}),
  };
}

async function post(
  io: McpIo,
  token: string,
  body: unknown,
  session: string | null,
): Promise<Response> {
  return io.fetch(MIRO_MCP_URL, {
    method: 'POST',
    headers: headers(token, session),
    body: JSON.stringify(body),
    redirect: 'error',
    ...(io.signal ? { signal: io.signal } : {}),
  });
}

async function failure(res: Response, what: string): Promise<Error> {
  const text = (await res.text().catch(() => '')).slice(0, QUOTED_LENGTH);
  const msg = `Miro MCP server answered ${res.status} to ${what}${text ? `: ${text}` : ''}`;
  if (res.status === 401 || res.status === 403) return new UpstreamAuthError(msg, res.status);
  return new UpstreamHttpError(msg, res.status);
}

/** Opens a session : `initialize`, then `notifications/initialized`. Returns the session id, if any. */
async function initialize(io: McpIo, token: string): Promise<string | null> {
  const id = nextId++;
  const res = await post(
    io,
    token,
    {
      jsonrpc: '2.0',
      id,
      method: 'initialize',
      params: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'vaubaan-gateway', version: '1' },
      },
    },
    null,
  );
  if (!res.ok) throw await failure(res, 'initialize');
  const session = res.headers.get(SESSION_HEADER);
  const frame = firstJsonRpcFrame(await res.text(), id);
  if ('error' in frame) {
    throw new Error(`Miro MCP initialize error ${frame.error.code}: ${frame.error.message}`);
  }
  const done = await post(
    io,
    token,
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    session,
  );
  // A notification is answered 202 (no body) ; anything else but a refusal is tolerated.
  if (done.status === 401 || done.status === 403) throw await failure(done, 'initialized');
  await done.text().catch(() => '');
  return session;
}

/**
 * One JSON-RPC request to Miro's MCP server ; the `result` of its answer.
 * Initializes a session once when the server asks for one (see above).
 */
export async function mcpRequest(
  io: McpIo,
  token: string,
  method: string,
  params: Readonly<Record<string, unknown>>,
): Promise<unknown> {
  let session: string | null = null;
  for (let attempt = 0; ; attempt++) {
    const id = nextId++;
    const res = await post(io, token, { jsonrpc: '2.0', id, method, params }, session);
    if (!res.ok) {
      if (attempt === 0 && (res.status === 400 || res.status === 404)) {
        await res.text().catch(() => '');
        session = await initialize(io, token);
        continue;
      }
      throw await failure(res, method);
    }
    const frame = firstJsonRpcFrame(await res.text(), id);
    if ('error' in frame) {
      throw new Error(`Miro MCP error ${frame.error.code}: ${frame.error.message}`);
    }
    return frame.result;
  }
}

/**
 * The first JSON-RPC frame answering `id` (or `null`, for an error) in a
 * Streamable HTTP body : SSE `data:` lines, or a bare JSON document.
 */
export function firstJsonRpcFrame(body: string, id: number): JsonRpcFrame {
  const candidates: string[] = [];
  const trimmed = body.trim();
  if (trimmed.startsWith('{')) candidates.push(trimmed);
  for (const line of body.split('\n')) {
    if (line.startsWith('data:')) candidates.push(line.slice('data:'.length).trim());
  }
  for (const payload of candidates) {
    const frame = asFrame(payload, id);
    if (frame) return frame;
  }
  throw new Error(`${PROVIDER_ID}: no JSON-RPC frame answered id ${id} in the MCP response`);
}

function asFrame(payload: string, id: number): JsonRpcFrame | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const frame = parsed as Record<string, unknown>;
  if (frame.jsonrpc !== '2.0') return null;
  const error = frame.error as Record<string, unknown> | null | undefined;
  // A null id is what a server answers when it could not read the request's
  // id : acceptable for an error frame, never for a result.
  if (frame.id !== id && !(frame.id === null && typeof error === 'object' && error !== null)) {
    return null;
  }
  if (typeof error === 'object' && error !== null) {
    return {
      error: {
        code: typeof error.code === 'number' ? error.code : 0,
        message: typeof error.message === 'string' ? error.message : 'no message',
      },
    };
  }
  return 'result' in frame ? { result: frame.result } : null;
}
