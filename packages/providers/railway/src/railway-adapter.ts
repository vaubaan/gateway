/**
 * RailwayAdapter — rewraps the official Railway MCP server (mcp.railway.com).
 *
 * Spec : docs/spec/vaubaan-gateway.md §5.1.
 * ADR  : docs/decisions/railway-rewrap-remote-mcp.md.
 *
 * Auth model : OAuth Auth app "Vaubaan Gateway" (authorization_code + PKCE).
 * The stored `access_token` is short-lived (1h), so unlike Vercel we refresh
 * on the gateway hot-path : if the token is within 60s of expiry we exchange
 * the `refresh_token` for a fresh pair (Basic auth → backboard.railway.com,
 * with `resource=https://mcp.railway.com` audience binding) and re-persist it
 * via the injected `persistRefresh` callback.
 *
 * The actual tool execution is forwarded as JSON-RPC `tools/call` to
 * https://mcp.railway.com/ (cf. execute.ts).
 */

import type { McpToolDeclaration, ProviderAdmin, ProviderBinding } from '@vaubaan/shared';
import { availableTools } from './tools.ts';
import { callGraphql, executeCall, type FetchImpl } from './execute.ts';
import { classifyRailwayV4, type RailwayClassifyResult } from './risk-classifier.ts';

const TOKEN_ENDPOINT = 'https://backboard.railway.com/oauth/token';
/** RFC 8707 resource indicator binding the token to the MCP audience. */
const MCP_RESOURCE = 'https://mcp.railway.com';
/** Refresh when the access_token is within this window of expiry. */
const REFRESH_THRESHOLD_MS = 60_000;
/** Railway project ids are UUIDs. */
const PROJECT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface RailwayRefreshedTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
}

export interface RailwayAdapterConfig {
  /** Override fetch in tests. */
  fetchImpl?: FetchImpl;
  /** OAuth Auth app credentials (env: RAILWAY_CLIENT_ID / RAILWAY_CLIENT_SECRET). */
  clientId?: string;
  clientSecret?: string;
  /** Persist a refreshed token pair back to provider_admins (injected by the web layer). */
  persistRefresh?: (admin: ProviderAdmin, tokens: RailwayRefreshedTokens) => Promise<void>;
}

export interface ValidateResult {
  ok: boolean;
  displayName?: string;
  error?: string;
}

export class RailwayAdapter {
  readonly provider = 'railway' as const;
  readonly availableTools: ReadonlyArray<McpToolDeclaration> = availableTools;
  private readonly fetchImpl: FetchImpl;
  private readonly clientId?: string;
  private readonly clientSecret?: string;
  private readonly persistRefresh?: RailwayAdapterConfig['persistRefresh'];

  constructor(config: RailwayAdapterConfig = {}) {
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.clientId = config.clientId;
    this.clientSecret = config.clientSecret;
    this.persistRefresh = config.persistRefresh;
  }

  authorizationUrl(_orgId: string, _returnUrl: string, _state: string): string {
    throw new Error(
      'RailwayAdapter: the authorize URL is built by the web OAuth route (PKCE + resource binding are request-scoped) — see /api/integrations/railway/connect.',
    );
  }

  async handleCallback(_orgId: string, _params: URLSearchParams) {
    throw new Error(
      'RailwayAdapter: the OAuth callback is handled by /api/integrations/railway/callback (needs the PKCE verifier cookie).',
    );
  }

  /**
   * Return a usable Bearer for an MCP call. Refreshes pre-emptively when the
   * stored access_token is within REFRESH_THRESHOLD_MS of expiry.
   */
  async mintUpstreamToken(admin: ProviderAdmin): Promise<{ token: string; expiresAt: Date }> {
    if (!admin.access_token_encrypted) {
      throw new Error('Railway ProviderAdmin has no access_token_encrypted.');
    }
    const current = new TextDecoder().decode(admin.access_token_encrypted);
    const expiresAt = admin.expires_at ? new Date(admin.expires_at) : null;
    const needsRefresh =
      expiresAt !== null && expiresAt.getTime() - Date.now() < REFRESH_THRESHOLD_MS;
    if (needsRefresh) {
      const refreshed = await this.refresh(admin);
      if (refreshed) return { token: refreshed.accessToken, expiresAt: refreshed.expiresAt };
    }
    return { token: current, expiresAt: expiresAt ?? new Date(Date.now() + 3600 * 1000) };
  }

