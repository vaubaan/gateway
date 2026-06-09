/**
 * GitHub classifier — maps a concrete (tool, args) call to the capability it
 * requires, in GitHub-native semantics.
 *
 * Spec : docs/spec/gateway-capability-model.md §3, §6.
 *
 * GitHub exposes the `repo` plane with the following ladder (interne → externe) :
 *
 *   niv1 `code`   — files, commits, branches, PRs, issues
 *   niv2 `ci`     — workflows (.github/workflows/*.yml), Actions config
 *   niv3 `rules`  — branch protection, required reviews, merge rules
 *   niv4 `access` — repo, collaborators, install tokens, secrets
 *
 * Env on the `code` level = the branch (decision #5 : the branch *is* the env).
 * `code:write@main` ≡ merge / canonical write ; `code:write@<feature>` ≡ propose.
 * Reads and meta operations are env-less.
 */

import type { Capability, ProviderBinding } from '@vaubaan/shared';
import type { ClassifyResult } from './adapter.ts';

type Kind =
  | 'read-code'
  | 'write-code'
  | 'write-code-branch' // env = args.branch
  | 'write-code-head' // env = args.head (PR creation)
  | 'merge-pr' // env = 'main' (default protected branch)
  | 'global-read';

/** Repo-scoped tools (need owner/repo bound to the project). */
const TOOL_KIND: Record<string, Kind> = {
  github__list_branches: 'read-code',
  github__list_commits: 'read-code',
  github__list_pull_requests: 'read-code',
  github__list_issues: 'read-code',
  github__get_file_contents: 'read-code',
  github__get_pull_request: 'read-code',
  github__get_issue: 'read-code',
  github__get_commit: 'read-code',
  github__add_issue_comment: 'write-code',
  github__create_branch: 'write-code-branch',
  github__create_or_update_file: 'write-code-branch',
  github__push_files: 'write-code-branch',
  github__delete_file: 'write-code-branch',
  github__create_pull_request: 'write-code-head',
  github__merge_pull_request: 'merge-pr',
};

/** Global (not repo-scoped) reads. */
const GLOBAL_READ = new Set(['github__search_code', 'github__search_issues']);

const MINT_TOOL = 'github__mint_install_token';

function cap(level: string, action: 'read' | 'write', env?: string): Capability {
  return env
    ? { provider: 'github', plane: 'repo', level, action, env }
    : { provider: 'github', plane: 'repo', level, action };
}

/** Env-less capability surface of a tool — used by the static tools/list filter. */
export function githubToolCapabilities(tool: string): readonly Capability[] {
  if (tool === MINT_TOOL) {
    // Two possible capabilities depending on `purpose` — clone or push.
    return [cap('access', 'read'), cap('code', 'write')];
  }
  if (GLOBAL_READ.has(tool)) return [cap('code', 'read')];
  const kind = TOOL_KIND[tool];
  if (!kind) return [];
  switch (kind) {
    case 'read-code':
      return [cap('code', 'read')];
    case 'write-code':
    case 'write-code-branch':
    case 'write-code-head':
    case 'merge-pr':
      return [cap('code', 'write')];
    case 'global-read':
      return [cap('code', 'read')];
  }
}

function boundRepos(bindings: ReadonlyArray<ProviderBinding>): string[] {
  return bindings.filter((b) => b.provider === 'github').map((b) => b.resource_ref);
}

function strArg(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

export function classifyGithub(
  tool: string,
  args: Record<string, unknown>,
  bindings: ReadonlyArray<ProviderBinding>,
): ClassifyResult {
  const repos = boundRepos(bindings);

  // Mint install token — classified by the power the minted credential grants
  // (clone = read code, push = write code). Env-less : the minted token can
  // touch any branch the App is installed on, so the *grant* is a fan-out and
  // its sensitivity is decided by the policy layer (cf. spec §5.1).
  if (tool === MINT_TOOL) {
    const purpose = args.purpose;
    if (purpose !== 'clone' && purpose !== 'push') {
      return { denied: `${MINT_TOOL} requires purpose 'clone' or 'push'.` };
    }
    const repo = strArg(args, 'repoFullName');
    if (repo && !repos.includes(repo)) {
      return { denied: `repo '${repo}' is not bound to this project.` };
    }
    return { capability: purpose === 'clone' ? cap('access', 'read') : cap('code', 'write') };
  }

  // Global searches — not repo-scoped.
  if (GLOBAL_READ.has(tool)) return { capability: cap('code', 'read') };

  const kind = TOOL_KIND[tool];
  if (!kind) return { denied: `unknown github tool '${tool}'.` };

  const owner = strArg(args, 'owner');
  const repo = strArg(args, 'repo');
  if (!owner || !repo) {
    return { denied: `tool '${tool}' requires string 'owner' and 'repo'.` };
  }
  const ref = `${owner}/${repo}`;
  if (!repos.includes(ref)) {
    return { denied: `repo '${ref}' is not bound to this project.` };
  }

  switch (kind) {
    case 'read-code':
      return { capability: cap('code', 'read') };
    case 'write-code':
      return { capability: cap('code', 'write') };
    case 'write-code-branch': {
      const branch = strArg(args, 'branch');
      return { capability: cap('code', 'write', branch) };
    }
    case 'write-code-head': {
      const head = strArg(args, 'head');
      return { capability: cap('code', 'write', head) };
    }
    case 'merge-pr':
      // The base branch isn't always in args ; assume the default protected branch.
      // The policy layer gates `write@main` strictly (human-gated by default).
      return { capability: cap('code', 'write', strArg(args, 'base') ?? 'main') };
    case 'global-read':
      return { capability: cap('code', 'read') };
  }
}
