/**
 * The review of a push (ADR gateway-as-git-remote D4): what each ref update
 * brings, read from GitHub once the pack is stored there under a temporary
 * ref. Reads only.
 *
 *   stale        the client's `old` is a claim: the ref is read at GitHub and
 *                a different value refuses the push ("stale info");
 *   base         what the push brings is reviewed from the nearest existing
 *                branch it was built on (`BaseFinder`, reasoning there), or
 *                from the default branch (a create) / `old` (an update);
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
import {
  parseAdvertisement,
  UPLOAD_PACK_SERVICE,
  UpstreamHttpError,
  type ExecuteContext,
  type GitRefUpdate,
  type GitReview,
  type GitReviewedUpdate,
  type GitUpdateKind,
} from '@vaubaan/plugin-sdk';

import { isUnderWorkflowDirectory, repoFullName } from './call.ts';
import { GITHUB_WEB_BASE } from './credential.ts';
import { GIT_PUSH_TOOL, pushedRef } from './git-call.ts';
import { gitGrant, targetOf, upstream } from './git-credential.ts';
import { ANCESTORS_PAGE_SIZE, COMMIT_MAX_FILES, GithubRest, type Comparison } from './git-rest.ts';
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

  /** The object ids the repository's branches point at now (its upload-pack advertisement). */
  private branchHeads(): Promise<ReadonlySet<string>> {
    this.heads ??= (async () => {
      const remote = await upstream(this.ctx, this.repository, 'read');
      const res = await this.ctx.fetch(`${remote.url}/info/refs?service=${UPLOAD_PACK_SERVICE}`, {
        method: 'GET',
        headers: { Authorization: remote.authorization },
        ...(this.ctx.signal ? { signal: this.ctx.signal } : {}),
      });
      if (!res.ok) {
        await res.body?.cancel();
        throw new UpstreamHttpError(`github info/refs answered HTTP ${res.status}`, res.status);
      }
      const ad = parseAdvertisement(new Uint8Array(await res.arrayBuffer()));
      return new Set(ad.refs.filter((r) => r.name.startsWith(BRANCH_PREFIX)).map((r) => r.oid));
    })();
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

const BRANCH_PREFIX = 'refs/heads/';

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

  if (update.old === null) {
    // A create brings what no branch holds: compared with the nearest branch it
    // was built on, or — none found — with the default branch.
    const nearest = await fromNearestBranch(null);
    let forward = nearest;
    if (forward === null || !forward.ok) {
      const base = await defaultBranch();
      if (base === null && forward === null) {
        return {
          reason: `${label} cannot be reviewed: the repository has no branch to compare it with`,
        };
      }
      const fromDefault = base === null ? null : await rest.compare(base, update.new, label);
      forward = narrowest([forward, fromDefault].filter((c): c is Comparison => c !== null));
    }
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
  const nearest = broad ? await fromNearestBranch(update.old) : null;
  const forward = narrowest([fromOld, ...(nearest ? [nearest] : [])]);
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
