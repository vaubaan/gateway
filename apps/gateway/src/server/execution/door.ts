/**
 * The execution MCP door (spec §4.1) — host-agnostic `Request → Response`.
 *
 *   POST /mcp          MCP Streamable HTTP, stateless: `tools/list`, `tools/call`
 *   GET  /mcp/catalog  the mission's catalog (tools, resources, remaining budget)
 *
 * Order of a request:
 *
 *   origin        a browser origin other than the instance's is refused (the door
 *                 answers no CORS preflight: agents are not browsers)
 *   bearer        `Authorization: Bearer <mission token>`; missing or unknown →
 *                 401; a token that authenticated once and no longer does —
 *                 rotated, revoked on its own, its member removed or
 *                 deactivated — → 401 whose `data.reason` says which
 *                 (`AUTH_FAILURE_REASONS`, gateway-core): the mission may be
 *                 serving its other holders, so this is not `mission-inactive`;
 *                 a web session or a delegated token → 403
 *                 `wrong-credential-kind` (spec §6 "none crosses over").
 *                 A verified token names its holder: every call is attributed
 *                 to them in the audit and the session (spec §8)
 *   grounds       the creator's authority over the mission, re-read from the
 *                 store on every request (spec §2.3 "orphaned", §10): a mission
 *                 whose grounds are gone reads `orphaned` for this request and
 *                 the call is refused `mission-inactive`; nothing is stored,
 *                 so the same token serves again once the authority is back
 *   surface rate  requests per minute per mission (spec §6) → 429
 *   protocol      the MCP SDK (`@modelcontextprotocol/server`, v2): 2026-07-28
 *                 requests through `createMcpHandler` (stateless, JSON, upgraded
 *                 to SSE only if a handler emits notifications), 2025-era
 *                 requests through the stateless JSON transport — or, for a
 *                 `tools/call` that carries a `progressToken`, through the
 *                 SDK's stateless SSE fallback
 *   tools/call    `CallPipeline.execute` (gateway-core) with the real stages
 *
 * Streaming (spec §4.1 "the decision is made before the stream starts"). MCP
 * has no partial result: a `tools/call` is answered by one message. What can
 * leave early is `notifications/progress` on the call's own event stream, and
 * only for a caller that sent a `progressToken`. The door hands the pipeline
 * an `onPart` that turns each part a plugin emits into one such notification;
 * the pipeline calls it from its last stage only, so no byte of a result
 * leaves before the mission, resource, risk and budget checks have passed and
 * the credit is counted, and a refused call is answered by its error alone. The
 * complete result still closes the exchange. A caller that sent no token gets
 * the same result as one JSON body.
 *
 * Refusals travel whole: a refused `tools/call` is the JSON-RPC error
 * `refusalToRpcError` describes — code `-32603`, `data` = the refusal with its
 * fields and its `hint` (claim URL, approval URL, allowed resources…). The v4
 * route forwarded only `error.message`, which hid them.
 *
 * Nothing here imports `next`; `src/app/mcp/**` are one-line adapters.
 */
import {
  createMcpHandler,
  isLegacyRequest,
  legacyStatelessFallback,
  ProtocolError,
  Server,
  WebStandardStreamableHTTPServerTransport,
  type AuthInfo,
  type CallToolResult,
  type LegacyHttpHandler,
  type ListToolsResult,
  type McpHttpHandler,
  type ServerContext,
} from '@modelcontextprotocol/server';
import {
  AUTH_REQUIRED_HTTP_STATUS,
  checkMissionActive,
  refusalToRpcError,
  rpcError,
  tokenHolderLabel,
  type CallPipeline,
  type CallRequest,
  type ClientOrigin,
  type MissionContext,
  type Refusal,
} from '@vaubaan/gateway-core';
import type { PluginRegistry } from '@vaubaan/plugin-sdk';
import type { JsonRpcError } from '@vaubaan/shared';

import type { BuildInfo } from '../compose/root';
import { budgetMissionOf, type SessionService } from '../budget';
import type { Logger } from '../logging';
import { maskedToken } from '../missions';
import { systemClock, type Clock } from '../store/clock';
import { isDenial, MissionAdmission, type Admitted, type MissionAdmissionDeps } from './admission';
import { readAgentLabel } from './request-meta';
import { buildCatalog, callableTools, type GitRemoteView } from './tools';

