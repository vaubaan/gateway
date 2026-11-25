/**
 * Classifier of the `github` service : `(tool, args, resources) → slices`.
 *
 * Spec : docs/spec/gateway-risk-model.md §3, §7 ; docs/spec/vaubaan-gateway.md §10
 *        ("a classification error is a security hole").
 * Handbook : docs/handbook/services/github.md.
 *
 * Pure : no IO, no credential, no `Date`. A call returns one OR MORE slices
 * (multi-slice tools : `merge_pull_request`, `create_pull_request`,
 * `create_release`, `push_files`, `add_labels` — one per label —, file
 * writes under `.github/workflows/`).
 * A call the plugin cannot place on the data model is `denied`, never
 * mapped to a broad slice.
 *
 * The repository is named explicitly by `owner` + `repo` and must be one of
 * the mission's GitHub resources ; the gateway checks the same thing before
 * calling (`resource-not-in-mission`), the classifier repeats it so a slice
 * never names a repository outside the mission.
 *
 * The arguments are read once, by `readGithubCall` (`call.ts`) : every
 * identifier is checked by its grammar there, and the slices below are built
 * from the same `GithubCall` the dispatcher sends (`octokit-dispatch.ts`).
 * What selects a risk class is therefore either sent to GitHub as it was
 * classified or verified against GitHub : file paths must be canonical and
 * branches must be branch names (refused otherwise, so the
 * `.github/workflows/` and protected-branch patterns cannot be dodged by
 * another spelling), and the declared base of `merge_pull_request` is
 * compared with the pull request's real base before the merge.
 *
 * Virtual slice leaves (verbs derived from the data model, see `data-model.ts`) :
 *   - `branch[X].merge-into.W`        — secondary slice of `merge_pull_request`
 *   - `branch[X].propose-to[Y].W`     — secondary slice of `create_pull_request`
 *   - `branch[X].workflow-via-file.W` — secondary slice when a file write
 *     targets `.github/workflows/*.yml`
 *   - `branch[X].files-bulk.W`        — secondary slice of `push_files`,
 *     distinguishing a multi-file commit from a single-file write
 *
 * "List all <entity>" reads emit the entity name without an identifier
 * (`repo[X].branch.R`) and the catalog's terminal `[**]` absorbs the missing
 * segment. An identifier the slice grammar cannot carry — a branch
 * `feature/ü`, a file `my notes.md` or `a*.ts`, a fork head `owner:branch` —
 * is written as "any" (`[*]`, `identOrAny`), never repaired into another
 * name ; so is a parent the arguments do not name (the workflow of a run,
 * the run of a job).
 */

import {
  isSliceIdent,
  parseSlice,
  type ClassifyOutcome,
  type Resource,
  type Slice,
} from '@vaubaan/plugin-sdk';

import { githubRepoRefs, isWorkflowPath, readGithubCall, type GithubCall } from './call.ts';
import { isGitTool, readGitCall, type GitCall, type GitTargetUpdate } from './git-call.ts';
import { SERVICE_ID, TOOL } from './identity.ts';

export { isWorkflowPath } from './call.ts';

// ─────────────────────────────────────────────────────────────────────────────
// Public entry point
// ─────────────────────────────────────────────────────────────────────────────

/** Entry point : `resources` are the mission's resources on this account. */
export function classifyGithub(
  tool: string,
  args: Readonly<Record<string, unknown>>,
  resources: readonly Resource[],
): ClassifyOutcome {
  if (isGitTool(tool)) {
    const git = readGitCall(tool, args, githubRepoRefs(resources));
    if ('denied' in git) return git;
    return { slices: gitSlicesOf(git) };
  }
  const call = readGithubCall(tool, args, githubRepoRefs(resources));
  if ('denied' in call) return call;
  return { slices: slicesOf(call) };
}

/**
 * The slices of a git fetch or push (spec §4.1 ter ; catalog v6).
 *
 *   fetch                    repo[R].branch.R, repo[R].tag.R           (read-code)
 *   push, every ref          <ref>.push.W                              (git-push)
 *   push to a branch         branch[B].W                               (feature-branch-write,
 *                                                                       merge-protected or the fallback)
 *   push of a tag            tag[T].W                                  (tag-write, create-release)
 *   not a fast-forward       <ref>.force.W                             (force-push)
 *   a deletion               <ref>.delete.W                            (branch-delete, tag-write)
 *   CI workflow files        <ref>.workflow-via-file.W                 (workflow-write-via-file)
 *
 * A deleted branch also touches `branch[B].W` : deleting `main` is a write on
 * `main`. The workflow marker is set from the review's `workflow_files` and,
 * as a second reading, from the files themselves.
 */
