/**
 * The review of a push (ADR gateway-as-git-remote D4): what each ref update
 * brings, read from GitHub once the pack is stored there under a temporary
 * ref. Reads only.
 *
 *   stale        the client's `old` is a claim: the ref is read at GitHub and
 *                a different value refuses the push ("stale info");
 *   base         what the push brings is reviewed from the narrowest of: the
 *                nearest existing branches it was built on (`BaseFinder`,
 *                reasoning there), the default branch, and `old` (an update);
 *   kind         create, fast-forward, force (a non-fast-forward, or any tag
 *                move), delete;
 *   files        the net change of the tip, from GitHub's comparison (both
 *                ways for a rewrite, so a change taken back is seen);
 *   workflows    every path under `.github/workflows/` the net change touches
 *                AND every one an intermediate commit of the range touches:
 *                a workflow added then removed inside one push still asks
 *                for `workflow-write-via-file`. Each commit of the range is
 *                read (`GET commits/{sha}`), at most `COMMITS_REVIEWED_MAX`
 *                per push; one listing 300 files or more (a large merge) is
 *                read by its trees: its workflows against its parents';
 *   permissions  the push token covers what the updates need, or the push is
 *                refused by the permission's name.
 *
 * Limits fail closed: over 300 files or 250 commits per comparison, over
 * `COMMITS_REVIEWED_MAX` commits per push, an unrelated history, an empty
 * repository — the push is refused.
 */
import {
  type ExecuteContext,
  type GitRefUpdate,
  type GitReview,
  type GitReviewedUpdate,
  type GitUpdateKind,
} from '@vaubaan/plugin-sdk';

import { isUnderWorkflowDirectory, repoFullName } from './call.ts';
import { GITHUB_WEB_BASE } from './credential.ts';
import { GIT_PUSH_TOOL, pushedRef } from './git-call.ts';
import { gitGrant, targetOf } from './git-credential.ts';
import { branchHeads } from './git-heads.ts';
import { workflowPathsOfCommit } from './git-inspect.ts';
import { ANCESTORS_PAGE_SIZE, GithubRest, type Comparison } from './git-rest.ts';
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

/**
 * The workflow paths each commit of `shas` changes, read
 * `COMMIT_READS_IN_PARALLEL` at a time. A commit whose file list GitHub
 * truncates (`COMMIT_MAX_FILES`: a large merge of a branch already at
 * GitHub, a vendored directory) is read by its trees instead
 * (`workflowPathsOfCommit`): whether its workflows differ from those of
 * every parent — fail closed when they cannot be read.
 */
async function workflowPathsByCommit(
  rest: GithubRest,
  shas: readonly string[],
): Promise<ReadonlyMap<string, readonly string[]>> {
  const paths = new Map<string, readonly string[]>();
  for (let at = 0; at < shas.length; at += COMMIT_READS_IN_PARALLEL) {
    const batch = shas.slice(at, at + COMMIT_READS_IN_PARALLEL);
    const read = await Promise.all(
      batch.map(async (sha) => {
        const changed = await rest.commitPaths(sha);
        return changed === null
          ? workflowPathsOfCommit(rest, sha)
          : changed.filter(isUnderWorkflowDirectory);
      }),
    );
    for (const [i, changed] of read.entries()) paths.set(batch[i]!, changed);
  }
  return paths;
}

interface Reviewing {
  readonly update: GitRefUpdate;
  readonly kind: GitUpdateKind;
  readonly compared: readonly Compared[];
}

/** Pages of a commit's history walked to find the branch it was built on (100 commits each). */
export const BASE_SEARCH_PAGES = 3;
/** Branch heads compared at most, the nearest first. */
export const BASE_CANDIDATES = 3;

/**
 * Where to start the review of what a push brings — the reasoning (ADR
 * gateway-as-git-remote D4 ter):
 *
 *   A commit reachable from a branch that exists at GitHub is already there:
 *   it came through the gateway (and was reviewed then), through a tool call
 *   (classified then), or from a person, outside any mission. What a push
 *   brings is therefore the commits of `new` that no branch already holds,
 *   and the review of `base..new` for ANY existing branch `base` covers every
 *   one of them that is not reachable from `base`. A base chosen by the gateway
 *   among the branch heads GitHub lists cannot hide a commit: whatever it
 *   leaves out is on that branch at GitHub. Temporary refs and tags are never
 *   candidates: only `refs/heads/*`, as GitHub lists them now.
 *
 * The base is among the nearest branch heads in `new`'s history: the first
 * `BASE_CANDIDATES` commits of `GET commits?sha=<new>` (newest first,
 * `BASE_SEARCH_PAGES` pages) that some branch points at, the one whose
 * comparison brings the fewest commits. The order rests on commit dates, which an agent can
 * forge: a forged date can only make the search miss, and then the review
 * falls back to the default branch (a create) or to `old` (an update) — larger,
 * never smaller.
 */
class BaseFinder {
  private heads: Promise<ReadonlySet<string>> | undefined;

  constructor(
    private readonly ctx: ExecuteContext,
    private readonly repository: string,
    private readonly rest: GithubRest,
  ) {}

  private branchHeads(): Promise<ReadonlySet<string>> {
    this.heads ??= branchHeads(this.ctx, this.repository);
    return this.heads;
  }

