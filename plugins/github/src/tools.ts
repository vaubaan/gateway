/**
 * MCP tools of the `github` service — the subset of the official GitHub
 * MCP server a coding agent needs, synthesised over the REST API.
 *
 * Naming : `github__<verb>_<noun>`, as the official server. Every
 * repository-scoped tool takes `owner` + `repo` explicitly ; the classifier
 * checks `owner/repo` against the mission's resources.
 *
 * Retired tools (risk-model spec §7.2 #1) : `dispatch_workflow`,
 * `cancel_workflow_run`, `rerun_workflow_run` — not declared, and refused
 * by the classifier if a client still names them.
 */

import type { McpToolDeclaration } from '@vaubaan/plugin-sdk';

import {
  MAX_ISSUE_BODY_LENGTH,
  MAX_ISSUE_TITLE_LENGTH,
  MAX_ISSUE_TYPE_LENGTH,
  MAX_LABEL_LENGTH,
  MAX_LABELS_PER_CALL,
} from './call.ts';
import { TOOL } from './identity.ts';

const repoArgs = {
  owner: { type: 'string', description: 'Repository owner (user or org).' },
  repo: { type: 'string', description: 'Repository name.' },
};

export const githubTools: readonly McpToolDeclaration[] = [
  // Read - list
  {
    name: TOOL.listBranches,
    description: 'List branches of a repository.',
    inputSchema: { type: 'object', properties: { ...repoArgs }, required: ['owner', 'repo'] },
  },
  {
    name: TOOL.listCommits,
    description: 'List commits on a branch / ref.',
    inputSchema: {
      type: 'object',
      properties: { ...repoArgs, sha: { type: 'string' }, per_page: { type: 'number' } },
      required: ['owner', 'repo'],
    },
  },
  {
    name: TOOL.listPullRequests,
    description: 'List pull requests on a repository.',
    inputSchema: {
      type: 'object',
      properties: { ...repoArgs, state: { type: 'string', enum: ['open', 'closed', 'all'] } },
      required: ['owner', 'repo'],
    },
  },
  {
    name: TOOL.listIssues,
    description: 'List issues on a repository.',
    inputSchema: {
      type: 'object',
      properties: { ...repoArgs, state: { type: 'string', enum: ['open', 'closed', 'all'] } },
      required: ['owner', 'repo'],
    },
  },
  // Read - get
  {
    name: TOOL.getFileContents,
    description: 'Get the contents of a file at a ref.',
    inputSchema: {
      type: 'object',
      properties: { ...repoArgs, path: { type: 'string' }, ref: { type: 'string' } },
      required: ['owner', 'repo', 'path'],
    },
  },
  {
    name: TOOL.getPullRequest,
    description: 'Get a single pull request.',
    inputSchema: {
      type: 'object',
      properties: { ...repoArgs, pull_number: { type: 'number' } },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
  {
    name: TOOL.getIssue,
    description: 'Get a single issue.',
    inputSchema: {
      type: 'object',
      properties: { ...repoArgs, issue_number: { type: 'number' } },
      required: ['owner', 'repo', 'issue_number'],
    },
  },
  {
    name: TOOL.getCommit,
    description: 'Get a single commit by SHA.',
    inputSchema: {
      type: 'object',
      properties: { ...repoArgs, sha: { type: 'string' } },
      required: ['owner', 'repo', 'sha'],
    },
  },
  // Search — account-shaped : not bounded to the mission resources (risk `github.search-global`).
  {
    name: TOOL.searchCode,
    description: 'Search code with a GitHub search query.',
    inputSchema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
  },
  {
    name: TOOL.searchIssues,
    description: 'Search issues and pull requests.',
    inputSchema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
  },
  // Write - branches
  {
    name: TOOL.createBranch,
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
    name: TOOL.createOrUpdateFile,
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
    name: TOOL.pushFiles,
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
  // Write - pull requests, comments, labels
  {
    name: TOOL.createPullRequest,
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
    name: TOOL.addIssueComment,
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
  {
    name: TOOL.addLabels,
    description:
      "Add labels to an issue or pull request (a pull request's number is an issue number). A label the repository does not have is created. Returns the names of every label the issue now carries.",
    inputSchema: {
      type: 'object',
      properties: {
        ...repoArgs,
        issue_number: { type: 'number' },
        labels: {
          type: 'array',
          items: { type: 'string', minLength: 1, maxLength: MAX_LABEL_LENGTH },
          minItems: 1,
          maxItems: MAX_LABELS_PER_CALL,
          description: `1 to ${MAX_LABELS_PER_CALL} label names, each at most ${MAX_LABEL_LENGTH} characters; blanks around a name are trimmed.`,
        },
      },
      required: ['owner', 'repo', 'issue_number', 'labels'],
    },
  },
  {
    name: TOOL.updateIssue,
    description:
      "Edit the title, the body or the type of an issue. An absent field is left unchanged; an empty body clears the description; type null removes the issue's type. Returns the issue as it now reads, type included: GitHub drops a type change silently when the token's user lacks push access.",
    inputSchema: {
      type: 'object',
      properties: {
        ...repoArgs,
        issue_number: { type: 'number' },
        title: {
          type: 'string',
          minLength: 1,
          maxLength: MAX_ISSUE_TITLE_LENGTH,
          description: `The new title, at most ${MAX_ISSUE_TITLE_LENGTH} characters; blanks around it are trimmed.`,
        },
        body: {
          type: 'string',
          maxLength: MAX_ISSUE_BODY_LENGTH,
          description: 'The new body (Markdown), replacing the whole description.',
        },
        type: {
          type: ['string', 'null'],
          maxLength: MAX_ISSUE_TYPE_LENGTH,
          description:
            "An issue type of the repository's organization, by name (e.g. Bug, Task); null removes the type.",
        },
      },
      required: ['owner', 'repo', 'issue_number'],
    },
  },
  // Read - ci (workflows + their runs)
  {
    name: TOOL.listWorkflows,
    description: 'List the workflows defined under .github/workflows on the repository.',
    inputSchema: { type: 'object', properties: { ...repoArgs }, required: ['owner', 'repo'] },
  },
  {
    name: TOOL.listWorkflowRuns,
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
  {
    name: TOOL.listWorkflowJobs,
    description: `List the jobs of a workflow run: name, status, conclusion, steps with their conclusions, html_url, started and completed times. Pass a job \`id\` to \`${TOOL.getJobLogs}\`.`,
    inputSchema: {
      type: 'object',
      properties: {
        ...repoArgs,
        run_id: { type: 'number', description: 'The workflow run id (from `list_workflow_runs`).' },
        filter: {
          type: 'string',
          enum: ['latest', 'all'],
          description: 'Jobs of the latest attempt of the run (default) or of every attempt.',
        },
        per_page: { type: 'number' },
      },
      required: ['owner', 'repo', 'run_id'],
    },
  },
  {
    name: TOOL.getJobLogs,
    description:
      'Read the log of one workflow job as plain text, bounded: at most `max_bytes` (default 65536, at most 1048576). With `tail: true` the end of the log is kept, where a failure usually is. The answer says when the log was truncated.',
    inputSchema: {
      type: 'object',
      properties: {
        ...repoArgs,
        job_id: { type: 'number', description: 'The job id (from `list_workflow_jobs`).' },
        max_bytes: {
          type: 'number',
          description: 'Most bytes of the log returned (default 65536, at most 1048576).',
        },
        tail: {
          type: 'boolean',
          description: 'Keep the end of the log instead of its beginning (default false).',
        },
      },
      required: ['owner', 'repo', 'job_id'],
    },
  },
  // Read - rules (branch protection)
  {
    name: TOOL.getBranchProtection,
    description:
      'Get the protection rules for a branch (required reviewers, status checks, restrictions).',
    inputSchema: {
      type: 'object',
      properties: { ...repoArgs, branch: { type: 'string', description: 'Branch name.' } },
      required: ['owner', 'repo', 'branch'],
    },
  },
  // Write - merge (touches `github.merge-protected` when the base is a protected branch)
  {
    name: TOOL.mergePullRequest,
    description:
      'Merge a pull request. Pass `base`, the base branch of the pull request : the call is classified on it and refused when the pull request targets another branch ; defaults to `main`.',
    inputSchema: {
      type: 'object',
      properties: {
        ...repoArgs,
        pull_number: { type: 'number' },
        base: { type: 'string', description: 'Base branch of the PR (defaults to `main`).' },
        merge_method: { type: 'string', enum: ['merge', 'squash', 'rebase'] },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
  {
    name: TOOL.deleteFile,
    description: 'Delete a file in a branch.',
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
    name: TOOL.updateBranchProtection,
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
  // Read - releases & tags
  {
    name: TOOL.listReleases,
    description: 'List releases on a repository. Backed by GET /repos/{owner}/{repo}/releases.',
    inputSchema: {
      type: 'object',
      properties: { ...repoArgs, per_page: { type: 'number' } },
      required: ['owner', 'repo'],
    },
  },
  {
    name: TOOL.listTags,
    description: 'List tags on a repository. Backed by GET /repos/{owner}/{repo}/tags.',
    inputSchema: {
      type: 'object',
      properties: { ...repoArgs, per_page: { type: 'number' } },
      required: ['owner', 'repo'],
    },
  },
  // Write - releases (create a tag + a release record)
  {
    name: TOOL.createRelease,
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
    name: TOOL.deleteRelease,
    description:
      'Delete a release (does not delete the underlying tag). Backed by DELETE /repos/{owner}/{repo}/releases/{release_id}.',
    inputSchema: {
      type: 'object',
      properties: { ...repoArgs, release_id: { type: 'number' } },
      required: ['owner', 'repo', 'release_id'],
    },
  },
];
