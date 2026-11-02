/**
 * `GitRemoteCapability` — what a plugin declares so that the instance can be
 * its agents' git remote (`https://<instance>/git/<provider id>/<repository>.git`).
 *
 * Spec : docs/spec/vaubaan-gateway.md §4.1 ter "Git remote" (the second door
 *        of the execution surface), §2.4.
 * ADR  : docs/decisions/gateway-as-git-remote.md,
 *        docs/decisions/protocol-doors-belong-to-the-host.md.
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
 *   - the inspection of a push's own objects before anything is sent
 *     (`inspectPack`) : whether each update's tip changes the CI workflow
 *     definitions, from objects the host hashed itself ;
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
import type { GitPackObjects } from './pack.ts';
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

/**
 * What a push's own objects change in the paths the provider guards (CI
 * workflow definitions), per ref update, read before the pack leaves the
 * gateway (ADR gateway-as-git-remote). `workflow_files` is
 * empty when the tip of the update provably leaves them as they are.
 */
export interface GitInspectedUpdate {
  readonly ref: string;
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

/**
 * What one permission of the catalog means for git, in the interface's words
 * ("push to branches named feature/*, fix/*…"). The mission page sorts these
 * lines into "can", "asks you first" and "cannot" from the mission's policy:
 * the plugin says what each permission is for git, the policy says whether
 * the mission holds it.
 */
export interface GitAbility {
  readonly risk_id: string;
  /** A verb phrase completing "With git, the agent can …" (`push tags`). */
  readonly words: string;
}

export interface GitRemoteCapability {
  /** Audited name of a fetch (`github__git_fetch`) ; classified, never executed by `execute`. */
  readonly fetchTool: string;
  /** Audited name of a push (`github__git_push`) ; classified and executed. */
  readonly pushTool: string;
  /**
   * The permission every push touches (`github.git-push`). A mission that
   * does not hold it is refused the push advertisement itself, before any
   * write credential is minted for it.
   */
  readonly pushRisk: string;
  /**
   * The resource ref of the repository a URL path names (`acme/app` for
   * `/git/github/acme/app.git`: the provider segment and the `.git` suffix
   * already removed), or `null` when
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
  /**
   * What the updates of a push change in the CI workflow definitions, decided
   * from the push's own objects (`objects`, hashed by the host) and the
   * provider's existing ones — BEFORE the pack is stored at the provider, so
   * that a mission that may not change CI is refused with nothing sent.
   * Fail closed: whatever cannot be determined (an object neither in the pack
   * nor at the provider, a provider error, a limit) counts as changed. A
   * throw refuses the push. Reads only. Absent: the plugin guards no path.
   */
  inspectPack?(
    ctx: ExecuteContext,
    repository: string,
    updates: readonly GitRefUpdate[],
    objects: GitPackObjects,
  ): Promise<readonly GitInspectedUpdate[]>;
  /**
   * Whether the provider credential of this connection can carry the push,
   * asked once the mission has decided on what the inspection found and
   * BEFORE the pack is stored at the provider: the sentence that refuses it
   * (a permission the account lacks, by name), or `null`. The mission's
   * decision never depends on it — it is asked after the precheck — and the
   * host asks `upstream` again afterwards, so a credential renewed here is
   * the one the pack is sent with. A throw refuses the push. Absent: the
   * provider's own refusal, once the pack is sent, is the only one.
   */
  admitPush?(
    ctx: ExecuteContext,
    repository: string,
    updates: readonly GitInspectedUpdate[],
  ): Promise<string | null>;
  /**
   * The prefix of the provider's own git URLs (`https://github.com/`). The
   * setup kit rewrites it to the instance (`url.<instance>/git/<provider id>/.insteadOf`),
   * so a hard-coded provider URL, a submodule or a script goes through the
   * mission too. Absent: the kit offers no rewrite.
   */
  readonly insteadOf?: string;
  /** What the permissions of the catalog mean for git, most common first. */
  readonly abilities?: readonly GitAbility[];
  /** A page of the provider showing what an update brings, for the person who approves it. */
  compareUrl?(repository: string, update: GitReviewedUpdate): string | null;
}

/** Prefix of the temporary refs the host pushes a pack under ; never a valid target for an agent. */
export const GIT_TEMPORARY_REF_PREFIX = 'refs/vaubaan/';
