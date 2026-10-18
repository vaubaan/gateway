/**
 * Tool → REST call dispatcher of the `github` provider, over Octokit.
 *
 * Each tool name in `tools.ts` maps to one Octokit call (or a short
 * sequence for `create_branch` and `push_files`, which the REST API has no
 * one-shot endpoint for). The result is the raw Octokit `data` payload.
 *
 * The dispatcher takes the `GithubCall` the classifier was given
 * (`call.ts`) : every identifier that reaches a request path, a query string
 * or a ref — repository, branch, path, revision, number — comes from the
 * call, checked by its grammar, never from the raw arguments. `args` only
 * supplies what is neither classified nor an identifier : contents, titles,
 * messages, flags, page sizes.
 *
 * The Octokit instance is built by the caller (`execute.ts` injects
 * `ctx.fetch` and `ctx.signal`), so this module never touches the global
 * fetch.
 */

import type { Octokit as OctokitType } from '@octokit/rest';
import { ExecutorRefusal } from '@vaubaan/plugin-sdk';

import { branchName, type GithubCall, type MINT_TOOL, type RepoCall } from './call.ts';

export type OctokitLike = Pick<OctokitType, 'rest' | 'request'>;

/**
 * Every call but the credential mint and the job log, which `execute.ts`
 * answers itself (the log is a redirect to a download, read bounded :
 * `job-logs.ts`).
 */
export type DispatchedCall = Exclude<
  GithubCall,
  { tool: typeof MINT_TOOL } | { tool: 'github__get_job_logs' }
>;

type Args = Readonly<Record<string, unknown>>;

const perPageOf = (args: Args): number | undefined =>
  typeof args.per_page === 'number' ? args.per_page : undefined;

