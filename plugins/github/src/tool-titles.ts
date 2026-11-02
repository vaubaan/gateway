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

import { TOOL } from './identity.ts';

export const githubToolTitles: Readonly<Record<string, string>> = {
  [TOOL.listBranches]: 'List branches',
  [TOOL.listCommits]: 'List commits',
  [TOOL.listPullRequests]: 'List pull requests',
  [TOOL.listIssues]: 'List issues',
  [TOOL.getFileContents]: 'Read a file',
  [TOOL.getPullRequest]: 'Read a pull request',
  [TOOL.getIssue]: 'Read an issue',
  [TOOL.getCommit]: 'Read a commit',
  [TOOL.searchCode]: 'Search code',
  [TOOL.searchIssues]: 'Search issues and pull requests',
  [TOOL.createBranch]: 'Create a branch',
  [TOOL.createOrUpdateFile]: 'Write a file on a branch',
  [TOOL.pushFiles]: 'Push files to a branch',
  [TOOL.createPullRequest]: 'Open a pull request',
  [TOOL.addIssueComment]: 'Comment on an issue or pull request',
  [TOOL.addLabels]: 'Add labels to an issue or pull request',
  [TOOL.listWorkflows]: 'List workflows',
  [TOOL.listWorkflowRuns]: 'List workflow runs',
  [TOOL.listWorkflowJobs]: 'List the jobs of a workflow run',
  [TOOL.getJobLogs]: 'Read the log of a workflow job',
  [TOOL.getBranchProtection]: 'Read the protection of a branch',
  [TOOL.mergePullRequest]: 'Merge a pull request',
  [TOOL.deleteFile]: 'Delete a file on a branch',
  [TOOL.updateBranchProtection]: 'Change the protection of a branch',
  [TOOL.listReleases]: 'List releases',
  [TOOL.listTags]: 'List tags',
  [TOOL.createRelease]: 'Create a release',
  [TOOL.deleteRelease]: 'Delete a release',
  // The two tools of the git remote : never in `tools/list`, shown on approval
  // requests and in the activity.
  [TOOL.gitFetch]: 'Clone or fetch with git',
  [TOOL.gitPush]: 'Push with git',
};
