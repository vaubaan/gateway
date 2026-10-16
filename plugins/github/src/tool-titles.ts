/**
 * What each tool of the `github` provider does, in a few words a person reads at
 * a glance (`ProviderPlugin.toolTitles`) : the head of an approval request in
 * the web interface, before the resource the call resolves to. A verb and its
 * object, sentence case, no final period. For people only : never part of
 * `tools/list`, and the host decides nothing from it.
 *
 * A structural test of the gateway checks that every tool of a shipped plugin
 * has its title : a new tool is added here with its declaration.
 */

export const githubToolTitles: Readonly<Record<string, string>> = {
  github__list_branches: 'List branches',
  github__list_commits: 'List commits',
  github__list_pull_requests: 'List pull requests',
  github__list_issues: 'List issues',
  github__get_file_contents: 'Read a file',
  github__get_pull_request: 'Read a pull request',
  github__get_issue: 'Read an issue',
  github__get_commit: 'Read a commit',
  github__search_code: 'Search code',
  github__search_issues: 'Search issues and pull requests',
  github__create_branch: 'Create a branch',
  github__create_or_update_file: 'Write a file on a branch',
  github__push_files: 'Push files to a branch',
  github__create_pull_request: 'Open a pull request',
  github__add_issue_comment: 'Comment on an issue or pull request',
  github__mint_install_token: 'Get a short-lived token for git',
  github__list_workflows: 'List workflows',
  github__list_workflow_runs: 'List workflow runs',
  github__get_branch_protection: 'Read the protection of a branch',
  github__merge_pull_request: 'Merge a pull request',
  github__delete_file: 'Delete a file on a branch',
  github__update_branch_protection: 'Change the protection of a branch',
  github__list_releases: 'List releases',
  github__list_tags: 'List tags',
  github__create_release: 'Create a release',
  github__delete_release: 'Delete a release',
  // The two tools of the git remote : never in `tools/list`, shown on approval
  // requests and in the activity.
  github__git_fetch: 'Clone or fetch with git',
  github__git_push: 'Push with git',
};