  /** Exchange the refresh_token for a fresh pair. Returns null if not possible. */
  private async refresh(admin: ProviderAdmin): Promise<RailwayRefreshedTokens | null> {
    if (!this.clientId || !this.clientSecret) return null;
    if (!admin.refresh_token_encrypted) return null;
    const refreshToken = new TextDecoder().decode(admin.refresh_token_encrypted);
    const basicAuth = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64');
    const res = await this.fetchImpl(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${basicAuth}`,
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        resource: MCP_RESOURCE,
      }),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in: number;
    };
    const tokens: RailwayRefreshedTokens = {
      accessToken: json.access_token,
      refreshToken: json.refresh_token ?? refreshToken,
      expiresAt: new Date(Date.now() + json.expires_in * 1000),
    };
    if (this.persistRefresh) {
      try {
        await this.persistRefresh(admin, tokens);
      } catch (e) {
        console.error('[railway] persistRefresh failed', e);
      }
    }
    return tokens;
  }

  async validateBinding(admin: ProviderAdmin, resourceRef: string): Promise<ValidateResult> {
    if (!PROJECT_ID_RE.test(resourceRef)) {
      return { ok: false, error: 'Railway binding must be a project id (UUID).' };
    }
    try {
      // Liveness check : a no-arg tool that only needs a valid token.
      await this.executeCall(admin, emptyBinding(resourceRef), 'railway__whoami', {});
      return { ok: true, displayName: resourceRef };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return { ok: false, error: `Railway validation failed: ${message}` };
    }
  }

  async retryAfterAuthFailure(
    admin: ProviderAdmin,
    _binding: ProviderBinding,
    tool: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    const refreshed = await this.refresh(admin);
    if (!refreshed) throw new Error('Railway token refresh not available.');
    return executeCall(this.fetchImpl, refreshed.accessToken, tool, args);
  }

  async executeCall(
    admin: ProviderAdmin,
    _binding: ProviderBinding,
    tool: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    const { token } = await this.mintUpstreamToken(admin);
    const result = await executeCall(this.fetchImpl, token, tool, args);
    if (tool === 'railway__railway-agent') {
      return {
        agent_response: result,
        vaubaan_hint:
          'The railway-agent stages configuration changes (repo source, Dockerfile, build settings, etc.) ' +
          'but does NOT commit or deploy them. If the agent reports that changes were made or a ' +
          '"deployment was triggered", the changes are only staged. You MUST call railway__accept-deploy ' +
          'with the environmentId to commit the staged changes and trigger the actual deployment.',
      };
    }
    return result;
  }

  /**
   * Check whether Railway can see GitHub repos (i.e. the Railway GitHub App is
   * installed on the user's GitHub account/org). Fail-open: on any error we
   * assume repos are available so we don't show a misleading CTA.
   */
  async checkGitHubRepos(
    admin: ProviderAdmin,
  ): Promise<{ available: boolean; repos: Array<{ fullName: string; id: number }> }> {
    try {
      const { token } = await this.mintUpstreamToken(admin);
      const data = await callGraphql<{
        githubRepos: Array<{ fullName: string; id: number }>;
      }>(this.fetchImpl, token, `{ githubRepos { fullName id } }`, {});
      return { available: data.githubRepos.length > 0, repos: data.githubRepos };
    } catch {
      return { available: true, repos: [] };
    }
  }

  /**
   * v4 classifier — emit the slice(s) the call touches. The provider plugin's
   * sole authorization responsibility.
   */
  classifyV4(
    tool: string,
    args: Record<string, unknown>,
    bindings: ReadonlyArray<ProviderBinding>,
  ): RailwayClassifyResult {
    return classifyRailwayV4(tool, args, bindings);
  }
}

function emptyBinding(resourceRef: string): ProviderBinding {
  return {
    id: '',
    project_id: '',
    provider: 'railway',
    resource_ref: resourceRef,
    display_name: null,
    created_at: '',
  };
}
