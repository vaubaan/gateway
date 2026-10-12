/**
 * The MCP Gateway endpoint — `POST /mcp`.
 *
 * Spec : docs/spec/vaubaan-gateway.md §7.1.
 *
 * Auth : `Authorization: Bearer vbn_live_<prefix>_<secret>`.
 *
 * Uses the official MCP SDK (`@modelcontextprotocol/sdk`) with
 * `WebStandardStreamableHTTPServerTransport` for protocol compliance
 * (streamable HTTP, correct 405 for unsupported methods, session mgmt).
 *
 * CORS : open (`*`). Browser-based MCP clients (Inspector, MCPJam, future
 * web playgrounds) must be able to call us. The actual auth is done via the
 * Bearer token — there is no cookie-based session on this route, so CORS *
 * is not equivalent to dropping auth.
 */

import { type NextRequest, NextResponse } from 'next/server';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { AuthError } from '@vaubaan/gateway-core';
import { buildGateway } from '@/lib/gateway/build';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, GET, DELETE, OPTIONS',
  'Access-Control-Allow-Headers':
    'Authorization, Content-Type, mcp-session-id, mcp-protocol-version',
  'Access-Control-Expose-Headers': 'mcp-session-id',
  'Access-Control-Max-Age': '86400',
};

function withCors(res: Response): Response {
  const patched = new Response(res.body, res);
  for (const [k, v] of Object.entries(CORS_HEADERS)) patched.headers.set(k, v);
  return patched;
}

export function OPTIONS(): NextResponse {
  const res = new NextResponse(null, { status: 204 });
  for (const [k, v] of Object.entries(CORS_HEADERS)) res.headers.set(k, v);
  return res;
}

export async function GET(req: NextRequest) {
  return handleMcpRequest(req);
}

export async function POST(req: NextRequest) {
  return handleMcpRequest(req);
}

export async function DELETE(req: NextRequest) {
  return handleMcpRequest(req);
}

async function handleMcpRequest(req: NextRequest): Promise<Response> {
  const auth = req.headers.get('authorization');
  const clientIp = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null;
  const clientUserAgent = req.headers.get('user-agent') ?? null;

  let gateway;
  try {
    gateway = buildGateway({ clientIp, clientUserAgent });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return withCors(
      Response.json(
        {
          jsonrpc: '2.0',
          id: null,
          error: { code: -32603, message: `gateway misconfigured: ${msg}` },
        },
        { status: 503 },
      ),
    );
  }

  let ctx;
  try {
    ctx = await gateway.authenticate(auth);
  } catch (e) {
    if (e instanceof AuthError) {
      return withCors(
        Response.json(
          {
            jsonrpc: '2.0',
            id: null,
            error: { code: e.code, message: e.message },
          },
          { status: e.httpStatus },
        ),
      );
    }
    const message = e instanceof Error ? e.message : String(e);
    return withCors(
      Response.json(
        {
          jsonrpc: '2.0',
          id: null,
          error: { code: -32603, message: `internal error: ${message}` },
        },
        { status: 500 },
      ),
    );
  }

  const server = new Server(
    { name: 'vaubaan-gateway', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: gateway.listTools(ctx) };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const response = await gateway.handle(ctx, {
      jsonrpc: '2.0',
      id: 'sdk',
      method: 'tools/call',
      params: { name: request.params.name, arguments: request.params.arguments ?? {} },
    });
    if ('error' in response) {
      return {
        content: [{ type: 'text' as const, text: response.error.message }],
        isError: true,
      };
    }
    const result = response.result as { content?: unknown[]; isError?: boolean } | undefined;
    return {
      content: (result?.content ?? []) as Array<{ type: 'text'; text: string }>,
      isError: result?.isError ?? false,
    };
  });

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  await server.connect(transport);
  try {
    const response = await transport.handleRequest(req);
    return withCors(response);
  } finally {
    await server.close();
    await transport.close();
  }
}
