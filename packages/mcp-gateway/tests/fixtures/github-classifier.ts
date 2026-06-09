/**
 * Mock GitHub classifier for the gateway tests.
 *
 * Mirrors packages/providers/github/src/classify.ts so the gateway tests can
 * exercise the capability model without depending on the real provider package.
 * Keep this in sync with the reference classifier — it implements the same
 * native-semantics mapping on the `repo` plane (provider=github, plane=repo,
 * level=code|access, action=read|write, env=branch on writes) and the same
 * binding enforcement (owner/repo must be bound to the project).
 *
 * NB: includes the fictional `github__list_repos` tool the gateway tests use
 * as a convenient read example — the real classifier doesn't expose it.
 */

import type { Capability, ProviderBinding } from '@vaubaan/shared';
import type { ClassifyResult } from '../../src/gateway.ts';

type Kind = 'read-code' | 'write-code' | 'write-code-branch' | 'write-code-head' | 'merge-pr';

const TOOL_KIND: Record<string, Kind> = {
  github__list_repos: 'read-code',
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

const GLOBAL_READ = new Set(['github__search_code', 'github__search_issues']);

function cap(level: string, action: 'read' | 'write', env?: string): Capability {
  return env
    ? { provider: 'github', plane: 'repo', level, action, env }
    : { provider: 'github', plane: 'repo', level, action };
}

/** Env-less capability surface of a tool, for static tools/list filtering. */
export function mockGithubToolCapabilities(tool: string): readonly Capability[] {
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
  }
}

function boundRepos(bindings: ReadonlyArray<ProviderBinding>): string[] {
  return bindings.filter((b) => b.provider === 'github').map((b) => b.resource_ref);
}

function strArg(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

export function mockClassifyGithub(
  tool: string,
  args: Record<string, unknown>,
  bindings: ReadonlyArray<ProviderBinding>,
): ClassifyResult {
  const repos = boundRepos(bindings);

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
      return { capability: cap('code', 'write', strArg(args, 'base') ?? 'main') };
  }
}
