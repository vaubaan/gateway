/**
 * Tool → REST call dispatcher of the `github` provider, over Octokit.
 *
 * Each tool name in `tools.ts` maps to one Octokit call (or a short
 * sequence for `create_branch` and `push_files`, which the REST API has no
 * one-shot endpoint for). The result is the raw Octokit `data` payload.
 *
 * The Octokit instance is built by the caller (`execute.ts` injects
 * `ctx.fetch` and `ctx.signal`), so this module never touches the global
 * fetch.
 */

import type { Octokit as OctokitType } from '@octokit/rest';

export type OctokitLike = Pick<OctokitType, 'rest' | 'request'>;

const repoArgs = (a: Readonly<Record<string, unknown>>) =>
  ({
    owner: a.owner as string,
    repo: a.repo as string,
  }) as const;

export async function dispatchGithubTool(
  octokit: OctokitLike,
  tool: string,
  args: Readonly<Record<string, unknown>>,
): Promise<unknown> {
  switch (tool) {
    case 'github__list_branches': {
      const { data } = await octokit.rest.repos.listBranches({ ...repoArgs(args) });
      return data;
    }
    case 'github__list_commits': {
      const { data } = await octokit.rest.repos.listCommits({
        ...repoArgs(args),
        sha: args.sha as string | undefined,
        per_page: typeof args.per_page === 'number' ? args.per_page : undefined,
      });
      return data;
    }
    case 'github__list_pull_requests': {
      const { data } = await octokit.rest.pulls.list({
        ...repoArgs(args),
        state: (args.state as 'open' | 'closed' | 'all') ?? 'open',
      });
      return data;
    }
    case 'github__list_issues': {
      const { data } = await octokit.rest.issues.listForRepo({
        ...repoArgs(args),
        state: (args.state as 'open' | 'closed' | 'all') ?? 'open',
      });
      return data;
    }
    case 'github__get_file_contents': {
      const { data } = await octokit.rest.repos.getContent({
        ...repoArgs(args),
        path: args.path as string,
        ref: args.ref as string | undefined,
      });
      return data;
    }
    case 'github__get_pull_request': {
      const { data } = await octokit.rest.pulls.get({
        ...repoArgs(args),
        pull_number: args.pull_number as number,
      });
      return data;
    }
    case 'github__get_issue': {
      const { data } = await octokit.rest.issues.get({
        ...repoArgs(args),
        issue_number: args.issue_number as number,
      });
      return data;
    }
    case 'github__get_commit': {
      const { data } = await octokit.rest.repos.getCommit({
        ...repoArgs(args),
        ref: args.sha as string,
      });
      return data;
    }
    case 'github__search_code': {
      const { data } = await octokit.rest.search.code({ q: args.q as string });
      return data;
    }
    case 'github__search_issues': {
      const { data } = await octokit.rest.search.issuesAndPullRequests({ q: args.q as string });
      return data;
    }
    case 'github__create_branch': {
      // No one-shot create_branch : resolve the base ref SHA, then create a new ref.
      const baseBranch =
        (args.from_branch as string | undefined) ??
        (await octokit.rest.repos.get({ ...repoArgs(args) })).data.default_branch;
      const baseRef = await octokit.rest.git.getRef({
        ...repoArgs(args),
        ref: `heads/${baseBranch}`,
      });
      const { data } = await octokit.rest.git.createRef({
        ...repoArgs(args),
        ref: `refs/heads/${args.branch as string}`,
        sha: baseRef.data.object.sha,
      });
      return data;
    }
    case 'github__create_or_update_file': {
      const { data } = await octokit.rest.repos.createOrUpdateFileContents({
        ...repoArgs(args),
        path: args.path as string,
        message: args.message as string,
        content: Buffer.from(args.content as string, 'utf8').toString('base64'),
        branch: args.branch as string,
        sha: args.sha as string | undefined,
      });
      return data;
    }
    case 'github__push_files': {
      const files = args.files as Array<{ path: string; content: string }>;
      const branch = args.branch as string;
      const message = args.message as string;
      const ref = await octokit.rest.git.getRef({ ...repoArgs(args), ref: `heads/${branch}` });
      const headSha = ref.data.object.sha;
      const baseCommit = await octokit.rest.git.getCommit({
        ...repoArgs(args),
        commit_sha: headSha,
      });
      const blobs = await Promise.all(
        files.map((f) =>
          octokit.rest.git.createBlob({
            ...repoArgs(args),
            content: Buffer.from(f.content, 'utf8').toString('base64'),
            encoding: 'base64',
          }),
        ),
      );
      const tree = await octokit.rest.git.createTree({
        ...repoArgs(args),
        base_tree: baseCommit.data.tree.sha,
        tree: files.map((f, i) => ({
          path: f.path,
          mode: '100644',
          type: 'blob',
          sha: blobs[i]!.data.sha,
        })),
      });
      const commit = await octokit.rest.git.createCommit({
        ...repoArgs(args),
        message,
        tree: tree.data.sha,
        parents: [headSha],
      });
      await octokit.rest.git.updateRef({
        ...repoArgs(args),
        ref: `heads/${branch}`,
        sha: commit.data.sha,
      });
      return { commit_sha: commit.data.sha, branch };
    }
    case 'github__create_pull_request': {
      const { data } = await octokit.rest.pulls.create({
        ...repoArgs(args),
        title: args.title as string,
        body: args.body as string | undefined,
        head: args.head as string,
        base: args.base as string,
        draft: (args.draft as boolean | undefined) ?? false,
      });
      return data;
    }
    case 'github__add_issue_comment': {
      const { data } = await octokit.rest.issues.createComment({
        ...repoArgs(args),
        issue_number: args.issue_number as number,
        body: args.body as string,
      });
      return data;
    }
    case 'github__merge_pull_request': {
      const { data } = await octokit.rest.pulls.merge({
        ...repoArgs(args),
        pull_number: args.pull_number as number,
        merge_method: (args.merge_method as 'merge' | 'squash' | 'rebase' | undefined) ?? 'merge',
      });
      return data;
    }
    case 'github__delete_file': {
      const { data } = await octokit.rest.repos.deleteFile({
        ...repoArgs(args),
        path: args.path as string,
        message: args.message as string,
        branch: args.branch as string,
        sha: args.sha as string,
      });
      return data;
    }
    case 'github__list_workflows': {
      const { data } = await octokit.rest.actions.listRepoWorkflows({ ...repoArgs(args) });
      return data;
    }
    case 'github__list_workflow_runs': {
      const workflowId = args.workflow_id;
      const branch = args.branch as string | undefined;
      const perPage = typeof args.per_page === 'number' ? args.per_page : undefined;
      if (workflowId !== undefined) {
        const { data } = await octokit.rest.actions.listWorkflowRuns({
          ...repoArgs(args),
          workflow_id: workflowId as string | number,
          branch,
          per_page: perPage,
        });
        return data;
      }
      const { data } = await octokit.rest.actions.listWorkflowRunsForRepo({
        ...repoArgs(args),
        branch,
        per_page: perPage,
      });
      return data;
    }
    case 'github__get_branch_protection': {
      const { data } = await octokit.rest.repos.getBranchProtection({
        ...repoArgs(args),
        branch: args.branch as string,
      });
      return data;
    }
    case 'github__update_branch_protection': {
      const { data } = await octokit.rest.repos.updateBranchProtection({
        ...repoArgs(args),
        branch: args.branch as string,
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
        ...repoArgs(args),
        per_page: typeof args.per_page === 'number' ? args.per_page : undefined,
      });
      return data;
    }
    case 'github__list_tags': {
      const { data } = await octokit.rest.repos.listTags({
        ...repoArgs(args),
        per_page: typeof args.per_page === 'number' ? args.per_page : undefined,
      });
      return data;
    }
    case 'github__create_release': {
      const { data } = await octokit.rest.repos.createRelease({
        ...repoArgs(args),
        tag_name: args.tag_name as string,
        target_commitish: args.target_commitish as string | undefined,
        name: args.name as string | undefined,
        body: args.body as string | undefined,
        draft: args.draft as boolean | undefined,
        prerelease: args.prerelease as boolean | undefined,
        generate_release_notes: args.generate_release_notes as boolean | undefined,
      });
      return data;
    }
    case 'github__delete_release': {
      await octokit.rest.repos.deleteRelease({
        ...repoArgs(args),
        release_id: args.release_id as number,
      });
      return { deleted: true, release_id: args.release_id };
    }
    default:
      throw new Error(`Unknown GitHub MCP tool: ${tool}`);
  }
}