export async function dispatchGithubTool(
  octokit: OctokitLike,
  call: DispatchedCall,
  args: Args,
): Promise<unknown> {
  // Account-shaped : `q` is the whole request, sent in the query string.
  if (!('target' in call)) {
    const q = args.q as string;
    const { data } =
      call.tool === 'github__search_code'
        ? await octokit.rest.search.code({ q })
        : await octokit.rest.search.issuesAndPullRequests({ q });
    return data;
  }
  const repo = { owner: call.target.owner, repo: call.target.repo } as const;
  switch (call.tool) {
    case 'github__list_branches': {
      const { data } = await octokit.rest.repos.listBranches({ ...repo });
      return data;
    }
    case 'github__list_commits': {
      const { data } = await octokit.rest.repos.listCommits({
        ...repo,
        sha: call.sha,
        per_page: perPageOf(args),
      });
      return data;
    }
    case 'github__list_pull_requests': {
      const { data } = await octokit.rest.pulls.list({
        ...repo,
        state: (args.state as 'open' | 'closed' | 'all') ?? 'open',
      });
      return data;
    }
    case 'github__list_issues': {
      const { data } = await octokit.rest.issues.listForRepo({
        ...repo,
        state: (args.state as 'open' | 'closed' | 'all') ?? 'open',
      });
      return data;
    }
    case 'github__get_file_contents': {
      const { data } = await octokit.rest.repos.getContent({
        ...repo,
        path: call.path,
        ref: call.ref,
      });
      return data;
    }
    case 'github__get_pull_request': {
      const { data } = await octokit.rest.pulls.get({ ...repo, pull_number: call.pullNumber });
      return data;
    }
    case 'github__get_issue': {
      const { data } = await octokit.rest.issues.get({ ...repo, issue_number: call.issueNumber });
      return data;
    }
    case 'github__get_commit': {
      const { data } = await octokit.rest.repos.getCommit({ ...repo, ref: call.sha });
      return data;
    }
    case 'github__create_branch': {
      // No one-shot create_branch : resolve the base ref SHA, then create a new ref.
      const baseBranch = call.fromBranch ?? (await defaultBranchOf(octokit, call));
      const baseRef = await octokit.rest.git.getRef({ ...repo, ref: `heads/${baseBranch}` });
      const { data } = await octokit.rest.git.createRef({
        ...repo,
        ref: `refs/heads/${call.branch}`,
        sha: baseRef.data.object.sha,
      });
      return data;
    }
    case 'github__create_or_update_file': {
      const { data } = await octokit.rest.repos.createOrUpdateFileContents({
        ...repo,
        path: call.path,
        message: args.message as string,
        content: Buffer.from(args.content as string, 'utf8').toString('base64'),
        branch: call.branch,
        sha: args.sha as string | undefined,
      });
      return data;
    }
    case 'github__push_files': {
      const { branch, files } = call;
      const message = args.message as string;
      const ref = await octokit.rest.git.getRef({ ...repo, ref: `heads/${branch}` });
      const headSha = ref.data.object.sha;
      const baseCommit = await octokit.rest.git.getCommit({ ...repo, commit_sha: headSha });
      const blobs = await Promise.all(
        files.map((f) =>
          octokit.rest.git.createBlob({
            ...repo,
            content: Buffer.from(f.content, 'utf8').toString('base64'),
            encoding: 'base64',
          }),
        ),
      );
      const tree = await octokit.rest.git.createTree({
        ...repo,
        base_tree: baseCommit.data.tree.sha,
        tree: files.map((f, i) => ({
          path: f.path,
          mode: '100644',
          type: 'blob',
          sha: blobs[i]!.data.sha,
        })),
      });
      const commit = await octokit.rest.git.createCommit({
        ...repo,
        message,
        tree: tree.data.sha,
        parents: [headSha],
      });
      await octokit.rest.git.updateRef({
        ...repo,
        ref: `heads/${branch}`,
        sha: commit.data.sha,
      });
      return { commit_sha: commit.data.sha, branch };
    }
    case 'github__create_pull_request': {
      const { data } = await octokit.rest.pulls.create({
        ...repo,
        title: args.title as string,
        body: args.body as string | undefined,
        head: call.head,
        base: call.base,
        draft: (args.draft as boolean | undefined) ?? false,
      });
      return data;
    }
    case 'github__add_issue_comment': {
      const { data } = await octokit.rest.issues.createComment({
        ...repo,
        issue_number: call.issueNumber,
        body: args.body as string,
      });
      return data;
    }
    case 'github__merge_pull_request': {
      await assertPullRequestTargetsDeclaredBase(octokit, call);
      const { data } = await octokit.rest.pulls.merge({
        ...repo,
        pull_number: call.pullNumber,
        merge_method: (args.merge_method as 'merge' | 'squash' | 'rebase' | undefined) ?? 'merge',
      });
      return data;
    }
    case 'github__delete_file': {
      const { data } = await octokit.rest.repos.deleteFile({
        ...repo,
        path: call.path,
        message: args.message as string,
        branch: call.branch,
        sha: args.sha as string,
      });
      return data;
    }
    case 'github__list_workflows': {
      const { data } = await octokit.rest.actions.listRepoWorkflows({ ...repo });
      return data;
    }
    case 'github__list_workflow_runs': {
      const { workflowId, branch } = call;
      if (workflowId !== undefined) {
        const { data } = await octokit.rest.actions.listWorkflowRuns({
          ...repo,
          workflow_id: workflowId,
          branch,
          per_page: perPageOf(args),
        });
        return data;
      }
      const { data } = await octokit.rest.actions.listWorkflowRunsForRepo({
        ...repo,
        branch,
        per_page: perPageOf(args),
      });
      return data;
    }
    case 'github__list_workflow_jobs': {
      const { data } = await octokit.rest.actions.listJobsForWorkflowRun({
        ...repo,
        run_id: call.runId,
        filter: call.filter,
        per_page: perPageOf(args),
      });
      return jobListing(data);
    }
    case 'github__get_branch_protection': {
      const { data } = await octokit.rest.repos.getBranchProtection({
        ...repo,
        branch: call.branch,
      });
      return data;
    }
    case 'github__update_branch_protection': {
      const { data } = await octokit.rest.repos.updateBranchProtection({
        ...repo,
        branch: call.branch,
        required_status_checks: args.required_status_checks as never,
        enforce_admins: args.enforce_admins as never,
        required_pull_request_reviews: args.required_pull_request_reviews as never,
        restrictions: args.restrictions as never,
        required_linear_history: args.required_linear_history as boolean | undefined,
        allow_force_pushes: args.allow_force_pushes as boolean | undefined,
        allow_deletions: args.allow_deletions as boolean | undefined,
        required_conversation_resolution: args.required_conversation_resolution as
          | boolean
          | undefined,
      });
      return data;
    }
    case 'github__list_releases': {
      const { data } = await octokit.rest.repos.listReleases({
        ...repo,
        per_page: perPageOf(args),
      });
      return data;
    }
    case 'github__list_tags': {
      const { data } = await octokit.rest.repos.listTags({ ...repo, per_page: perPageOf(args) });
      return data;
    }
    case 'github__create_release': {
      const { data } = await octokit.rest.repos.createRelease({
        ...repo,
        tag_name: call.tagName,
        target_commitish: call.targetCommitish,
        name: args.name as string | undefined,
        body: args.body as string | undefined,
        draft: args.draft as boolean | undefined,
        prerelease: args.prerelease as boolean | undefined,
        generate_release_notes: args.generate_release_notes as boolean | undefined,
      });
      return data;
    }
    case 'github__delete_release': {
      await octokit.rest.repos.deleteRelease({ ...repo, release_id: call.releaseId });
      return { deleted: true, release_id: call.releaseId };
    }
  }
}

