/**
 * The two tools of the GitHub git remote, and the one reader of their
 * arguments that `classify` and `execute` share.
 *
 * Spec : docs/spec/vaubaan-gateway.md §4.1 ter "Git remote" ;
 *        docs/spec/gateway-risk-model.md §7.
 * ADR  : docs/decisions/gateway-as-git-remote.md.
 *
 * Pure. The arguments are written by the host's git door, never by an
 * agent (the host refuses these tools on the MCP door) ; they are still
 * read with the grammars of `call.ts`, so a ref the classifier reasons about
 * is the ref `execute` moves, character for character.
 *
 *   github__git_fetch { repository, step }      — a clone or a fetch
 *   github__git_push  { repository, updates[] } — one push, every ref of it
 *
 * Only branches (`refs/heads/<branch>`) and tags (`refs/tags/<tag>`) can be
 * pushed. The gateway's temporary refs (`refs/vaubaan/…`) and every other
 * namespace (`refs/notes`, `refs/pull`, …) are refused.
 */

import {
  GIT_TEMPORARY_REF_PREFIX,
  GIT_UPDATE_KINDS,
  OID_SHAPE,
  printableRef,
} from '@vaubaan/plugin-sdk/git';
import type { GitReviewedUpdate, GitUpdateKind } from '@vaubaan/plugin-sdk/git';

import {
  branchName,
  repoFullName,
  repositoryNotSelectedMessage,
  tagName,
  type Denied,
  type RepoTarget,
} from './call.ts';

export const GIT_FETCH_TOOL = 'github__git_fetch';
export const GIT_PUSH_TOOL = 'github__git_push';

/** Ref updates one push may carry. git sends one per ref ; more is not a development push. */
export const MAX_GIT_PUSH_UPDATES = 50;
/** Paths an update may list : GitHub's compare stops at 300 files (the review refuses beyond). */
export const MAX_GIT_UPDATE_FILES = 300;

const BRANCH_PREFIX = 'refs/heads/';
const TAG_PREFIX = 'refs/tags/';
const FETCH_STEPS = ['refs', 'pack'] as const;

export type GitRefKind = 'branch' | 'tag';

/** One update of a push, with the branch or tag name it moves. */
export interface GitTargetUpdate {
  readonly refKind: GitRefKind;
  /** The branch or tag name, without `refs/heads/` or `refs/tags/`. */
  readonly name: string;
  readonly update: GitReviewedUpdate;
}

export type GitCall =
  | {
      readonly tool: typeof GIT_FETCH_TOOL;
      readonly target: RepoTarget;
      readonly step: (typeof FETCH_STEPS)[number];
    }
  | {
      readonly tool: typeof GIT_PUSH_TOOL;
      readonly target: RepoTarget;
      readonly updates: readonly GitTargetUpdate[];
    };

export function isGitTool(tool: string): tool is GitCall['tool'] {
  return tool === GIT_FETCH_TOOL || tool === GIT_PUSH_TOOL;
}

/** The sentence a refused ref gets ; git shows it on the `! [remote rejected]` line. */
export function refNotPushable(ref: string): string {
  if (ref.startsWith(GIT_TEMPORARY_REF_PREFIX)) {
    return `'${GIT_TEMPORARY_REF_PREFIX}' is reserved by the gateway; push to a branch or a tag`;
  }
  return 'only branches (refs/heads/...) and tags (refs/tags/...) can be pushed through the gateway';
}

/** The branch or tag a full ref name moves, or the reason it cannot be pushed. */
export function pushedRef(ref: string): { refKind: GitRefKind; name: string } | Denied {
  if (ref.startsWith(BRANCH_PREFIX)) {
    const name = branchName(ref.slice(BRANCH_PREFIX.length));
    if (name !== null) return { refKind: 'branch', name };
    return { denied: `'${printableRef(ref)}' is not a valid branch name` };
  }
  if (ref.startsWith(TAG_PREFIX)) {
    const name = tagName(ref.slice(TAG_PREFIX.length));
    if (name !== null) return { refKind: 'tag', name };
    return { denied: `'${printableRef(ref)}' is not a valid tag name` };
  }
  return { denied: refNotPushable(ref) };
}

