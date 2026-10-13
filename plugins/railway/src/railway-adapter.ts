/**
 * RailwayAdapter — legacy v4 adapter, deleted in P1.6.
 *
 * Kept so the v4 gateway pipeline (`apps/gateway/src/lib/gateway/build.ts`,
 * `lib/providers/state.ts`) keeps compiling until the execution door
 * consumes `railwayPlugin` (`index.ts`). It owns no upstream logic of its
 * own : forwarding and GraphQL live in `execute.ts`, classification in
 * `classify.ts`. The hot-path refresh here reads the OAuth app from the
 * constructor (v4 wiring) ; the v5 equivalent is `refreshRailwayCredential`
 * in `credential.ts`, driven by the host.
 *
 * @deprecated legacy v4, deleted in P1.6 — use `railwayPlugin`.
 */

import type { McpToolDeclaration } from '@vaubaan/plugin-sdk';
// legacy v4, deleted in P1.6
import type { ProviderAdmin, ProviderBinding } from '@vaubaan/shared';

import {
  RAILWAY_MCP_RESOURCE,
  RAILWAY_REFRESH_THRESHOLD_MS,
  RAILWAY_TOKEN_URL,
} from './credential.ts';
import { callGraphql, executeCall, type FetchImpl } from './execute.ts';
import { classifyRailwayV4, type RailwayClassifyResult } from './risk-classifier.ts';
import { railwayTools } from './tools.ts';

/** Railway project ids are UUIDs. */
const PROJECT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** @deprecated legacy v4, deleted in P1.6. */
export interface RailwayRefreshedTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
}

/** @deprecated legacy v4, deleted in P1.6. */
export interface RailwayAdapterConfig {
  /** Override fetch in tests. */
  fetchImpl?: FetchImpl;
  /** OAuth Auth app credentials (v4 : env RAILWAY_CLIENT_ID / RAILWAY_CLIENT_SECRET). */
  clientId?: string;
  clientSecret?: string;
  /** Persist a refreshed token pair back to provider_admins (injected by the web layer). */
  persistRefresh?: (admin: ProviderAdmin, tokens: RailwayRefreshedTokens) => Promise<void>;
}

/** @deprecated legacy v4, deleted in P1.6. */
export interface ValidateResult {
  ok: boolean;
  displayName?: string;
  error?: string;
}

/** @deprecated legacy v4, deleted in P1.6 — use `railwayPlugin`. */
export class RailwayAdapter {
  readonly provider = 'railway' as const;
  readonly availableTools: ReadonlyArray<McpToolDeclaration> = railwayTools;
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
   * stored access_token is within the refresh window of expiry.
   */
  async mintUpstreamToken(admin: ProviderAdmin): Promise<{ token: string; expiresAt: Date }> {
    if (!admin.access_token_encrypted) {
      throw new Error('Railway ProviderAdmin has no access_token_encrypted.');
    }
    const current = new TextDecoder().decode(admin.access_token_encrypted);
    const expiresAt = admin.expires_at ? new Date(admin.expires_at) : null;
    const needsRefresh =
      expiresAt !== null && expiresAt.getTime() - Date.now() < RAILWAY_REFRESH_THRESHOLD_MS;
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
    const res = await this.fetchImpl(RAILWAY_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${basicAuth}`,
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        resource: RAILWAY_MCP_RESOURCE,
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

  /** v4 classifier entry point — delegates to the v5 classifier through the bindings bridge. */
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
