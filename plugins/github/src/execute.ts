/**
 * Upstream calls of the `github` service : `execute` and `discoverResources`.
 *
 * Spec : docs/spec/vaubaan-gateway.md §2.4 — the credential arrives
 *        decrypted in the context, is used for one call, and is never
 *        returned to the executor.
 *
 * Every call sends the account's token as the bearer and dispatches over
 * Octokit with the injected `fetch`. What the token may do is what its owner
 * ticked at GitHub, which GitHub enforces : 401 / 403 from GitHub →
 * `UpstreamAuthError`.
 */

import { Octokit } from '@octokit/rest';
import {
  ExecutorRefusal,
  UpstreamAuthError,
  UpstreamProtocolError,
  declining,
  httpJson,
  isList,
  isRecord,
  jsonResult,
  type AccountContext,
  type ExecuteContext,
  type McpToolResult,
  type PluginLogger,
  type Resource,
} from '@vaubaan/plugin-sdk';

import { GITHUB_API_BASE, HTTP_FORBIDDEN, githubApiHeaders } from './api.ts';
import { githubRepoRefs, readGithubCall, repoFullName, type GithubCall } from './call.ts';
import { fetchGithubRepository, githubRepositoryOf, githubTokenOf } from './credential.ts';
import { isGitTool } from './git-call.ts';
import { executeGit } from './git-remote.ts';
import { SERVICE_ID, TOOL } from './identity.ts';
import { readJobLogs } from './job-logs.ts';
import { dispatchGithubTool, type OctokitLike } from './octokit-dispatch.ts';

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
  if (isGitTool(tool)) return declining(() => executeGit(ctx, tool, args));
  return declining(() => executeRead(ctx, tool, args));
}

async function executeRead(
  ctx: ExecuteContext,
  tool: string,
  args: Readonly<Record<string, unknown>>,
): Promise<McpToolResult> {
  // The reader the classifier used, over the same mission resources : the
  // call that runs is the call that was classified, or nothing runs.
  const call = readGithubCall(tool, args, githubRepoRefs(ctx.resources));
  if ('denied' in call) throw new ExecutorRefusal(refusalOf(tool, call.denied));
  try {
    return await send(ctx, call, args, githubTokenOf(ctx));
  } catch (e: unknown) {
    throw asAuthError(e);
  }
}

/** One request of a checked call with `token` : the job log read bounded, any other tool over Octokit. */
async function send(
  ctx: ExecuteContext,
  call: GithubCall,
  args: Readonly<Record<string, unknown>>,
  token: string,
): Promise<McpToolResult> {
  if (call.tool === TOOL.getJobLogs) return readJobLogs(ctx, token, call);
  const octokit: OctokitLike = new Octokit({
    auth: token,
    request: { fetch: ctx.fetch, ...(ctx.signal ? { signal: ctx.signal } : {}) },
    // Octokit logs failed requests ; route them to the host logger, never to the console.
    log: octokitLog(ctx.logger),
  });
  return jsonResult(await dispatchGithubTool(octokit, call, args));
}

