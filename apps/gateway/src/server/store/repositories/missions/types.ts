import type {
  Gate,
  Iso,
  MissionAccountInput,
  MissionIssuerRecord,
  MissionMemberRecord,
  MissionPolicyEntry,
  MissionPolicyLineInput,
  MissionRecord,
  MissionResourceSource,
  MissionStatus,
  MissionTokenRecord,
  MissionTrustMarkRecord,
  NewEvent,
  RequestLine,
  RiskId,
  TokenHolderRecord,
} from '../../types.ts';
import type { EventScope } from '../mission-logs.ts';

export interface CreateMissionInput {
  readonly name: string;
  readonly creatorUserId: string;
  /** Start of the first period; defaults to the creation instant. */
  readonly periodAnchor?: Iso;
  /** Period length in seconds; null for a one-off mission. */
  readonly periodSeconds: number | null;
  readonly expiresAt?: Iso | null;
  /** The mission whose agent issued this one through its `vaubaan` account. */
  readonly issuedByMissionId?: string | null;
  /**
   * Every account with its sets and their lines (`resourceSets`), or with its
   * selection directly: it then has one set, whose lines are the `policy` lines of its
   * service.
   */
  readonly accounts: readonly MissionAccountInput[];
  /**
   * The lines of the accounts given without sets, placed in the set of the
   * account of their service (the first segment of the risk id). Every id must be in
   * the catalog; a line no account is for is refused.
   */
  readonly policy?: readonly MissionPolicyLineInput[];
}

export interface IssueTokenInput {
  readonly missionId: string;
  readonly prefix: string;
  readonly hash: string;
  readonly hashAlg: string;
  /** Who the token belongs to. */
  readonly holder: TokenHolderRecord;
  /** The user who generates or creates it. */
  readonly createdBy: string;
  /**
   * A named token this one replaces (the creator's "Replace key" on a machine key):
   * its id. The old token is retired (`rotated`) and the new one inserted under the
   * same name in ONE transaction, so there is no instant at which the name is free
   * or two keys of it work. The holder must be that token's name.
   */
  readonly replacing?: string;
}

export interface AddedMember {
  readonly member: MissionMemberRecord;
  /** A working token that predated the membership, revoked with it; normally `null`. */
  readonly tokenRevoked: MissionTokenRecord | null;
}

export interface IssuedToken {
  readonly token: MissionTokenRecord;
  /** The holder's previous active token, now `rotated`; `null` for a first token. */
  readonly replaced: MissionTokenRecord | null;
}

export interface AddMemberInput {
  readonly missionId: string;
  readonly userId: string;
  readonly addedBy: string;
}

export interface RemovedMember {
  readonly member: MissionMemberRecord;
  /** The member's active token, revoked in the same transaction; `null` when they had none. */
  readonly tokenRevoked: MissionTokenRecord | null;
}

/** The call that created the resources `addResources` adds (source `created`). */
export interface CreatedBy {
  readonly tool: string;
  /** The human behind the call's key. */
  readonly actorUserId: string | null;
}

/** What `addResources` did on one account of a mission. */
export interface AddedMissionResources {
  /** The set each given resource is in after the write, in the given order. */
  readonly placed: readonly { readonly resourceId: string; readonly resourceSetId: string }[];
  /** The ids written now, in the given order; an id already selected is not repeated. */
  readonly added: readonly string[];
}

/** Why a resource joined or left a set of a running mission after issuance. */
export type ResourceMoveReason = 'discovered' | 'relabelled';

/** A resource of an account that appeared, or whose effective environment changed. */
export interface ResourceChange {
  readonly resourceId: string;
  readonly reason: ResourceMoveReason;
}

/** One join or leave `applyResourceChanges` wrote. */
export interface ResourceMove {
  readonly missionId: string;
  readonly accountId: string;
  readonly resourceSetId: string;
  readonly resourceId: string;
  readonly ref: string;
  readonly change: 'joined' | 'left';
  readonly reason: ResourceMoveReason;
}

/** What the `missions.status` column may hold: every `MissionStatus` but the derived one. */
export type StoredMissionStatus = Exclude<MissionStatus, 'orphaned'>;

/**
 * One token, named by its mission and its id together: no repository method reads or
 * changes a token by its id alone, so a caller that forgot to check the mission
 * reaches nothing (security audit 2026-10-31, L8). A token of another mission reads
 * as missing.
 */
export interface MissionTokenKey {
  readonly missionId: string;
  readonly tokenId: string;
}

