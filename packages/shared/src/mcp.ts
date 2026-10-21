/**
 * MCP and JSON-RPC primitives, plus the tool-naming convention every plugin
 * follows.
 *
 * Spec : docs/spec/vaubaan-gateway.md §4.1 (execution surface).
 */

// ─────────────────────────────────────────────────────────────────────────────
// Tool naming — `<provider_id_with_underscores>__<local_name>`
// ─────────────────────────────────────────────────────────────────────────────

/** Separator between the provider prefix and the local tool name. */
export const TOOL_NAME_SEPARATOR = '__';

/**
 * MCP tool-name prefix for a provider id : `cloudflare-dns` → `cloudflare_dns__`.
 * Provider ids never contain `_` (see `PROVIDER_ID_PATTERN` in risk-id.ts),
 * so the mapping `-` → `_` is reversible.
 */
export function toolPrefixFor(providerId: string): string {
  return `${providerId.replaceAll('-', '_')}${TOOL_NAME_SEPARATOR}`;
}

/** The two halves of a tool name, or `null` when the name carries no prefix. */
export interface SplitToolName {
  /** Provider id recovered from the prefix (`cloudflare_dns` → `cloudflare-dns`). */
  readonly providerId: string;
  /** Local tool name, after the separator (`list_branches`). */
  readonly localName: string;
}

/**
 * Split a tool name into its provider id and local name. Pure string work ;
 * the caller (the plugin registry) decides whether the provider exists.
 */
export function splitToolName(toolName: string): SplitToolName | null {
  const at = toolName.indexOf(TOOL_NAME_SEPARATOR);
  if (at <= 0) return null;
  const prefix = toolName.slice(0, at);
  const localName = toolName.slice(at + TOOL_NAME_SEPARATOR.length);
  if (localName.length === 0 || !/^[a-z][a-z0-9_]*$/.test(prefix)) return null;
  return { providerId: prefix.replaceAll('_', '-'), localName };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool declarations and results
// ─────────────────────────────────────────────────────────────────────────────

export interface McpToolDeclaration {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties?: Record<string, unknown>;
    required?: string[];
  };
}

/** One content block of a tool result, as the MCP protocol transports it. */
export type McpToolContent =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'image'; readonly data: string; readonly mimeType: string }
  | {
      readonly type: 'resource';
      readonly resource: {
        readonly uri: string;
        readonly mimeType?: string;
        readonly text?: string;
      };
    };

/** What a plugin returns from `execute` ; forwarded to the MCP client as is. */
export interface McpToolResult {
  readonly content: readonly McpToolContent[];
  /** Optional machine-readable twin of the text content. */
  readonly structuredContent?: Readonly<Record<string, unknown>>;
  readonly isError?: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Upstream errors (thrown by plugins: 401/403 from the provider, any other failed status)
// ─────────────────────────────────────────────────────────────────────────────

export class UpstreamAuthError extends Error {
  readonly upstreamStatus: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'UpstreamAuthError';
    this.upstreamStatus = status;
  }
}

/**
 * A credential refused for a reason the PLUGIN states in its own words: a
 * pasted token that lacks a scope, reaches another organisation, or is not
 * the kind of token the plugin needs; a provider that answers "this account
 * may not use this service" in a way the plugin recognises. Unlike any other
 * error, its message may be shown to the person who connects the account
 * (ADR provider-error-text-stays-with-the-agent, amendment of 2026-10-21):
 * the gateway keeps it, on the connect page, in the discovery state and in
 * the audit.
 *
 * Rule for the plugin: the message is a sentence the plugin wrote, with at
 * most values the person typed or identifiers the plugin checked (a scope
 * name, an organisation slug). Never text the provider sent, never a part
 * of the credential. Anything quoted from the provider goes in an
 * `UpstreamAuthError` instead, which the gateway reduces to its status.
 *
 * It is an `UpstreamAuthError`: everything that treats a rejected credential
 * (refresh, "needs reconnecting") treats this one the same way.
 */
export class CredentialRefusal extends UpstreamAuthError {
  constructor(message: string, status = 401) {
    super(message, status);
    this.name = 'CredentialRefusal';
  }
}

/**
 * Thrown by a plugin when the provider answered with an HTTP status that is
 * not a credential problem (a 4xx other than 401/403, a 5xx). The host reads
 * `status` for the audit summary and for the telemetry error class; the
 * message is for the agent only.
 */
export class UpstreamHttpError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'UpstreamHttpError';
    this.status = status;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// JSON-RPC 2.0
// ─────────────────────────────────────────────────────────────────────────────

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcSuccess {
  jsonrpc: '2.0';
  id: string | number | null;
  result: unknown;
}

export interface JsonRpcError {
  jsonrpc: '2.0';
  id: string | number | null;
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcError;
