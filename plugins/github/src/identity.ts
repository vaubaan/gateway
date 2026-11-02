/**
 * Identity of the `github` provider — the one place its id and its tool
 * names are written.
 *
 * Handbook : docs/handbook/providers/github.md ; guide : plugins/README.md, step 1.
 *
 * `PROVIDER_ID` is also written as `provider:` and as the prefix of every id
 * in `risk-catalog.yaml`, and in the package name. Everything else — the
 * plugin id, the data-model provider, the tool names, the resources
 * discovery returns, the credential kind check — is derived from this module.
 */

/** The provider id. */
export const PROVIDER_ID = 'github';

/**
 * `github__`, prepended to every tool name : what `toolPrefixFor(PROVIDER_ID)`
 * writes (a test holds the two equal). Spelled as a template so that each
 * name of `TOOL` keeps its literal type : the tool is the discriminant of a
 * checked call (`call.ts`, `git-call.ts`), and a `string` would discriminate
 * nothing.
 */
export const TOOL_PREFIX = `${PROVIDER_ID}__` as const;

/**
 * The tool names : the 28 MCP tools in the order `tools.ts` declares them,
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
  searchCode: `${TOOL_PREFIX}search_code`,
  searchIssues: `${TOOL_PREFIX}search_issues`,
  createBranch: `${TOOL_PREFIX}create_branch`,
  createOrUpdateFile: `${TOOL_PREFIX}create_or_update_file`,
  pushFiles: `${TOOL_PREFIX}push_files`,
  createPullRequest: `${TOOL_PREFIX}create_pull_request`,
  addIssueComment: `${TOOL_PREFIX}add_issue_comment`,
  addLabels: `${TOOL_PREFIX}add_labels`,
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
 * Tools retired by the risk-model spec §7.2 #1 : declared nowhere, and
 * refused by name if a client still calls them.
 */
export const RETIRED_TOOL = {
  dispatchWorkflow: `${TOOL_PREFIX}dispatch_workflow`,
  cancelWorkflowRun: `${TOOL_PREFIX}cancel_workflow_run`,
  rerunWorkflowRun: `${TOOL_PREFIX}rerun_workflow_run`,
} as const;