export function gitSlicesOf(call: GitCall): Slice[] {
  const repo = `${SERVICE_ID}.repo[${call.target.ref}]`;
  if (call.tool === TOOL.gitFetch) {
    return [build(`${repo}.branch.R`), build(`${repo}.tag.R`)];
  }
  return dedup(call.updates.flatMap((u) => gitUpdateSlices(repo, u)));
}

function gitUpdateSlices(repo: string, target: GitTargetUpdate): Slice[] {
  const { update } = target;
  const ref = `${repo}.${target.refKind}[${identOrAny(target.name)}]`;
  const out = [build(`${ref}.push.W`)];
  if (update.kind === 'delete') {
    if (target.refKind === 'branch') out.push(build(`${ref}.W`));
    out.push(build(`${ref}.delete.W`));
    return out;
  }
  out.push(build(`${ref}.W`));
  if (update.kind === 'force') out.push(build(`${ref}.force.W`));
  const workflow =
    update.workflow_files.length > 0 || update.files.some((path) => isWorkflowPath(path));
  if (workflow) out.push(build(`${ref}.workflow-via-file.W`));
  return out;
}

/** The slices of a call whose identifiers `readGithubCall` has checked. */
export function slicesOf(call: GithubCall): Slice[] {
  switch (call.tool) {
    // ── The search plane : GitHub's global search, beyond the repositories ──
    case TOOL.searchCode:
      return [build(`${SERVICE_ID}.search.code.R`)];
    case TOOL.searchIssues:
      return [build(`${SERVICE_ID}.search.issues.R`)];

    default:
      return repoSlices(call);
  }
}

