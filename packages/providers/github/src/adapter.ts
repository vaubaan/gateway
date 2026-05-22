/**
 * Generic ProviderAdapter contract.
 *
 * Spec : docs/spec/mcp-proxy.md §5.1.
 *
 * Every cloud provider (GitHub, Vercel, Supabase) implements this contract.
 * The MCP gateway dispatches against it without knowing provider specifics.
 */

import type { McpToolDeclaration, Provider, ProviderAdmin, ProviderBinding } from '@vauban/shared';

export interface ValidateResult {
  ok: boolean;
  displayName?: string;
  error?: string;
}

export interface MintedToken {
  token: string;
  expiresAt: Date;
}

export interface ProviderAdapter {
  readonly provider: Provider;
  readonly availableTools: ReadonlyArray<McpToolDeclaration>;

  authorizationUrl(orgId: string, returnUrl: string, state: string): string;

  handleCallback(
    orgId: string,
    params: URLSearchParams,
  ): Promise<{
    installation_id: string | null;
    team_id: string | null;
    access_token_encrypted: Uint8Array | null;
    refresh_token_encrypted: Uint8Array | null;
    expires_at: Date | null;
  }>;

  mintUpstreamToken(admin: ProviderAdmin): Promise<MintedToken>;

  validateBinding(admin: ProviderAdmin, resourceRef: string): Promise<ValidateResult>;

  executeCall(
    admin: ProviderAdmin,
    binding: ProviderBinding,
    tool: string,
    args: Record<string, unknown>,
  ): Promise<unknown>;

  /** Resolve an abstract target into concrete resource refs from this project's bindings. */
  resolveTarget(target: string, bindings: ProviderBinding[]): string[];
}
