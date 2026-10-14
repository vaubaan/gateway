/**
 * The credential of the GitHub git remote (ADR gateway-as-git-remote D10):
 * what is presented to GitHub for one repository and one access, derived in
 * memory from the connection and never returned to the agent.
 *
 *   App connection    an installation token minted for the one repository,
 *                     `contents: read` to fetch; to push `contents: write`,
 *                     with `workflows: write` when the installation holds it;
 *                     cached for the connection like the API tools' tokens.
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
  type GitUpstream,
} from '@vaubaan/plugin-sdk';

import { repoFullName, type RepoTarget } from './call.ts';
import { GITHUB_WEB_BASE, installationTokenFor } from './credential.ts';
import { GIT_FETCH_TOOL, GIT_PUSH_TOOL } from './git-call.ts';
import { declineMissingPermissions, gitFetchNeeds, gitPushNeeds } from './permission-check.ts';
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
export async function gitGrant(
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
