/**
 * `GitRemoteCapability` — what a plugin declares so that the instance can be
 * its agents' git remote (`https://<instance>/git/<repository>.git`).
 *
 * Spec : docs/spec/vaubaan-gateway.md §4.1 bis "Git remote" (the second door
 *        of the execution surface), §2.4.
 * ADR  : docs/decisions/gateway-as-git-remote.md.
 * Handbook : docs/handbook/git-remote.md.
 *
 * The host owns the transport : it authenticates the mission key, relays
 * fetches, reads a push's command list, stores the pack at the provider
 * under a temporary ref, and decides through the call pipeline like any
 * tool call. The plugin owns everything provider-shaped :
 *
 *   - which URL path names a repository, and its resource ref ;
 *   - the upstream endpoint and the credential to present there, minted or
 *     decrypted in memory from the connection (`upstream`) — the key of the
 *     agent never reaches the provider, the provider's credential never
 *     reaches the agent ;
 *   - the review of a push before the decision (`review`) : for each ref,
 *     fast-forward or not, how many commits, which files, which of them are
 *     CI workflow files — read from the provider, never from the pack ;
 *   - the two tools the pipeline decides and audits : `fetchTool` (never
 *     executed by `execute` : the host relays the bytes) and `pushTool`,
 *     whose `execute` moves the real refs with the reviewed old ids as
 *     compare-and-swap values.
 *
 * Neither tool is listed in `tools` nor callable over MCP : the host
 * refuses them on the MCP door and refuses every other tool on the git
 * door, so the arguments of a push are always the host's review, never an
 * agent's claim.
 */

import type { ExecuteContext } from '../plugin.ts';
import type { GitUpstream } from './receive-pack.ts';

/** What the upstream credential is for : reading refs and packs, or writing refs. */
export type GitAccess = 'read' | 'write';

/** One ref update of a push, as git sent it ; `null` is the zero id. */
export interface GitRefUpdate {
  /** Full ref name (`refs/heads/feature/x`, `refs/tags/v1.2.0`). */
  readonly ref: string;
  readonly old: string | null;
  readonly new: string | null;
}

export const GIT_UPDATE_KINDS = ['create', 'fast-forward', 'force', 'delete'] as const;
export type GitUpdateKind = (typeof GIT_UPDATE_KINDS)[number];

/**
 * A ref update after review : what the pipeline classifies and the creator
 * reads on an approval request. Deterministic for a given `(ref, old, new)`
 * so that the same push, sent again, has the same fingerprint.
 */
export interface GitReviewedUpdate extends GitRefUpdate {
  readonly kind: GitUpdateKind;
  /** Commits the update brings that the base did not have. */
  readonly commits: number;
  /** Paths the update changes, sorted ; renames list both names. */
  readonly files: readonly string[];
  /** The subset of `files` that are CI workflow definitions. */
  readonly workflow_files: readonly string[];
}

export type GitReview =
  | { readonly ok: true; readonly updates: readonly GitReviewedUpdate[] }
  /** The push cannot be reviewed (too large, unrelated history) : the host refuses it, fail closed. */
  | { readonly ok: false; readonly reason: string };

/** Arguments of the fetch tool, built by the host. */
export interface GitFetchArguments {
  readonly repository: string;
  /** `refs` (the advertisement or `ls-refs`) or `pack` (objects). */
  readonly step: 'refs' | 'pack';
}

/** Arguments of the push tool, built by the host from the review. */
export interface GitPushArguments {
  readonly repository: string;
  readonly updates: readonly GitReviewedUpdate[];
}

/** Outcome of the push tool, per ref, in the text of its result (JSON). */
export interface GitPushResult {
  readonly updates: readonly {
    readonly ref: string;
    readonly ok: boolean;
    readonly error?: string;
  }[];
}

export interface GitRemoteCapability {
  /** Audited name of a fetch (`github__git_fetch`) ; classified, never executed by `execute`. */
  readonly fetchTool: string;
  /** Audited name of a push (`github__git_push`) ; classified and executed. */
  readonly pushTool: string;
  /**
   * The resource ref of the repository a URL path names (`acme/app` for
   * `/git/acme/app.git`, the `.git` suffix already removed), or `null` when
   * the path names no repository of this provider. Pure.
   */
  repositoryOf(path: string): string | null;
  /** The upstream repository endpoint and the credential to present there, for this access. */
  upstream(ctx: ExecuteContext, repository: string, access: GitAccess): Promise<GitUpstream>;
  /**
   * Review the updates of a push whose objects the provider already holds
   * (the host stored the pack under temporary refs first). Reads only.
   */
  review(
    ctx: ExecuteContext,
    repository: string,
    updates: readonly GitRefUpdate[],
  ): Promise<GitReview>;
  /** A page of the provider showing what an update brings, for the person who approves it. */
  compareUrl?(repository: string, update: GitReviewedUpdate): string | null;
}

/** Prefix of the temporary refs the host pushes a pack under ; never a valid target for an agent. */
export const GIT_TEMPORARY_REF_PREFIX = 'refs/vaubaan/';
