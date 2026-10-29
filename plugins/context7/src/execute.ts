/**
 * Upstream calls of the `context7` provider.
 *
 * Spec     : docs/spec/vaubaan-gateway.md §2.4 — the credential arrives
 *            decrypted in the context, is used for one call, and never
 *            reaches the executor's result.
 * ADR      : docs/decisions/rewrap-official-mcps.md (the shape).
 * Handbook : docs/handbook/providers/context7.md.
 *
 * Two upstreams :
 *   - the official Context7 MCP server, https://mcp.context7.com/mcp
 *     (Streamable HTTP, SSE-framed JSON-RPC, stateless : no
 *     `Mcp-Session-Id`, no `initialize` before `tools/call`). Our
 *     `tools/call` is forwarded with the `context7__` prefix stripped and the
 *     arguments rebuilt from the classifier's `readCall` ;
 *   - the REST API, `GET /api/v2/usage` (`usage.ts`), for discovery and to
 *     explain a tool error.
 *
 * No identifier reaches a URL : both URLs are constants, and the arguments
 * of the agent travel in the JSON-RPC body.
 *
 * Failures. The MCP server answers a failed Context7 request with a tool
 * result `isError: true` on an HTTP 200 (a bad key included, checked live on
 * 2026-10-16). Such a result is not passed through — the audit would say
 * the call went through — and its text is not parsed to decide anything :
 * the executor asks the usage endpoint about the key (free) and throws
 *   - `UpstreamAuthError` with the status when the key is refused there
 *     (401 or 403) ; on a 401 only, the host marks the connection expired ;
 *   - `UpstreamHttpError(429)` when the usage endpoint answers 429, or
 *     answers 200 with a quota provably spent (`isQuotaSpent` : a Free plan
 *     past its included requests, or a spending limit reached) ;
 *   - a plain `Error` carrying Context7's text otherwise (an unknown
 *     library, a paid plan in billed overage, a server failure), or when
 *     the probe itself fails. The agent reads the text ; the audit keeps the
 *     class. An aborted call is rethrown as the abort.
 *
 * The JSON-RPC client is a copy of Railway's, stricter (a type guard on the
 * result, a null id accepted for an error frame only) ; extracting one
 * `callRemoteMcpTool` into the SDK is a follow-up.
 */

import {
  UpstreamAuthError,
  UpstreamHttpError,
  refusalResult,
  type ConnectionContext,
  type ExecuteContext,
  type McpToolContent,
  type McpToolResult,
  type Resource,
} from '@vaubaan/plugin-sdk';

import { readCall, resolveIndex, type Context7Call } from './classify.ts';
import { INDEX_REF, PROVIDER_ID } from './identity.ts';
import {
  CONTEXT7_USER_AGENT,
  context7KeyOf,
  isKeyRefusal,
  isQuotaSpent,
  parsedJson,
  readPlan,
  requestUsage,
} from './usage.ts';

export const CONTEXT7_MCP_URL = 'https://mcp.context7.com/mcp';
/** The protocol revision sent, as Railway's rewrap sends it. */
export const MCP_PROTOCOL_VERSION = '2025-06-18';

const HTTP_TOO_MANY_REQUESTS = 429;
/** Longest excerpt of an upstream body or tool text quoted in an error. */
const QUOTED_LENGTH = 300;

/** Display name of the one resource of a connection. */
export const INDEX_DISPLAY_NAME = 'Context7 library index';

export async function executeContext7(
  ctx: ExecuteContext,
  tool: string,
  args: Readonly<Record<string, unknown>>,
): Promise<McpToolResult> {
  // Declined here, before any request : a result the agent reads, not an
  // upstream failure. Every refusal is decided at this entry point, so no
  // `ExecutorRefusal` is thrown and `declining` is not needed.
  const call = readCall(tool, args);
  if ('denied' in call) return refusalResult(call.denied);
  const index = resolveIndex(ctx.resources);
  if ('denied' in index) return refusalResult(index.denied);

  const key = context7KeyOf(ctx.credential);
  const result = await callTool(ctx, key, call);
  if (result.isError === true) throw await explainToolError(ctx, key, result);
  return { content: result.content };
}

