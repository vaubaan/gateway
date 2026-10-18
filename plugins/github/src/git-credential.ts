/**
 * The credential of the GitHub git remote (ADR gateway-as-git-remote D10):
 * what is presented to GitHub for one repository and one access, derived in
 * memory from the connection and never returned to the agent.
 *
 *   App connection    an installation token minted for the one repository,
 *                     `contents: read` to fetch; to push `contents: write`,
 *                     with `workflows: write` when the installation holds it;
 *                     cached for the connection like the API tools' tokens.
 *                     What GitHub reports for the token is kept with it: a
 *                     push that changes `.github/workflows/` is declined by
 *                     name before its pack leaves when the token lacks
 *                     `workflows` (`admitPush`), after a fresh mint when the
 *                     grant came from the cache.
 *   token connection  the connection's token (`githubTokenOf`); its
 *                     permissions are unknown here, nothing is declined on a
 *                     guess.
 */
import {
  ExecutorRefusal,
  UpstreamHttpError,
  expectCredentialKind,
  type ExecuteContext,
  type GitAccess,
  type GitInspectedUpdate,
  type GitUpstream,
} from '@vaubaan/plugin-sdk';

import { repoFullName, type RepoTarget } from './call.ts';
import { GITHUB_WEB_BASE, installationTokenFor } from './credential.ts';
import { GIT_FETCH_TOOL, GIT_PUSH_TOOL } from './git-call.ts';
import {
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
 * that changes `.github/workflows/*` without it — and goes without otherwise.
 * Not silently: the permissions GitHub reports for the token minted say what
 * it lacks, and `admitPush` declines a push that changes a workflow by the
 * missing permission's name before its pack leaves.
 */
export const GIT_TOKEN_PERMISSIONS: Readonly<
  Record<GitAccess, readonly Readonly<Record<string, string>>[]>
> = {
  read: [gitFetchNeeds()],
  write: [gitPushNeeds([{ workflow_files: ['.github/workflows/'] }]), gitPushNeeds()],
};

/** The user name GitHub expects with an installation token over HTTP. */
const TOKEN_USER = 'x-access-token';
const MS_PER_SECOND = 1000;
const CACHE_SECONDS = 50 * 60;

/** `owner/repo` of a `/git/<owner>/<repo>` path (`.git` already removed). */
export function repositoryOf(path: string): string | null {
  return repoFullName(path)?.ref ?? null;
}

/** A credential for one repository and access, and what GitHub said it may do. */
export interface GitGrant {
  readonly token: string;
  /** The permissions GitHub reported for the token; empty when unknown (a token connection). */
  readonly permissions: Readonly<Record<string, string>>;
}

/** A grant, and whether it was served from the cache (it may predate a permission granted since). */
export interface ServedGitGrant extends GitGrant {
  readonly cached: boolean;
}

interface CachedGitGrant extends GitGrant {
  readonly expiresAt: string;
}

/** The cache key of the grant of one repository and access. */
export function gitGrantCacheKey(target: RepoTarget, access: GitAccess): string {
  return `git-token:${target.repo}:${access}`;
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
export async function gitGrant(
  ctx: ExecuteContext,
  target: RepoTarget,
  access: GitAccess,
  options: { readonly fresh?: boolean } = {},
): Promise<ServedGitGrant> {
  // A token connection (ADR token-connections-beside-the-integration-app).
  if (ctx.credential.kind === 'api-key') {
    return { token: githubTokenOf(ctx), permissions: {}, cached: false };
  }
  expectCredentialKind('github', ctx.credential, 'app-install');
  const key = gitGrantCacheKey(target, access);
  const cache = ctx.credentialCache;
  // `fresh`: the cached grant is dropped — replaced below by the one minted now.
  if (cache && options.fresh !== true) {
    const cached = await cache.get<CachedGitGrant>(key);
    if (cached && secondsLeft(cached.expiresAt) > 0) {
      return { token: cached.token, permissions: cached.permissions ?? {}, cached: true };
    }
  }
  const minted = await mintFirstHeld(ctx, target, access);
  const grant: GitGrant = { token: minted.token, permissions: minted.permissions ?? {} };
  if (cache) {
    const expiresAt = minted.expiresAt.toISOString();
    const ttl = Math.min(CACHE_SECONDS, secondsLeft(expiresAt));
    if (ttl > 0) await cache.set<CachedGitGrant>(key, { ...grant, expiresAt }, ttl);
  }
  return { ...grant, cached: false };
}

/**
 * `GitRemoteCapability.admitPush`: whether the push token can carry the
 * updates as the inspection found them — `contents: write`, and
 * `workflows: write` when an update changes `.github/workflows/` — asked
 * after the mission's precheck (so the mission's decision never depends on
 * the token) and before the pack leaves. A grant served from the cache that
 * falls short is minted afresh once: an administrator may have granted the
 * permission since. The sentence that declines the push names what is
 * missing; `null` when the token covers it, or when its permissions are
 * unknown (a token connection: nothing is declined on a guess).
 */
export async function admitPush(
  ctx: ExecuteContext,
  repository: string,
  updates: readonly GitInspectedUpdate[],
): Promise<string | null> {
  const target = targetOf(repository);
  const needs = gitPushNeeds(updates);
  let grant = await gitGrant(ctx, target, 'write');
  let missing = missingPermissionSentence(GIT_PUSH_TOOL, needs, grant.permissions);
  if (missing !== null && grant.cached) {
    grant = await gitGrant(ctx, target, 'write', { fresh: true });
    missing = missingPermissionSentence(GIT_PUSH_TOOL, needs, grant.permissions);
  }
  return missing;
}

/**
 * Mint with the first permission set of `access` the installation holds;
 * decline by name when none. A set GitHub refuses is said in the log (the
 * permission names, never a token), and the token minted reports what it
 * carries — what `admitPush` reads.
 */
async function mintFirstHeld(ctx: ExecuteContext, target: RepoTarget, access: GitAccess) {
  const sets = GIT_TOKEN_PERMISSIONS[access];
  for (const [i, permissions] of sets.entries()) {
    try {
      return await installationTokenFor(ctx, { repositories: [target.repo], permissions });
    } catch (error) {
      if (!(error instanceof UpstreamHttpError && error.status === UNPROCESSABLE)) throw error;
      if (i < sets.length - 1) {
        ctx.logger?.info('github: the installation does not hold a git token permission set', {
          repository: target.ref,
          access,
          refused: Object.keys(permissions).sort().join(','),
        });
      }
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

export function targetOf(repository: string): RepoTarget {
  const target = repoFullName(repository);
  if (target === null) throw new ExecutorRefusal(`'${repository}' is not an owner/repo name`);
  return target;
}

export async function upstream(
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