/** Name the door announces to MCP clients. */
export const MCP_SERVER_INFO_NAME = 'vaubaan-gateway';
/** JSON-RPC code of the surface rate limit (next to `AUTH_REQUIRED_RPC_CODE`). */
export const SURFACE_RATE_LIMITED_RPC_CODE = -32002;
/** JSON-RPC code of a structural rejection: the call cannot be placed (unknown tool, arguments). */
export const CALL_REJECTED_RPC_CODE = -32602;

const HTTP_FORBIDDEN = 403;
const HTTP_METHOD_NOT_ALLOWED = 405;
const HTTP_TOO_MANY_REQUESTS = 429;
const MS_PER_SECOND = 1000;
/** Key under which the request scope rides `AuthInfo.extra` to the per-request server. */
const SCOPE_KEY = 'vaubaan';
const TOOLS_CALL_METHOD = 'tools/call';
const PROGRESS_NOTIFICATION = 'notifications/progress';

export interface ExecutionDoorDeps extends MissionAdmissionDeps {
  readonly registry: PluginRegistry;
  readonly budget: Pick<SessionService, 'stateOf'>;
  readonly pipeline: CallPipeline;
  readonly logger: Logger;
  readonly build: BuildInfo;
  readonly clock?: Clock;
  /** Where the catalog says the git remote of each repository is; absent: no git remote. */
  readonly gitRemote?: GitRemoteView;
}

/** What one authenticated request carries to the handlers. */
interface RequestScope {
  readonly ctx: MissionContext;
  readonly headers: Headers;
  readonly client: ClientOrigin;
}

export class ExecutionDoor {
  /** The admission of a mission key; the git door is handed this same instance. */
  readonly admission: MissionAdmission;
  private readonly clock: Clock;
  private readonly modern: McpHttpHandler;
  /** 2025-era calls that asked for progress: the SDK's stateless leg, answering in SSE. */
  private readonly legacyStream: LegacyHttpHandler;

  constructor(private readonly deps: ExecutionDoorDeps) {
    this.clock = deps.clock ?? systemClock;
    this.admission = new MissionAdmission(deps);
    // 2026-07-28 traffic. The handler holds nothing between requests; the factory
    // builds one server per request around the scope the door authenticated.
    const onerror = (error: Error): void =>
      deps.logger.debug('mcp request rejected', { error: error.message });
    this.modern = createMcpHandler(({ authInfo }) => this.buildServer(scopeOf(authInfo)), {
      legacy: 'reject',
      responseMode: 'auto',
      onerror,
    });
    this.legacyStream = legacyStatelessFallback(
      ({ authInfo }) => this.buildServer(scopeOf(authInfo)),
      onerror,
    );
  }

  /** `/mcp` — every HTTP method the route exports lands here. */
  async handleMcp(request: Request): Promise<Response> {
    const gate = await this.admit(request);
    if (gate instanceof Response) return gate;
    const scope: RequestScope = {
      ctx: gate.ctx,
      headers: request.headers,
      client: gate.client,
    };
    const authInfo: AuthInfo = {
      // The SDK wants a token string; it gets the masked prefix, never the bearer.
      token: maskedToken(scope.ctx.token.prefix),
      clientId: scope.ctx.mission.id,
      scopes: [],
      extra: { [SCOPE_KEY]: scope },
    };
    if (await isLegacyRequest(request)) return this.serveLegacy(request, scope, authInfo);
    return this.modern.fetch(request, { authInfo });
  }

