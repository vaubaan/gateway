/**
 * Legacy v4 adapter shim — `SupabaseAdapter`.
 *
 * @deprecated legacy v4, deleted in P1.6. Kept so `apps/gateway`
 * (`lib/gateway/build.ts`) compiles until the execution door consumes
 * `supabasePlugin` through the registry. Tool dispatch delegates to the v5
 * `callSupabase` ; the v4 `*_to_venv` tools are gone (plan §8-Q5) and
 * `venvStore` is accepted and ignored.
 */

import type { McpToolDeclaration, ProviderAdmin, ProviderBinding } from '@vaubaan/shared';

import { classifySupabaseV4, type ClassifyV4Result } from './risk-classifier.ts';
import { callSupabase, SUPABASE_API_BASE, type FetchImpl } from './execute.ts';
import { REFRESH_THRESHOLD_MS } from './credential.ts';
import { supabaseTools } from './tools.ts';

/** @deprecated legacy v4, deleted in P1.6. */
export interface SupabaseRefreshedTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
}

/** @deprecated legacy v4, deleted in P1.6. */
export interface SupabaseAdapterConfig {
  /** Override fetch in tests. */
  fetchImpl?: FetchImpl;
  /** Ignored : the v4 project env-var store has no v5 counterpart. */
  venvStore?: unknown;
  /** OAuth client credentials for token refresh. */
  clientId?: string;
  clientSecret?: string;
  /** Persist a refreshed token pair back to provider_admins. */
  persistRefresh?: (admin: ProviderAdmin, tokens: SupabaseRefreshedTokens) => Promise<void>;
}

/** @deprecated legacy v4, deleted in P1.6. */
export interface ValidateResult {
  ok: boolean;
  displayName?: string;
  error?: string;
}

/** @deprecated legacy v4, deleted in P1.6 — use `supabasePlugin`. */
export class SupabaseAdapter {
  readonly provider = 'supabase' as const;
  readonly availableTools: ReadonlyArray<McpToolDeclaration> = supabaseTools;
  private readonly fetchImpl: FetchImpl;
  private readonly clientId?: string;
  private readonly clientSecret?: string;
  private readonly persistRefresh?: SupabaseAdapterConfig['persistRefresh'];

  constructor(config: SupabaseAdapterConfig = {}) {
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.clientId = config.clientId;
    this.clientSecret = config.clientSecret;
    this.persistRefresh = config.persistRefresh;
  }

  authorizationUrl(_orgId: string, _returnUrl: string, _state: string): string {
    throw new Error(
      'SupabaseAdapter: the OAuth flow is driven by the host from supabasePlugin.credential.',
    );
  }

  async handleCallback(_orgId: string, _params: URLSearchParams): Promise<never> {
    throw new Error(
      'SupabaseAdapter: the OAuth callback is driven by the host from supabasePlugin.credential.',
    );
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
    const res = await this.fetchImpl(`${SUPABASE_API_BASE}/oauth/token`, {
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
    _binding: ProviderBinding,
    tool: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    const refreshed = await this.refresh(admin);
    if (!refreshed) throw new Error('Supabase token refresh not available.');
    return callSupabase(this.fetchImpl, refreshed.accessToken, tool, args);
  }

  async validateBinding(admin: ProviderAdmin, resourceRef: string): Promise<ValidateResult> {
    if (!/^[a-z0-9]{20}$/.test(resourceRef)) {
      return { ok: false, error: 'Supabase binding must be a 20-char project ref.' };
    }
    try {
      const { token } = await this.mintUpstreamToken(admin);
      const data = (await callSupabase(this.fetchImpl, token, 'supabase__get_project', {
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
    return callSupabase(this.fetchImpl, token, tool, args);
  }

  classifyV4(
    tool: string,
    args: Record<string, unknown>,
    bindings: ReadonlyArray<ProviderBinding>,
  ): ClassifyV4Result {
    return classifySupabaseV4(tool, args, bindings);
  }
}
