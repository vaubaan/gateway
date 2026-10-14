/**
 * The GitHub git remote : the provider side of `https://<instance>/git/<owner>/<repo>.git`.
 *
 * Spec : docs/spec/vaubaan-gateway.md §4.1 ter "Git remote", §2.4 ;
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
  UpstreamAuthError,
  UpstreamHttpError,
  expectCredentialKind,
  type ExecuteContext,
  type GitAccess,
  type GitRefUpdate,
  type GitRemoteCapability,
  type GitReview,
  type GitReviewedUpdate,
  type GitUpdateKind,
  type GitPushResult,
  type GitUpstream,
  type McpToolResult,
} from '@vaubaan/plugin-sdk';

import { GITHUB_API_BASE, GITHUB_API_HEADERS } from './app-install.ts';
import { githubRepoRefs, isWorkflowPath, repoFullName, type RepoTarget } from './call.ts';
import { GITHUB_WEB_BASE, installationTokenFor } from './credential.ts';
import { GIT_FETCH_TOOL, GIT_PUSH_TOOL, pushedRef, readGitCall, type GitCall } from './git-call.ts';
import {
  assertGranted,
  declineMissingPermissions,
  gitFetchNeeds,
  gitPushNeeds,
  missingPermissionSentence,
} from './permission-check.ts';
import { INSTALLATION_TOKEN_EXPIRY_MARGIN_SECONDS } from './token-cache.ts';
import { githubTokenOf } from './token.ts';

/**
 * Installation-token permissions per git access, most first: the first set
 * the installation holds is minted (GitHub answers 422 to a token asking for
 * a permission the installation lacks). A push token carries
 * `workflows: write` when the installation holds it — GitHub refuses a push
 * that changes `.github/workflows/*` without it — and goes without otherwise:
 * the review then declines such a push by the missing permission's name.
 */
export const GIT_TOKEN_PERMISSIONS: Readonly<
  Record<GitAccess, readonly Readonly<Record<string, string>>[]>
> = {
  read: [gitFetchNeeds()],
  write: [gitPushNeeds([{ workflow_files: ['.github/workflows/'] }]), gitPushNeeds()],
};

/** GitHub's compare API lists at most this many files ; a longer list is truncated. */
export const COMPARE_MAX_FILES = 300;
/** GitHub's compare API lists at most this many commits. */
export const COMPARE_MAX_COMMITS = 250;

/** The user name GitHub expects with an installation token over HTTP. */
const TOKEN_USER = 'x-access-token';
const MS_PER_SECOND = 1000;
const CACHE_SECONDS = 50 * 60;

/** `owner/repo` of a `/git/<owner>/<repo>` path (`.git` already removed). */
function repositoryOf(path: string): string | null {
  return repoFullName(path)?.ref ?? null;
}

/** A credential for one repository and access, and what GitHub said it may do. */
interface GitGrant {
  readonly token: string;
  /** The permissions GitHub reported for the token; empty when unknown (a token connection). */
  readonly permissions: Readonly<Record<string, string>>;
}

interface CachedGitGrant extends GitGrant {
  readonly expiresAt: string;
}

/** GitHub's answer to a token asking for a permission the installation does not hold. */
const UNPROCESSABLE = 422;

/**
 * The credential presented to GitHub for this repository and access. An App
 * connection mints a token scoped to the repository and the access ; a token
 * connection presents its token (GitHub narrows nothing further, the
 * mission's decision is what narrows it, and its permissions are unknown
 * here: nothing is declined on a guess).
 */
async function gitGrant(
  ctx: ExecuteContext,
  target: RepoTarget,
  access: GitAccess,
): Promise<GitGrant> {
  // A token connection (ADR token-connections-beside-the-integration-app).
  if (ctx.credential.kind === 'api-key') return { token: githubTokenOf(ctx), permissions: {} };
  expectCredentialKind('github', ctx.credential, 'app-install');
  const key = `git-token:${target.repo}:${access}`;
  const cache = ctx.credentialCache;
  if (cache) {
    const cached = await cache.get<CachedGitGrant>(key);
    if (cached && secondsLeft(cached.expiresAt) > 0) {
      return { token: cached.token, permissions: cached.permissions ?? {} };
    }
  }
  const minted = await mintFirstHeld(ctx, target, access);
  const grant: GitGrant = { token: minted.token, permissions: minted.permissions ?? {} };
  if (cache) {
    const expiresAt = minted.expiresAt.toISOString();
    const ttl = Math.min(CACHE_SECONDS, secondsLeft(expiresAt));
    if (ttl > 0) await cache.set<CachedGitGrant>(key, { ...grant, expiresAt }, ttl);
  }
  return grant;
}

