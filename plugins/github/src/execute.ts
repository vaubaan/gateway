/**
 * Upstream calls of the `github` provider : `execute` and `discoverResources`.
 *
 * Spec : docs/spec/vaubaan-gateway.md §2.4 — the credential arrives
 *        decrypted in the context, is used for one call, and is never
 *        returned to the executor.
 *
 * Every call uses an installation token scoped to the repository named in
 * the arguments — minted (`credential.ts`) or, when the host provides a
 * connection-scoped cache, reused for a few minutes (`token-cache.ts`) — then
 * dispatches over Octokit with the injected `fetch`. 401 / 403 from GitHub →
 * `UpstreamAuthError`.
 *
 * `github__mint_install_token` is the one tool whose result IS a credential :
 * it returns a token scoped to the mission's repositories and to the
 * permission set of `purpose` ; once returned it leaves the gateway's
 * perimeter (risks `github.mint-install-token-{clone,push}`).
 */

import { Octokit } from '@octokit/rest';
import {
  UpstreamAuthError,
  type ConnectionContext,
  type ExecuteContext,
  type McpToolResult,
  type PluginLogger,
  type Resource,
} from '@vaubaan/plugin-sdk';

import { GITHUB_API_BASE, GITHUB_API_HEADERS } from './app-install.ts';
import { MINT_TOOL, githubRepoRefs } from './classify.ts';
import { installationTokenFor } from './credential.ts';
import { dispatchGithubTool, type OctokitLike } from './octokit-dispatch.ts';
import { installationTokenForCall } from './token-cache.ts';

const PROVIDER = 'github';

/** Permission sets of `github__mint_install_token`, by purpose. */
export const MINT_PERMISSIONS: Readonly<
  Record<'clone' | 'push', Readonly<Record<string, string>>>
> = {
  clone: { contents: 'read' },
  // workflows:write covers pushes that include `.github/workflows/*.yml` —
  // GitHub rejects the push otherwise. Requires the App itself to hold
  // workflows R/W ; GitHub silently drops a permission the App lacks.
  push: {
    contents: 'write',
    pull_requests: 'write',
    metadata: 'read',
    workflows: 'write',
  },
};

/** Repositories per page and page cap of `discoverResources` (GitHub maxes `per_page` at 100). */
export const DISCOVERY_PAGE_SIZE = 100;
export const DISCOVERY_MAX_PAGES = 10;

export async function executeGithub(
  ctx: ExecuteContext,
  tool: string,
  args: Readonly<Record<string, unknown>>,
): Promise<McpToolResult> {
  if (tool === MINT_TOOL) return mintInstallTokenTool(ctx, args);

  const repo = typeof args.repo === 'string' && args.repo.length > 0 ? args.repo : undefined;
  // Least privilege : the per-call token only sees the repository the call
  // names ; account-shaped tools (search) get an installation-wide token.
  // Reused across calls when the host provides a connection-scoped cache.
  const token = await installationTokenForCall(ctx, repo);
  const octokit: OctokitLike = new Octokit({
    auth: token,
    request: { fetch: ctx.fetch, ...(ctx.signal ? { signal: ctx.signal } : {}) },
    // Octokit logs failed requests ; route them to the host logger, never to the console.
    log: octokitLog(ctx.logger),
  });
  try {
    return json(await dispatchGithubTool(octokit, tool, args));
  } catch (e: unknown) {
    const status = (e as { status?: number }).status;
    if (status === 401 || status === 403) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new UpstreamAuthError(`github rejected the credential: ${msg}`, status);
    }
    throw e;
  }
}

/**
 * Mint a short-lived installation token scoped to the mission's repositories
 * (or the one named by `repoFullName`) with the permission set of `purpose`.
 * The classifier already refused unknown purposes and foreign repositories ;
 * the checks are repeated here so the function is safe on its own.
 */
