/**
 * The review of a push (ADR gateway-as-git-remote D4): what each ref update
 * brings, read from GitHub once the pack is stored there under a temporary
 * ref. Reads only.
 *
 *   stale        the client's `old` is a claim: the ref is read at GitHub and
 *                a different value refuses the push ("stale info");
 *   tag          a pushed tag may be an annotated tag object, which has no
 *                history of its own: it is reviewed through the commit it
 *                points at (peeled, as `git rev-parse <tag>^{commit}`), under
 *                the same risk as a lightweight tag — the tag message is no
 *                security boundary; a tag that names no commit is refused;
 *   base         what the push brings is reviewed from the narrowest of: the
 *                nearest existing branches it was built on (`BaseFinder`,
 *                reasoning there), the default branch, and `old` (an update);
 *                in a repository with no branch at all (a new, empty one),
 *                a create brings its whole history (`wholeHistory`);
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
 *
 * The review does not look at the push token's permissions: the mission's
 * decision comes first, on everything the review found. `admitPush` checked
 * the token against the inspection before the pack left; `execute`
 * (`git-moves.ts`) checks it again against the review before any ref moves.
 *
 * Limits fail closed: over 300 files or 250 commits per comparison, over
 * `COMMITS_REVIEWED_MAX` commits per push, a history unrelated to the
 * branches GitHub has — the push is refused, with what to do.
 */
import { type ExecuteContext } from '@vaubaan/plugin-sdk';
import {
  type GitRefUpdate,
  type GitReview,
  type GitReviewedUpdate,
  type GitUpdateKind,
} from '@vaubaan/plugin-sdk/git';

import { isUnderWorkflowDirectory, repoFullName } from './call.ts';
import { GITHUB_WEB_BASE } from './api.ts';
import { pushedRef, type GitRefKind } from './git-call.ts';
import { targetOf } from './git-credential.ts';
import { branchHeads } from './git-heads.ts';
import { workflowPathsOfCommit } from './git-inspect.ts';
import { ANCESTORS_PAGE_SIZE, COMPARE_MAX_FILES, GithubRest, type Comparison } from './git-rest.ts';

/** Commits of one push read one by one for workflow changes (one request each). */
export const COMMITS_REVIEWED_MAX = 100;
/** Commit reads in flight at once. */
const COMMIT_READS_IN_PARALLEL = 8;
/** Annotated tags peeled one inside the other, at most (as `git-inspect.ts`). */
const TAG_DEPTH_MAX = 4;

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
 * The commit a tag's object id names, annotated tags peeled: the id itself
 * when GitHub holds a commit under it, else the object the tag points at,
 * followed `TAG_DEPTH_MAX` times; `null` when the chain ends on something
 * else (a tree, a blob, an object GitHub does not hold, a chain too deep).
 * GitHub's compare and commit listing know commits and ref names only, not a
 * tag object's id.
 */
async function peeledCommit(rest: GithubRest, oid: string): Promise<string | null> {
  let at = oid;
  for (let depth = 0; depth <= TAG_DEPTH_MAX; depth += 1) {
    const read = await rest.gitObject(at);
    if (read === null) return null;
    if (read.kind === 'commit') return at;
    at = read.object;
  }
  return null;
}

/**
 * The commits the review compares for one update: a branch points at commits
 * (git refuses anything else under `refs/heads/`), a tag may point at an
 * annotated tag object, peeled. The update itself keeps the object ids git
 * sent: the ref is moved to the tag object, not to the commit.
 */
