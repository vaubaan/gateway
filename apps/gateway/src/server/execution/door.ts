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
  AuthError,
  BOOTSTRAP_ACTOR_ID,
  checkMissionActive,
  DoorAuthenticator,
  isRefusal,
  refusalToRpcError,
  refuse,
  rpcError,
  tokenHolderLabel,
  type AuthFailureReason,
  type CallPipeline,
  type CallRequest,
  type ClientOrigin,
  type CredentialResolver,
  type DelegationContext,
  type MissionContext,
  type Refusal,
  type ResolvedCredential,
} from '@vaubaan/gateway-core';
import type { PluginRegistry } from '@vaubaan/plugin-sdk';
import type { JsonRpcError } from '@vaubaan/shared';

import { SESSION_COOKIE, type SessionService as WebSessionService } from '../auth';
import type { MissionGrounds } from '../authority';
import { budgetMissionOf, type SessionService } from '../budget';
import type { BuildInfo } from '../compose/root';
import type { RateLimiter } from '../compose/ports';
import type { InstanceConfig } from '../config';
import { UNKNOWN_CLIENT } from '../http/client-ip';
import type { Logger } from '../logging';
import { maskedToken, prefixOfBearer, type TokenRetirement } from '../missions';
import type { Store } from '../store';
import { systemClock, type Clock } from '../store/clock';
import type { MissionRecord } from '../store/types';
import { loadMissionContext } from './mission-context';
import { clientOriginOf, readAgentLabel, trustedProxyList } from './request-meta';
import type { TokenVerifier } from './token-verifier';
import { buildCatalog, callableTools } from './tools';

/** Name the door announces to MCP clients. */
export const MCP_SERVER_INFO_NAME = 'vaubaan-gateway';
/** JSON-RPC code of the surface rate limit (next to `AUTH_REQUIRED_RPC_CODE`). */
export const SURFACE_RATE_LIMITED_RPC_CODE = -32002;
/** JSON-RPC code of a structural rejection: the call cannot be placed (unknown tool, arguments). */
export const CALL_REJECTED_RPC_CODE = -32602;
export const SURFACE_RATE_WINDOW_MS = 60_000;

const HTTP_FORBIDDEN = 403;
const HTTP_METHOD_NOT_ALLOWED = 405;
const HTTP_TOO_MANY_REQUESTS = 429;
const MS_PER_SECOND = 1000;
/** Key under which the request scope rides `AuthInfo.extra` to the per-request server. */
const SCOPE_KEY = 'vaubaan';
const SESSION_ID_SHAPE = /^[A-Za-z0-9_-]{16,}$/;
const TOOLS_CALL_METHOD = 'tools/call';
const PROGRESS_NOTIFICATION = 'notifications/progress';

/** Identifies a delegated token (management door). Absent until then. */
export interface DelegatedTokenResolver {
  resolve(bearer: string): Promise<DelegationContext | null>;
}

export interface ExecutionDoorDeps {
  readonly config: Pick<InstanceConfig, 'publicUrl' | 'trustedProxies' | 'mcp'>;
  readonly store: Pick<Store, 'connections' | 'users' | 'groups' | 'sessions'>;
  readonly registry: PluginRegistry;
  readonly tokens: TokenVerifier;
  /** Records "last used" on the token a call authenticated with (to the minute). */
  readonly tokenUse: TokenUseRecorder;
  /** Is the mission still grounded in its creator's current authority? Never optional. */
  readonly grounds: Pick<MissionGrounds, 'inspect'>;
  readonly webSessions: Pick<WebSessionService, 'read'>;
  readonly budget: Pick<SessionService, 'stateOf'>;
  readonly pipeline: CallPipeline;
  readonly rateLimiter: RateLimiter;
  readonly logger: Logger;
  readonly build: BuildInfo;
  readonly clock?: Clock;
  readonly delegations?: DelegatedTokenResolver;
}

/** `MissionsRepo.markTokenUsed`: the door's only write outside the pipeline. */
export interface TokenUseRecorder {
  markTokenUsed(tokenId: string, granularitySeconds: number): Promise<boolean>;
}