async function mintInstallTokenTool(
  ctx: ExecuteContext,
  args: Readonly<Record<string, unknown>>,
): Promise<McpToolResult> {
  const purpose = args.purpose;
  if (purpose !== 'clone' && purpose !== 'push') {
    throw new Error(`${MINT_TOOL} requires purpose in ['clone','push'], got ${String(purpose)}.`);
  }
  const refs = githubRepoRefs(ctx.resources);
  if (refs.length === 0) throw new Error(`${MINT_TOOL}: the mission touches no GitHub repository.`);

  const repoFullName = typeof args.repoFullName === 'string' ? args.repoFullName : undefined;
  let scoped: readonly string[];
  if (repoFullName) {
    if (!refs.includes(repoFullName)) {
      throw new Error(`${MINT_TOOL}: ${repoFullName} is not a GitHub resource of this mission.`);
    }
    scoped = [repoFullName];
  } else {
    scoped = refs;
  }

  const minted = await installationTokenFor(ctx, {
    repositories: scoped.map(repoNameOf),
    permissions: MINT_PERMISSIONS[purpose],
  });
  return json({
    token: minted.token,
    expires_at: minted.expiresAt.toISOString(),
    repositories: minted.repositories,
    permissions: minted.permissions,
  });
}

interface InstallationRepositoryDto {
  readonly full_name: string;
  readonly default_branch?: string;
  readonly private?: boolean;
  readonly archived?: boolean;
}

/**
 * Resources reachable through the installation : one `Resource` per
 * repository the App is installed on, paged by `DISCOVERY_PAGE_SIZE` up to
 * `DISCOVERY_MAX_PAGES`. The owner labels the environment later.
 */
export async function discoverGithubResources(
  ctx: ConnectionContext,
): Promise<readonly Resource[]> {
  const { token } = await installationTokenFor(ctx);
  const out: Resource[] = [];
  for (let page = 1; page <= DISCOVERY_MAX_PAGES; page++) {
    const url = `${GITHUB_API_BASE}/installation/repositories?per_page=${DISCOVERY_PAGE_SIZE}&page=${page}`;
    const res = await ctx.fetch(url, {
      method: 'GET',
      headers: { ...GITHUB_API_HEADERS, Authorization: `Bearer ${token}` },
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    });
    if (res.status === 401 || res.status === 403) {
      throw new UpstreamAuthError(
        `github rejected the installation token (HTTP ${res.status})`,
        res.status,
      );
    }
    if (!res.ok)
      throw new Error(`github GET /installation/repositories failed with HTTP ${res.status}`);
    const body = (await res.json()) as {
      total_count?: number;
      repositories?: readonly InstallationRepositoryDto[];
    };
    const repositories = body.repositories ?? [];
    for (const r of repositories) {
      out.push({
        provider: PROVIDER,
        ref: r.full_name,
        displayName: r.full_name,
        metadata: {
          ...(r.default_branch !== undefined ? { default_branch: r.default_branch } : {}),
          ...(r.private !== undefined ? { private: r.private } : {}),
          ...(r.archived !== undefined ? { archived: r.archived } : {}),
        },
      });
    }
    const total = body.total_count;
    if (repositories.length < DISCOVERY_PAGE_SIZE || (total !== undefined && out.length >= total))
      break;
  }
  return out;
}

type OctokitLog = NonNullable<ConstructorParameters<typeof Octokit>[0]>['log'];

function octokitLog(logger: PluginLogger | undefined): OctokitLog {
  const to =
    (level: 'debug' | 'info' | 'warn' | 'error') =>
    (...parts: unknown[]) => {
      if (!logger) return;
      logger[level](parts.map(String).join(' '), { source: 'octokit' });
    };
  return { debug: to('debug'), info: to('info'), warn: to('warn'), error: to('error') };
}

/** `owner/repo` → `repo` (the access_tokens endpoint takes names without owner). */
function repoNameOf(fullName: string): string {
  const slash = fullName.indexOf('/');
  return slash >= 0 ? fullName.slice(slash + 1) : fullName;
}

function json(payload: unknown): McpToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
}
