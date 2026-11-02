/**
 * The permissions of a fine-grained personal access token, as GitHub's token
 * page names them, each with the tools of this plugin it serves. The one
 * declaration the connect page's guide is built from : `definePlugin` checks
 * that every tool is served by at least one of them.
 *
 * Handbook : docs/handbook/providers/github.md.
 */

import type { TokenPermission } from '@vaubaan/plugin-sdk';

import { TOOL } from './identity.ts';

export const GITHUB_TOKEN_PERMISSIONS: readonly TokenPermission[] = [
  // GitHub grants Metadata (read) to every fine-grained token by itself.
  { name: 'Metadata', access: 'read', tools: [TOOL.listTags] },
  {
    name: 'Contents',
    access: 'read-write',
    tools: [
      TOOL.listBranches,
      TOOL.listCommits,
      TOOL.getFileContents,
      TOOL.getCommit,
      TOOL.searchCode,
      TOOL.listReleases,
      TOOL.gitFetch,
      TOOL.createBranch,
      TOOL.createOrUpdateFile,
      TOOL.pushFiles,
      TOOL.deleteFile,
      TOOL.mergePullRequest,
      TOOL.createRelease,
      TOOL.deleteRelease,
      TOOL.gitPush,
    ],
  },
  {
    name: 'Pull requests',
    access: 'read-write',
    tools: [
      TOOL.listPullRequests,
      TOOL.getPullRequest,
      TOOL.createPullRequest,
      TOOL.mergePullRequest,
    ],
  },
  {
    name: 'Issues',
    access: 'read-write',
    tools: [
      TOOL.listIssues,
      TOOL.getIssue,
      TOOL.searchIssues,
      TOOL.addIssueComment,
      TOOL.addLabels,
    ],
  },
  {
    name: 'Actions',
    access: 'read',
    tools: [TOOL.listWorkflows, TOOL.listWorkflowRuns, TOOL.listWorkflowJobs, TOOL.getJobLogs],
  },
  {
    name: 'Administration',
    access: 'read-write',
    tools: [TOOL.getBranchProtection, TOOL.updateBranchProtection],
  },
  // A write under .github/workflows/ — by a file tool or a git push — needs it.
  {
    name: 'Workflows',
    access: 'read-write',
    tools: [TOOL.createOrUpdateFile, TOOL.pushFiles, TOOL.deleteFile, TOOL.gitPush],
  },
];