/**
 * The one resource of a connection : the library index its key can query,
 * with the plan of its teamspace. `GET /v2/usage` checks the key on the way
 * and is not counted on its quota.
 */
export async function discoverContext7Resources(
  ctx: ConnectionContext,
): Promise<readonly Resource[]> {
  const plan = await readPlan(ctx);
  return [
    { provider: PROVIDER_ID, ref: INDEX_REF, displayName: INDEX_DISPLAY_NAME, metadata: { plan } },
  ];
}

// ─────────────────────────────────────────────────────────────────────────────
// JSON-RPC over Streamable HTTP
// ─────────────────────────────────────────────────────────────────────────────

interface UpstreamToolResult {
  readonly content: readonly McpToolContent[];
  readonly isError?: boolean;
}

async function callTool(
  ctx: ExecuteContext,
  key: string,
  call: Context7Call,
): Promise<UpstreamToolResult> {
  const id = Math.floor(Math.random() * 1_000_000_000);
  const res = await ctx.fetch(CONTEXT7_MCP_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': MCP_PROTOCOL_VERSION,
      'User-Agent': CONTEXT7_USER_AGENT,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id,
      method: 'tools/call',
      params: { name: call.upstream, arguments: call.arguments },
    }),
    ...(ctx.signal ? { signal: ctx.signal } : {}),
  });
  if (!res.ok) {
    const msg = `Context7 MCP upstream ${res.status}: ${(await res.text()).slice(0, QUOTED_LENGTH)}`;
    if (isKeyRefusal(res.status)) throw new UpstreamAuthError(msg, res.status);
    throw new UpstreamHttpError(msg, res.status);
  }
  const frame = firstJsonRpcFrame(await res.text(), id);
  if ('error' in frame) {
    throw new Error(`Context7 MCP upstream error ${frame.error.code}: ${frame.error.message}`);
  }
  if (!isToolResult(frame.result)) {
    throw new Error(`${PROVIDER_ID}: the MCP server answered something that is not a tool result`);
  }
  return frame.result;
}

type JsonRpcFrame =
  | { readonly result: unknown }
  | { readonly error: { readonly code: number; readonly message: string } };

/**
 * The first JSON-RPC frame answering `id` (or `null`) in a Streamable HTTP
 * body : SSE `data:` lines, or a bare JSON document.
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

/** An MCP tool result made of text blocks, which is all Context7's tools answer. */
function isToolResult(x: unknown): x is UpstreamToolResult {
  if (typeof x !== 'object' || x === null) return false;
  const r = x as Record<string, unknown>;
  return (
    Array.isArray(r.content) &&
    r.content.every(
      (block: unknown) =>
        typeof block === 'object' &&
        block !== null &&
        (block as Record<string, unknown>).type === 'text' &&
        typeof (block as Record<string, unknown>).text === 'string',
    ) &&
    (r.isError === undefined || typeof r.isError === 'boolean')
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// A tool error, explained by the usage endpoint
// ─────────────────────────────────────────────────────────────────────────────

/** What to throw for an upstream `isError` result, decided by what `GET /v2/usage` says of the key. */
async function explainToolError(
  ctx: ExecuteContext,
  key: string,
  result: UpstreamToolResult,
): Promise<Error> {
  const said = `Context7: ${toolText(result)}`;
  let res: Response;
  let body: unknown;
  try {
    res = await requestUsage(ctx, key);
    body = res.ok ? parsedJson(await res.text()) : undefined;
  } catch (err) {
    // An aborted call is the caller's, not a fact about the key.
    if (ctx.signal?.aborted) throw err;
    // The probe failed : nothing is known of the key, the tool's text is what there is.
    return new Error(said);
  }
  if (isKeyRefusal(res.status)) return new UpstreamAuthError(said, res.status);
  if (res.status === HTTP_TOO_MANY_REQUESTS) return new UpstreamHttpError(said, res.status);
  if (res.ok && isQuotaSpent(body)) return new UpstreamHttpError(said, HTTP_TOO_MANY_REQUESTS);
  return new Error(said);
}

function toolText(result: UpstreamToolResult): string {
  const text = result.content
    .map((block) => (block.type === 'text' ? block.text : ''))
    .join(' ')
    .trim();
  return text.length === 0 ? 'the tool failed without a message' : text.slice(0, QUOTED_LENGTH);
}
