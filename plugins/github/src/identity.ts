/**
 * Identity of the `github` service — the one place its id and its tool
 * names are written.
 *
 * Handbook : docs/handbook/services/github.md ; guide : plugins/README.md, step 1.
 *
 * `SERVICE_ID` is also written as `service:` and as the prefix of every id
 * in `risk-catalog.yaml`, and in the package name. Everything else — the
 * plugin id, the data-model service, the tool names, the resources
 * discovery returns, the credential kind check — is derived from this module.
 */

/** The service id. */
export const SERVICE_ID = 'github';

/**
 * `github__`, prepended to every tool name : what `toolPrefixFor(SERVICE_ID)`
 * writes (a test holds the two equal). Spelled as a template so that each
 * name of `TOOL` keeps its literal type : the tool is the discriminant of a
 * checked call (`call.ts`, `git-call.ts`), and a `string` would discriminate
 * nothing.
 */
export const TOOL_PREFIX = `${SERVICE_ID}__` as const;

/**
 * The tool names : the 34 MCP tools in the order `tools.ts` declares them,
 * then the git remote's two, which are never in `tools/list` (the host's git
 * door calls them, spec §4.1 ter).
 */
export const TOOL = {
  listBranches: `${TOOL_PREFIX}list_branches`,
  listCommits: `${TOOL_PREFIX}list_commits`,
  listPullRequests: `${TOOL_PREFIX}list_pull_requests`,
  listIssues: `${TOOL_PREFIX}list_issues`,
  getFileContents: `${TOOL_PREFIX}get_file_contents`,
  getPullRequest: `${TOOL_PREFIX}get_pull_request`,
  getIssue: `${TOOL_PREFIX}get_issue`,
  getCommit: `${TOOL_PREFIX}get_commit`,
  getIssueComments: `${TOOL_PREFIX}get_issue_comments`,
  getPullRequestReviews: `${TOOL_PREFIX}get_pull_request_reviews`,
  getPullRequestComments: `${TOOL_PREFIX}get_pull_request_comments`,
  getPullRequestFiles: `${TOOL_PREFIX}get_pull_request_files`,
  searchCode: `${TOOL_PREFIX}search_code`,
  searchIssues: `${TOOL_PREFIX}search_issues`,
  createBranch: `${TOOL_PREFIX}create_branch`,
  createOrUpdateFile: `${TOOL_PREFIX}create_or_update_file`,
  pushFiles: `${TOOL_PREFIX}push_files`,
  createPullRequest: `${TOOL_PREFIX}create_pull_request`,
  addIssueComment: `${TOOL_PREFIX}add_issue_comment`,
  replyToPullRequestComment: `${TOOL_PREFIX}reply_to_pull_request_comment`,
  addLabels: `${TOOL_PREFIX}add_labels`,
  updateIssue: `${TOOL_PREFIX}update_issue`,
  listWorkflows: `${TOOL_PREFIX}list_workflows`,
  listWorkflowRuns: `${TOOL_PREFIX}list_workflow_runs`,
  listWorkflowJobs: `${TOOL_PREFIX}list_workflow_jobs`,
  getJobLogs: `${TOOL_PREFIX}get_job_logs`,
  getBranchProtection: `${TOOL_PREFIX}get_branch_protection`,
  mergePullRequest: `${TOOL_PREFIX}merge_pull_request`,
  deleteFile: `${TOOL_PREFIX}delete_file`,
  updateBranchProtection: `${TOOL_PREFIX}update_branch_protection`,
  listReleases: `${TOOL_PREFIX}list_releases`,
  listTags: `${TOOL_PREFIX}list_tags`,
  createRelease: `${TOOL_PREFIX}create_release`,
  deleteRelease: `${TOOL_PREFIX}delete_release`,
  gitFetch: `${TOOL_PREFIX}git_fetch`,
  gitPush: `${TOOL_PREFIX}git_push`,
} as const;

/**
 * Tools of GitHub the plugin deliberately leaves out (risk-model spec §7.2 #1),
 * each with the sentence its public page shows : declared nowhere, refused by
 * name if a client still calls them (`call.ts`), and the plugin's
 * `excludedTools`.
 */
export const EXCLUDED_TOOLS: Readonly<Record<string, string>> = {
  [`${TOOL_PREFIX}dispatch_workflow`]:
    "Dispatching a workflow runs whatever it does with the repository's secrets; deployments go through the tools of the service that hosts the service.",
  [`${TOOL_PREFIX}cancel_workflow_run`]:
    'Cancelling a run stops checks or a deployment a person started; nothing an agent needs to do its work.',
  [`${TOOL_PREFIX}rerun_workflow_run`]:
    "Re-running a run executes it again with the repository's secrets, which is a dispatch by another name.",
};
