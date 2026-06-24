/**
 * VercelAdapter — Marketplace Integration OAuth, rewraps the official Vercel MCP server.
 *
 * Spec : docs/spec/vaubaan-gateway.md §5.1.
 * ADR  : docs/decisions/rewrap-official-mcps.md.
 *
 * Vaubaan's policy engine and audit live in front ; the actual tool execution
 * is forwarded as JSON-RPC `tools/call` to https://mcp.vercel.com/.
 *
 * Auth model : Marketplace Integration OAuth (access_token + refresh_token).
 * Token exchange via POST /v1/auth/token with grant_type.
 */

import type { McpToolDeclaration, ProviderAdmin, ProviderBinding } from '@vaubaan/shared';
import { availableTools } from './tools.ts';
import { executeCall, type FetchImpl } from './execute.ts';
import { classifyVercelV4, type ClassifyResult } from './risk-classifier.ts';
import { UPSERT_ENV_FROM_VENV } from './custom-tools.ts';

const TOKEN_ENDPOINT = 'https://api.vercel.com/login/oauth/token';
const REFRESH_THRESHOLD_MS = 5 * 60 * 1000;

export interface VercelRefreshedTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
}

export interface VenvStoreReader {
  get(projectId: string, key: string): Promise<string>;
}

export interface VercelAdapterConfig {
  /** Override fetch in tests. */
  fetchImpl?: FetchImpl;
  /** Project env var store for _from_venv tools. */
  venvStore?: VenvStoreReader | null;
  clientId?: string;
  clientSecret?: string;
  persistRefresh?: (admin: ProviderAdmin, tokens: VercelRefreshedTokens) => Promise<void>;
}

export interface ValidateResult {
  ok: boolean;
  displayName?: string;
  error?: string;
  warnings?: string[];
}

export class VercelAdapter {
  readonly provider = 'vercel' as const;
  readonly availableTools: ReadonlyArray<McpToolDeclaration> = availableTools;
  private readonly fetchImpl: FetchImpl;
  private readonly venvStore: VenvStoreReader | null;
  private readonly clientId: string | undefined;
  private readonly clientSecret: string | undefined;
  private readonly persistRefresh:
    | ((admin: ProviderAdmin, tokens: VercelRefreshedTokens) => Promise<void>)
    | undefined;

  constructor(config: VercelAdapterConfig = {}) {
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.venvStore = config.venvStore ?? null;
    this.clientId = config.clientId;
    this.clientSecret = config.clientSecret;
    this.persistRefresh = config.persistRefresh;
  }

  async mintUpstreamToken(admin: ProviderAdmin): Promise<{ token: string; expiresAt: Date }> {
    if (!admin.access_token_encrypted) {
      throw new Error('Vercel ProviderAdmin has no access_token_encrypted.');
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

  private async refresh(admin: ProviderAdmin): Promise<VercelRefreshedTokens | null> {
    if (!this.clientId || !this.clientSecret) return null;
    if (!admin.refresh_token_encrypted) return null;
    const refreshToken = new TextDecoder().decode(admin.refresh_token_encrypted);
    const res = await this.fetchImpl(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: this.clientId,
        client_secret: this.clientSecret,
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      }),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
    };
    const tokens: VercelRefreshedTokens = {
      accessToken: json.access_token,
      refreshToken: json.refresh_token ?? refreshToken,
      expiresAt: new Date(Date.now() + (json.expires_in ?? 3600) * 1000),
    };
    if (this.persistRefresh) {
      try {
        await this.persistRefresh(admin, tokens);
      } catch (e) {
        console.error('[vercel] persistRefresh failed', e);
      }
    }
    return tokens;
  }

  async validateBinding(admin: ProviderAdmin, resourceRef: string): Promise<ValidateResult> {
    if (!/^prj_[A-Za-z0-9]+$/.test(resourceRef)) {
      return { ok: false, error: 'Vercel binding must be a project id like `prj_xxx`.' };
    }
    try {
      const { token } = await this.mintUpstreamToken(admin);
      const data = (await executeCall(this.fetchImpl, token, admin.team_id, 'vercel__get_project', {
        projectId: resourceRef,
      })) as { content?: Array<{ text?: string }>; name?: string };
      // The upstream MCP wraps results in {content:[{type:'text',text:<JSON>}]} ;
      // we accept either shape for the display name.
      let displayName = data.name ?? resourceRef;
      if (Array.isArray(data.content)) {
        const first = data.content[0];
        if (first?.text) {
          try {
            const inner = JSON.parse(first.text) as { name?: string };
            displayName = inner.name ?? displayName;
          } catch {
            // leave default
          }
        }
      }
      return {
        ok: true,
        displayName,
        warnings: [
          'Vercel does not allow API tokens to modify Deployment Protection (SSO / Password). ' +
            'If your previews are behind Vercel Authentication, disable it manually in the ' +
            'Vercel dashboard (Project → Settings → Deployment Protection) or attach a custom domain.',
        ],
      };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return { ok: false, error: `Vercel validation failed: ${message}` };
    }
  }

  async executeCall(
    admin: ProviderAdmin,
    binding: ProviderBinding,
    tool: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    const { token } = await this.mintUpstreamToken(admin);
    if (tool === UPSERT_ENV_FROM_VENV) {
      return this.executeUpsertEnvFromVenv(token, admin.team_id, binding.project_id, args);
    }
    return executeCall(this.fetchImpl, token, admin.team_id, tool, args);
  }

  private async executeUpsertEnvFromVenv(
    token: string,
    teamId: string | null,
    projectId: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    if (!this.venvStore) throw new Error('venv store is not configured on this gateway.');
    const venvKey = typeof args.venv_key === 'string' ? args.venv_key : '';
    if (!venvKey) throw new Error('vercel__upsert_env_from_venv requires venv_key.');
    const vercelProjectId = typeof args.projectId === 'string' ? args.projectId : '';
    if (!vercelProjectId) throw new Error('vercel__upsert_env_from_venv requires projectId.');
    const value = await this.venvStore.get(projectId, venvKey);
    const target = Array.isArray(args.target)
      ? args.target
      : ['production', 'preview', 'development'];
    const type = typeof args.type === 'string' ? args.type : 'encrypted';
    await executeCall(this.fetchImpl, token, teamId, 'vercel__upsert_env_var', {
      projectId: vercelProjectId,
      key: venvKey,
      value,
      target,
      type,
    });
    const dest = `vercel/${vercelProjectId}/${(target as string[]).join(',')}`;
    return { venv_key: venvKey, destination: dest, status: 'deployed' };
  }

  /**
   * v4 classifier — emit the slice(s) the call touches. The provider plugin's
   * sole authorization responsibility.
   */
  classifyV4(
    tool: string,
    args: Record<string, unknown>,
    bindings: ReadonlyArray<ProviderBinding>,
  ): ClassifyResult {
    return classifyVercelV4(tool, args, bindings);
  }
}