/** The HTTP status Octokit's `RequestError` carries, if `e` is one. */
function statusOf(e: unknown): number | undefined {
  return isRecord(e) && typeof e.status === 'number' ? e.status : undefined;
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** 401 / 403 from GitHub → `UpstreamAuthError` ; anything else as it is. */
function asAuthError(e: unknown): unknown {
  const status = statusOf(e);
  if (status === 401 || status === HTTP_FORBIDDEN) {
    return new UpstreamAuthError(`github rejected the credential: ${messageOf(e)}`, status);
  }
  return e;
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
 * Resources of the account : its one repository (`GET /repos/{owner}/{repo}`,
 * named on the connect form), never hidden — the owner named it. An account
 * made before the form asked for it (2026-11-16) keeps the former listing
 * until it is reconnected (`discoverListedRepositories`).
 */
export async function discoverGithubResources(ctx: AccountContext): Promise<readonly Resource[]> {
  const named = githubRepositoryOf(ctx);
  if (named === null) return discoverListedRepositories(ctx);
  const repository = await fetchGithubRepository(ctx, named);
  const resource = resourceOf(repository, false);
  if (resource === null) {
    throw new UpstreamProtocolError(
      `github: repository ${named.ref} answered without an owner/repo full_name`,
    );
  }
  // GitHub answers the canonical spelling (case, a renamed repository) ; the
  // owner named the repository, so it is never hidden from new missions.
  return [{ ...resource, hiddenByDefault: false }];
}

/**
 * The former discovery, kept for an account without a named repository : one
 * `Resource` per repository the token reaches (`GET /user/repos`, a bare list), paged by
 * `DISCOVERY_PAGE_SIZE` up to `DISCOVERY_MAX_PAGES`. The owner labels the
 * environment later. A public repository the token most likely cannot act on
 * is marked `hiddenByDefault` (`hiddenByDefault` below). An answer that is not a
 * list is GitHub's failure (`UpstreamProtocolError`), not an account without
 * repositories.
 */
async function discoverListedRepositories(ctx: AccountContext): Promise<readonly Resource[]> {
  const token = githubTokenOf(ctx);
  const fineGrained = token.startsWith(FINE_GRAINED_PREFIX);
  const headers = githubApiHeaders(token);
  const out: Resource[] = [];
  for (let page = 1; page <= DISCOVERY_MAX_PAGES; page++) {
    const url = `${GITHUB_API_BASE}/user/repos?per_page=${DISCOVERY_PAGE_SIZE}&page=${page}`;
    const repositories = await httpJson(ctx, { url, headers }, isList);
    for (const repository of repositories) {
      const resource = resourceOf(repository, fineGrained);
      if (resource !== null) {
        out.push(resource);
        continue;
      }
      // A name the reader of the calls would refuse is of no use to a
      // mission : it is left out, and said, instead of listing a resource no
      // call can name.
      ctx.logger?.warn('github: repository left out, its name is not owner/repo', {
        full_name: String(isRecord(repository) ? repository.full_name : repository).slice(0, 200),
      });
    }
    if (repositories.length < DISCOVERY_PAGE_SIZE) break;
  }
  return out;
}

/** GitHub's prefix of a fine-grained personal access token (its token formats page). */
const FINE_GRAINED_PREFIX = 'github_pat_';

/**
 * Whether a repository of `/user/repos` is listed hidden from new missions
 * (handbook services/github "Repositories outside the grant"). GitHub gives a
 * token no way to list the repositories it was granted, and every token reads
 * every public repository; so only a **public** repository is ever hidden:
 *   - one the user cannot push to (`permissions.push` false): no token of theirs
 *     can write it, it is in the list only because public repositories are readable;
 *   - any public one under a fine-grained token: its grant on a public repository
 *     cannot be read, and `permissions` states the user's role, not the token's.
 * A private repository is listed only when the token was granted it: never hidden.
 * The owner shows what they need; discovery never overrides that choice.
 */
function hiddenByDefault(repository: Record<string, unknown>, fineGrained: boolean): boolean {
  if (repository.private !== false) return false;
  if (fineGrained) return true;
  const permissions = repository.permissions;
  return isRecord(permissions) && permissions.push === false;
}

/** One repository of `/user/repos` as a resource, or `null` when its `full_name` is not `owner/repo`. */
function resourceOf(repository: unknown, fineGrained: boolean): Resource | null {
  if (!isRecord(repository)) return null;
  const named = repoFullName(repository.full_name);
  if (named === null) return null;
  const { default_branch: defaultBranch, private: isPrivate, archived } = repository;
  return {
    service: SERVICE_ID,
    ref: named.ref,
    displayName: named.ref,
    metadata: {
      ...(typeof defaultBranch === 'string' ? { default_branch: defaultBranch } : {}),
      ...(typeof isPrivate === 'boolean' ? { private: isPrivate } : {}),
      ...(typeof archived === 'boolean' ? { archived } : {}),
    },
    ...(hiddenByDefault(repository, fineGrained) ? { hiddenByDefault: true } : {}),
  };
}

type OctokitLog = NonNullable<ConstructorParameters<typeof Octokit>[0]>['log'];

function octokitLog(logger: PluginLogger | undefined): OctokitLog {
  const to =
    (level: 'debug' | 'info' | 'warn' | 'error') =>
    (...parts: unknown[]) => {
      if (!logger) return;
      // nosemgrep: unsafe-dynamic-method -- level is one of the four literals of the closure above
      logger[level](parts.map(String).join(' '), { source: 'octokit' });
    };
  return { debug: to('debug'), info: to('info'), warn: to('warn'), error: to('error') };
}
