/**
 * JSON-RPC error builder for the MCP gateway.
 *
 * Spec : docs/spec/mcp-proxy.md §6.3, §7.5.
 *
 * Standard error codes :
 *   -32700  Parse error
 *   -32600  Invalid Request
 *   -32601  Method not found
 *   -32602  Invalid params
 *   -32603  Internal error  ← used for policy denials and upstream errors with denial_reason.
 *   -32001  Auth required (Vauban-specific)
 */

import type { JsonRpcError, JsonRpcSuccess } from '@vaubaan/shared';

export function rpcError(
  id: string | number | null,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcError {
  const err: JsonRpcError = {
    jsonrpc: '2.0',
    id,
    error: { code, message },
  };
  if (data !== undefined) err.error.data = data;
  return err;
}

export function rpcSuccess(id: string | number | null, result: unknown): JsonRpcSuccess {
  return { jsonrpc: '2.0', id, result };
}

export class GatewayError extends Error {
  constructor(
    message: string,
    readonly code: number,
    readonly httpStatus: number,
  ) {
    super(message);
    this.name = 'GatewayError';
  }
}

export class AuthError extends GatewayError {
  constructor(message: string) {
    super(message, -32001, 401);
    this.name = 'AuthError';
  }
}

export class PolicyDenialError extends GatewayError {
  constructor(message: string) {
    super(message, -32603, 200);
    this.name = 'PolicyDenialError';
  }
}
