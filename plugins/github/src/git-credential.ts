/**
 * The credential of the GitHub git remote (ADR gateway-as-git-remote D10):
 * what is presented to GitHub for one repository, derived in memory from the
 * account and never returned to the agent — the account's token
 * (`githubTokenOf`). GitHub narrows nothing further : the mission's decision
 * is what narrows a push, and the token's permissions are GitHub's to
 * enforce (a push that changes `.github/workflows/` needs `Workflows`).
 */
import { ExecutorRefusal, type ExecuteContext } from '@vaubaan/plugin-sdk';
import { type GitAccess, type GitUpstream } from '@vaubaan/plugin-sdk/git';

import { GITHUB_WEB_BASE } from './api.ts';
import { repoFullName, type RepoTarget } from './call.ts';
import { githubTokenOf } from './credential.ts';

/** The user name GitHub expects with a token over HTTP. */
const TOKEN_USER = 'x-access-token';

/** `owner/repo` of a `/git/github/<owner>/<repo>` path (provider segment and `.git` already removed). */
export function repositoryOf(path: string): string | null {
  return repoFullName(path)?.ref ?? null;
}

export function targetOf(repository: string): RepoTarget {
  const target = repoFullName(repository);
  if (target === null) throw new ExecutorRefusal(`'${repository}' is not an owner/repo name`);
  return target;
}

/** The repository's smart HTTP endpoint at GitHub and the credential to present there. */
export function upstream(
  ctx: ExecuteContext,
  repository: string,
  _access: GitAccess,
): Promise<GitUpstream> {
  const target = targetOf(repository);
  const password = githubTokenOf(ctx);
  return Promise.resolve({
    url: `${GITHUB_WEB_BASE}/${target.owner}/${target.repo}.git`,
    authorization: `Basic ${Buffer.from(`${TOKEN_USER}:${password}`).toString('base64')}`,
  });
}
