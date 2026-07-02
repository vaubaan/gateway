/**
 * SupabaseAdapter — ProviderAdapter for Supabase, paste-token (Mgmt API PAT) mode.
 *
 * Spec : docs/spec/vaubaan-gateway.md §5.1.
 * Note : OAuth Mgmt API flow is Phase 5+ once we register a Vaubaan Gateway
 *        Supabase OAuth app. v0 uses paste-token (`sbp_...`) directly.
 */

import type { McpToolDeclaration, ProviderAdmin, ProviderBinding } from '@vaubaan/shared';
import { availableTools } from './tools.ts';
import { executeCall, executeVenvTool, type FetchImpl, type VenvStoreLike } from './execute.ts';
import { classifySupabaseV4, type ClassifyV4Result } from './risk-classifier.ts';

const REFRESH_THRESHOLD_MS = 60_000;

export interface SupabaseRefreshedTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
}

export interface SupabaseAdapterConfig {
  /** Override fetch in tests. */
  fetchImpl?: FetchImpl;
  /** Project env var store for _to_venv tools. When absent, venv tools
   *  are still listed but throw at execution time. */
  venvStore?: VenvStoreLike | null;
  /** OAuth client credentials for token refresh. */
  clientId?: string;
  clientSecret?: string;
  /** Persist a refreshed token pair back to provider_admins. */
  persistRefresh?: (admin: ProviderAdmin, tokens: SupabaseRefreshedTokens) => Promise<void>;
}

export interface ValidateResult {
  ok: boolean;
  displayName?: string;
  error?: string;
}

const VENV_TOOLS = new Set([
  'supabase__service_role_to_venv',
  'supabase__anon_key_to_venv',
  'supabase__url_to_venv',
]);

export class SupabaseAdapter {
  readonly provider = 'supabase' as const;
  readonly availableTools: ReadonlyArray<McpToolDeclaration> = availableTools;
  private readonly fetchImpl: FetchImpl;
  private readonly venvStore: VenvStoreLike | null;
  private readonly clientId?: string;
  private readonly clientSecret?: string;
  private readonly persistRefresh?: SupabaseAdapterConfig['persistRefresh'];

  constructor(config: SupabaseAdapterConfig = {}) {
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.venvStore = config.venvStore ?? null;
    this.clientId = config.clientId;
    this.clientSecret = config.clientSecret;
    this.persistRefresh = config.persistRefresh;
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
    const current = new TextDecoder().decode(admin.access_token_encrypted);
    const expiresAt = admin.expires_at ? new Date(admin.expires_at) : null;
    const needsRefresh =
      expiresAt !== null && expiresAt.getTime() - Date.now() < REFRESH_THRESHOLD_MS;
    if (needsRefresh) {
      const refreshed = await this.refresh(admin);
      if (refreshed) return { token: refreshed.accessToken, expiresAt: refreshed.expiresAt };
    }
    return {
      token: current,
      expiresAt: expiresAt ?? new Date(Date.now() + 365 * 24 * 3600 * 1000),
    };
  }

  private async refresh(admin: ProviderAdmin): Promise<SupabaseRefreshedTokens | null> {
    if (!this.clientId || !this.clientSecret) return null;
    if (!admin.refresh_token_encrypted) return null;
    const refreshToken = new TextDecoder().decode(admin.refresh_token_encrypted);
    const basicAuth = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64');
    const res = await this.fetchImpl('https://api.supabase.com/v1/oauth/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${basicAuth}`,
      },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
    };
    const tokens: SupabaseRefreshedTokens = {
      accessToken: json.access_token,
      refreshToken: json.refresh_token,
      expiresAt: new Date(Date.now() + json.expires_in * 1000),
    };
    if (this.persistRefresh) {
      try {
        await this.persistRefresh(admin, tokens);
      } catch (e) {
        console.error('[supabase] persistRefresh failed', e);
      }
    }
    return tokens;
  }

  async retryAfterAuthFailure(
    admin: ProviderAdmin,
    binding: ProviderBinding,
    tool: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    const refreshed = await this.refresh(admin);
    if (!refreshed) throw new Error('Supabase token refresh not available.');
    const token = refreshed.accessToken;
    if (VENV_TOOLS.has(tool)) {
      if (!this.venvStore) throw new Error('venv store is not configured on this gateway.');
      return executeVenvTool(this.fetchImpl, token, tool, args, this.venvStore, binding.project_id);
    }
    return executeCall(this.fetchImpl, token, tool, args);
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
    binding: ProviderBinding,
    tool: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    const { token } = await this.mintUpstreamToken(admin);
    if (VENV_TOOLS.has(tool)) {
      if (!this.venvStore) throw new Error('venv store is not configured on this gateway.');
      return executeVenvTool(this.fetchImpl, token, tool, args, this.venvStore, binding.project_id);
    }
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