/** Read the arguments of a git tool against the repositories of the mission. */
export function readGitCall(
  tool: GitCall['tool'],
  args: Readonly<Record<string, unknown>>,
  missionRepos: readonly string[],
): GitCall | Denied {
  const target = repoFullName(args.repository);
  if (target === null || !missionRepos.includes(target.ref)) {
    return {
      denied: repositoryNotSelectedMessage(
        typeof args.repository === 'string' ? args.repository : '<none>',
        missionRepos,
      ),
    };
  }
  if (tool === GIT_FETCH_TOOL) {
    const step = FETCH_STEPS.find((s) => s === args.step);
    if (step === undefined) return { denied: `${tool} requires step 'refs' or 'pack'` };
    return { tool, target, step };
  }
  return readPush(target, args.updates);
}

function readPush(target: RepoTarget, raw: unknown): GitCall | Denied {
  if (!Array.isArray(raw) || raw.length === 0) {
    return { denied: `${GIT_PUSH_TOOL} requires a non-empty list of 'updates'` };
  }
  if (raw.length > MAX_GIT_PUSH_UPDATES) {
    return {
      denied: `a push may update at most ${MAX_GIT_PUSH_UPDATES} refs at once; this one updates ${raw.length}`,
    };
  }
  const updates: GitTargetUpdate[] = [];
  const seen = new Set<string>();
  for (const item of raw as readonly unknown[]) {
    const read = readUpdate(item);
    if ('denied' in read) return read;
    if (seen.has(read.update.ref)) {
      return { denied: `'${printableRef(read.update.ref)}' is updated twice in one push` };
    }
    seen.add(read.update.ref);
    updates.push(read);
  }
  return { tool: GIT_PUSH_TOOL, target, updates };
}

function readUpdate(item: unknown): GitTargetUpdate | Denied {
  if (typeof item !== 'object' || item === null || Array.isArray(item)) {
    return { denied: `${GIT_PUSH_TOOL}: each update must be an object` };
  }
  const u = item as Record<string, unknown>;
  if (typeof u.ref !== 'string') return { denied: `${GIT_PUSH_TOOL}: an update has no 'ref'` };
  const pushed = pushedRef(u.ref);
  if ('denied' in pushed) return pushed;
  const old = oidOrNull(u.old);
  const next = oidOrNull(u.new);
  const kind = GIT_UPDATE_KINDS.find((k) => k === u.kind);
  if (old === undefined || next === undefined || kind === undefined) {
    return {
      denied: `${GIT_PUSH_TOOL}: '${printableRef(u.ref)}' has a malformed old, new or kind`,
    };
  }
  if (!consistent(kind, old, next)) {
    return { denied: `${GIT_PUSH_TOOL}: '${printableRef(u.ref)}' is not a valid '${kind}' update` };
  }
  const commits = u.commits;
  if (typeof commits !== 'number' || !Number.isSafeInteger(commits) || commits < 0) {
    return { denied: `${GIT_PUSH_TOOL}: '${printableRef(u.ref)}' has a malformed commit count` };
  }
  const files = stringList(u.files);
  const workflowFiles = stringList(u.workflow_files);
  if (files === null || workflowFiles === null || files.length > MAX_GIT_UPDATE_FILES) {
    return { denied: `${GIT_PUSH_TOOL}: '${printableRef(u.ref)}' has a malformed list of files` };
  }
  return {
    ...pushed,
    update: {
      ref: u.ref,
      old,
      new: next,
      kind,
      commits,
      files,
      workflow_files: workflowFiles,
    },
  };
}

/** `create` adds a ref, `delete` removes one, the other two move one. */
function consistent(kind: GitUpdateKind, old: string | null, next: string | null): boolean {
  switch (kind) {
    case 'create':
      return old === null && next !== null;
    case 'delete':
      return old !== null && next === null;
    case 'fast-forward':
    case 'force':
      return old !== null && next !== null;
  }
}

/** An object id, `null` for "none", `undefined` when malformed. */
function oidOrNull(value: unknown): string | null | undefined {
  if (value === null) return null;
  return typeof value === 'string' && OID_SHAPE.test(value) ? value : undefined;
}

function stringList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return (value as readonly unknown[]).every((v) => typeof v === 'string')
    ? [...(value as string[])]
    : null;
}
