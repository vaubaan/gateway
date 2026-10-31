/**
 * Upstream calls of the `github` provider : `execute` and `discoverResources`.
 *
 * Spec : docs/spec/vaubaan-gateway.md §2.4 — the credential arrives
 *        decrypted in the context, is used for one call, and is never
 *        returned to the executor.
 *
 * Every call sends the connection's token as the bearer and dispatches over
 * Octokit with the injected `fetch`. What the token may do is what its owner
 * ticked at GitHub, which GitHub enforces : 401 / 403 from GitHub →
 * `UpstreamAuthError`.
 */

import { Octokit } from '@octokit/rest';
import {
  ExecutorRefusal,
  UpstreamAuthError,
  declining,
  httpJson,
  isList,
  isRecord,
  jsonResult,
  type ConnectionContext,
  type ExecuteContext,
  type McpToolResult,
  type PluginLogger,
  type Resource,
} from '@vaubaan/plugin-sdk';

import { GITHUB_API_BASE, HTTP_FORBIDDEN, githubApiHeaders } from './api.ts';
import { githubRepoRefs, readGithubCall, repoFullName, type GithubCall } from './call.ts';
import { githubTokenOf } from './credential.ts';
import { isGitTool } from './git-call.ts';
import { executeGit } from './git-remote.ts';
import { PROVIDER_ID, TOOL } from './identity.ts';
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
 * Resources reachable through the connection : one `Resource` per
 * repository the token reaches (`GET /user/repos`, a bare list), paged by
 * `DISCOVERY_PAGE_SIZE` up to `DISCOVERY_MAX_PAGES`. The owner labels the
 * environment later. An answer that is not a list is GitHub's failure
 * (`UpstreamProtocolError`), not an account without repositories.
 */
export async function discoverGithubResources(
  ctx: ConnectionContext,
): Promise<readonly Resource[]> {
  const headers = githubApiHeaders(githubTokenOf(ctx));
  const out: Resource[] = [];
  for (let page = 1; page <= DISCOVERY_MAX_PAGES; page++) {
    const url = `${GITHUB_API_BASE}/user/repos?per_page=${DISCOVERY_PAGE_SIZE}&page=${page}`;
    const repositories = await httpJson(ctx, { url, headers }, isList);
    for (const repository of repositories) {
      const resource = resourceOf(repository);
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

/** One repository of `/user/repos` as a resource, or `null` when its `full_name` is not `owner/repo`. */
function resourceOf(repository: unknown): Resource | null {
  if (!isRecord(repository)) return null;
  const named = repoFullName(repository.full_name);
  if (named === null) return null;
  const { default_branch: defaultBranch, private: isPrivate, archived } = repository;
  return {
    provider: PROVIDER_ID,
    ref: named.ref,
    displayName: named.ref,
    metadata: {
      ...(typeof defaultBranch === 'string' ? { default_branch: defaultBranch } : {}),
      ...(typeof isPrivate === 'boolean' ? { private: isPrivate } : {}),
      ...(typeof archived === 'boolean' ? { archived } : {}),
    },
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