/** Mint with the first permission set of `access` the installation holds; decline by name when none. */
async function mintFirstHeld(ctx: ExecuteContext, target: RepoTarget, access: GitAccess) {
  const sets = GIT_TOKEN_PERMISSIONS[access];
  for (const permissions of sets) {
    try {
      return await installationTokenFor(ctx, { repositories: [target.repo], permissions });
    } catch (error) {
      if (!(error instanceof UpstreamHttpError && error.status === UNPROCESSABLE)) throw error;
    }
  }
  const tool = access === 'read' ? GIT_FETCH_TOOL : GIT_PUSH_TOOL;
  return declineMissingPermissions({ tool }, sets.at(-1) ?? {});
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
  const { token: password } = await gitGrant(ctx, target, access);
  return {
    url: `${GITHUB_WEB_BASE}/${target.owner}/${target.repo}.git`,
    authorization: `Basic ${Buffer.from(`${TOKEN_USER}:${password}`).toString('base64')}`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// GitHub's REST API, as the review and the ref moves use it
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

/** GitHub's answer to a ref write it refuses (not a fast-forward, already exists, protected). */
const UNPROCESSABLE_REF = 422;
const HTTP_NOT_FOUND = 404;
const HTTP_CONFLICT = 409;

/** `heads/feature/x` → `heads/feature/x` with every segment URL-encoded. */
function refPath(ref: string): string {
  return ref
    .replace(/^refs\//, '')
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

class GithubRest {
  private readonly tokens = new Map<GitAccess, string>();

  constructor(
    private readonly ctx: ExecuteContext,
    private readonly target: RepoTarget,
  ) {}

  private get repoPath(): string {
    return `/repos/${this.target.owner}/${this.target.repo}`;
  }

  async request(
    access: GitAccess,
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    path: string,
    body?: unknown,
  ): Promise<Response> {
    let token = this.tokens.get(access);
    if (token === undefined) {
      token = (await gitGrant(this.ctx, this.target, access)).token;
      this.tokens.set(access, token);
    }
    const res = await this.ctx.fetch(`${GITHUB_API_BASE}${this.repoPath}${path}`, {
      method,
      headers: {
        ...GITHUB_API_HEADERS,
        Authorization: `Bearer ${token}`,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
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
    const res = await this.request('read', 'GET', '');
    if (!res.ok)
      throw new UpstreamHttpError(`github GET /repos failed with HTTP ${res.status}`, res.status);
    const body = (await res.json()) as { default_branch?: unknown };
    return typeof body.default_branch === 'string' ? body.default_branch : null;
  }

  /**
   * What `ref` points at now at GitHub, or `null` when it does not exist.
   * `GET /git/ref/{ref}` answers one exact ref; anything else is "absent".
   */
  async refValue(ref: string): Promise<string | null> {
    const res = await this.request('read', 'GET', `/git/ref/${refPath(ref)}`);
    if (res.status === HTTP_NOT_FOUND || res.status === HTTP_CONFLICT) {
      // 409: an empty repository has no ref at all.
      await res.body?.cancel();
      return null;
    }
    if (!res.ok) {
      throw new UpstreamHttpError(`github GET git/ref failed with HTTP ${res.status}`, res.status);
    }
    const body = (await res.json()) as { ref?: unknown; object?: { sha?: unknown } };
    if (body.ref !== ref || typeof body.object?.sha !== 'string') return null;
    return body.object.sha;
  }

  /** `base...head` : what `head` brings since its merge base with `base`. */
  async compare(base: string, head: string, label: string): Promise<Comparison> {
    const res = await this.request(
      'read',
      'GET',
      `/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`,
    );
    if (res.status === HTTP_NOT_FOUND) {
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

/** Every change under `.github/workflows/` counts, nested or not: GitHub asks `workflows` for all of them. */
const WORKFLOW_DIRECTORY = /^\.github\/workflows\//i;

function workflowFilesOf(files: readonly string[]): string[] {
  return files.filter((path) => isWorkflowPath(path) || WORKFLOW_DIRECTORY.test(path));
}

// ─────────────────────────────────────────────────────────────────────────────
// Review — read before the decision
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The client's `old` is a claim: the ref's value at GitHub is read, and a
 * push whose `old` differs is refused (git calls it "stale info"). Otherwise
 * a client could claim a later `old` and keep out of the review the commits
 * — a workflow change, say — that lie between the real value and its claim.
 */
async function staleRef(rest: GithubRest, update: GitRefUpdate): Promise<string | null> {
  const actual = await rest.refValue(update.ref);
  if (actual === update.old) return null;
  return update.old === null
    ? `${update.ref} already exists at GitHub; fetch first, then push again`
    : `${update.ref} has moved at GitHub since your last fetch (stale info); fetch first, then push again`;
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
  // Every update is reviewed, not only the first.
  for (const update of updates) {
    const pushed = pushedRef(update.ref);
    if ('denied' in pushed) return { ok: false, reason: `${update.ref}: ${pushed.denied}` };
    const label = update.ref;
    const stale = await staleRef(rest, update);
    if (stale !== null) return { ok: false, reason: stale };
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
      workflow_files: workflowFilesOf(files),
    });
  }
  // The push token's permissions cover what these updates need — a workflow
  // file needs `workflows: write` — or the push is refused by the permission's name.
  const { permissions } = await gitGrant(ctx, target, 'write');
  const missing = missingPermissionSentence(GIT_PUSH_TOOL, gitPushNeeds(reviewed), permissions);
  if (missing !== null) return { ok: false, reason: missing };
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
  insteadOf: `${GITHUB_WEB_BASE}/`,
  abilities: [
    { risk_id: 'github.read-code', words: 'clone and fetch' },
    { risk_id: 'github.git-push', words: 'push' },
    {
      risk_id: 'github.feature-branch-write',
      words: 'push to working branches (feature/*, fix/*, chore/*, bug/*, docs/*, refactor/*)',
    },
    {
      risk_id: 'github.merge-protected',
      words: 'push to main, master, prod, production and release-* branches',
    },
    { risk_id: 'github.force-push', words: 'force-push (rewrite a branch)' },
    { risk_id: 'github.branch-delete', words: 'delete branches' },
    { risk_id: 'github.tag-write', words: 'push and delete tags' },
    {
      risk_id: 'github.workflow-write-via-file',
      words: 'change CI workflows (.github/workflows/)',
    },
  ],
};

// ─────────────────────────────────────────────────────────────────────────────
// Execute — move the real refs through the REST API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `execute` of the push tool; the arguments are the host's review. Each ref
 * moves on its own, in order, and reports on its own — like git without
 * `--atomic`:
 *
 *   create        POST   git/refs                  (GitHub refuses an existing ref)
 *   fast-forward  PATCH  git/refs/<ref> force:false (GitHub refuses a non-fast-forward)
 *   force         the ref is read again and must still be the reviewed `old`,
 *                 then PATCH force:true — only an accepted `force-push` gets here
 *   delete        the ref is read again and must still be the reviewed `old`,
 *                 then DELETE git/refs/<ref>
 */
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
  const grant = await gitGrant(ctx, call.target, 'write');
  assertGranted(GIT_PUSH_TOOL, gitPushNeeds(call.updates.map((u) => u.update)), grant.permissions);
  const rest = new GithubRest(ctx, call.target);
  const updates: GitPushResult['updates'][number][] = [];
  for (const { update } of call.updates) {
    updates.push({ ref: update.ref, ...(await moveRef(rest, update)) });
  }
  return {
    content: [{ type: 'text', text: JSON.stringify({ updates }) }],
    ...(updates.some((u) => !u.ok) ? { isError: true } : {}),
  };
}

type MoveOutcome = { readonly ok: true } | { readonly ok: false; readonly error: string };

async function moveRef(rest: GithubRest, update: GitReviewedUpdate): Promise<MoveOutcome> {
  if (update.ref.startsWith(GIT_TEMPORARY_REF_PREFIX)) {
    return { ok: false, error: `'${GIT_TEMPORARY_REF_PREFIX}' is reserved by the gateway` };
  }
  const path = `/git/refs/${refPath(update.ref)}`;
  let res: Response;
  switch (update.kind) {
    case 'create':
      res = await rest.request('write', 'POST', '/git/refs', {
        ref: update.ref,
        sha: update.new,
      });
      break;
    case 'fast-forward':
      res = await rest.request('write', 'PATCH', path, { sha: update.new, force: false });
      break;
    case 'force':
    case 'delete': {
      // No compare-and-swap in the API: the ref is read again, right before.
      if ((await rest.refValue(update.ref)) !== update.old) {
        return { ok: false, error: 'stale info: the ref moved at GitHub during the review' };
      }
      res =
        update.kind === 'force'
          ? await rest.request('write', 'PATCH', path, { sha: update.new, force: true })
          : await rest.request('write', 'DELETE', path);
      break;
    }
  }
  if (res.ok) {
    await res.body?.cancel();
    return { ok: true };
  }
  return { ok: false, error: await refusalOfRefWrite(res, update) };
}

/** GitHub's reason for a refused ref write, in the words git prints. */
async function refusalOfRefWrite(res: Response, update: GitReviewedUpdate): Promise<string> {
  let message = '';
  try {
    const body = (await res.json()) as { message?: unknown };
    message = typeof body.message === 'string' ? body.message : '';
  } catch {
    message = '';
  }
  if (res.status === UNPROCESSABLE_REF && update.kind === 'fast-forward') {
    return `non-fast-forward (GitHub: ${message || 'Update is not a fast forward'}); fetch first`;
  }
  if (res.status >= 500) {
    throw new UpstreamHttpError(`github ref write failed with HTTP ${res.status}`, res.status);
  }
  return `GitHub refused the update (HTTP ${res.status}${message ? `: ${message}` : ''})`;
}