  /** `GET /mcp/catalog` — spec §4.1 "Catalog". */
  async handleCatalog(request: Request): Promise<Response> {
    if (request.method !== 'GET') {
      return json(
        HTTP_METHOD_NOT_ALLOWED,
        rpcError(null, -32600, 'the catalog is read with GET.'),
        { Allow: 'GET' },
      );
    }
    const gate = await this.admit(request);
    if (gate instanceof Response) return gate;
    const now = this.clock.now();
    const inactive = checkMissionActive(gate.ctx, now);
    if (inactive) return json(HTTP_FORBIDDEN, refusalToRpcError(null, inactive));
    const state = await this.deps.budget.stateOf(budgetMissionOf(gate.mission), now);
    const creator = await this.deps.store.users.getById(gate.mission.creatorUserId);
    return json(
      200,
      buildCatalog(
        gate.ctx,
        this.deps.registry,
        state,
        { creator: creator?.email ?? null },
        this.deps.gitRemote ?? null,
      ),
    );
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Admission: origin, bearer, surface rate limit (shared with the other door)
  // ───────────────────────────────────────────────────────────────────────────

  private async admit(request: Request): Promise<Admitted | Response> {
    const outcome = await this.admission.admit(request, request.headers.get('authorization'));
    if (!isDenial(outcome)) return outcome;
    switch (outcome.denial) {
      case 'cross-origin':
        return json(
          HTTP_FORBIDDEN,
          rpcError(null, -32600, 'cross-origin requests are not accepted on this endpoint.'),
        );
      case 'verification-throttled':
      case 'rate-limited':
        return tooManyRequests(outcome.retryAfterMs);
      case 'unauthenticated': {
        // `reason` is set only for a token whose secret was proven: the caller
        // learns nothing they could not have learnt while the token worked.
        const err = outcome.error;
        const data = err.reason ? { reason: err.reason } : undefined;
        return json(AUTH_REQUIRED_HTTP_STATUS, rpcError(null, err.code, err.message, data), {
          'WWW-Authenticate': `Bearer realm="${MCP_SERVER_INFO_NAME}"`,
        });
      }
      case 'refused':
        return json(HTTP_FORBIDDEN, refusalToRpcError(null, outcome.refusal));
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // MCP serving
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * 2025-era clients: one stateless exchange, answered as plain JSON — unless
   * the call asked for progress, in which case the answer is the call's event
   * stream (progress notifications, then the result).
   */
  private async serveLegacy(
    request: Request,
    scope: RequestScope,
    authInfo: AuthInfo,
  ): Promise<Response> {
    if (request.method !== 'POST') {
      // Stateless: there is no session to stream (GET) or to end (DELETE).
      return json(HTTP_METHOD_NOT_ALLOWED, rpcError(null, -32000, 'Method not allowed.'), {
        Allow: 'POST',
      });
    }
    if (await asksForProgress(request)) return this.legacyStream(request, { authInfo });
    const server = this.buildServer(scope);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);
    try {
      return await transport.handleRequest(request);
    } finally {
      await server.close();
    }
  }

  private buildServer(scope: RequestScope | undefined): Server {
    if (!scope) throw new Error('execution door: MCP server built without a request scope');
    const { ctx } = scope;
    const server = new Server(
      { name: MCP_SERVER_INFO_NAME, version: this.deps.build.version },
      { capabilities: { tools: {} } },
    );

    server.setRequestHandler('tools/list', async () => {
      const inactive = checkMissionActive(ctx, this.clock.now());
      if (inactive) throw refusalError(inactive);
      // Plugin tool declarations are JSON Schema documents (`McpToolDeclaration`);
      // the SDK types the same documents as JSON values.
      return { tools: callableTools(ctx, this.deps.registry) as ListToolsResult['tools'] };
    });

    server.setRequestHandler(TOOLS_CALL_METHOD, async (request, { mcpReq }) => {
      const { name, arguments: args, _meta: meta } = request.params;
      const onPart = this.progressForwarder(mcpReq, ctx);
      const outcome = await this.deps.pipeline.execute(ctx, {
        tool: name,
        args: args ?? {},
        agent_label: this.agentLabel(scope, meta),
        client: scope.client,
        ...(onPart ? { onPart } : {}),
        signal: mcpReq.signal,
      });
      // Arguments are never logged; the audit entry carries their fingerprint.
      this.deps.logger.info('tools/call', {
        mission_id: ctx.mission.id,
        token_prefix: ctx.token.prefix,
        token_kind: ctx.token.holder.kind,
        // The holder as the instance names them (an email, or the token's name).
        holder_label: tokenHolderLabel(ctx.token.holder),
        tool: name,
        outcome: outcome.kind,
        refusal_code: outcome.audit.refusal_code,
        arguments_hash: outcome.audit.arguments_hash,
        agent_label: outcome.audit.agent_label,
      });
      switch (outcome.kind) {
        case 'allowed':
          // What the plugin returned (`McpToolResult`), forwarded as is.
          return outcome.result as CallToolResult;
        case 'refused':
          throw refusalError(outcome.refusal);
        case 'rejected':
          throw new ProtocolError(
            CALL_REJECTED_RPC_CODE,
            `Vaubaan rejected the call: ${outcome.reason}`,
            { reason: outcome.reason },
          );
        case 'failed':
          if (outcome.refusal) throw refusalError(outcome.refusal);
          // The call was allowed and counted; the provider failed. A tool-level
          // error, so the model reads it and can react.
          return {
            isError: true,
            content: [{ type: 'text', text: `Upstream error: ${outcome.error}` }],
          };
      }
    });
    return server;
  }

  /**
   * The label of a call (attribution only). A carrier whose value is not a
   * label is dropped and logged — its reason and length, never its value —
   * and changes nothing else about the call.
   */
  private agentLabel(scope: RequestScope, meta: unknown): string | null {
    const reading = readAgentLabel(scope.headers, meta);
    for (const dropped of reading.dropped) {
      this.deps.logger.info('agent label dropped', {
        mission_id: scope.ctx.mission.id,
        carrier: dropped.carrier,
        reason: dropped.reason,
        length: dropped.length,
      });
    }
    return reading.label;
  }

  /**
   * What turns the parts of a streamed result into progress notifications on
   * the call's event stream; nothing when the caller sent no `progressToken`.
   * `progress` counts the parts; a text part travels as `message`. A
   * notification that cannot be delivered never fails the call: the caller
   * being gone is seen through the call's signal.
   */
  private progressForwarder(
    mcpReq: ServerContext['mcpReq'],
    ctx: MissionContext,
  ): CallRequest['onPart'] {
    const progressToken = mcpReq._meta?.progressToken;
    if (progressToken === undefined) return undefined;
    let sent = 0;
    return async (part) => {
      sent += 1;
      try {
        await mcpReq.notify({
          method: PROGRESS_NOTIFICATION,
          params: {
            progressToken,
            progress: sent,
            ...(part.type === 'text' ? { message: part.text } : {}),
          },
        });
      } catch (err) {
        this.deps.logger.debug('progress notification not delivered', {
          mission_id: ctx.mission.id,
          error: err instanceof Error ? err.name : 'Error',
        });
      }
    };
  }
}

/** The request scope the door put in `AuthInfo.extra` for the per-request server. */
function scopeOf(authInfo: AuthInfo | undefined): RequestScope | undefined {
  return authInfo?.extra?.[SCOPE_KEY] as RequestScope | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Does this POST carry a single `tools/call` with a `progressToken`? Read on
 * a clone, so the SDK still reads the body itself. Anything else — a batch,
 * another method, an unreadable body — is served as JSON.
 */
async function asksForProgress(request: Request): Promise<boolean> {
  let body: unknown;
  try {
    body = await request.clone().json();
  } catch {
    return false;
  }
  if (!isRecord(body) || body.method !== TOOLS_CALL_METHOD || !isRecord(body.params)) return false;
  const meta = body.params._meta;
  if (!isRecord(meta)) return false;
  return typeof meta.progressToken === 'string' || typeof meta.progressToken === 'number';
}

/** The JSON-RPC error of a refusal, as a throwable the SDK serializes untouched. */
function refusalError(refusal: Refusal): ProtocolError {
  const { error } = refusalToRpcError(null, refusal);
  return new ProtocolError(error.code, error.message, error.data);
}

function tooManyRequests(retryAfterMs: number): Response {
  const seconds = Math.max(1, Math.ceil(retryAfterMs / MS_PER_SECOND));
  return json(
    HTTP_TOO_MANY_REQUESTS,
    rpcError(
      null,
      SURFACE_RATE_LIMITED_RPC_CODE,
      `Too many requests for this mission; retry in ${seconds} s.`,
      { retry_after_seconds: seconds },
    ),
    { 'Retry-After': String(seconds) },
  );
}

function json(
  status: number,
  body: JsonRpcError | object,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers },
  });
}
