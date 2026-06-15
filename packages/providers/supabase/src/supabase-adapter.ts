/**
 * SupabaseAdapter — ProviderAdapter for Supabase, paste-token (Mgmt API PAT) mode.
 *
 * Spec : docs/spec/vaubaan-gateway.md §5.1.
 * Note : OAuth Mgmt API flow is Phase 5+ once we register a Vaubaan Gateway
 *        Supabase OAuth app. v0 uses paste-token (`sbp_...`) directly.
 */

import type { McpToolDeclaration, ProviderAdmin, ProviderBinding } from '@vaubaan/shared';
import { availableTools } from './tools.ts';
import { executeCall, type FetchImpl } from './execute.ts';
import { classifySupabaseV4, type ClassifyV4Result } from './risk-classifier.ts';

export interface SupabaseAdapterConfig {
  /** Override fetch in tests. */
  fetchImpl?: FetchImpl;
}

export interface ValidateResult {
  ok: boolean;
  displayName?: string;
  error?: string;
}

export class SupabaseAdapter {
  readonly provider = 'supabase' as const;
  readonly availableTools: ReadonlyArray<McpToolDeclaration> = availableTools;
  private readonly fetchImpl: FetchImpl;

  constructor(config: SupabaseAdapterConfig = {}) {
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  authorizationUrl(_orgId: string, _returnUrl: string, _state: string): string {
    throw new Error(
      'SupabaseAdapter: OAuth Mgmt flow not implemented yet — use paste-token mode by inserting provider_admins directly.',
    );
  }

  async handleCallback(_orgId: string, _params: URLSearchParams) {
    throw new Error('SupabaseAdapter: OAuth callback not implemented in v0.');
  }

  async mintUpstreamToken(admin: ProviderAdmin): Promise<{ token: string; expiresAt: Date }> {
    if (!admin.access_token_encrypted) {
      throw new Error('Supabase ProviderAdmin has no access_token_encrypted.');
    }
    const token = new TextDecoder().decode(admin.access_token_encrypted);
    return { token, expiresAt: new Date(Date.now() + 365 * 24 * 3600 * 1000) };
  }

  async validateBinding(admin: ProviderAdmin, resourceRef: string): Promise<ValidateResult> {
    if (!/^[a-z0-9]{20}$/.test(resourceRef)) {
      return { ok: false, error: 'Supabase binding must be a 20-char project ref.' };
    }
    try {
      const { token } = await this.mintUpstreamToken(admin);
      const data = (await executeCall(this.fetchImpl, token, 'supabase__get_project', {
        project_ref: resourceRef,
      })) as { name?: string };
      return { ok: true, displayName: data.name ?? resourceRef };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return { ok: false, error: `Supabase validation failed: ${message}` };
    }
  }

  async executeCall(
    admin: ProviderAdmin,
    _binding: ProviderBinding,
    tool: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    const { token } = await this.mintUpstreamToken(admin);
    return executeCall(this.fetchImpl, token, tool, args);
  }

  /**
   * v4 classifier — emit the slice(s) the call touches. The provider plugin's
   * sole authorization responsibility.
   */
  classifyV4(
    tool: string,
    args: Record<string, unknown>,
    bindings: ReadonlyArray<ProviderBinding>,
  ): ClassifyV4Result {
    return classifySupabaseV4(tool, args, bindings);
  }
}
