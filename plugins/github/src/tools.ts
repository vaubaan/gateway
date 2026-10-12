/**
 * GitHub MCP tools — subset of the official GitHub MCP server exposed by Vaubaan.
 *
 * Spec : docs/spec/vaubaan-gateway.md §5.2, §16.2.
 * ADR  : docs/decisions/dispatch-upstream-option-a-synthese.md.
 *
 * Naming convention `github__<verb>_<noun>` matches the official MCP server.
 * 17 tools — the strict subset relevant for coding agents.
 */

import type { McpToolDeclaration } from '@vaubaan/shared';

const repoArgs = {
  owner: { type: 'string', description: 'Repository owner (user or org).' },
  repo: { type: 'string', description: 'Repository name.' },
};

export const availableTools: readonly McpToolDeclaration[] = [
  // Read - list
  {
    name: 'github__list_branches',
    description: 'List branches of a repository.',
    inputSchema: { type: 'object', properties: { ...repoArgs }, required: ['owner', 'repo'] },
  },
  {
    name: 'github__list_commits',
    description: 'List commits on a branch / ref.',
    inputSchema: {
      type: 'object',
      properties: { ...repoArgs, sha: { type: 'string' }, per_page: { type: 'number' } },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'github__list_pull_requests',
    description: 'List pull requests on a repository.',
    inputSchema: {
      type: 'object',
      properties: { ...repoArgs, state: { type: 'string', enum: ['open', 'closed', 'all'] } },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'github__list_issues',
    description: 'List issues on a repository.',
    inputSchema: {
      type: 'object',
      properties: { ...repoArgs, state: { type: 'string', enum: ['open', 'closed', 'all'] } },
      required: ['owner', 'repo'],
    },
  },
  // Read - get
  {
    name: 'github__get_file_contents',
    description: 'Get the contents of a file at a ref.',
    inputSchema: {
      type: 'object',
      properties: { ...repoArgs, path: { type: 'string' }, ref: { type: 'string' } },
      required: ['owner', 'repo', 'path'],
    },
  },
  {
    name: 'github__get_pull_request',
    description: 'Get a single pull request.',
    inputSchema: {
      type: 'object',
      properties: { ...repoArgs, pull_number: { type: 'number' } },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
  {
    name: 'github__get_issue',
    description: 'Get a single issue.',
    inputSchema: {
      type: 'object',
      properties: { ...repoArgs, issue_number: { type: 'number' } },
      required: ['owner', 'repo', 'issue_number'],
    },
  },
  {
    name: 'github__get_commit',
    description: 'Get a single commit by SHA.',
    inputSchema: {
      type: 'object',
      properties: { ...repoArgs, sha: { type: 'string' } },
      required: ['owner', 'repo', 'sha'],
    },
  },
  // Search
  {
    name: 'github__search_code',
    description: 'Search code with a GitHub search query.',
    inputSchema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
  },
  {
    name: 'github__search_issues',
    description: 'Search issues and pull requests.',
    inputSchema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
  },
  // Write - branches
  {
    name: 'github__create_branch',
    description: 'Create a branch from a base ref.',
    inputSchema: {
      type: 'object',
      properties: {
        ...repoArgs,
        branch: { type: 'string', description: 'New branch name.' },
        from_branch: { type: 'string', description: 'Base branch (defaults to repo default).' },
      },
      required: ['owner', 'repo', 'branch'],
    },
  },
  // Write - files
  {
    name: 'github__create_or_update_file',
    description: 'Create or update a single file in a branch.',
    inputSchema: {
      type: 'object',
      properties: {
        ...repoArgs,
        path: { type: 'string' },
        content: { type: 'string', description: 'UTF-8 file content.' },
        message: { type: 'string', description: 'Commit message.' },
        branch: { type: 'string' },
        sha: { type: 'string', description: 'Existing blob SHA (required to update).' },
      },
      required: ['owner', 'repo', 'path', 'content', 'message', 'branch'],
    },
  },
  {
    name: 'github__push_files',
    description: 'Push multiple files in one commit to a branch.',
    inputSchema: {
      type: 'object',
      properties: {
        ...repoArgs,
        branch: { type: 'string' },
        message: { type: 'string' },
        files: {
          type: 'array',
          items: {
            type: 'object',
            properties: { path: { type: 'string' }, content: { type: 'string' } },
            required: ['path', 'content'],
          },
        },
      },
      required: ['owner', 'repo', 'branch', 'message', 'files'],
    },
  },
  // Write - pull requests
  {
    name: 'github__create_pull_request',
    description: 'Open a pull request from head to base.',
    inputSchema: {
      type: 'object',
      properties: {
        ...repoArgs,
        title: { type: 'string' },
        body: { type: 'string' },
        head: { type: 'string' },
        base: { type: 'string' },
        draft: { type: 'boolean' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'github__add_issue_comment',
    description: 'Add a comment on an issue or pull request.',
    inputSchema: {
      type: 'object',
      properties: {
        ...repoArgs,
        issue_number: { type: 'number' },
        body: { type: 'string' },
      },
      required: ['owner', 'repo', 'issue_number', 'body'],
    },
  },
  // Mint install token — kills host-side git creds for callers needing
  // ephemeral GitHub App credentials (clone, push).
  {
    name: 'github__mint_install_token',
    description:
      'Mint a short-lived (1h) GitHub App installation token scoped to the project repos. Used for clone or push flows; the caller role pins the purpose. ADR mint-install-token-credential.',
    inputSchema: {
      type: 'object',
      properties: {
        repoFullName: {
          type: 'string',
          description:
            "Optional `<owner>/<repo>` — must be in the project's github bindings. Omit to scope the token to every github binding of the project.",
        },
        purpose: {
          type: 'string',
          enum: ['clone', 'push'],
          description:
            '`clone` → contents:read only. `push` → contents:write + pull_requests:write + metadata:read.',
        },
      },
      required: ['purpose'],
    },
  },
  // Read - ci (workflows + their runs)
  {
    name: 'github__list_workflows',
    description: 'List the workflows defined under .github/workflows on the repository.',
    inputSchema: { type: 'object', properties: { ...repoArgs }, required: ['owner', 'repo'] },
  },
  {
    name: 'github__list_workflow_runs',
    description:
      'List recent workflow runs on the repository (optionally filtered by branch or workflow id).',
    inputSchema: {
      type: 'object',
      properties: {
        ...repoArgs,
        branch: { type: 'string', description: 'Filter to runs on this branch.' },
        workflow_id: {
          type: ['string', 'number'],
          description: 'Filter to runs of a specific workflow (numeric id or filename slug).',
        },
        per_page: { type: 'number' },
      },
      required: ['owner', 'repo'],
    },
  },
  // Read - rules (branch protection)
  {
    name: 'github__get_branch_protection',
    description:
      'Get the protection rules for a branch (required reviewers, status checks, restrictions).',
    inputSchema: {
      type: 'object',
      properties: { ...repoArgs, branch: { type: 'string', description: 'Branch name.' } },
      required: ['owner', 'repo', 'branch'],
    },
  },
  // Dangerous — not granted by any builtin role (default-deny applies).
  {
    name: 'github__merge_pull_request',
    description: 'Merge a pull request. Requires a custom role; no builtin grants it.',
    inputSchema: {
      type: 'object',
      properties: {
        ...repoArgs,
        pull_number: { type: 'number' },
        merge_method: { type: 'string', enum: ['merge', 'squash', 'rebase'] },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
  {
    name: 'github__delete_file',
    description: 'Delete a file in a branch. Typically denied by github:developer.',
    inputSchema: {
      type: 'object',
      properties: {
        ...repoArgs,
        path: { type: 'string' },
        message: { type: 'string' },
        branch: { type: 'string' },
        sha: { type: 'string' },
      },
      required: ['owner', 'repo', 'path', 'message', 'branch', 'sha'],
    },
  },
  // Write - rules (branch protection)
  {
    name: 'github__update_branch_protection',
    description:
      'Set/replace branch protection rules. Backed by PUT /repos/{owner}/{repo}/branches/{branch}/protection. `required_status_checks`, `required_pull_request_reviews`, `enforce_admins`, `restrictions` follow the GitHub REST shape. Pass `null` for any top-level field to disable it.',
    inputSchema: {
      type: 'object',
      properties: {
        ...repoArgs,
        branch: { type: 'string', description: 'Branch to protect (e.g. `main`).' },
        required_status_checks: {
          type: ['object', 'null'],
          description: '{ strict: bool, contexts: string[] } — null to clear.',
        },
        enforce_admins: {
          type: ['boolean', 'null'],
          description: 'Apply rules to admins. Null to clear.',
        },
        required_pull_request_reviews: {
          type: ['object', 'null'],
          description:
            '{ dismissal_restrictions, dismiss_stale_reviews, required_approving_review_count, … }',
        },
        restrictions: {
          type: ['object', 'null'],
          description: '{ users: string[], teams: string[], apps: string[] }',
        },
        required_linear_history: { type: 'boolean' },
        allow_force_pushes: { type: ['boolean', 'null'] },
        allow_deletions: { type: 'boolean' },
        required_conversation_resolution: { type: 'boolean' },
      },
      required: ['owner', 'repo', 'branch'],
    },
  },
  // Read - releases & tags (sit on the code level — they reference commits/tags)
  {
    name: 'github__list_releases',
    description: 'List releases on a repository. Backed by GET /repos/{owner}/{repo}/releases.',
    inputSchema: {
      type: 'object',
      properties: { ...repoArgs, per_page: { type: 'number' } },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'github__list_tags',
    description: 'List tags on a repository. Backed by GET /repos/{owner}/{repo}/tags.',
    inputSchema: {
      type: 'object',
      properties: { ...repoArgs, per_page: { type: 'number' } },
      required: ['owner', 'repo'],
    },
  },
  // Write - releases (create a tag + a release record)
  {
    name: 'github__create_release',
    description:
      'Create a new release on a tag (creates the tag if needed). Backed by POST /repos/{owner}/{repo}/releases.',
    inputSchema: {
      type: 'object',
      properties: {
        ...repoArgs,
        tag_name: { type: 'string', description: 'Tag name (e.g. `v1.2.3`).' },
        target_commitish: {
          type: 'string',
          description: 'Branch or commit SHA to tag — defaults to the repo default branch.',
        },
        name: { type: 'string', description: 'Release display name.' },
        body: { type: 'string', description: 'Release notes (Markdown).' },
        draft: { type: 'boolean' },
        prerelease: { type: 'boolean' },
        generate_release_notes: { type: 'boolean' },
      },
      required: ['owner', 'repo', 'tag_name'],
    },
  },
  {
    name: 'github__delete_release',
    description:
      'Delete a release (does not delete the underlying tag). Backed by DELETE /repos/{owner}/{repo}/releases/{release_id}.',
    inputSchema: {
      type: 'object',
      properties: { ...repoArgs, release_id: { type: 'number' } },
      required: ['owner', 'repo', 'release_id'],
    },
  },
];