  /**
   * The first `BASE_CANDIDATES` branch heads met in `sha`'s history (itself
   * included), `exclude` left out — the nearest first. Several, because
   * commit dates tie and order the history only roughly.
   */
  async nearest(sha: string, exclude: string | null): Promise<readonly string[]> {
    const heads = await this.branchHeads();
    const found: string[] = [];
    if (heads.size === 0) return found;
    for (let page = 1; page <= BASE_SEARCH_PAGES; page += 1) {
      const ancestors = await this.rest.ancestors(sha, page);
      for (const oid of ancestors) {
        if (oid !== exclude && heads.has(oid) && !found.includes(oid)) found.push(oid);
        if (found.length >= BASE_CANDIDATES) return found;
      }
      if (ancestors.length < ANCESTORS_PAGE_SIZE) break;
    }
    return found;
  }
}

/** The reviewable comparison that brings the fewest commits, or the first refusal. */
function narrowest(comparisons: readonly Comparison[]): Comparison {
  const ok = comparisons.filter((c): c is Compared => c.ok);
  if (ok.length === 0) return comparisons[0]!;
  return ok.reduce((best, c) => (c.commits < best.commits ? c : best));
}

async function compareOne(
  rest: GithubRest,
  bases: BaseFinder,
  update: GitRefUpdate,
  defaultBranch: () => Promise<string | null>,
): Promise<Reviewing | { readonly reason: string }> {
  const pushed = pushedRef(update.ref);
  if ('denied' in pushed) return { reason: `${update.ref}: ${pushed.denied}` };
  const stale = await staleRef(rest, update);
  if (stale !== null) return { reason: stale };
  if (update.new === null) return { update, kind: 'delete', compared: [] };
  const label = update.ref;
  /** The narrowest comparison from the nearest branch heads, or `null` when none was found. */
  const fromNearestBranch = async (exclude: string | null): Promise<Comparison | null> => {
    const candidates = await bases.nearest(update.new!, exclude);
    if (candidates.length === 0) return null;
    return narrowest(
      await Promise.all(candidates.map((base) => rest.compare(base, update.new!, label))),
    );
  };

  /**
   * The default branch's comparison, always a candidate: it is a branch
   * like the others, and the nearest heads by commit date can be stale
   * branches whose range holds commits the default branch already has (the
   * dogfood of 2026-10-16: three old v5 branches, each range holding the
   * 1762-file merge of v5 into main, while main itself brought one commit).
   */
  const fromDefaultBranch = async (): Promise<Comparison | null> => {
    const base = await defaultBranch();
    return base === null ? null : rest.compare(base, update.new!, label);
  };

  if (update.old === null) {
    // A create brings what no branch holds: compared with the nearest branches
    // it was built on and with the default branch, the narrowest kept.
    const candidates = [await fromNearestBranch(null), await fromDefaultBranch()].filter(
      (c): c is Comparison => c !== null,
    );
    if (candidates.length === 0) {
      return {
        reason: `${label} cannot be reviewed: the repository has no branch to compare it with`,
      };
    }
    const forward = narrowest(candidates);
    if (!forward.ok) return { reason: forward.reason };
    return { update, kind: 'create', compared: [forward] };
  }

  // An update: what `old` already had is at GitHub; so is what any branch has.
  const fromOld = await rest.compare(update.old, update.new, label);
  const { status } = fromOld;
  const fastForward = pushed.refKind === 'branch' && (status === 'ahead' || status === 'identical');
  const kind: GitUpdateKind = fastForward ? 'fast-forward' : 'force';
  // One commit on top of `old` is already the narrowest range; otherwise (a
  // merge of another branch, a rebase onto it) the nearest branch may hold most
  // of what the range lists.
  const broad = !fromOld.ok || fromOld.commits > 1;
  const others = broad ? [await fromNearestBranch(update.old), await fromDefaultBranch()] : [];
  const forward = narrowest([fromOld, ...others.filter((c): c is Comparison => c !== null)]);
  if (!forward.ok) return { reason: forward.reason };
  if (fastForward) return { update, kind, compared: [forward] };
  // A rewrite can also take back what the old history had: both sides count.
  const backward = await rest.compare(update.new, update.old, label);
  if (!backward.ok) return { reason: backward.reason };
  return { update, kind, compared: [forward, backward] };
}

export async function review(
  ctx: ExecuteContext,
  repository: string,
  updates: readonly GitRefUpdate[],
): Promise<GitReview> {
  const target = targetOf(repository);
  const rest = new GithubRest(ctx, target);
  const bases = new BaseFinder(ctx, repository, rest);
  let defaultBranch: Promise<string | null> | undefined;
  const base = () => (defaultBranch ??= rest.defaultBranch());
  // Every update is reviewed, not only the first.
  const reviewing: Reviewing[] = [];
  for (const update of updates) {
    const one = await compareOne(rest, bases, update, base);
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
  const reviewed: GitReviewedUpdate[] = [];
  for (const r of reviewing) {
    const files = [...new Set(r.compared.flatMap((c) => c.files))].sort();
    const workflows = new Set(files.filter(isUnderWorkflowDirectory));
    for (const sha of r.compared[0]?.shas ?? []) {
      for (const path of perCommit.get(sha) ?? []) workflows.add(path);
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
