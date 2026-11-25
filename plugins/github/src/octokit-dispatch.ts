/**
 * Tool → REST call dispatcher of the `github` service, over Octokit.
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
import { ExecutorRefusal, UpstreamProtocolError, isList, isRecord } from '@vaubaan/plugin-sdk';

import { branchName, type GithubCall, type RepoCall } from './call.ts';
import { TOOL } from './identity.ts';

export type OctokitLike = Pick<OctokitType, 'rest' | 'request'>;

/**
 * Every call but the job log, which `execute.ts` answers itself (the log is a redirect to a download, read bounded :
 * `job-logs.ts`).
 */
export type DispatchedCall = Exclude<GithubCall, { tool: typeof TOOL.getJobLogs }>;

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
      call.tool === TOOL.searchCode
        ? await octokit.rest.search.code({ q })
        : await octokit.rest.search.issuesAndPullRequests({ q });
    return data;
  }
  const repo = { owner: call.target.owner, repo: call.target.repo } as const;
  switch (call.tool) {
    case TOOL.listBranches: {
      const { data } = await octokit.rest.repos.listBranches({ ...repo });
      return data;
    }
    case TOOL.listCommits: {
      const { data } = await octokit.rest.repos.listCommits({
        ...repo,
        sha: call.sha,
        per_page: perPageOf(args),
      });
      return data;
    }
    case TOOL.listPullRequests: {
      const { data } = await octokit.rest.pulls.list({
        ...repo,
        state: (args.state as 'open' | 'closed' | 'all') ?? 'open',
      });
      return data;
    }
    case TOOL.listIssues: {
      const { data } = await octokit.rest.issues.listForRepo({
        ...repo,
        state: (args.state as 'open' | 'closed' | 'all') ?? 'open',
      });
      return data;
    }
    case TOOL.getFileContents: {
      const { data } = await octokit.rest.repos.getContent({
        ...repo,
        path: call.path,
        ref: call.ref,
      });
      return data;
    }
    case TOOL.getPullRequest: {
      const { data } = await octokit.rest.pulls.get({ ...repo, pull_number: call.pullNumber });
      return data;
    }
    case TOOL.getIssue: {
      const { data } = await octokit.rest.issues.get({ ...repo, issue_number: call.issueNumber });
      return data;
    }
    case TOOL.getIssueComments: {
      const { data } = await octokit.rest.issues.listComments({
        ...repo,
        issue_number: call.issueNumber,
        per_page: call.perPage,
        page: call.page,
      });
      return recordsOf(data).map(issueComment);
    }
    case TOOL.getPullRequestReviews: {
      const { data } = await octokit.rest.pulls.listReviews({
        ...repo,
        pull_number: call.pullNumber,
        per_page: call.perPage,
        page: call.page,
      });
      return recordsOf(data).map(review);
    }
    case TOOL.getPullRequestComments: {
      const { data } = await octokit.rest.pulls.listReviewComments({
        ...repo,
        pull_number: call.pullNumber,
        per_page: call.perPage,
        page: call.page,
      });
      return recordsOf(data).map(reviewComment);
    }
    case TOOL.getPullRequestFiles: {
      const { data } = await octokit.rest.pulls.listFiles({
        ...repo,
        pull_number: call.pullNumber,
        per_page: call.perPage,
        page: call.page,
      });
      return recordsOf(data).map(changedFile);
    }
    case TOOL.getCommit: {
      const { data } = await octokit.rest.repos.getCommit({ ...repo, ref: call.sha });
      return data;
    }
    case TOOL.createBranch: {
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
    case TOOL.createOrUpdateFile: {
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
    case TOOL.pushFiles: {
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
    case TOOL.createPullRequest: {
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
    case TOOL.addIssueComment: {
      const { data } = await octokit.rest.issues.createComment({
        ...repo,
        issue_number: call.issueNumber,
        body: args.body as string,
      });
      return data;
    }
    case TOOL.replyToPullRequestComment: {
      const { data } = await octokit.rest.pulls.createReplyForReviewComment({
        ...repo,
        pull_number: call.pullNumber,
        comment_id: call.commentId,
        body: call.body,
      });
      return isRecord(data) ? reviewComment(data) : data;
    }
    case TOOL.addLabels: {
      const { data } = await octokit.rest.issues.addLabels({
        ...repo,
        issue_number: call.issueNumber,
        labels: [...call.labels],
      });
      return labelNames(data);
    }
    case TOOL.updateIssue: {
      const { data } = await octokit.rest.issues.update({
        ...repo,
        issue_number: call.issueNumber,
        ...(call.title === undefined ? {} : { title: call.title }),
        ...(call.body === undefined ? {} : { body: call.body }),
        ...(call.type === undefined ? {} : { type: call.type }),
      });
      return issueSummary(data);
    }
    case TOOL.mergePullRequest: {
      await assertPullRequestTargetsDeclaredBase(octokit, call);
      const { data } = await octokit.rest.pulls.merge({
        ...repo,
        pull_number: call.pullNumber,
        merge_method: (args.merge_method as 'merge' | 'squash' | 'rebase' | undefined) ?? 'merge',
      });
      return data;
    }
    case TOOL.deleteFile: {
      const { data } = await octokit.rest.repos.deleteFile({
        ...repo,
        path: call.path,
        message: args.message as string,
        branch: call.branch,
        sha: args.sha as string,
      });
      return data;
    }
    case TOOL.listWorkflows: {
      const { data } = await octokit.rest.actions.listRepoWorkflows({ ...repo });
      return data;
    }
    case TOOL.listWorkflowRuns: {
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
    case TOOL.listWorkflowJobs: {
      const { data } = await octokit.rest.actions.listJobsForWorkflowRun({
        ...repo,
        run_id: call.runId,
        filter: call.filter,
        per_page: perPageOf(args),
      });
      return jobListing(data);
    }
    case TOOL.getBranchProtection: {
      const { data } = await octokit.rest.repos.getBranchProtection({
        ...repo,
        branch: call.branch,
      });
      return data;
    }
    case TOOL.updateBranchProtection: {
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
          boolean | undefined,
      });
      return data;
    }
    case TOOL.listReleases: {
      const { data } = await octokit.rest.repos.listReleases({
        ...repo,
        per_page: perPageOf(args),
      });
      return data;
    }
    case TOOL.listTags: {
      const { data } = await octokit.rest.repos.listTags({ ...repo, per_page: perPageOf(args) });
      return data;
    }
    case TOOL.createRelease: {
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
    case TOOL.deleteRelease: {
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
    throw new UpstreamProtocolError(
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
  call: Extract<RepoCall, { tool: typeof TOOL.mergePullRequest }>,
): Promise<void> {
  const { pullNumber, base: declared } = call;
  const pull = await octokit.rest.pulls.get({
    owner: call.target.owner,
    repo: call.target.repo,
    pull_number: pullNumber,
  });
  const actual = baseRefOf(pull.data);
  if (actual === undefined) {
    throw new UpstreamProtocolError(
      `${TOOL.mergePullRequest}: could not read the base branch of pull request #${pullNumber}; not merged.`,
    );
  }
  if (actual !== declared) {
    // Declined, not failed : the pull request is not the one the call was classified on.
    throw new ExecutorRefusal(
      `${TOOL.mergePullRequest}: pull request #${pullNumber} targets '${actual}', not the declared base '${declared}'. Call again with base '${actual}'.`,
    );
  }
}

/** `base.ref` of a pull-request payload, when it is there as a non-empty string. */
function baseRefOf(pull: unknown): string | undefined {
  if (!isRecord(pull) || !isRecord(pull.base)) return undefined;
  const { ref } = pull.base;
  return typeof ref === 'string' && ref.length > 0 ? ref : undefined;
}

/**
 * GitHub's listing of the jobs of a run, cut down to what diagnoses a run :
 * the job, its outcome, its steps and their outcomes, its page. The rest
 * (runner labels, check-run URLs, node ids) only costs the agent's context.
 * Read field by field : Octokit types the answer, it does not check it.
 */
function jobListing(data: unknown): unknown {
  const body = isRecord(data) ? data : {};
  return {
    total_count: body.total_count,
    jobs: recordsOf(body.jobs).map((job) => ({
      id: job.id,
      name: job.name,
      status: job.status,
      conclusion: job.conclusion,
      started_at: job.started_at,
      completed_at: job.completed_at,
      html_url: job.html_url,
      run_attempt: job.run_attempt,
      steps: recordsOf(job.steps).map((step) => ({
        number: step.number,
        name: step.name,
        status: step.status,
        conclusion: step.conclusion,
      })),
    })),
  };
}

/**
 * GitHub's answer to `add_labels` — every label the issue now carries, with
 * colours, ids and URLs — cut down to their names.
 */
function labelNames(data: unknown): unknown {
  const names = recordsOf(data)
    .map((label) => label.name)
    .filter((name) => typeof name === 'string');
  return { labels: names };
}

/**
 * GitHub's answer to `update_issue` — the whole issue, with its author,
 * labels, reactions and URLs — cut down to what the edit changed. GitHub
 * drops a type change silently when the person behind the token lacks push
 * access : the answered `type` is what the issue really carries.
 */
function issueSummary(data: unknown): unknown {
  if (!isRecord(data)) return data;
  const { number, title, body, state, html_url, updated_at } = data;
  const type = isRecord(data.type) && typeof data.type.name === 'string' ? data.type.name : null;
  return { number, title, body, type, state, html_url, updated_at };
}

/*
 * Comments, reviews and changed files, cut down to what an agent answering a
 * review reads : who, what, where, when, and the link. GitHub's payloads carry
 * the author's whole profile, reactions and a dozen URLs per item, which only
 * cost the agent's context. Read field by field : Octokit types the answer,
 * it does not check it.
 */

/** The login of a payload's `user`, or `null` (a deleted account is `ghost` or absent). */
function loginOf(item: Record<string, unknown>): unknown {
  return isRecord(item.user) ? item.user.login : null;
}

/** A comment of an issue or of a pull request's conversation. */
function issueComment(c: Record<string, unknown>): unknown {
  return {
    id: c.id,
    author: loginOf(c),
    author_association: c.author_association,
    created_at: c.created_at,
    updated_at: c.updated_at,
    body: c.body,
    html_url: c.html_url,
  };
}

/** A review : its verdict and its summary ; the comments on lines are read apart. */
function review(r: Record<string, unknown>): unknown {
  return {
    id: r.id,
    author: loginOf(r),
    state: r.state,
    body: r.body,
    commit_id: r.commit_id,
    submitted_at: r.submitted_at,
    html_url: r.html_url,
  };
}

/** A comment on a line of a pull request's diff, with what places it in its thread. */
function reviewComment(c: Record<string, unknown>): unknown {
  return {
    id: c.id,
    in_reply_to_id: c.in_reply_to_id ?? null,
    pull_request_review_id: c.pull_request_review_id,
    author: loginOf(c),
    author_association: c.author_association,
    path: c.path,
    line: c.line ?? null,
    start_line: c.start_line ?? null,
    side: c.side,
    original_line: c.original_line ?? null,
    commit_id: c.commit_id,
    diff_hunk: c.diff_hunk,
    body: c.body,
    created_at: c.created_at,
    updated_at: c.updated_at,
    html_url: c.html_url,
  };
}

/** A file a pull request changes, its patch as GitHub gives it (absent when too large). */
function changedFile(f: Record<string, unknown>): unknown {
  return {
    filename: f.filename,
    status: f.status,
    previous_filename: f.previous_filename,
    additions: f.additions,
    deletions: f.deletions,
    changes: f.changes,
    patch: f.patch,
  };
}

/** The objects of a list, or none when `value` is not a list. */
function recordsOf(value: unknown): readonly Record<string, unknown>[] {
  return isList(value) ? value.filter(isRecord) : [];
}
