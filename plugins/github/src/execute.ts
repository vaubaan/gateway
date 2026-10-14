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
  ExecutorRefusal,
  UpstreamAuthError,
  UpstreamHttpError,
  declining,
  type ConnectionContext,
  type ExecuteContext,
  type McpToolResult,
  type PluginLogger,
  type Resource,
} from '@vaubaan/plugin-sdk';

import { GITHUB_API_BASE, GITHUB_API_HEADERS } from './app-install.ts';
import {
  MINT_TOOL,
  PROVIDER,
  githubRepoRefs,
  readGithubCall,
  repoFullName,
  type GithubCall,
} from './call.ts';
import { installationTokenFor } from './credential.ts';
import { dispatchGithubTool, type OctokitLike } from './octokit-dispatch.ts';
import {
  assertAppPermissions,
  declineMissingPermissions,
  mintPermissions,
} from './permission-check.ts';
import { installationGrantForCall } from './token-cache.ts';

/**
 * Permission sets of `github__mint_install_token`, by purpose, when the
 * installation holds everything the purpose may use. A push token carries
 * `pull_requests` and `workflows` only when the installation holds them
 * (`permission-check.ts`): GitHub refuses a token asking for more.
 */
export const MINT_PERMISSIONS: Readonly<
  Record<'clone' | 'push', Readonly<Record<string, string>>>
> = {
  clone: mintPermissions('clone', {}),
  push: mintPermissions('push', {}),
};

/** Repositories per page and page cap of `discoverResources` (GitHub maxes `per_page` at 100). */
export const DISCOVERY_PAGE_SIZE = 100;
export const DISCOVERY_MAX_PAGES = 10;

/**
 * What the reader denies, and the merge guard that does not hold, is declined :
 * an `isError` result (`ExecutorRefusal`), no request sent for it, nothing failed
 * at GitHub. A failure of GitHub is thrown.
 */
export function executeGithub(
  ctx: ExecuteContext,
  tool: string,
  args: Readonly<Record<string, unknown>>,
): Promise<McpToolResult> {
  return declining(() => executeRead(ctx, tool, args));
}

async function executeRead(
  ctx: ExecuteContext,
  tool: string,
  args: Readonly<Record<string, unknown>>,
): Promise<McpToolResult> {
  // The reader the classifier used, over the same mission resources : the
  // call that runs is the call that was classified, or nothing runs — not
  // even the token mint.
  const call = readGithubCall(tool, args, githubRepoRefs(ctx.resources));
  if ('denied' in call) throw new ExecutorRefusal(refusalOf(tool, call.denied));
  if (call.tool === MINT_TOOL) return mintInstallTokenTool(ctx, call);

  // Least privilege : the per-call token only sees the repository the call
  // names ; account-shaped tools (search) get an installation-wide token.
  // Reused across calls when the host provides a connection-scoped cache.
  // What the installation holds is checked before anything else is sent: a
  // missing permission is declined by name, not left to GitHub's 403.
  const { token, permissions } = await installationGrantForCall(
    ctx,
    'target' in call ? call.target.repo : undefined,
  );
  assertAppPermissions(call, permissions);
  const octokit: OctokitLike = new Octokit({
    auth: token,
    request: { fetch: ctx.fetch, ...(ctx.signal ? { signal: ctx.signal } : {}) },
    // Octokit logs failed requests ; route them to the host logger, never to the console.
    log: octokitLog(ctx.logger),
  });
  try {
    return json(await dispatchGithubTool(octokit, call, args));
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
 * What `execute` answers for a call the reader refuses : the classifier's
 * sentence, led by the tool name (`tool 'x' requires …` → `x requires …`).
 * Declined, like every refusal of this executor — nothing was sent.
 */
function refusalOf(tool: string, denied: string): string {
  const classifierLead = `tool '${tool}' `;
  if (denied.startsWith(classifierLead)) return `${tool} ${denied.slice(classifierLead.length)}`;
  return denied.startsWith(tool) ? denied : `${tool}: ${denied}`;
}

/**
 * Mint a short-lived installation token scoped to the mission's repositories
 * (or the one named by `repoFullName`) with the permission set of `purpose`.
 * `call` comes from `readGithubCall` : an unknown purpose or a repository
 * outside the mission never reaches this function, and the repositories of
 * the token are the ones the slices named.
 */
async function mintInstallTokenTool(
  ctx: ExecuteContext,
  call: Extract<GithubCall, { tool: typeof MINT_TOOL }>,
): Promise<McpToolResult> {
  // The access_tokens endpoint takes names without owner.
  const repositories = call.repositories.map((r) => r.repo);
  const mint = (permissions: Readonly<Record<string, string>>) =>
    installationTokenFor(ctx, { repositories, permissions });
  let minted: Awaited<ReturnType<typeof mint>>;
  try {
    // Everything the purpose may use; GitHub answers 422 when the installation
    // lacks one of them.
    minted = await mint(MINT_PERMISSIONS[call.purpose]);
  } catch (error) {
    if (!notGranted(error)) throw error;
    const needs = mintPermissions(call.purpose, NOTHING_HELD);
    try {
      // Then what the purpose cannot do without.
      minted = await mint(needs);
    } catch (again) {
      if (notGranted(again)) declineMissingPermissions(call, needs);
      throw again;
    }
  }
  return json({
    token: minted.token,
    expires_at: minted.expiresAt.toISOString(),
    repositories: minted.repositories,
    permissions: minted.permissions,
  });
}

/** The permissions of an installation that holds nothing optional: `mintPermissions` adds no extra. */
const NOTHING_HELD: Readonly<Record<string, string>> = { metadata: 'read' };
/** GitHub's answer to a token asking for a permission the installation does not hold. */
const UNPROCESSABLE = 422;

function notGranted(error: unknown): boolean {
  return error instanceof UpstreamHttpError && error.status === UNPROCESSABLE;
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
  let listed = 0;
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
    if (!res.ok) {
      throw new UpstreamHttpError(
        `github GET /installation/repositories failed with HTTP ${res.status}`,
        res.status,
      );
    }
    const body = (await res.json()) as {
      total_count?: number;
      repositories?: readonly InstallationRepositoryDto[];
    };
    const repositories = body.repositories ?? [];
    listed += repositories.length;
    for (const r of repositories) {
      // A name the reader of the calls would refuse is of no use to a
      // mission : it is left out, and said, instead of listing a resource no
      // call can name.
      const named = repoFullName(r.full_name);
      if (named === null) {
        ctx.logger?.warn('github: repository left out, its name is not owner/repo', {
          full_name: String(r.full_name).slice(0, 200),
        });
        continue;
      }
      out.push({
        provider: PROVIDER,
        ref: named.ref,
        displayName: named.ref,
        metadata: {
          ...(r.default_branch !== undefined ? { default_branch: r.default_branch } : {}),
          ...(r.private !== undefined ? { private: r.private } : {}),
          ...(r.archived !== undefined ? { archived: r.archived } : {}),
        },
      });
    }
    const total = body.total_count;
    if (repositories.length < DISCOVERY_PAGE_SIZE || (total !== undefined && listed >= total))
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

function json(payload: unknown): McpToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
}
