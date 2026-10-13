/**
 * The management MCP door (spec §4.1 bis) — host-agnostic `Request → Response`.
 *
 *   /mcp/manage   MCP Streamable HTTP, stateless: `tools/list`, `tools/call`
 *
 * Order of a request:
 *
 *   admission     `ManagementGate.admit` (authorization server): a live
 *                 delegated access token and nothing else — a mission token or
 *                 a human session is refused `wrong-credential-kind`, anything
 *                 unknown gets the OAuth challenge
 *   surface rate  requests per minute per delegation (spec §6) → 429
 *   protocol      the MCP SDK (`@modelcontextprotocol/server`, v2): 2026-07-28
 *                 requests through `createMcpHandler`, 2025-era requests
 *                 through the stateless JSON transport — as the execution door
 *   tools         one `McpServer` per request, with the seven tools of
 *                 `MANAGEMENT_TOOLS` bound to the delegation that was admitted
 *
 * A tool answers with **structured content**: the answer itself, also
 * serialized as text for clients that only read text. A "no" — a draft beyond
 * the user's authority, a mission that is not theirs — is a tool error
 * (`isError`) whose structured content is `{ error: { code, message, hint, … } }`,
 * so the model reads it and corrects itself. Only what the door itself rejects
 * before any tool (credential, rate) is an HTTP or JSON-RPC error.
 *
 * Nothing here imports `next`; `src/app/mcp/manage/route.ts` is a one-line adapter.
 */
import {
  createMcpHandler,
  isLegacyRequest,
  McpServer,
  WebStandardStreamableHTTPServerTransport,
  type CallToolResult,
  type McpHttpHandler,
} from '@modelcontextprotocol/server';
import { rpcError } from '@vaubaan/gateway-core';

import type { BuildInfo } from '../config';
import type { Logger } from '../logging';
import {
  MANAGEMENT_INSTRUCTIONS,
  MANAGEMENT_TOOLS,
  type ManagementToolDefinition,
} from './definitions';
import type { ManagementActor, ManagementAdmission, ManagementRateLimit } from './ports';
import type { ManagementTools, ToolOutcome } from './tools';

/** Name the door announces to MCP clients. */
export const MANAGEMENT_SERVER_INFO_NAME = 'vaubaan-gateway-management';
/** Requests one delegation may send per window, whatever they ask. */
export const MANAGEMENT_REQUESTS_PER_WINDOW = 120;
export const MANAGEMENT_REQUEST_WINDOW_MS = 60_000;
/** JSON-RPC code of the surface rate limit (the execution door's). */
export const MANAGEMENT_RATE_LIMITED_RPC_CODE = -32002;

const HTTP_METHOD_NOT_ALLOWED = 405;
const HTTP_TOO_MANY_REQUESTS = 429;
const MS_PER_SECOND = 1000;
/** Key under which the admitted actor rides `AuthInfo.extra` to the per-request server. */
const ACTOR_KEY = 'vaubaan.management';

export interface ManagementDoorDeps {
  readonly admit: ManagementAdmission;
  readonly tools: ManagementTools;
  readonly rateLimit: ManagementRateLimit;
  readonly build: BuildInfo;
  readonly logger: Logger;
}

function json(status: number, body: object, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers },
  });
}

/** A tool's answer as MCP carries it: structured content, and the same as text. */
export function toolResultOf(outcome: ToolOutcome<unknown>): CallToolResult {
  if (outcome.ok) {
    return {
      content: [{ type: 'text', text: JSON.stringify(outcome.data, null, 2) }],
      structuredContent: outcome.data,
    };
  }
  const { refusal } = outcome;
  return {
    isError: true,
    content: [
      {
        type: 'text',
        text: `${refusal.code}: ${refusal.message} ${refusal.hint}\n${JSON.stringify({ error: refusal }, null, 2)}`,
      },
    ],
    structuredContent: { error: refusal },
  };
}

export class ManagementDoor {
  private readonly modern: McpHttpHandler;