/** `mission_tokens.last_used_at` is written at most once per token in this many seconds. */
export const TOKEN_LAST_USED_GRANULARITY_SECONDS = 60;

/**
 * What the door answers for a token whose secret matched and that no longer
 * authenticates. A token revoked together with its mission is not here: that
 * one still identifies the mission and is answered `mission-inactive`.
 */
const AUTH_FAILURE_OF: Readonly<Record<TokenRetirement, AuthFailureReason>> = {
  rotated: 'token-rotated',
  revoked: 'token-revoked',
  'holder-removed': 'holder-removed',
  'holder-deactivated': 'holder-deactivated',
};

/** What one authenticated request carries to the handlers. */
interface RequestScope {
  readonly ctx: MissionContext;
  readonly headers: Headers;
  readonly client: ClientOrigin;
}

interface Authenticated {
  readonly ctx: MissionContext;
  readonly mission: MissionRecord;
  readonly client: ClientOrigin;
}

class VerificationThrottled extends Error {
  constructor(readonly retryAfterMs: number) {
    super('too many token verifications');
  }
}

export class ExecutionDoor {
  private readonly clock: Clock;
  private readonly missionsByContext = new WeakMap<MissionContext, MissionRecord>();
  private readonly proxies: ReturnType<typeof trustedProxyList>;
  private readonly modern: McpHttpHandler;
  /** 2025-era calls that asked for progress: the SDK's stateless leg, answering in SSE. */
  private readonly legacyStream: LegacyHttpHandler;

  constructor(private readonly deps: ExecutionDoorDeps) {
    this.clock = deps.clock ?? systemClock;
    this.proxies = trustedProxyList(deps.config.trustedProxies);
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
      buildCatalog(gate.ctx, this.deps.registry, state, {
        creator: creator?.email ?? null,
      }),
    );
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Admission: origin, bearer, surface rate limit
  // ───────────────────────────────────────────────────────────────────────────

  private async admit(request: Request): Promise<Authenticated | Response> {
    const origin = request.headers.get('origin');
    if (origin !== null && origin !== this.deps.config.publicUrl.origin) {
      return json(
        HTTP_FORBIDDEN,
        rpcError(null, -32600, 'cross-origin requests are not accepted on this endpoint.'),
      );
    }

    // Resolved once per request: the audit entry and the verification throttle
    // must name the same address.
    const client = clientOriginOf(request.headers, {
      proxies: this.proxies,
      configured: this.deps.config.trustedProxies.length > 0,
    });
    let ctx: MissionContext | Refusal;
    try {
      ctx = await this.authenticate(request.headers, client.ip ?? UNKNOWN_CLIENT);
    } catch (err) {
      if (err instanceof VerificationThrottled) return tooManyRequests(err.retryAfterMs);
      if (err instanceof AuthError) {
        // `reason` is set only for a token whose secret was proven: the caller
        // learns nothing they could not have learnt while the token worked.
        const data = err.reason ? { reason: err.reason } : undefined;
        return json(AUTH_REQUIRED_HTTP_STATUS, rpcError(null, err.code, err.message, data), {
          'WWW-Authenticate': `Bearer realm="${MCP_SERVER_INFO_NAME}"`,
        });
      }
      throw err;
    }
    if (isRefusal(ctx)) {
      this.deps.logger.warn('bearer refused at the execution door', { refusal_code: ctx.code });
      return json(HTTP_FORBIDDEN, refusalToRpcError(null, ctx));
    }

    const surface = await this.deps.rateLimiter.take(
      `mcp:mission:${ctx.mission.id}`,
      this.deps.config.mcp.rateLimitPerMinute,
      SURFACE_RATE_WINDOW_MS,
    );
    if (!surface.allowed) return tooManyRequests(surface.retryAfterMs);

    const mission = this.missionsByContext.get(ctx);
    if (!mission) throw new Error('execution door: mission context without its record');
    await this.noteTokenUse(ctx);
    return { ctx, mission, client };
  }

