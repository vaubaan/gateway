/**
 * The review of a push (ADR gateway-as-git-remote D4): what each ref update
 * brings, read from GitHub once the pack is stored there under a temporary
 * ref. Reads only.
 *
 *   stale        the client's `old` is a claim: the ref is read at GitHub and
 *                a different value refuses the push ("stale info");
 *   kind         create, fast-forward, force (a non-fast-forward, or any tag
 *                move), delete;
 *   files        the net change of the tip, from GitHub's comparison (both
 *                ways for a rewrite, so a change taken back is seen);
 *   workflows    every path under `.github/workflows/` the net change touches
 *                AND every one an intermediate commit of the range touches:
 *                a workflow added then removed inside one push still asks
 *                for `workflow-write-via-file`. Each commit of the range is
 *                read (`GET commits/{sha}`), at most `COMMITS_REVIEWED_MAX`
 *                per push;
 *   permissions  the push token covers what the updates need, or the push is
 *                refused by the permission's name.
 *
 * Limits fail closed: over 300 files or 250 commits per comparison, over
 * `COMMITS_REVIEWED_MAX` commits per push, a commit with 300 or more files,
 * an unrelated history, an empty repository — the push is refused.
 */
import type {
  ExecuteContext,
  GitRefUpdate,
  GitReview,
  GitReviewedUpdate,
  GitUpdateKind,
} from '@vaubaan/plugin-sdk';

import { isUnderWorkflowDirectory, repoFullName } from './call.ts';
import { GITHUB_WEB_BASE } from './credential.ts';
import { GIT_PUSH_TOOL, pushedRef } from './git-call.ts';
import { gitGrant, targetOf } from './git-credential.ts';
import { COMMIT_MAX_FILES, GithubRest, type Comparison } from './git-rest.ts';
import { gitPushNeeds, missingPermissionSentence } from './permission-check.ts';

/** Commits of one push read one by one for workflow changes (one request each). */
export const COMMITS_REVIEWED_MAX = 100;
/** Commit reads in flight at once. */
const COMMIT_READS_IN_PARALLEL = 8;

type Compared = Extract<Comparison, { ok: true }>;

/**
 * The client's `old` against the ref at GitHub: a later claimed `old` would
 * keep out of the review the commits between the real value and the claim.
 */
async function staleRef(rest: GithubRest, update: GitRefUpdate): Promise<string | null> {
  const actual = await rest.refValue(update.ref);
  if (actual === update.old) return null;
  return update.old === null
    ? `${update.ref} already exists at GitHub; fetch first, then push again`
    : `${update.ref} has moved at GitHub since your last fetch (stale info); fetch first, then push again`;
}

/** The workflow paths each commit of `shas` changes, read `COMMIT_READS_IN_PARALLEL` at a time. */
async function workflowPathsByCommit(
  rest: GithubRest,
  shas: readonly string[],
): Promise<
  | { readonly ok: true; readonly paths: ReadonlyMap<string, readonly string[]> }
  | { readonly ok: false; readonly reason: string }
> {
  const paths = new Map<string, readonly string[]>();
  for (let at = 0; at < shas.length; at += COMMIT_READS_IN_PARALLEL) {
    const batch = shas.slice(at, at + COMMIT_READS_IN_PARALLEL);
    const read = await Promise.all(batch.map((sha) => rest.commitPaths(sha)));
    for (const [i, changed] of read.entries()) {
      const sha = batch[i]!;
      if (changed === null) {
        return {
          ok: false,
          reason: `commit ${sha.slice(0, 12)} changes ${COMMIT_MAX_FILES} or more files and cannot be reviewed; split it`,
        };
      }
      paths.set(sha, changed.filter(isUnderWorkflowDirectory));
    }
  }
  return { ok: true, paths };
}

interface Reviewing {
  readonly update: GitRefUpdate;
  readonly kind: GitUpdateKind;
  readonly compared: readonly Compared[];
}

