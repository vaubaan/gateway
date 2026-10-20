/**
 * The permissions of a fine-grained personal access token, as GitHub's token
 * page names them, each with the tools of this plugin it serves. The one
 * declaration the connect page's guide is built from : `definePlugin` checks
 * that every tool is served by at least one of them.
 *
 * Handbook : docs/handbook/providers/github.md.
 */

import type { TokenPermission } from '@vaubaan/plugin-sdk';

export const GITHUB_TOKEN_PERMISSIONS: readonly TokenPermission[] = [
  // GitHub grants Metadata (read) to every fine-grained token by itself.
  { name: 'Metadata', access: 'read', tools: ['github__list_tags'] },
  {
    name: 'Contents',
    access: 'read-write',
    tools: [
      'github__list_branches',
      'github__list_commits',
      'github__get_file_contents',
      'github__get_commit',
      'github__search_code',
      'github__list_releases',
      'github__git_fetch',
      'github__create_branch',
      'github__create_or_update_file',
      'github__push_files',
      'github__delete_file',
      'github__merge_pull_request',
      'github__create_release',
      'github__delete_release',
      'github__git_push',
    ],
  },
  {
    name: 'Pull requests',
    access: 'read-write',
    tools: [
      'github__list_pull_requests',
      'github__get_pull_request',
      'github__create_pull_request',
      'github__merge_pull_request',
    ],
  },
  {
    name: 'Issues',
    access: 'read-write',
    tools: [
      'github__list_issues',
      'github__get_issue',
      'github__search_issues',
      'github__add_issue_comment',
    ],
  },
  {
    name: 'Actions',
    access: 'read',
    tools: [
      'github__list_workflows',
      'github__list_workflow_runs',
      'github__list_workflow_jobs',
      'github__get_job_logs',
    ],
  },
  {
    name: 'Administration',
    access: 'read-write',
    tools: ['github__get_branch_protection', 'github__update_branch_protection'],
  },
  // A write under .github/workflows/ — by a file tool or a git push — needs it.
  {
    name: 'Workflows',
    access: 'read-write',
    tools: [
      'github__create_or_update_file',
      'github__push_files',
      'github__delete_file',
      'github__git_push',
    ],
  },
];
