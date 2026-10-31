/**
 * The inspection of a push before it leaves the gateway (ADR
 * gateway-as-git-remote): does the tip of each ref update
 * change the CI workflow definitions (`.github/workflows/`)? Decided from the
 * push's own objects — hashed by the host, so found only under the id their
 * content hashes to — and from GitHub's existing objects, read with the read
 * grant. Nothing is sent before the answer.
 *
 * What is compared — the guarded state of a commit:
 *
 *   every root entry named `.github` (any case: the REST path matches
 *   `.github/workflows/` without case too), and when it is a directory every
 *   entry in it named `workflows` (any case) — each as name, mode and object
 *   id. Two commits with the same state run the same workflows; a changed
 *   file, an added or deleted one, a rename into or out of the directory, a
 *   mode change, a symlink in place of the directory: all change an id.
 *
 * Against what — the bases of an update:
 *
 *   update   the ref's current value as the client claims it (`old`); the
 *            review refuses later a claim GitHub contradicts (stale info);
 *   create   the default branch's head (no branch at all: no workflows);
 *   both     and any current branch head that a commit of the push builds on
 *            directly — the parents of the push's own commits that the pack
 *            does not hold, at most `INSPECT_HEAD_BASES_MAX` of them. What a
 *            branch already runs is not a change (ADR gateway-as-git-remote
 *            D4 ter: a merge of a moved branch is not asked again). Only
 *            current heads: an older commit, an object left by a refused
 *            push or one of a fork network is never a base — the revert to
 *            an old workflows tree is seen.
 *
 * Only the tip of each update is compared: GitHub runs the workflows of the
 * pushed tip, never those of an intermediate commit. The review (after the
 * store) still counts intermediate commits, as before.
 *
 * Fail closed: a state that cannot be read (an object neither in the pack
 * nor at GitHub, a GitHub error, a truncated tree, a tag chain too deep)
 * counts as a change of `.github/workflows/`.
 */
import { type ExecuteContext } from '@vaubaan/plugin-sdk';
import {
  parseCommit,
  parseTag,
  parseTree,
  TREE_MODE,
  type GitInspectedUpdate,
  type GitPackObjects,
  type GitRefUpdate,
  type GitTreeEntry,
} from '@vaubaan/plugin-sdk/git';

import { targetOf } from './git-credential.ts';
import { GithubRest } from './git-rest.ts';
import { branchHeads } from './git-heads.ts';

/** What an update reports when its workflows could not be compared. */
export const WORKFLOWS_UNVERIFIED = '.github/workflows/';
/** Branch heads under the push's own commits taken as bases, at most. */
export const INSPECT_HEAD_BASES_MAX = 5;
/** Commits of the pack walked to find the heads it builds on, at most. */
export const INSPECT_WALK_MAX = 10_000;
/** Annotated tags peeled one inside the other, at most. */
const TAG_DEPTH_MAX = 4;

const GITHUB_DIRECTORY = '.github';
const WORKFLOWS_DIRECTORY = 'workflows';

/** One guarded entry of a commit: `.github` itself when not a directory, or a `workflows` in it. */
interface Guarded {
  readonly path: string;
  readonly mode: string;
  readonly oid: string;
}

/** The guarded state of a commit, its entries sorted by path. */
interface GuardedState {
  readonly entries: readonly Guarded[];
}

const NO_WORKFLOWS: GuardedState = { entries: [] };

function sameState(a: GuardedState, b: GuardedState): boolean {
  return (
    a.entries.length === b.entries.length &&
    a.entries.every(
      (e, i) =>
        e.path === b.entries[i]!.path &&
        e.mode === b.entries[i]!.mode &&
        e.oid === b.entries[i]!.oid,
    )
  );
}

/** The push's own objects first, then GitHub's — each read once. */
class Objects {
  private readonly commits = new Map<
    string,
    Promise<{ tree: string; parents: readonly string[] } | null>
  >();
  private readonly trees = new Map<string, Promise<readonly GitTreeEntry[] | null>>();

  constructor(
    private readonly pack: GitPackObjects,
    private readonly rest: GithubRest,
  ) {}

  /** The commit an id names, annotated tags peeled; `null` when unknown or not a commit. */
  commit(oid: string): Promise<{ tree: string; parents: readonly string[] } | null> {
    let read = this.commits.get(oid);
    if (read === undefined) {
      read = this.peel(oid, 0);
      this.commits.set(oid, read);
    }
    return read;
  }