async function compareOne(
  rest: GithubRest,
  update: GitRefUpdate,
  defaultBranch: () => Promise<string | null>,
): Promise<Reviewing | { readonly reason: string }> {
  const pushed = pushedRef(update.ref);
  if ('denied' in pushed) return { reason: `${update.ref}: ${pushed.denied}` };
  const stale = await staleRef(rest, update);
  if (stale !== null) return { reason: stale };
  if (update.new === null) return { update, kind: 'delete', compared: [] };
  const label = update.ref;
  let comparisons: Comparison[];
  let kind: GitUpdateKind;
  if (update.old === null) {
    const base = await defaultBranch();
    if (base === null) {
      return {
        reason: `${label} cannot be reviewed: the repository has no default branch to compare it with`,
      };
    }
    comparisons = [await rest.compare(base, update.new, label)];
    kind = 'create';
  } else {
    const forward = await rest.compare(update.old, update.new, label);
    const fastForward =
      forward.ok &&
      pushed.refKind === 'branch' &&
      (forward.status === 'ahead' || forward.status === 'identical');
    kind = fastForward ? 'fast-forward' : 'force';
    // A rewrite can also take back what the old history had : both sides count.
    comparisons = fastForward
      ? [forward]
      : [forward, await rest.compare(update.new, update.old, label)];
  }
  const failed = comparisons.find((c): c is Extract<Comparison, { ok: false }> => !c.ok);
  if (failed) return { reason: failed.reason };
  return { update, kind, compared: comparisons as Compared[] };
}

export async function review(
  ctx: ExecuteContext,
  repository: string,
  updates: readonly GitRefUpdate[],
): Promise<GitReview> {
  const target = targetOf(repository);
  const rest = new GithubRest(ctx, target);
  let defaultBranch: Promise<string | null> | undefined;
  const base = () => (defaultBranch ??= rest.defaultBranch());
  // Every update is reviewed, not only the first.
  const reviewing: Reviewing[] = [];
  for (const update of updates) {
    const one = await compareOne(rest, update, base);
    if ('reason' in one) return { ok: false, reason: one.reason };
    reviewing.push(one);
  }
  // The commits each update brings (forward comparison only: commits a rewrite
  // drops add nothing); the net change already covers a single commit.
  const shas = [
    ...new Set(
      reviewing.flatMap((r) =>
        r.compared[0] && r.compared[0].shas.length > 1 ? r.compared[0].shas : [],
      ),
    ),
  ];
  if (shas.length > COMMITS_REVIEWED_MAX) {
    return {
      ok: false,
      reason: `this push brings ${shas.length} commits; at most ${COMMITS_REVIEWED_MAX} are reviewed one by one in a push; push in smaller parts`,
    };
  }
  const perCommit = await workflowPathsByCommit(rest, shas);
  if (!perCommit.ok) return perCommit;
  const reviewed: GitReviewedUpdate[] = [];
  for (const r of reviewing) {
    const files = [...new Set(r.compared.flatMap((c) => c.files))].sort();
    const workflows = new Set(files.filter(isUnderWorkflowDirectory));
    for (const sha of r.compared[0]?.shas ?? []) {
      for (const path of perCommit.paths.get(sha) ?? []) workflows.add(path);
    }
    reviewed.push({
      ...r.update,
      kind: r.kind,
      commits: r.compared[0]?.commits ?? 0,
      files,
      workflow_files: [...workflows].sort(),
    });
  }
  // The push token's permissions cover what these updates need — a workflow
  // file needs `workflows: write` — or the push is refused by the permission's name.
  const { permissions } = await gitGrant(ctx, target, 'write');
  const missing = missingPermissionSentence(GIT_PUSH_TOOL, gitPushNeeds(reviewed), permissions);
  if (missing !== null) return { ok: false, reason: missing };
  return { ok: true, updates: reviewed };
}

/** GitHub's comparison of one update, for the person who approves it. */
export function compareUrl(repository: string, update: GitReviewedUpdate): string | null {
  const target = repoFullName(repository);
  if (target === null || update.new === null) return null;
  const base = `${GITHUB_WEB_BASE}/${target.owner}/${target.repo}`;
  if (update.old === null) return `${base}/compare/${update.new}`;
  return `${base}/compare/${update.old}...${update.new}`;
}