export interface MissionsRepo {
  /**
   * The creator's edit of the whole mission after issuance (ADR
   * mission-editable-after-issuance): the mission becomes `accounts` and `policy`,
   * named `name`, expiring at `expiresAt`. In one `BEGIN IMMEDIATE` transaction: the
   * mission is read again, and nothing is written (`null`) unless `actorUserId` is its
   * creator, its stored status is not `revoked` and `unchanged(mission)` holds — the
   * edit was judged against that very state. Only the rows that move are written: a
   * kept account or resource row is not rewritten (it keeps its `source`), and a
   * resource row the edit adds carries `source = 'edit'`. An expiry moved into the future
   * (or removed) brings a mission stored `expired` back to `active`. Open claims and
   * approval requests about a removed risk are closed (`refused`, `mission-changed`),
   * unconsumed approvals covering one are retired, and, when the mission has a
   * mission log, one event per risk that moved is recorded (`permission-added`,
   * `permission-removed`, `limits-changed`, `gate-changed`), the closed requests'
   * `request` events, then `summary(requestsClosed)`.
   */
  edit(id: string, edit: MissionEditInput): Promise<MissionEditResult | null>;
  /**
   * Replaces the whole policy (every line names a set of the mission) when the stored one
   * is still `expected`; with `requestId`, grants that open permission request, whose
   * every line must be in `policy`. `null` (nothing written) otherwise.
   */
  changePermissions(
    id: string,
    policy: readonly MissionPolicyEntry[],
    expected: readonly MissionPolicyEntry[],
    actor: string,
    requestId?: string,
  ): Promise<MissionRecord | null>;
  create(input: CreateMissionInput): Promise<MissionRecord>;
  /**
   * Adds resources of one of the mission's accounts to the list of one of its sets,
   * each row marked with `source` (ADR created-resources-join-the-mission: `created` for
   * a resource the mission created). The set of each resource follows `judgedSetIds`,
   * the sets the creating call was judged against (risk model §4.7): exactly one, that
   * set; several, the candidate with future on in the resource's environment, else a
   * candidate in its environment, else the first candidate by position — never a set the
   * call was not judged against, so a resource made under a strict judgement never gets
   * a looser set's rights (it may then sit in a set of another environment: the next
   * edit refuses the set as mixed until it is relabelled or moved). Absent (or none of
   * them a set of that account any more): the same order over every set of the
   * account. An id already selected, in any set, keeps its row, its set and its
   * source. One transaction. `NotFoundError` when the mission does not carry the
   * account; `InvariantError` when a resource is not one of that account's. With
   * `created`, the mission log (when it has one) records a `resources-created`
   * event in the same transaction.
   */
  addResources(
    missionId: string,
    accountId: string,
    resourceIds: readonly string[],
    source: MissionResourceSource,
    created?: CreatedBy,
    judgedSetIds?: readonly string[],
  ): Promise<AddedMissionResources>;
  /**
   * Future resources (ADR resource-set-is-one-environment-with-optional-future-resources):
   * for every running mission (stored `active`, not past its expiry at `now`) with a set
   * on the account, in one transaction, each changed resource
   *
   *   leaves  the set holding it when it was relabelled and its effective environment is
   *           no longer the set's (a legacy `mixedEnv` set keeps it; a resource that
   *           appeared and is held already — placed by its creating call — stays);
   *   joins   the set with future on in its environment (else a legacy `mixedEnv` set
   *           with future on), unless a set of the mission holds it, it is hidden, or its
   *           id is in `neverJoin` (the instance's own) — row source `future`.
   *
   * Returns every move written, for the caller's audit. A resource of another
   * account, or unknown, is ignored.
   */
  applyResourceChanges(
    accountId: string,
    changes: readonly ResourceChange[],
    neverJoin: readonly string[],
  ): Promise<ResourceMove[]>;
  /**
   * The accounts a running mission's set with future on depends on (hourly
   * discovery), in id order.
   */
  accountsWithFutureSets(now: Iso): Promise<string[]>;
  getById(id: string): Promise<MissionRecord | null>;
  listForCreator(userId: string): Promise<MissionRecord[]>;
  /**
   * How many missions are active at `now`: stored `active` and not past their
   * expiry. Orphaned ones are derived elsewhere and still counted here: the
   * figure is the instance profile's bucket (spec §9), not an authority check.
   */
  countActive(now: Iso): Promise<number>;
  /** The missions this user is a current member of (never the ones they created). */
  listForMember(userId: string): Promise<MissionRecord[]>;
  listForAccount(accountId: string): Promise<MissionRecord[]>;
  /**
   * The missions of a Timeline scope (`EventScope`: created, current member of, or all)
   * that Activity's Overview shows: stored `active`, or with a call entry at or after
   * `calledSince`. Oldest first.
   */
  listInScope(scope: EventScope, calledSince: Iso): Promise<MissionRecord[]>;
  /**
   * The client behind each of these missions that was issued through the
   * management door, keyed by mission id. A mission issued in the interface
   * has no entry.
   */
  issuersOf(missionIds: readonly string[]): Promise<Map<string, MissionIssuerRecord>>;
  /**
   * `orphaned` is not a stored status (spec §2.3: derived from the creator's current
   * authority, never stored as a verdict): the type refuses it here, and the trigger of
   * migration 0007 refuses it in the table.
   */
  setStatus(id: string, status: StoredMissionStatus): Promise<MissionRecord>;
  setExpiresAt(id: string, expiresAt: Iso | null): Promise<MissionRecord>;
  /**
   * The creator enlarges or shrinks the mission; the whole policy is replaced atomically.
   * Each line names a set of the mission (`resourceSetId`).
   */
  replacePolicy(id: string, policy: readonly MissionPolicyEntry[]): Promise<MissionRecord>;
  /**
   * Sets the gate of one accepted line (spec §3.5 "at issuance, or later") and, when the
   * mission has a mission log, records the `gate-changed` event in the same transaction: the
   * event is what ends a gate opening granted earlier in the period, so the two must not
   * come apart. The line is a risk in a set, or a risk alone when exactly one set of the
   * mission accepts it. Returns the gate the line had; `null` (nothing written) when it
   * is not in the mission's policy, or the risk alone names several lines. Setting the
   * gate it already has writes nothing.
   */
  setGate(
    id: string,
    line: RiskId | RequestLine,
    gate: Gate,
    actorUserId: string,
    options?: SetGateOptions,
  ): Promise<{
    readonly mission: MissionRecord;
    readonly previous: Gate;
    /** A `gate-changed` event was recorded although the stored gate did not move. */
    readonly openingClosed: boolean;
  } | null>;
  /**
   * Changes the limits of accepted risks after issuance (the creator's "Change limits"):
   * the quota per period and the number of calls of the rate window, nothing else — the
   * rate window, the gate and the list of accepted risks stay as they are. In one
   * transaction: every listed risk is read, the ones whose values move are written, and,
   * when the mission has a mission log, one `limits-changed` event per changed risk is
   * recorded. Returns each listed risk with its limits before and after; `null` (nothing
   * written) when a listed risk is not in the mission's policy. The budget reads the
   * policy rows inside its own decision transaction, so no call decided after this
   * commit sees the old values.
   */
  setLimits(
    id: string,
    changes: readonly LimitChange[],
    actorUserId: string,
  ): Promise<{
    readonly mission: MissionRecord;
    readonly changes: readonly AppliedLimitChange[];
  } | null>;
  /**
   * Issues a token to one holder. A member's previous active token becomes `rotated`
   * in the same transaction (at most one active token per member of a mission); the
   * tokens of the other holders are untouched. A named token whose name an active
   * token of the mission already carries is refused
   * (`TokenNotIssuableError('name-taken')`): a name identifies one token. So is a
   * token on a mission whose stored status is not `active`, or for a holder who is
   * not on the mission: both are read again inside the transaction.
   */
  issueToken(input: IssueTokenInput): Promise<IssuedToken>;
  findTokenByPrefix(
    prefix: string,
  ): Promise<{ token: MissionTokenRecord; mission: MissionRecord } | null>;
  /** The token, if it belongs to that mission; `null` otherwise. */
  getToken(key: MissionTokenKey): Promise<MissionTokenRecord | null>;
  /** Every token of the mission, whatever its status, oldest first. */
  listTokens(missionId: string): Promise<MissionTokenRecord[]>;
  /** Revokes every non-retired token of the mission; returns how many were revoked. */
  revokeTokens(missionId: string): Promise<number>;
  /**
   * Revokes one active token of that mission; `null` (nothing written) when it is not
   * active, unknown, or another mission's.
   */
  revokeToken(key: MissionTokenKey): Promise<MissionTokenRecord | null>;
  /**
   * Revokes every active member token this user holds on a mission they did not
   * create — the tokens of a deactivated member. Their tokens on their own missions
   * are left alone: those missions read `orphaned` by the derived rule and serve
   * again, same token, if the user is reactivated. Returns the revoked rows.
   */
  revokeMemberTokensOf(userId: string): Promise<MissionTokenRecord[]>;
  /**
   * Records that the door authenticated a call with this token. Written at most once
   * per `granularitySeconds`: the column says "about when", not "exactly when", so a
   * busy agent does not turn every call into a write. Returns whether a row was written.
   */
  markTokenUsed(key: MissionTokenKey, granularitySeconds: number): Promise<boolean>;