/**
 * The default branch of the repository, for a `create_branch` that names no
 * base. GitHub's answer lands in a request path like an argument would, so
 * it goes through the same grammar.
 */
async function defaultBranchOf(octokit: OctokitLike, call: RepoCall): Promise<string> {
  const { data } = await octokit.rest.repos.get({
    owner: call.target.owner,
    repo: call.target.repo,
  });
  const branch = branchName(data.default_branch);
  if (branch === null) {
    throw new Error(
      `${call.tool}: the default branch GitHub answered for ${call.target.ref} is not a branch name; nothing created. Name the base with 'from_branch'.`,
    );
  }
  return branch;
}

/**
 * `merge_pull_request` is classified on the base branch the caller declares
 * (`call.base`), and GitHub's merge endpoint takes no base : it merges into
 * the pull request's own. Read the pull request first and refuse the merge
 * unless the two agree, so a declared `feature/x` can never merge into `main`
 * under the risks of a feature branch.
 */
async function assertPullRequestTargetsDeclaredBase(
  octokit: OctokitLike,
  call: Extract<RepoCall, { tool: 'github__merge_pull_request' }>,
): Promise<void> {
  const { pullNumber, base: declared } = call;
  const pull = await octokit.rest.pulls.get({
    owner: call.target.owner,
    repo: call.target.repo,
    pull_number: pullNumber,
  });
  const actual = baseRefOf(pull.data);
  if (actual === undefined) {
    throw new Error(
      `github__merge_pull_request: could not read the base branch of pull request #${pullNumber}; not merged.`,
    );
  }
  if (actual !== declared) {
    // Declined, not failed : the pull request is not the one the call was classified on.
    throw new ExecutorRefusal(
      `github__merge_pull_request: pull request #${pullNumber} targets '${actual}', not the declared base '${declared}'. Call again with base '${actual}'.`,
    );
  }
}

/** `base.ref` of a pull-request payload, when it is there as a non-empty string. */
function baseRefOf(pull: unknown): string | undefined {
  if (pull === null || typeof pull !== 'object' || !('base' in pull)) return undefined;
  const base: unknown = pull.base;
  if (base === null || typeof base !== 'object' || !('ref' in base)) return undefined;
  const ref: unknown = base.ref;
  return typeof ref === 'string' && ref.length > 0 ? ref : undefined;
}

/** A step of a job, as `list_workflow_jobs` answers it. */
interface JobStepSummary {
  readonly number: unknown;
  readonly name: unknown;
  readonly status: unknown;
  readonly conclusion: unknown;
}

/**
 * GitHub's listing of the jobs of a run, cut down to what diagnoses a run :
 * the job, its outcome, its steps and their outcomes, its page. The rest
 * (runner labels, check-run URLs, node ids) only costs the agent's context.
 */
function jobListing(data: unknown): unknown {
  const body = (data ?? {}) as { total_count?: unknown; jobs?: unknown };
  const jobs = Array.isArray(body.jobs) ? (body.jobs as readonly Record<string, unknown>[]) : [];
  return {
    total_count: body.total_count,
    jobs: jobs.map((job) => ({
      id: job.id,
      name: job.name,
      status: job.status,
      conclusion: job.conclusion,
      started_at: job.started_at,
      completed_at: job.completed_at,
      html_url: job.html_url,
      run_attempt: job.run_attempt,
      steps: (Array.isArray(job.steps) ? (job.steps as readonly JobStepSummary[]) : []).map(
        (step) => ({
          number: step.number,
          name: step.name,
          status: step.status,
          conclusion: step.conclusion,
        }),
      ),
    })),
  };
}
