/**
 * The MCP Gateway endpoint — `POST /mcp`.
 *
 * Spec : docs/spec/mcp-proxy.md §7.1.
 *
 * Auth : `Authorization: Bearer vbn_live_<prefix>_<secret>`.
 * Body : JSON-RPC 2.0 request. Methods : initialize | tools/list | tools/call | ping.
 */

import { type NextRequest, NextResponse } from 'next/server';
import { AuthError } from '@vauban/mcp-gateway';
import type { JsonRpcRequest } from '@vauban/shared';
import { buildGateway } from '@/lib/gateway/build';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const auth = req.headers.get('authorization');
  let body: JsonRpcRequest;
  try {
    body = (await req.json()) as JsonRpcRequest;
  } catch {
    return NextResponse.json(
      {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: 'parse error: body is not valid JSON' },
      },
      { status: 400 },
    );
  }

  if (body.jsonrpc !== '2.0' || typeof body.method !== 'string') {
    return NextResponse.json(
      {
        jsonrpc: '2.0',
        id: body.id ?? null,
        error: { code: -32600, message: 'invalid request: expected JSON-RPC 2.0' },
      },
      { status: 400 },
    );
  }

  const clientIp = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null;
  const clientUserAgent = req.headers.get('user-agent') ?? null;

  let gateway;
  try {
    gateway = buildGateway({ clientIp, clientUserAgent });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      {
        jsonrpc: '2.0',
        id: body.id ?? null,
        error: { code: -32603, message: `gateway misconfigured: ${msg}` },
      },
      { status: 503 },
    );
  }

  try {
    const ctx = await gateway.authenticate(auth);
    const response = await gateway.handle(ctx, body);
    return NextResponse.json(response);
  } catch (e) {
    if (e instanceof AuthError) {
      return NextResponse.json(
        {
          jsonrpc: '2.0',
          id: body.id ?? null,
          error: { code: e.code, message: e.message },
        },
        { status: e.httpStatus },
      );
    }
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      {
        jsonrpc: '2.0',
        id: body.id ?? null,
        error: { code: -32603, message: `internal error: ${message}` },
      },
      { status: 500 },
    );
  }
}