  /**
   * Gives a user access to the mission. Adding a removed member again clears
   * `removed_at` (their old token stays revoked). The creator is never a row: adding
   * them is refused (`InvariantError`). A member starts with no token: a working
   * member token of that user found on the mission is revoked in the same
   * transaction and returned (`tokenRevoked`), `null` when there was none.
   */
  addMember(input: AddMemberInput): Promise<AddedMember>;
  /**
   * Removes a current member and revokes their active token, in one transaction: there
   * is no instant at which a removed member still holds a working token. `null` when
   * the user is not a current member.
   */
  removeMember(missionId: string, userId: string): Promise<RemovedMember | null>;
  /** The member's row, removed or not; `null` when the user was never a member. */
  getMember(missionId: string, userId: string): Promise<MissionMemberRecord | null>;
  /** The current members, in the order they were added. Never the creator. */
  listMembers(missionId: string): Promise<MissionMemberRecord[]>;
  /** The trust-raise marks of the mission's sets (risk model §4.7). */
  trustMarks(missionId: string): Promise<MissionTrustMarkRecord[]>;
  /**
   * "Not now" on a trust-raise proposal: stamps the macro-action of the set as put off
   * now. `false` (nothing written) when the set is not the mission's.
   */
  snoozeTrustRaise(
    missionId: string,
    resourceSetId: string,
    macroActionId: string,
  ): Promise<boolean>;
}

