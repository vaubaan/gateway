/**
 * Placeholder of the management MCP door — **to be replaced by feature P2.4**.
 *
 * The authorization server exists to protect `/mcp/manage`; without something
 * answering there, an MCP client could not be driven through discovery,
 * registration, consent and its first authenticated request. This placeholder
 * is that something and nothing more: it admits the request through
 * `ManagementGate` (the part that stays) and serves an MCP server that lists
 * **no tool**. Reading, previewing, issuing, rotating and revoking missions
 * arrive with P2.4, which keeps the gate and replaces this file.
 *
 * Same protocol handling as the execution door: 2026-07-28 requests through
 * `createMcpHandler` (stateless), 2025-era requests through the stateless JSON
 * transport.
 */
import {
  createMcpHandler,
  isLegacyRequest,
  Server,
  WebStandardStreamableHTTPServerTransport,
  type McpHttpHandler,
} from '@modelcontextprotocol/server';
import { rpcError } from '@vaubaan/gateway-core';

import type { BuildInfo } from '../config';
import type { Logger } from '../logging';
import type { ManagementGate } from './management-gate';

/** Name the door announces to MCP clients. */
export const MANAGEMENT_SERVER_INFO_NAME = 'vaubaan-gateway-management';
const HTTP_METHOD_NOT_ALLOWED = 405;

export interface ManagementDoorPlaceholderDeps {
  readonly gate: ManagementGate;
  readonly build: BuildInfo;
  readonly logger: Logger;
}

export class ManagementDoorPlaceholder {
  private readonly modern: McpHttpHandler;

  constructor(private readonly deps: ManagementDoorPlaceholderDeps) {
    this.modern = createMcpHandler(() => this.buildServer(), {
      legacy: 'reject',
      responseMode: 'auto',
      onerror: (error) => deps.logger.debug('mcp request rejected', { error: error.message }),
    });
  }

  /** `/mcp/manage` — every HTTP method the route exports lands here. */
  async handle(request: Request): Promise<Response> {
    const admitted = await this.deps.gate.admit(request);
    if (admitted instanceof Response) return admitted;
    if (await isLegacyRequest(request)) return this.serveLegacy(request);
    return this.modern.fetch(request, {
      authInfo: {
        // The SDK wants a token string; it gets the delegation id, never the bearer.
        token: admitted.delegation.delegation_id,
        clientId: admitted.delegation.client_id,
        scopes: [...admitted.delegation.scopes],
      },
    });
  }

  /** 2025-era clients: one stateless exchange, answered as plain JSON. */
  private async serveLegacy(request: Request): Promise<Response> {
    if (request.method !== 'POST') {
      return new Response(JSON.stringify(rpcError(null, -32000, 'Method not allowed.')), {
        status: HTTP_METHOD_NOT_ALLOWED,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', Allow: 'POST' },
      });
    }
    const server = this.buildServer();
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

  private buildServer(): Server {
    const server = new Server(
      { name: MANAGEMENT_SERVER_INFO_NAME, version: this.deps.build.version },
      { capabilities: { tools: {} } },
    );
    server.setRequestHandler('tools/list', async () => ({ tools: [] }));
    return server;
  }
}
