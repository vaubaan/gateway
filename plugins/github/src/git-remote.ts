/**
 * The GitHub git remote : the provider side of `https://<instance>/git/<owner>/<repo>.git`.
 *
 * Spec : docs/spec/vaubaan-gateway.md §4.1 bis "Git remote", §2.4 ;
 *        docs/spec/gateway-risk-model.md §7.
 * ADR  : docs/decisions/gateway-as-git-remote.md.
 * Handbook : docs/handbook/git-remote.md, docs/handbook/providers/github.md.
 *
 * What the host asks of this plugin (`GitRemoteCapability`) :
 *
 *   upstream   the repository's smart HTTP endpoint at GitHub and the HTTP
 *              credential to present there, derived in memory from the
 *              connection : an installation token minted from the company's
 *              App, scoped to the one repository and to `contents:read`
 *              (read) or `contents:write` + `workflows:write` (write), cached
 *              for the connection like the per-call tokens of the API tools ;
 *              or the connection's own token when it is a token connection.
 *   review     for each ref of a push, read from GitHub's compare API once the
 *              pack is stored there under a temporary ref : fast-forward or
 *              not, how many commits, which files, which are workflow files.
 *              GitHub lists at most 300 files and 250 commits per comparison ;
 *              beyond that the push cannot be reviewed and is refused.
 *   execute    of `github__git_push` : the reviewed updates sent to GitHub's
 *              receive-pack as a command list with an empty pack, the
 *              reviewed `old` ids as compare-and-swap values, atomically
 *              when GitHub advertises it.
 *
 * `github__git_fetch` is never executed here : the host relays the bytes.
 */

import {
  ExecutorRefusal,
  GIT_TEMPORARY_REF_PREFIX,
  RECEIVE_PACK_SERVICE,
  UpstreamAuthError,
  UpstreamHttpError,
  advertisementType,
  expectCredentialKind,
  parseAdvertisement,
  sendRefUpdates,
  type ExecuteContext,
  type GitAccess,
  type GitRefUpdate,
  type GitRemoteCapability,
  type GitReview,
  type GitReviewedUpdate,
  type GitUpdateKind,
  type GitUpstream,
  type McpToolResult,
} from '@vaubaan/plugin-sdk';

import { GITHUB_API_BASE, GITHUB_API_HEADERS } from './app-install.ts';
import { githubRepoRefs, isWorkflowPath, repoFullName, type RepoTarget } from './call.ts';
import { GITHUB_WEB_BASE, installationTokenFor } from './credential.ts';
import { GIT_FETCH_TOOL, GIT_PUSH_TOOL, pushedRef, readGitCall, type GitCall } from './git-call.ts';
import { INSTALLATION_TOKEN_EXPIRY_MARGIN_SECONDS } from './token-cache.ts';

/** Installation-token permissions per git access. */
export const GIT_TOKEN_PERMISSIONS: Readonly<Record<GitAccess, Readonly<Record<string, string>>>> =
  {
    read: { contents: 'read' },
    // A push that adds or changes `.github/workflows/*` is refused by GitHub
    // without `workflows: write` ; the App itself must hold that permission.
    write: { contents: 'write', workflows: 'write' },
  };

/** GitHub's compare API lists at most this many files ; a longer list is truncated. */
export const COMPARE_MAX_FILES = 300;
/** GitHub's compare API lists at most this many commits. */
export const COMPARE_MAX_COMMITS = 250;

/** The user name GitHub expects with an installation token over HTTP. */
const TOKEN_USER = 'x-access-token';
/** The credential field of a token connection (the `api-key` kind). */
export const TOKEN_CONNECTION_FIELD = 'token';
const GIT_AGENT = 'vaubaan-gateway';
const MS_PER_SECOND = 1000;
const CACHE_SECONDS = 50 * 60;

/** `owner/repo` of a `/git/<owner>/<repo>` path (`.git` already removed). */
function repositoryOf(path: string): string | null {
  return repoFullName(path)?.ref ?? null;
}

