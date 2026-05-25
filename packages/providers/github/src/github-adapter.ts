/**
 * GitHubAdapter — implements ProviderAdapter for GitHub via GitHub App install.
 *
 * Spec  : docs/spec/mcp-proxy.md §5.1, §5.2.
 * ADRs  : docs/decisions/oauth-app-install-per-provider.md,
 *         docs/decisions/dispatch-upstream-option-a-synthese.md.
 */

import { Octokit } from '@octokit/rest';
import type { McpToolDeclaration, ProviderAdmin, ProviderBinding } from '@vaubaan/shared';
import type { ProviderAdapter, ValidateResult, MintedToken } from './adapter.ts';
import { mintInstallationToken } from './app-install.ts';
import { availableTools } from './tools.ts';
import { executeCall, type OctokitFactory } from './execute.ts';

export interface GitHubAdapterConfig {
  /** GitHub App ID. Required for the App-install path. */
  appId?: string;
  /** App slug (e.g. "vaubaan-gateway") used to build the install URL. */
  appSlug?: string;
  /** PEM private key. Required for the App-install path. */
  privateKeyPem?: string;
  /** Override for tests. */
  octokitFactory?: OctokitFactory;
  /** Override fetch in tests. */
  fetchImpl?: typeof fetch;
}

const defaultOctokitFactory: OctokitFactory = (token) => new Octokit({ auth: token });

export class GitHubAdapter implements ProviderAdapter {
  readonly provider = 'github' as const;
  readonly availableTools: ReadonlyArray<McpToolDeclaration> = availableTools;

  private readonly config: GitHubAdapterConfig;

  constructor(config: GitHubAdapterConfig) {
    this.config = config;
  }

  authorizationUrl(_orgId: string, returnUrl: string, state: string): string {
    if (!this.config.appSlug) {
      throw new Error('GitHubAdapter: appSlug is required to build the install URL.');
    }
    const url = new URL(`https://github.com/apps/${this.config.appSlug}/installations/new`);
    url.searchParams.set('state', state);
    void returnUrl;
    return url.toString();
  }

  async handleCallback(_orgId: string, params: URLSearchParams) {
    const installationId = params.get('installation_id');
    if (!installationId) {
      throw new Error('GitHub callback: missing installation_id query param.');
    }
    return {
      installation_id: installationId,
      team_id: null,
      access_token_encrypted: null,
      refresh_token_encrypted: null,
      expires_at: null,
    };
  }

  async mintUpstreamToken(admin: ProviderAdmin): Promise<MintedToken> {
    // App-install path (production) : mint a 1h installation token JIT.
    if (admin.installation_id) {
      if (!this.config.appId || !this.config.privateKeyPem) {
        throw new Error(
          'GitHubAdapter: appId and privateKeyPem are required to mint an installation token.',
        );
      }
      const { token, expiresAt } = await mintInstallationToken({
        appId: this.config.appId,
        privateKeyPem: this.config.privateKeyPem,
        installationId: admin.installation_id,
        fetchImpl: this.config.fetchImpl,
      });
      return { token, expiresAt };
    }
    // PAT fallback (E2E test / no App registered yet) : use the stored bytea
    // as a raw UTF-8 token. v0 doesn't actually encrypt yet (no Vault wired),
    // so the bytea holds plain UTF-8 bytes of the PAT.
    if (admin.access_token_encrypted) {
      const token = new TextDecoder().decode(admin.access_token_encrypted);
      // PATs are long-lived ; we report an arbitrary far-future expiry so the
      // cache (when wired) can hold them. Vaubaan never relies on this date
      // for revocation — that's done at the provider_admins.status level.
      return { token, expiresAt: new Date(Date.now() + 30 * 24 * 3600 * 1000) };
    }
    throw new Error('GitHub ProviderAdmin has neither installation_id nor access_token_encrypted.');
  }

  async validateBinding(admin: ProviderAdmin, resourceRef: string): Promise<ValidateResult> {
    const m = resourceRef.match(/^([^/]+)\/([^/]+)$/);
    if (!m) {
      return { ok: false, error: 'GitHub binding must be of the form "owner/repo".' };
    }
    const [, owner, repo] = m;
    try {
      const { token } = await this.mintUpstreamToken(admin);
      const octokit = (this.config.octokitFactory ?? defaultOctokitFactory)(token);
      const { data } = await octokit.rest.repos.get({ owner: owner!, repo: repo! });
      return { ok: true, displayName: data.full_name };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return { ok: false, error: `GitHub validation failed: ${message}` };
    }
  }

  async executeCall(
    admin: ProviderAdmin,
    _binding: ProviderBinding,
    tool: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    const { token } = await this.mintUpstreamToken(admin);
    return executeCall(this.config.octokitFactory ?? defaultOctokitFactory, token, tool, args);
  }

  resolveTarget(target: string, bindings: ProviderBinding[]): string[] {
    if (target === '*') return ['*'];
    if (target === 'project.repos') {
      return bindings.filter((b) => b.provider === 'github').map((b) => b.resource_ref);
    }
    return [];
  }
}