async function reviewedCommits(
  rest: GithubRest,
  refKind: GitRefKind,
  update: GitRefUpdate & { readonly new: string },
): Promise<{ readonly old: string | null; readonly new: string } | { readonly reason: string }> {
  if (refKind === 'branch') return { old: update.old, new: update.new };
  const head = await peeledCommit(rest, update.new);
  const old = update.old === null ? null : await peeledCommit(rest, update.old);
  if (head === null || (update.old !== null && old === null)) {
    return { reason: `${update.ref} cannot be reviewed: it does not point at a commit` };
  }
  return { old, new: head };
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

  /** Whether GitHub lists no branch at all: a new repository, empty or holding only tags. */
  async noBranch(): Promise<boolean> {
    return (await this.branchHeads()).size === 0;
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

/**
 * What a create brings to a repository with no branch: nothing is there to
 * compare it with, so everything is new — every commit of its history and
 * every path of its tree, as GitHub holds them (the pack is stored there
 * already). The same limits as a comparison, with what to do instead: push
 * an earlier, smaller commit first, then the rest compares with it.
 */
async function wholeHistory(rest: GithubRest, head: string, label: string): Promise<Comparison> {
  const smaller = `push an earlier commit first (git push origin <commit>:${label}), then the rest`;
  const shas: string[] = [];
  for (let page = 1; shas.length <= COMMITS_REVIEWED_MAX; page += 1) {
    const ancestors = await rest.ancestors(head, page);
    shas.push(...ancestors);
    if (ancestors.length < ANCESTORS_PAGE_SIZE) break;
  }
  if (shas.length > COMMITS_REVIEWED_MAX) {
    return {
      ok: false,
      reason: `${label} is too large to review as the first branch of the repository (more than ${COMMITS_REVIEWED_MAX} commits); ${smaller}`,
    };
  }
  const commit = await rest.gitObject(head);
  const files =
    commit?.kind !== 'commit'
      ? null
      : commit.tree === EMPTY_TREE
        ? []
        : await rest.treePaths(commit.tree);
  if (files === null) {
    return {
      ok: false,
      reason: `${label} cannot be reviewed: GitHub did not list the files of ${head.slice(0, 12)}`,
    };
  }
  if (files.length >= COMPARE_MAX_FILES) {
    return {
      ok: false,
      reason: `${label} is too large to review as the first branch of the repository (${COMPARE_MAX_FILES} or more files); ${smaller}`,
    };
  }
  // Oldest first, as the compare API lists them.
  return { ok: true, status: 'ahead', commits: shas.length, shas: shas.reverse(), files };
}

/**
 * git's empty tree, the tree of a commit made with `--allow-empty` on nothing
 * (the usual "Initial commit" of a new repository): no path by definition, so
 * the review never asks GitHub to list it.
 */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

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
  // What is compared: the commits, an annotated tag peeled to the one it names.
  const commits = await reviewedCommits(rest, pushed.refKind, { ...update, new: update.new });
  if ('reason' in commits) return commits;
  const head = commits.new;
  /** The narrowest comparison from the nearest branch heads, or `null` when none was found. */
  const fromNearestBranch = async (exclude: string | null): Promise<Comparison | null> => {
    const candidates = await bases.nearest(head, exclude);
    if (candidates.length === 0) return null;
    return narrowest(await Promise.all(candidates.map((base) => rest.compare(base, head, label))));
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
    return base === null ? null : rest.compare(base, head, label);
  };

  if (commits.old === null && (await bases.noBranch())) {
    // The first branch of a new repository: nothing to compare it with.
    const whole = await wholeHistory(rest, head, label);
    if (!whole.ok) return { reason: whole.reason };
    return { update, kind: 'create', compared: [whole] };
  }

  if (commits.old === null) {
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
  const old = commits.old;
  const fromOld = await rest.compare(old, head, label);
  const { status } = fromOld;
  const fastForward = pushed.refKind === 'branch' && (status === 'ahead' || status === 'identical');
  const kind: GitUpdateKind = fastForward ? 'fast-forward' : 'force';
  // One commit on top of `old` is already the narrowest range; otherwise (a
  // merge of another branch, a rebase onto it) the nearest branch may hold most
  // of what the range lists.
  const broad = !fromOld.ok || fromOld.commits > 1;
  const others = broad ? [await fromNearestBranch(old), await fromDefaultBranch()] : [];
  const forward = narrowest([fromOld, ...others.filter((c): c is Comparison => c !== null)]);
  if (!forward.ok) return { reason: forward.reason };
  if (fastForward) return { update, kind, compared: [forward] };
  // A rewrite can also take back what the old history had: both sides count.
  const backward = await rest.compare(head, old, label);
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