  private async peel(
    oid: string,
    depth: number,
  ): Promise<{ tree: string; parents: readonly string[] } | null> {
    if (depth > TAG_DEPTH_MAX) return null;
    const own = this.pack.get(oid);
    if (own !== undefined) {
      if (own.type === 'commit') return parseCommit(own.body);
      if (own.type !== 'tag') return null;
      const tag = parseTag(own.body);
      return tag === null ? null : this.peel(tag.object, depth + 1);
    }
    const read = await this.rest.gitObject(oid);
    if (read === null) return null;
    if (read.kind === 'commit') return { tree: read.tree, parents: read.parents };
    return this.peel(read.object, depth + 1);
  }

  tree(oid: string): Promise<readonly GitTreeEntry[] | null> {
    let read = this.trees.get(oid);
    if (read === undefined) {
      const own = this.pack.get(oid);
      read =
        own === undefined
          ? this.rest.gitTree(oid)
          : Promise.resolve(own.type === 'tree' ? parseTree(own.body) : null);
      this.trees.set(oid, read);
    }
    return read;
  }

  /** The guarded state of the commit `oid` names; `null` when it cannot be read. */
  async stateOf(oid: string): Promise<GuardedState | null> {
    const commit = await this.commit(oid);
    if (commit === null) return null;
    const root = await this.tree(commit.tree);
    if (root === null) return null;
    const entries: Guarded[] = [];
    for (const top of root.filter((e) => e.name.toLowerCase() === GITHUB_DIRECTORY)) {
      if (top.mode !== TREE_MODE) {
        entries.push({ path: top.name, mode: top.mode, oid: top.oid });
        continue;
      }
      const inside = await this.tree(top.oid);
      if (inside === null) return null;
      for (const w of inside.filter((e) => e.name.toLowerCase() === WORKFLOWS_DIRECTORY)) {
        entries.push({ path: `${top.name}/${w.name}`, mode: w.mode, oid: w.oid });
      }
    }
    entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return { entries };
  }

  /**
   * The parents of the push's own commits reachable from `oid` that the push
   * does not carry — what it builds on — `oid` itself when the push does not
   * carry it. Bounded by `INSPECT_WALK_MAX`: a longer walk returns what it
   * found, which only leaves fewer bases.
   */
  async boundaryOf(oid: string): Promise<readonly string[]> {
    const boundary: string[] = [];
    const seen = new Set<string>();
    const queue = [oid];
    while (queue.length > 0 && seen.size < INSPECT_WALK_MAX) {
      const next = queue.shift()!;
      if (seen.has(next)) continue;
      seen.add(next);
      const own = this.pack.get(next);
      if (own === undefined) {
        boundary.push(next);
        continue;
      }
      if (own.type === 'commit') queue.push(...(parseCommit(own.body)?.parents ?? []));
      if (own.type === 'tag') {
        const tag = parseTag(own.body);
        if (tag !== null) queue.push(tag.object);
      }
    }
    return boundary;
  }
}

/** The names that differ between two directory listings, under `path`. */
function changedNames(
  path: string,
  before: readonly GitTreeEntry[],
  after: readonly GitTreeEntry[],
): string[] {
  const key = (e: GitTreeEntry) => `${e.mode} ${e.oid}`;
  const was = new Map(before.map((e) => [e.name, key(e)]));
  const is = new Map(after.map((e) => [e.name, key(e)]));
  const names = new Set([...was.keys(), ...is.keys()]);
  return [...names].filter((n) => was.get(n) !== is.get(n)).map((n) => `${path}/${n}`);
}

/** The workflow paths that differ between two states, as precisely as GitHub's objects allow. */
async function changedPaths(
  objects: Objects,
  before: GuardedState | null,
  after: GuardedState,
): Promise<readonly string[]> {
  if (before === null) return [WORKFLOWS_UNVERIFIED];
  const paths = new Set<string>();
  const was = new Map(before.entries.map((e) => [e.path, e]));
  const is = new Map(after.entries.map((e) => [e.path, e]));
  for (const path of new Set([...was.keys(), ...is.keys()])) {
    const a = was.get(path);
    const b = is.get(path);
    if (a && b && a.mode === b.mode && a.oid === b.oid) continue;
    const listing = async (e: Guarded | undefined) =>
      e === undefined ? [] : e.mode === TREE_MODE ? await objects.tree(e.oid) : null;
    const [left, right] = await Promise.all([listing(a), listing(b)]);
    if (left === null || right === null) {
      paths.add(path.includes('/') ? path : WORKFLOWS_UNVERIFIED);
      continue;
    }
    const names = changedNames(path, left, right);
    if (names.length === 0) paths.add(`${path}/`);
    for (const n of names) paths.add(n);
  }
  return paths.size === 0 ? [WORKFLOWS_UNVERIFIED] : [...paths].sort();
}