interface CachedGitToken {
  readonly token: string;
  readonly expiresAt: string;
}

/**
 * The secret presented to GitHub for this repository and access. An App
 * connection mints a token scoped to the repository and the access ; a
 * token connection presents its token (GitHub narrows nothing further, the
 * mission's decision is what narrows it).
 */
async function gitPassword(
  ctx: ExecuteContext,
  target: RepoTarget,
  access: GitAccess,
): Promise<string> {
  if (ctx.credential.kind === 'api-key') {
    const token = ctx.credential.fields[TOKEN_CONNECTION_FIELD];
    if (typeof token !== 'string' || token.length === 0) {
      throw new ExecutorRefusal('this GitHub account holds no token the git remote can use');
    }
    return token;
  }
  expectCredentialKind('github', ctx.credential, 'app-install');
  const key = `git-token:${target.repo}:${access}`;
  const cache = ctx.credentialCache;
  if (cache) {
    const cached = await cache.get<CachedGitToken>(key);
    if (cached && secondsLeft(cached.expiresAt) > 0) return cached.token;
  }
  const minted = await installationTokenFor(ctx, {
    repositories: [target.repo],
    permissions: GIT_TOKEN_PERMISSIONS[access],
  });
  if (cache) {
    const expiresAt = minted.expiresAt.toISOString();
    const ttl = Math.min(CACHE_SECONDS, secondsLeft(expiresAt));
    if (ttl > 0) await cache.set<CachedGitToken>(key, { token: minted.token, expiresAt }, ttl);
  }
  return minted.token;
}

function secondsLeft(expiresAt: string): number {
  const at = Date.parse(expiresAt);
  if (!Number.isFinite(at)) return 0;
  return Math.floor((at - Date.now()) / MS_PER_SECOND) - INSTALLATION_TOKEN_EXPIRY_MARGIN_SECONDS;
}

function targetOf(repository: string): RepoTarget {
  const target = repoFullName(repository);
  if (target === null) throw new ExecutorRefusal(`'${repository}' is not an owner/repo name`);
  return target;
}

