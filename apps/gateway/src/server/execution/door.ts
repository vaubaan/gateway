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
 *   bearer        `Authorization: Bearer <mission token>`; missing, unknown or
 *                 rotated → 401; a web session or a delegated token → 403
 *                 `wrong-credential-kind` (spec §6 "none crosses over")
 *   grounds       the creator's authority over the mission, re-read from the
 *                 store on every request (spec §2.3 "orphaned", §10): a mission
 *                 whose grounds vanished is turned `orphaned` here and every
 *                 call is then refused `mission-inactive`
 *   surface rate  requests per minute per mission (spec §6) → 429
 *   protocol      the MCP SDK (`@modelcontextprotocol/server`, v2): 2026-07-28
 *                 requests through `createMcpHandler` (stateless, JSON, upgraded
 *                 to SSE only if a handler emits notifications), 2025-era
 *                 requests through the stateless JSON transport
 *   tools/call    `CallPipeline.execute` (gateway-core) with the real stages
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
  ProtocolError,
  Server,
  WebStandardStreamableHTTPServerTransport,
  type CallToolResult,
  type ListToolsResult,
  type McpHttpHandler,
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
  type CallPipeline,
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
import { maskedToken, prefixOfBearer } from '../missions';
import type { Store } from '../store';
import { systemClock, type Clock } from '../store/clock';
import type { MissionRecord } from '../store/types';
import { loadMissionContext } from './mission-context';
import { agentLabelOf, clientOriginOf, trustedProxyList } from './request-meta';
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

/** Identifies a delegated token (management door, feature P2.3). Absent until then. */
export interface DelegatedTokenResolver {
  resolve(bearer: string): Promise<DelegationContext | null>;
}

export interface ExecutionDoorDeps {
  readonly config: Pick<InstanceConfig, 'publicUrl' | 'trustedProxies' | 'mcp'>;
  readonly store: Pick<Store, 'connections' | 'users' | 'groups' | 'sessions'>;
  readonly registry: PluginRegistry;
  readonly tokens: TokenVerifier;
  /** Is the mission still grounded in its creator's current authority? Never optional. */
  readonly grounds: Pick<MissionGrounds, 'settle'>;
  readonly webSessions: Pick<WebSessionService, 'read'>;
  readonly budget: Pick<SessionService, 'stateOf'>;
  readonly pipeline: CallPipeline;
  readonly rateLimiter: RateLimiter;
  readonly logger: Logger;
  readonly build: BuildInfo;
  readonly clock?: Clock;
  readonly delegations?: DelegatedTokenResolver;
}

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

  constructor(private readonly deps: ExecutionDoorDeps) {
    this.clock = deps.clock ?? systemClock;
    this.proxies = trustedProxyList(deps.config.trustedProxies);
    // 2026-07-28 traffic. The handler holds nothing between requests; the factory
    // builds one server per request around the scope the door authenticated.
    this.modern = createMcpHandler(
      ({ authInfo }) => this.buildServer(authInfo?.extra?.[SCOPE_KEY] as RequestScope),
      {
        legacy: 'reject',
        responseMode: 'auto',
        onerror: (error) => deps.logger.debug('mcp request rejected', { error: error.message }),
      },
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
    if (await isLegacyRequest(request)) return this.serveLegacy(request, scope);
    return this.modern.fetch(request, {
      authInfo: {
        // The SDK wants a token string; it gets the masked prefix, never the bearer.
        token: maskedToken(scope.ctx.token.prefix),
        clientId: scope.ctx.mission.id,
        scopes: [],
        extra: { [SCOPE_KEY]: scope },
      },
    });
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
    return json(200, buildCatalog(gate.ctx, this.deps.registry, state));
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
        return json(AUTH_REQUIRED_HTTP_STATUS, rpcError(null, err.code, err.message), {
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
    return { ctx, mission, client };
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
          // A token replaced by rotation no longer authenticates. A token retired
          // by the revocation of its mission still identifies that mission, so the
          // caller is told `mission-inactive` rather than "unknown bearer".
          const dead = verified.outcome === 'retired' && verified.mission.status === 'active';
          if (dead || (verified.outcome === 'retired' && verified.reason === 'rotated')) {
            return null;
          }
          // Authority is never snapshotted in a mission: the creator's is re-read
          // here, and a mission it no longer grounds is `orphaned` from this call on.
          const mission = await this.deps.grounds.settle(verified.mission);
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

  /** 2025-era clients: one stateless exchange, answered as plain JSON. */
  private async serveLegacy(request: Request, scope: RequestScope): Promise<Response> {
    if (request.method !== 'POST') {
      // Stateless: there is no session to stream (GET) or to end (DELETE).
      return json(HTTP_METHOD_NOT_ALLOWED, rpcError(null, -32000, 'Method not allowed.'), {
        Allow: 'POST',
      });
    }
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

    server.setRequestHandler('tools/call', async (request) => {
      const { name, arguments: args, _meta: meta } = request.params;
      const outcome = await this.deps.pipeline.execute(ctx, {
        tool: name,
        args: args ?? {},
        agent_label: agentLabelOf(scope.headers, meta),
        client: scope.client,
      });
      // Arguments are never logged; the audit entry carries their fingerprint.
      this.deps.logger.info('tools/call', {
        mission_id: ctx.mission.id,
        token_prefix: ctx.token.prefix,
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
