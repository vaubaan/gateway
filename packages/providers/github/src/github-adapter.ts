/**
 * GitHubAdapter — implements ProviderAdapter for GitHub via GitHub App install.
 *
 * Spec  : docs/spec/mcp-proxy.md §5.1, §5.2.
 * ADRs  : docs/decisions/oauth-app-install-per-provider.md,
 *         docs/decisions/dispatch-upstream-option-a-synthese.md.
 */

import { Octokit } from '@octokit/rest';
import type { McpToolDeclaration, ProviderAdmin, ProviderBinding } from '@vauban/shared';
import type { ProviderAdapter, ValidateResult, MintedToken } from './adapter.ts';
import { mintInstallationToken } from './app-install.ts';
import { availableTools } from './tools.ts';
import { executeCall, type OctokitFactory } from './execute.ts';

export interface GitHubAdapterConfig {
  appId: string;
  appSlug: string; // e.g. "vauban-gateway" — used to build the install URL
  privateKeyPem: string;
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
    // GitHub App install URL — the org admin picks an installation target on
    // GitHub's screen. GitHub will POST back to our callback with installation_id.
    const url = new URL(`https://github.com/apps/${this.config.appSlug}/installations/new`);
    url.searchParams.set('state', state);
    // GitHub doesn't actually use redirect_url on the install URL — we pass
    // returnUrl in state by convention to round-trip through. The callback
    // handler is the source of truth for what to do next.
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
    if (!admin.installation_id) {
      throw new Error('GitHub ProviderAdmin missing installation_id.');
    }
    const { token, expiresAt } = await mintInstallationToken({
      appId: this.config.appId,
      privateKeyPem: this.config.privateKeyPem,
      installationId: admin.installation_id,
      fetchImpl: this.config.fetchImpl,
    });
    return { token, expiresAt };
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