  constructor(private readonly deps: ManagementDoorDeps) {
    // The handler holds nothing between requests; the factory builds one server
    // per request around the actor the gate admitted.
    this.modern = createMcpHandler(
      ({ authInfo }) => this.buildServer(authInfo?.extra?.[ACTOR_KEY] as ManagementActor),
      {
        legacy: 'reject',
        responseMode: 'auto',
        onerror: (error) => deps.logger.debug('mcp request rejected', { error: error.message }),
      },
    );
  }

  /** `/mcp/manage` — every HTTP method the route exports lands here. */
  async handle(request: Request): Promise<Response> {
    const admitted = await this.deps.admit(request);
    if (admitted instanceof Response) return admitted;
    const { delegation } = admitted;
    const actor: ManagementActor = {
      userId: delegation.user_id,
      delegationId: delegation.delegation_id,
      clientId: delegation.client_id,
    };

    const surface = await this.deps.rateLimit.take(
      `delegation:${actor.delegationId}`,
      MANAGEMENT_REQUESTS_PER_WINDOW,
      MANAGEMENT_REQUEST_WINDOW_MS,
    );
    if (!surface.allowed) return tooManyRequests(surface.retryAfterMs);

    if (await isLegacyRequest(request)) return this.serveLegacy(request, actor);
    return this.modern.fetch(request, {
      authInfo: {
        // The SDK wants a token string; it gets the delegation id, never the bearer.
        token: actor.delegationId,
        clientId: actor.clientId,
        scopes: [...delegation.scopes],
        extra: { [ACTOR_KEY]: actor },
      },
    });
  }

  /** 2025-era clients: one stateless exchange, answered as plain JSON. */
  private async serveLegacy(request: Request, actor: ManagementActor): Promise<Response> {
    if (request.method !== 'POST') {
      // Stateless: there is no session to stream (GET) or to end (DELETE).
      return json(HTTP_METHOD_NOT_ALLOWED, rpcError(null, -32000, 'Method not allowed.'), {
        Allow: 'POST',
      });
    }
    const server = this.buildServer(actor);
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

  private buildServer(actor: ManagementActor | undefined): McpServer {
    if (!actor) throw new Error('management door: MCP server built without an admitted actor');
    const server = new McpServer(
      { name: MANAGEMENT_SERVER_INFO_NAME, version: this.deps.build.version },
      { capabilities: { tools: { listChanged: false } }, instructions: MANAGEMENT_INSTRUCTIONS },
    );
    for (const tool of MANAGEMENT_TOOLS) {
      server.registerTool(
        tool.name,
        {
          title: tool.title,
          description: tool.description,
          inputSchema: tool.inputSchema,
          annotations: tool.annotations,
        },
        (args: unknown) => this.call(tool, actor, args),
      );
    }
    return server;
  }

  private async call(
    tool: ManagementToolDefinition,
    actor: ManagementActor,
    args: unknown,
  ): Promise<CallToolResult> {
    try {
      const outcome = await tool.run(this.deps.tools, actor, args);
      // Arguments and answers are never logged: an answer may carry a mission token.
      this.deps.logger.info('tools/call', {
        tool: tool.name,
        kind: tool.kind,
        outcome: outcome.ok ? 'ok' : outcome.refusal.code,
        user_id: actor.userId,
        delegation_id: actor.delegationId,
        client_id: actor.clientId,
      });
      return toolResultOf(outcome);
    } catch (err) {
      this.deps.logger.error('management tool failed', {
        tool: tool.name,
        delegation_id: actor.delegationId,
        err,
      });
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: 'internal-error: the gateway could not complete this call. Nothing can be assumed about its effect: read the state again with `list_my_missions` before retrying.',
          },
        ],
        structuredContent: {
          error: {
            code: 'internal-error',
            message: 'The gateway could not complete this call.',
            hint: 'Read the state again with `list_my_missions` before retrying.',
          },
        },
      };
    }
  }
}

function tooManyRequests(retryAfterMs: number): Response {
  const seconds = Math.max(1, Math.ceil(retryAfterMs / MS_PER_SECOND));
  return json(
    HTTP_TOO_MANY_REQUESTS,
    rpcError(
      null,
      MANAGEMENT_RATE_LIMITED_RPC_CODE,
      `Too many requests for this delegation; retry in ${seconds} s.`,
      { retry_after_seconds: seconds },
    ),
    { 'Retry-After': String(seconds) },
  );
}