async function upstream(
  ctx: ExecuteContext,
  repository: string,
  access: GitAccess,
): Promise<GitUpstream> {
  const target = targetOf(repository);
  const password = await gitPassword(ctx, target, access);
  return {
    url: `${GITHUB_WEB_BASE}/${target.owner}/${target.repo}.git`,
    authorization: `Basic ${Buffer.from(`${TOKEN_USER}:${password}`).toString('base64')}`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Review — GitHub's compare API, read before the decision
// ─────────────────────────────────────────────────────────────────────────────

interface CompareFile {
  readonly filename?: string;
  readonly previous_filename?: string;
}

interface CompareDto {
  readonly status?: string;
  readonly ahead_by?: number;
  readonly total_commits?: number;
  readonly files?: readonly CompareFile[];
}

type Comparison =
  | {
      readonly ok: true;
      readonly status: string;
      readonly commits: number;
      readonly files: readonly string[];
    }
  | { readonly ok: false; readonly reason: string };

class GithubRest {
  private token: string | null = null;

  constructor(
    private readonly ctx: ExecuteContext,
    private readonly target: RepoTarget,
  ) {}

  async get(path: string): Promise<Response> {
    this.token ??= await gitPassword(this.ctx, this.target, 'read');
    const res = await this.ctx.fetch(`${GITHUB_API_BASE}${path}`, {
      method: 'GET',
      headers: { ...GITHUB_API_HEADERS, Authorization: `Bearer ${this.token}` },
      ...(this.ctx.signal ? { signal: this.ctx.signal } : {}),
    });
    if (res.status === 401) {
      await res.body?.cancel();
      throw new UpstreamAuthError('github rejected the credential (HTTP 401)', 401);
    }
    return res;
  }

  /** The repository's default branch, or `null` for an empty repository. */
  async defaultBranch(): Promise<string | null> {
    const res = await this.get(`/repos/${this.target.owner}/${this.target.repo}`);
    if (!res.ok)
      throw new UpstreamHttpError(`github GET /repos failed with HTTP ${res.status}`, res.status);
    const body = (await res.json()) as { default_branch?: unknown };
    return typeof body.default_branch === 'string' ? body.default_branch : null;
  }

  /** `base...head` : what `head` brings since its merge base with `base`. */
  async compare(base: string, head: string, label: string): Promise<Comparison> {
    const path = `/repos/${this.target.owner}/${this.target.repo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`;
    const res = await this.get(path);
    if (res.status === 404) {
      await res.body?.cancel();
      return {
        ok: false,
        reason: `${label} cannot be reviewed: it has no history in common with ${shortName(base)}`,
      };
    }
    if (!res.ok) {
      throw new UpstreamHttpError(`github compare failed with HTTP ${res.status}`, res.status);
    }
    const body = (await res.json()) as CompareDto;
    const files = body.files ?? [];
    const commits = body.total_commits ?? body.ahead_by ?? 0;
    if (files.length >= COMPARE_MAX_FILES || commits > COMPARE_MAX_COMMITS) {
      return {
        ok: false,
        reason: `${label} is too large to review (${files.length >= COMPARE_MAX_FILES ? `${COMPARE_MAX_FILES} or more files` : `more than ${COMPARE_MAX_COMMITS} commits`}); push it in smaller parts`,
      };
    }
    const names = new Set<string>();
    for (const f of files) {
      if (typeof f.filename === 'string') names.add(f.filename);
      if (typeof f.previous_filename === 'string') names.add(f.previous_filename);
    }
    return {
      ok: true,
      status: body.status ?? 'unknown',
      commits: body.ahead_by ?? commits,
      files: [...names],
    };
  }
}

function shortName(ref: string): string {
  return /^[0-9a-f]{40}$/.test(ref) ? ref.slice(0, 12) : ref;
}

async function review(
  ctx: ExecuteContext,
  repository: string,
  updates: readonly GitRefUpdate[],
): Promise<GitReview> {
  const target = targetOf(repository);
  const rest = new GithubRest(ctx, target);
  let defaultBranch: string | null | undefined;
  const reviewed: GitReviewedUpdate[] = [];
  for (const update of updates) {
    const pushed = pushedRef(update.ref);
    if ('denied' in pushed) return { ok: false, reason: `${update.ref}: ${pushed.denied}` };
    const label = update.ref;
    if (update.new === null) {
      reviewed.push({ ...update, kind: 'delete', commits: 0, files: [], workflow_files: [] });
      continue;
    }
    let comparisons: Comparison[];
    let kind: GitUpdateKind;
    if (update.old === null) {
      defaultBranch ??= await rest.defaultBranch();
      if (defaultBranch === null) {
        return {
          ok: false,
          reason: `${label} cannot be reviewed: the repository has no default branch to compare it with`,
        };
      }
      comparisons = [await rest.compare(defaultBranch, update.new, label)];
      kind = 'create';
    } else {
      const forward = await rest.compare(update.old, update.new, label);
      const fastForward =
        forward.ok &&
        pushed.refKind === 'branch' &&
        (forward.status === 'ahead' || forward.status === 'identical');
      kind = fastForward ? 'fast-forward' : 'force';
      // A rewrite can also take back what the old history had : both sides count.
      comparisons = fastForward
        ? [forward]
        : [forward, await rest.compare(update.new, update.old, label)];
    }
    const failed = comparisons.find((c): c is Extract<Comparison, { ok: false }> => !c.ok);
    if (failed) return { ok: false, reason: failed.reason };
    const ok = comparisons as Extract<Comparison, { ok: true }>[];
    const files = [...new Set(ok.flatMap((c) => c.files))].sort();
    reviewed.push({
      ...update,
      kind,
      commits: ok[0]?.commits ?? 0,
      files,
      workflow_files: files.filter((path) => isWorkflowPath(path)),
    });
  }
  return { ok: true, updates: reviewed };
}

function compareUrl(repository: string, update: GitReviewedUpdate): string | null {
  const target = repoFullName(repository);
  if (target === null || update.new === null) return null;
  const base = `${GITHUB_WEB_BASE}/${target.owner}/${target.repo}`;
  if (update.old === null) return `${base}/compare/${update.new}`;
  return `${base}/compare/${update.old}...${update.new}`;
}

export const githubGitRemote: GitRemoteCapability = {
  fetchTool: GIT_FETCH_TOOL,
  pushTool: GIT_PUSH_TOOL,
  repositoryOf,
  upstream,
  review,
  compareUrl,
};

// ─────────────────────────────────────────────────────────────────────────────
// Execute — move the real refs
// ─────────────────────────────────────────────────────────────────────────────

/** `execute` of the two git tools ; the arguments are the host's review. */
export async function executeGit(
  ctx: ExecuteContext,
  tool: GitCall['tool'],
  args: Readonly<Record<string, unknown>>,
): Promise<McpToolResult> {
  const call = readGitCall(tool, args, githubRepoRefs(ctx.resources));
  if ('denied' in call) throw new ExecutorRefusal(`${tool}: ${call.denied}`);
  if (call.tool === GIT_FETCH_TOOL) {
    throw new ExecutorRefusal(
      `${GIT_FETCH_TOOL} is relayed by the gateway's git remote, never executed`,
    );
  }
  const remote = await upstream(ctx, call.target.ref, 'write');
  const atomic = await advertisesAtomic(ctx, remote);
  const commands = call.updates.map(({ update }) => ({
    old: update.old,
    new: update.new,
    ref: update.ref,
  }));
  if (commands.some((c) => c.ref.startsWith(GIT_TEMPORARY_REF_PREFIX))) {
    throw new ExecutorRefusal(`'${GIT_TEMPORARY_REF_PREFIX}' is reserved by the gateway`);
  }
  const sent = await sendRefUpdates({
    fetch: ctx.fetch,
    upstream: remote,
    commands,
    atomic,
    agent: GIT_AGENT,
    ...(ctx.signal ? { signal: ctx.signal } : {}),
  });
  if (sent.status === 401) {
    throw new UpstreamAuthError('github rejected the credential (HTTP 401)', 401);
  }
  if (sent.report === null) {
    throw new UpstreamHttpError(`github receive-pack answered HTTP ${sent.status}`, sent.status);
  }
  const { report } = sent;
  const unpackFailed = report.unpack !== 'ok';
  const updates = commands.map((c) => {
    const status = report.refs.get(c.ref);
    if (unpackFailed) return { ref: c.ref, ok: false, error: `unpack ${report.unpack}` };
    if (!status) return { ref: c.ref, ok: false, error: 'github reported nothing for this ref' };
    return status.ok ? { ref: c.ref, ok: true } : { ref: c.ref, ok: false, error: status.error };
  });
  return {
    content: [{ type: 'text', text: JSON.stringify({ updates }) }],
    ...(updates.some((u) => !u.ok) ? { isError: true } : {}),
  };
}

/** Does GitHub's receive-pack offer `atomic` for this repository? */
async function advertisesAtomic(ctx: ExecuteContext, remote: GitUpstream): Promise<boolean> {
  const res = await ctx.fetch(`${remote.url}/info/refs?service=${RECEIVE_PACK_SERVICE}`, {
    method: 'GET',
    headers: {
      Authorization: remote.authorization,
      Accept: advertisementType(RECEIVE_PACK_SERVICE),
    },
    ...(ctx.signal ? { signal: ctx.signal } : {}),
  });
  if (res.status === 401) {
    await res.body?.cancel();
    throw new UpstreamAuthError('github rejected the credential (HTTP 401)', 401);
  }
  if (!res.ok) {
    await res.body?.cancel();
    throw new UpstreamHttpError(
      `github receive-pack advertisement answered HTTP ${res.status}`,
      res.status,
    );
  }
  const ad = parseAdvertisement(new Uint8Array(await res.arrayBuffer()));
  return ad.capabilities.includes('atomic');
}