  /**
   * "Last used" of the token, for the creator's list of tokens. Informational:
   * a failure to record it is logged and never refuses the request.
   */
  private async noteTokenUse(ctx: MissionContext): Promise<void> {
    try {
      await this.deps.tokenUse.markTokenUsed(ctx.token.id, TOKEN_LAST_USED_GRANULARITY_SECONDS);
    } catch (err) {
      this.deps.logger.warn('token use not recorded', {
        mission_id: ctx.mission.id,
        token_prefix: ctx.token.prefix,
        error: err instanceof Error ? err.name : 'Error',
      });
    }
  }

  private async authenticate(
    headers: Headers,
    clientIp: string,
  ): Promise<MissionContext | Refusal> {
    const authorization = headers.get('authorization');
    if (!authorization && (await this.deps.webSessions.read(headers))) {
      // A browser session presented where a mission token is expected.
      return refuse.wrongCredentialKind({
        door: 'execution',
        presented: 'human-session',
        expected: 'mission-token',
      });
    }
    return new DoorAuthenticator(this.credentialResolver(clientIp)).authenticateMission(
      authorization,
    );
  }

  /** One resolver per request: the verification throttle is keyed on the caller's address. */
  private credentialResolver(clientIp: string): CredentialResolver {
    return {
      resolve: async (bearer): Promise<ResolvedCredential | null> => {
        const verified = await this.deps.tokens.verify(bearer, clientIp);
        if (verified.outcome === 'throttled')
          throw new VerificationThrottled(verified.retryAfterMs);
        if (verified.outcome !== 'unknown') {
          if (verified.outcome === 'retired') {
            // A token retired by the revocation of its MISSION still identifies that
            // mission, so the caller is told `mission-inactive`. Every other retired
            // token no longer authenticates, and the 401 says why: replaced by its
            // holder, revoked on its own, its member removed, its holder deactivated.
            // In those cases the mission may be serving its other holders, so
            // `mission-inactive` would be a lie about the mission.
            // The status read here is the STORED one, on purpose: the question is
            // whether the store still holds the mission active, asked before the
            // derivation (`grounds.inspect`) below.
            const withItsMission =
              verified.reason === 'revoked' && verified.mission.status !== 'active';
            if (!withItsMission) {
              const reason = AUTH_FAILURE_OF[verified.reason];
              this.deps.logger.warn('retired mission token presented at the execution door', {
                mission_id: verified.mission.id,
                token_prefix: verified.token.prefix,
                token_kind: verified.token.holder.kind,
                reason,
              });
              throw AuthError.tokenStopped(reason);
            }
          }
          // Authority is never snapshotted in a mission, and `orphaned` is never
          // stored: the creator's authority is re-read here, and the mission is
          // orphaned for this request exactly when it does not ground it now.
          const { mission, orphan } = await this.deps.grounds.inspect(verified.mission);
          if (orphan) {
            // No administrative entry: no human is behind this read. The refused
            // call itself is audited by the pipeline (`mission-inactive`).
            this.deps.logger.info('mission orphaned at the execution door', {
              mission_id: mission.id,
              cause: orphan.cause,
              connection_id: orphan.connectionId,
              uncovered: orphan.uncovered,
            });
          }
          const context = await loadMissionContext(this.deps.store, mission, verified.token);
          this.missionsByContext.set(context, mission);
          return { kind: 'mission-token', context };
        }

        // A bearer of mission-token shape is never used as a session-store key.
        if (!prefixOfBearer(bearer) && SESSION_ID_SHAPE.test(bearer)) {
          const asCookie = new Headers({ cookie: `${SESSION_COOKIE}=${bearer}` });
          const session = await this.deps.webSessions.read(asCookie);
          if (session) {
            const { record } = session;
            return {
              kind: 'human-session',
              user_id: record.kind === 'user' ? record.userId : BOOTSTRAP_ACTOR_ID,
            };
          }
        }
        const delegation = await this.deps.delegations?.resolve(bearer);
        return delegation ? { kind: 'delegated-token', delegation } : null;
      },
    };
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
