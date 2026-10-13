/**
 * @deprecated legacy v4 adapter, deleted in P1.6 — the v5 surface is
 * `githubPlugin` (`index.ts`), built with `definePlugin`.
 *
 * Kept, unchanged in behaviour, so the v4 gateway
 * (`apps/gateway/src/lib/gateway/build.ts`) and its tests keep compiling and
 * passing until the execution door replaces it. Depends on the quarantined
 * v4 row types (`ProviderAdmin`, `ProviderBinding`) and on the global fetch
 * for its PAT fallback ; nothing here is part of the plugin contract.
 */

import { Octokit } from '@octokit/rest';
import {
  UpstreamAuthError,
  type McpToolDeclaration,
  type ProviderAdmin,
  type ProviderBinding,
} from '@vaubaan/shared';
import { mintInstallationToken } from './app-install.ts';
import { githubTools } from './tools.ts';
import { classifyGithubV4, type ClassifyV4Result } from './risk-classifier.ts';
import { executeCall, type OctokitFactory } from './octokit-dispatch.ts';

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
  /**
   * Load every github binding of a project. Injected by the web layer (DB
   * lookup) and used by `github__mint_install_token` to scope the minted token
   * to the project's repos.
   */
  loadGithubBindings?: (projectId: string) => Promise<ProviderBinding[]>;
}

export interface ValidateResult {
  ok: boolean;
  displayName?: string;
  error?: string;
}

export interface MintedToken {
  token: string;
  expiresAt: Date;
}

const MINT_TOOL = 'github__mint_install_token';
const MINT_PERMISSIONS: Record<'clone' | 'push', Record<string, string>> = {
  clone: { contents: 'read' },
  // workflows:write covers pushes that include `.github/workflows/*.yml` —
  // GitHub rejects the push otherwise (App tokens are strict about workflow
  // file changes). Requires the App itself to have workflows R/W ; without
  // that, GitHub silently ignores the requested permission.
  push: {
    contents: 'write',
    pull_requests: 'write',
    metadata: 'read',
    workflows: 'write',
  },
};

const defaultOctokitFactory: OctokitFactory = (token) => new Octokit({ auth: token });

/** @deprecated legacy v4, deleted in P1.6. */
export class GitHubAdapter {
  readonly provider = 'github' as const;
  readonly availableTools: ReadonlyArray<McpToolDeclaration> = githubTools;

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
    binding: ProviderBinding,
    tool: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    if (tool === MINT_TOOL) {
      return this.mintTokenForCaller(admin, binding, args);
    }
    const { token } = await this.mintUpstreamToken(admin);
    try {
      return await executeCall(
        this.config.octokitFactory ?? defaultOctokitFactory,
        token,
        tool,
        args,
      );
    } catch (e: unknown) {
      const status = (e as { status?: number }).status;
      if (status === 401 || status === 403) {
        const msg = e instanceof Error ? e.message : String(e);
        throw new UpstreamAuthError(msg, status);
      }
      throw e;
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
  ): ClassifyV4Result {
    return classifyGithubV4(tool, args, bindings);
  }

  /**
   * Mint a short-lived installation token scoped to the project repos. The
   * caller's role pins `purpose` via policy constraints (typically `clone`
   * vs `push`).
   *
   * Policy enforces the purpose constraint upstream — this method trusts the
   * value but still rejects unknown values defensively.
   */
  private async mintTokenForCaller(
    admin: ProviderAdmin,
    binding: ProviderBinding,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    if (!admin.installation_id) {
      throw new Error(`${MINT_TOOL} requires a GitHub App installation_id on the org.`);
    }
    if (!this.config.appId || !this.config.privateKeyPem) {
      throw new Error(`${MINT_TOOL} requires App credentials (appId + privateKeyPem).`);
    }
    if (!this.config.loadGithubBindings) {
      throw new Error(`${MINT_TOOL}: loadGithubBindings callback not configured.`);
    }
    const purpose = args.purpose;
    if (purpose !== 'clone' && purpose !== 'push') {
      throw new Error(`${MINT_TOOL} requires purpose in ['clone','push'], got ${String(purpose)}.`);
    }
    if (!binding.project_id) {
      throw new Error(`${MINT_TOOL}: missing project context.`);
    }

    const bindings = await this.config.loadGithubBindings(binding.project_id);
    if (bindings.length === 0) {
      throw new Error(`${MINT_TOOL}: project has no github bindings.`);
    }

    const repoFullName = typeof args.repoFullName === 'string' ? args.repoFullName : undefined;
    let repositories: string[];
    if (repoFullName) {
      if (!bindings.some((b) => b.resource_ref === repoFullName)) {
        throw new Error(`${MINT_TOOL}: ${repoFullName} is not in the project's github bindings.`);
      }
      repositories = [repoFullName.split('/')[1] ?? ''];
    } else {
      repositories = bindings.map((b) => b.resource_ref.split('/')[1] ?? '');
    }

    const minted = await mintInstallationToken({
      appId: this.config.appId,
      privateKeyPem: this.config.privateKeyPem,
      installationId: admin.installation_id,
      repositories,
      permissions: MINT_PERMISSIONS[purpose],
      fetchImpl: this.config.fetchImpl,
    });

    return {
      token: minted.token,
      expires_at: minted.expiresAt.toISOString(),
      repositories: minted.repositories,
      permissions: minted.permissions,
    };
  }
}
