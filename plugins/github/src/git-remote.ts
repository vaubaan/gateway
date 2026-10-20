/**
 * The GitHub git remote : the provider side of `https://<instance>/git/<owner>/<repo>.git`.
 *
 * Spec : docs/spec/vaubaan-gateway.md §4.1 ter "Git remote", §2.4 ;
 *        docs/spec/gateway-risk-model.md §7.
 * ADR  : docs/decisions/gateway-as-git-remote.md.
 * Handbook : docs/handbook/git-remote.md, docs/handbook/providers/github.md.
 *
 * What the host asks of this plugin (`GitRemoteCapability`), module by module :
 *
 *   upstream   git-credential.ts  the repository's smart HTTP endpoint and the
 *                                 credential to present there, in memory
 *   inspect    git-inspect.ts     whether each update's tip changes the CI
 *                                 workflows, before the pack leaves the gateway
 *   review     git-review.ts      what each ref update brings, read at GitHub
 *   execute    git-moves.ts       the reviewed refs moved, each reported
 *   REST       git-rest.ts        the reads and writes both of them use
 *
 * `github__git_fetch` is never executed here : the host relays the bytes.
 */
import type { GitRemoteCapability, RiskCatalog } from '@vaubaan/plugin-sdk';

import { GITHUB_WEB_BASE } from './api.ts';
import { GIT_FETCH_TOOL, GIT_PUSH_TOOL } from './git-call.ts';
import { repositoryOf, upstream } from './git-credential.ts';
import { inspectPack } from './git-inspect.ts';
import { compareUrl, review } from './git-review.ts';

export { COMPARE_MAX_COMMITS, COMPARE_MAX_FILES } from './git-rest.ts';
export { COMMITS_REVIEWED_MAX } from './git-review.ts';
export { executeGit } from './git-moves.ts';

/** The risk a push to a working branch touches ; its catalog patterns name the branches. */
const WORKING_BRANCH_RISK = 'github.feature-branch-write';

/** The branch write of a pattern (`….branch[feature/*,fix/*].W`), capturing its bracket list. */
const BRANCH_WRITE = /\.branch\[([^\]]+)\]\.W$/;

/**
 * The working-branch globs, read from the catalog's `feature-branch-write`
 * pattern : the YAML holds the one list, the git remote's words never restate
 * it. Throws at boot when the entry or its branch-write pattern is missing.
 */
export function workingBranchesOf(catalog: RiskCatalog): readonly string[] {
  const entry = catalog.risks.find((risk) => risk.id === WORKING_BRANCH_RISK);
  const patterns: readonly string[] = entry === undefined ? [] : [entry.matches].flat();
  for (const pattern of patterns) {
    const list = BRANCH_WRITE.exec(pattern)?.[1];
    if (list !== undefined) return list.split(',');
  }
  throw new Error(`${WORKING_BRANCH_RISK}: no 'branch[…].W' pattern in the github catalog`);
}

/** The plugin's git remote, its words built from `catalog`. */
export const githubGitRemoteOf = (catalog: RiskCatalog): GitRemoteCapability => ({
  fetchTool: GIT_FETCH_TOOL,
  pushTool: GIT_PUSH_TOOL,
  pushRisk: 'github.git-push',
  repositoryOf,
  upstream,
  inspectPack,
  review,
  compareUrl,
  insteadOf: `${GITHUB_WEB_BASE}/`,
  abilities: [
    { risk_id: 'github.read-code', words: 'clone and fetch' },
    { risk_id: 'github.git-push', words: 'push' },
    {
      risk_id: WORKING_BRANCH_RISK,
      words: `push to working branches (${workingBranchesOf(catalog).join(', ')})`,
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
});