function repoSlices(call: Extract<GithubCall, { target: unknown }>): Slice[] {
  const repo = `${SERVICE_ID}.repo[${call.target.ref}]`;
  switch (call.tool) {
    // ── Reads — code / branch / commit / file / tag ────────────────────────
    case TOOL.listBranches:
      return [build(`${repo}.branch.R`)];
    case TOOL.listCommits:
      return [
        build(
          call.sha !== undefined
            ? `${repo}.branch[${identOrAny(call.sha)}].commit.R`
            : `${repo}.commit.R`,
        ),
      ];
    case TOOL.getFileContents: {
      const branchSeg = call.ref !== undefined ? `branch[${identOrAny(call.ref)}].` : 'branch.';
      return [build(`${repo}.${branchSeg}file[${identOrAny(call.path)}].R`)];
    }
    case TOOL.getCommit:
      return [build(`${repo}.commit[${identOrAny(call.sha)}].R`)];
    case TOOL.listTags:
      return [build(`${repo}.tag.R`)];

    // ── Reads — meta (PRs, issues, comments, releases, workflows, rules) ───
    case TOOL.listPullRequests:
      return [build(`${repo}.pull_request.R`)];
    case TOOL.getPullRequest:
      return [build(`${repo}.pull_request[${call.pullNumber}].R`)];
    case TOOL.listIssues:
      return [build(`${repo}.issue.R`)];
    case TOOL.getIssue:
      return [build(`${repo}.issue[${call.issueNumber}].R`)];
    // A pull request's conversation is its issue's comments : one number space.
    case TOOL.getIssueComments:
      return [build(`${repo}.issue[${call.issueNumber}].comment.R`)];
    case TOOL.getPullRequestReviews:
      return [build(`${repo}.pull_request[${call.pullNumber}].review.R`)];
    case TOOL.getPullRequestComments:
      return [build(`${repo}.pull_request[${call.pullNumber}].review-comment.R`)];
    // The changed files are the pull request's diff : a read of the pull request.
    case TOOL.getPullRequestFiles:
      return [build(`${repo}.pull_request[${call.pullNumber}].R`)];
    case TOOL.listReleases:
      return [build(`${repo}.release.R`)];
    case TOOL.listWorkflows:
      return [build(`${repo}.workflow.R`)];
    case TOOL.listWorkflowRuns: {
      const tail =
        call.workflowId !== undefined
          ? `workflow[${identOrAny(String(call.workflowId))}].workflow-run.R`
          : 'workflow-run.R';
      return [build(`${repo}.${tail}`)];
    }
    // A run is named by its id alone : its workflow is "any". A job likewise : its run too.
    case TOOL.listWorkflowJobs:
      return [build(`${repo}.workflow[${ANY}].workflow-run[${call.runId}].job.R`)];
    case TOOL.getJobLogs:
      return [build(`${repo}.workflow[${ANY}].workflow-run[${ANY}].job[${call.jobId}].log.R`)];
    case TOOL.getBranchProtection:
      return [build(`${repo}.branch-protection[${identOrAny(call.branch)}].R`)];

    // ── Writes — branches / files / commits ────────────────────────────────
    case TOOL.createBranch:
      return [build(`${repo}.branch[${identOrAny(call.branch)}].W`)];
    case TOOL.createOrUpdateFile:
    case TOOL.deleteFile:
      return fileWriteSlices(repo, call.branch, [call.path]);
    case TOOL.pushFiles: {
      const out = fileWriteSlices(
        repo,
        call.branch,
        call.files.map((f) => f.path),
      );
      if (call.files.length > 1) {
        out.push(build(`${repo}.branch[${identOrAny(call.branch)}].files-bulk.W`));
      }
      return dedup(out);
    }

    // ── Writes — PRs / issues / comments / labels ──────────────────────────
    case TOOL.createPullRequest:
      return [
        build(`${repo}.pull_request.W`),
        build(`${repo}.branch[${identOrAny(call.head)}].propose-to[${identOrAny(call.base)}].W`),
      ];
    case TOOL.mergePullRequest:
      return [
        build(`${repo}.pull_request[${call.pullNumber}].W`),
        build(`${repo}.branch[${identOrAny(call.base)}].merge-into.W`),
      ];
    case TOOL.addIssueComment:
      // Trailing `comment` name — no leaf id (unknown before posting).
      return [build(`${repo}.issue[${call.issueNumber}].comment.W`)];
    case TOOL.replyToPullRequestComment:
      // A comment on the pull request's number, as `add_issue_comment` : any
      // write slice beneath `pull_request[N]` would also touch `create-pr`
      // (its pattern `pull_request[**].W` spans the subtree).
      return [build(`${repo}.issue[${call.pullNumber}].comment.W`)];
    case TOOL.addLabels:
      // One slice per label, named : a mission can be narrowed to `label[e2e]`.
      return dedup(
        call.labels.map((name) =>
          build(`${repo}.issue[${call.issueNumber}].label[${identOrAny(name)}].W`),
        ),
      );

    case TOOL.updateIssue:
      // Its own verb leaf : `issue[N].W` would also match the comments and
      // labels beneath the issue (a pattern's trailing `.W` spans the subtree).
      return [build(`${repo}.issue[${call.issueNumber}].edit.W`)];

    // ── Writes — releases ──────────────────────────────────────────────────
    case TOOL.createRelease:
      return [build(`${repo}.release.W`), build(`${repo}.tag[${identOrAny(call.tagName)}].W`)];
    case TOOL.deleteRelease:
      // Its own verb leaf : deleting is not the risk of publishing.
      return [build(`${repo}.release[${call.releaseId}].delete.W`)];

    // ── Writes — rules ─────────────────────────────────────────────────────
    case TOOL.updateBranchProtection:
      return [build(`${repo}.branch-protection[${identOrAny(call.branch)}].W`)];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** One `file[<path>].W` slice per path, plus the `workflow-via-file` marker once a path is a workflow YAML. */
function fileWriteSlices(repo: string, branch: string, paths: readonly string[]): Slice[] {
  const out: Slice[] = [];
  for (const path of paths) {
    out.push(build(`${repo}.branch[${identOrAny(branch)}].file[${identOrAny(path)}].W`));
    if (isWorkflowPath(path)) {
      out.push(build(`${repo}.branch[${identOrAny(branch)}].workflow-via-file.W`));
    }
  }
  return out;
}

/** "Any identifier" in a slice string : `[*]`. */
const ANY = '*';

/**
 * A checked identifier as a slice names it : itself when the slice grammar
 * can carry it, "any" otherwise. Never repaired : `feature/ü` written
 * `feature/-` names a branch that does not exist — in the audit, in the
 * refusal the agent reads — and the catalog would decide on that other name.
 * Written as "any", it touches every risk some identifier at that place
 * could : a write to such a branch takes both the working-branch and the
 * protected-branch risk, whatever its prefix. The request carries the
 * identifier itself.
 */
function identOrAny(value: string): string {
  return isSliceIdent(value) ? value : ANY;
}

/** Parse at build time so a typo in a slice template fails close to the call site. */
function build(input: string): Slice {
  return parseSlice(input);
}

function dedup(slices: readonly Slice[]): Slice[] {
  const seen = new Set<string>();
  const out: Slice[] = [];
  for (const s of slices) {
    const key = JSON.stringify({ p: s.service, a: s.action, path: s.path });
    if (!seen.has(key)) {
      seen.add(key);
      out.push(s);
    }
  }
  return out;
}