interface Inspecting {
  readonly objects: Objects;
  readonly heads: () => Promise<ReadonlySet<string>>;
  readonly defaultHead: () => Promise<string | null>;
}

/** The workflow paths one update changes; empty when its tip runs what a base already runs. */
async function inspectOne(on: Inspecting, update: GitRefUpdate): Promise<readonly string[]> {
  if (update.new === null) return [];
  const { objects } = on;
  const tip = await objects.stateOf(update.new);
  if (tip === null) return [WORKFLOWS_UNVERIFIED];
  const primary = update.old ?? (await on.defaultHead());
  const before = primary === null ? NO_WORKFLOWS : await objects.stateOf(primary);
  if (before !== null && sameState(tip, before)) return [];
  const heads = await on.heads();
  const bases = (await objects.boundaryOf(update.new))
    .filter((oid) => oid !== primary && heads.has(oid))
    .slice(0, INSPECT_HEAD_BASES_MAX);
  for (const base of bases) {
    const state = await objects.stateOf(base);
    if (state !== null && sameState(tip, state)) return [];
  }
  return changedPaths(objects, before, tip);
}

const NO_OBJECTS: GitPackObjects = { get: () => undefined, size: 0, complete: true };

/**
 * The workflow paths one commit at GitHub changes, read by its trees: none
 * when its guarded state equals that of one of its parents (what it runs
 * comes from that parent, whose own commits are reviewed or already on a
 * branch); otherwise the paths that differ from its first parent. The
 * review's fallback for a commit whose file list GitHub truncates — a large
 * merge of a branch already at GitHub. Never throws: unknown is a change.
 */
export async function workflowPathsOfCommit(
  rest: GithubRest,
  sha: string,
): Promise<readonly string[]> {
  const objects = new Objects(NO_OBJECTS, rest);
  try {
    const commit = await objects.commit(sha);
    const state = await objects.stateOf(sha);
    if (commit === null || state === null) return [WORKFLOWS_UNVERIFIED];
    if (commit.parents.length === 0) {
      return sameState(state, NO_WORKFLOWS) ? [] : changedPaths(objects, NO_WORKFLOWS, state);
    }
    const parents = await Promise.all(commit.parents.map((p) => objects.stateOf(p)));
    if (parents.some((p) => p !== null && sameState(p, state))) return [];
    return await changedPaths(objects, parents[0] ?? null, state);
  } catch {
    return [WORKFLOWS_UNVERIFIED];
  }
}

/** `GitRemoteCapability.inspectPack` for GitHub. Never throws: what it cannot read counts as changed. */
export async function inspectPack(
  ctx: ExecuteContext,
  repository: string,
  updates: readonly GitRefUpdate[],
  pack: GitPackObjects,
): Promise<readonly GitInspectedUpdate[]> {
  const rest = new GithubRest(ctx, targetOf(repository));
  let heads: Promise<ReadonlySet<string>> | undefined;
  let defaultHead: Promise<string | null> | undefined;
  const on: Inspecting = {
    objects: new Objects(pack, rest),
    heads: () => (heads ??= branchHeads(ctx, repository)),
    defaultHead: () =>
      (defaultHead ??= (async () => {
        const name = await rest.defaultBranch();
        return name === null ? null : rest.refValue(`refs/heads/${name}`);
      })()),
  };
  const out: GitInspectedUpdate[] = [];
  for (const update of updates) {
    let workflowFiles: readonly string[];
    try {
      workflowFiles = await inspectOne(on, update);
    } catch {
      workflowFiles = update.new === null ? [] : [WORKFLOWS_UNVERIFIED];
    }
    out.push({ ref: update.ref, workflow_files: workflowFiles });
  }
  return out;
}