/** What `MissionsRepo.edit` makes of a mission. */
export interface MissionEditInput {
  readonly actorUserId: string;
  /** The state the edit was judged against still stands; read inside the transaction. */
  readonly unchanged: (current: MissionRecord) => boolean;
  readonly name: string;
  readonly expiresAt: Iso | null;
  /**
   * Every account of the mission after the edit, with its sets in order and their
   * lines: a set with the `id` of a stored set of that account is that set (its
   * counters and requests follow it); any other is a new set. An account given with
   * its selection directly (one set, lines in `policy`) keeps the account's one
   * stored set, when it has one.
   */
  readonly accounts: readonly MissionAccountInput[];
  /** The lines of the accounts given without sets, as `CreateMissionInput.policy`. */
  readonly policy?: readonly MissionPolicyLineInput[];
  /** The mission log's summary event of the edit, given how many requests it closed. */
  readonly summary: (requestsClosed: number) => NewEvent;
  /**
   * The version this edit restores (a rollback, spec §4.2 "History"): the version it
   * leaves says so. Absent for an ordinary edit.
   */
  readonly restoredFrom?: number;
  /**
   * The mission whose key made the edit through the `vaubaan` plugin, for the creator
   * (`actorUserId`): the version it leaves names that mission as its author. Absent
   * for an edit by the person.
   */
  readonly viaMissionId?: string;
}

export interface MissionEditResult {
  readonly before: MissionRecord;
  readonly mission: MissionRecord;
  /** The open requests the edit made moot, now closed. */
  readonly closedRequests: readonly { readonly id: string; readonly kind: string }[];
}

/** The new limits of one accepted line (`MissionsRepo.setLimits`). */
export interface LimitChange {
  /** The set of the line; absent when exactly one set of the mission accepts the risk. */
  readonly resourceSetId?: string;
  readonly riskId: RiskId;
  readonly quota: number;
  /** Calls allowed per rate window; the window itself does not change. */
  readonly rateLimit: number;
}

/** One listed line as `setLimits` found it and left it. */
export interface AppliedLimitChange {
  readonly resourceSetId: string;
  readonly riskId: RiskId;
  readonly before: { readonly quota: number; readonly rateLimit: number };
  readonly after: { readonly quota: number; readonly rateLimit: number };
  /** Its stored window, unchanged: what `rateLimit` counts over. */
  readonly rateWindowSeconds: number;
  /** False when the values asked were the ones it had: nothing was written for it. */
  readonly changed: boolean;
}

export interface SetGateOptions {
  /**
   * The caller found the gate of this risk open for the period (a `gate-opened` event
   * later than its last `gate-changed`): when the stored gate is already `approval`
   * and `approval` is asked, a `gate-changed` event is still recorded, which is what
   * ends an opening. Without it the edit would be a silent no-op and the opening stay.
   */
  readonly closeOpening?: boolean;
}
