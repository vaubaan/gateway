/**
 * Upstream calls of the `context7` service.
 *
 * Spec     : docs/spec/vaubaan-gateway.md §2.4 — the credential arrives
 *            decrypted in the context, is used for one call, and never
 *            reaches the executor's result.
 * ADR      : docs/decisions/rewrap-official-mcps.md (the shape).
 * Handbook : docs/handbook/services/context7.md.
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
 *     (401 or 403) ; on a 401 only, the host marks the account expired ;
 *   - `UpstreamHttpError(429)` when the usage endpoint answers 429, or
 *     answers 200 with a quota provably spent (`isQuotaSpent` : a Free plan
 *     past its included requests, or a spending limit reached) ;
 *   - a plain `Error` carrying Context7's text otherwise (an unknown
 *     library, a paid plan in billed overage, a server failure), or when
 *     the probe itself fails. The agent reads the text ; the audit keeps the
 *     class. An aborted call is rethrown as the abort.
 *
 * The call itself goes through the SDK's MCP client (`callUpstreamTool`) :
 * a failed status is `UpstreamAuthError` (401 / 403) or `UpstreamHttpError`,
 * a JSON-RPC error frame, an answer with no frame for the request or one
 * that is not a tool result `UpstreamProtocolError`.
 */

import {
  QUOTED_LENGTH,
  UpstreamAuthError,
  UpstreamHttpError,
  anyJson,
  callUpstreamTool,
  refusalResult,
  type AccountContext,
  type ExecuteContext,
  type McpToolResult,
  type Resource,
} from '@vaubaan/plugin-sdk';

import { readCall, resolveIndex } from './classify.ts';
import { CONTEXT7_MCP_SERVER, INDEX_REF, SERVICE_ID } from './identity.ts';
import { context7KeyOf, isQuotaSpent, readPlan, requestUsage } from './usage.ts';

const HTTP_TOO_MANY_REQUESTS = 429;

/** Display name of the one resource of an account. */
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
  const result = await callUpstreamTool(
    ctx,
    CONTEXT7_MCP_SERVER,
    key,
    call.upstream,
    call.arguments,
  );
  if (result.isError === true) throw await explainToolError(ctx, key, result);
  return { content: result.content };
}

/**
 * The one resource of an account : the library index its key can query,
 * with the plan of its teamspace. `GET /v2/usage` checks the key on the way
 * and is not counted on its quota.
 */
export async function discoverContext7Resources(ctx: AccountContext): Promise<readonly Resource[]> {
  const plan = await readPlan(ctx);
  return [
    { service: SERVICE_ID, ref: INDEX_REF, displayName: INDEX_DISPLAY_NAME, metadata: { plan } },
  ];
}

// ─────────────────────────────────────────────────────────────────────────────
// A tool error, explained by the usage endpoint
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What to throw for an upstream `isError` result, decided by what
 * `GET /v2/usage` says of the key. The probe is best-effort by design : a
 * probe that fails without saying anything of the key (another status, an
 * answer that is not JSON, the network) leaves Context7's text as the
 * failure, never the probe's own.
 */
async function explainToolError(
  ctx: ExecuteContext,
  key: string,
  result: McpToolResult,
): Promise<Error> {
  const said = `Context7: ${toolText(result)}`;
  let usage: unknown;
  try {
    usage = await requestUsage(ctx, key, anyJson);
  } catch (err) {
    // An aborted call is the caller's, not a fact about the key.
    if (ctx.signal?.aborted) throw err;
    if (err instanceof UpstreamAuthError) return new UpstreamAuthError(said, err.upstreamStatus);
    if (err instanceof UpstreamHttpError && err.status === HTTP_TOO_MANY_REQUESTS) {
      return new UpstreamHttpError(said, HTTP_TOO_MANY_REQUESTS);
    }
    return new Error(said);
  }
  if (isQuotaSpent(usage)) return new UpstreamHttpError(said, HTTP_TOO_MANY_REQUESTS);
  return new Error(said);
}

function toolText(result: McpToolResult): string {
  const text = result.content
    .map((block) => (block.type === 'text' ? block.text : ''))
    .join(' ')
    .trim();
  return text.length === 0 ? 'the tool failed without a message' : text.slice(0, QUOTED_LENGTH);
}
