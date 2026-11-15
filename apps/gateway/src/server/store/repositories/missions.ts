import { assertKnownRiskIds } from '../catalog-index.ts';
import { withImmediateTransaction } from '../db.ts';
import { InvariantError, NotFoundError, TokenNotIssuableError } from '../errors.ts';
import { isOnMission, membershipOf } from '../membership.ts';
import { MISSION_TOKEN_KINDS } from '@vaubaan/shared';

import {
  MISSION_RESOURCE_SOURCES,
  MISSION_TOKEN_STATUSES,
  USER_STATUSES,
  type Gate,
  type Iso,
  type MissionAccountInput,
  type MissionAccountRecord,
  type MissionIssuerRecord,
  type MissionMemberRecord,
  type MissionPolicyEntry,
  type MissionPolicyLineInput,
  type MissionRecord,
  type MissionResourceSetInput,
  type MissionResourceSetRecord,
  type MissionResourceSource,
  type MissionTrustMarkRecord,
  type RequestLine,
  type MissionStatus,
  type MissionTokenRecord,
  type NewEvent,
  type RiskId,
  type TokenHolderRecord,
} from '../types.ts';
import { nowIso, parseEnum, requireRow, type RepoContext } from './context.ts';
import { GATES, STORED_MISSION_STATUSES } from './enums.ts';
import { riskIdsOf } from './approvals.ts';
import { requestLinesOf, storedLinesOf } from './requests.ts';
import { createSessionPrimitives } from './sessions.ts';

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
   * session, one event per risk that moved is recorded (`permission-added`,
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
   * `created`, the mission's session (when it has one) records a `resources-created`
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
   * mission has a session, records the `gate-changed` event in the same transaction: the
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
   * when the mission has a session, one `limits-changed` event per changed risk is
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
  /** The session's summary event of the edit, given how many requests it closed. */
  readonly summary: (requestsClosed: number) => NewEvent;
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

interface MissionRow {
  id: string;
  name: string;
  creator_user_id: string;
  status: string;
  period_anchor: string;
  period_seconds: number | null;
  expires_at: string | null;
  issued_by_mission_id: string | null;
  issued_via_client_name: string | null;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
}

interface IssuerRow {
  mission_id: string;
  issued_by_mission_id: string | null;
  issuer_name: string | null;
  issued_via_client_name: string | null;
}

interface PolicyRow {
  resource_set_id: string;
  risk_id: string;
  quota: number;
  rate_limit: number;
  rate_window_seconds: number;
  gate: string;
}

interface AccountRow {
  account_id: string;
}

interface SetRow {
  id: string;
  account_id: string;
  position: number;
  future: number;
  env: string | null;
  mixed_env: number;
  trust_levels_json: string | null;
}

const SET_COLUMNS = 'id, account_id, position, future, env, mixed_env, trust_levels_json';

interface SelectedRow {
  resource_id: string;
  resource_set_id: string;
  source: string;
}

interface TokenRow {
  id: string;
  mission_id: string;
  prefix: string;
  hash: string;
  hash_alg: string;
  status: string;
  kind: string;
  holder_user_id: string | null;
  name: string | null;
  created_by: string;
  created_at: string;
  retired_at: string | null;
  last_used_at: string | null;
}

interface MemberRow {
  mission_id: string;
  user_id: string;
  added_by: string;
  added_at: string;
  removed_at: string | null;
}

const MS_PER_SECOND = 1000;

const COLUMNS = `id, name, creator_user_id, status, period_anchor, period_seconds, expires_at,
  issued_by_mission_id, issued_via_client_name, created_at, updated_at, closed_at`;
const TOKEN_COLUMNS = `id, mission_id, prefix, hash, hash_alg, status, kind, holder_user_id, name,
  created_by, created_at, retired_at, last_used_at`;
const MEMBER_COLUMNS = 'mission_id, user_id, added_by, added_at, removed_at';

/** The holder of a row. The schema's CHECK guarantees the pairing; a row that breaks it is corrupt. */
function holderOf(row: TokenRow): TokenHolderRecord {
  const kind = parseEnum(MISSION_TOKEN_KINDS, row.kind, 'mission_tokens.kind');
  if (kind === 'member') {
    if (row.holder_user_id === null) {
      throw new InvariantError(`mission_tokens ${row.id}: a member token without a holder`);
    }
    return { kind, userId: row.holder_user_id };
  }
  if (row.name === null) {
    throw new InvariantError(`mission_tokens ${row.id}: a named token without a name`);
  }
  return { kind, name: row.name };
}

function tokenToRecord(row: TokenRow): MissionTokenRecord {
  const holder = holderOf(row);
  return {
    id: row.id,
    missionId: row.mission_id,
    prefix: row.prefix,
    hash: row.hash,
    hashAlg: row.hash_alg,
    status: parseEnum(MISSION_TOKEN_STATUSES, row.status, 'mission_tokens.status'),
    kind: holder.kind,
    holder,
    createdBy: row.created_by,
    createdAt: row.created_at,
    retiredAt: row.retired_at,
    lastUsedAt: row.last_used_at,
  };
}

function memberToRecord(row: MemberRow): MissionMemberRecord {
  return {
    missionId: row.mission_id,
    userId: row.user_id,
    addedBy: row.added_by,
    addedAt: row.added_at,
    removedAt: row.removed_at,
  };
}

function policyToRecord(row: PolicyRow): MissionPolicyEntry {
  return {
    resourceSetId: row.resource_set_id,
    riskId: row.risk_id,
    quota: row.quota,
    rateLimit: row.rate_limit,
    rateWindowSeconds: row.rate_window_seconds,
    gate: parseEnum(GATES, row.gate, 'mission_policy.gate'),
  };
}

function setToRecord(row: SetRow, selected: readonly SelectedRow[]): MissionResourceSetRecord {
  const sources: Record<string, MissionResourceSource> = {};
  for (const r of selected) {
    const source = parseEnum(MISSION_RESOURCE_SOURCES, r.source, 'mission_resources.source');
    if (source !== 'issuance') sources[r.resource_id] = source;
  }
  return {
    id: row.id,
    position: row.position,
    resourceIds: selected.map((r) => r.resource_id),
    future: row.future === 1,
    env: row.env,
    mixedEnv: row.mixed_env === 1,
    ...(Object.keys(sources).length > 0 ? { resourceSources: sources } : {}),
    ...(row.trust_levels_json === null
      ? {}
      : { trustLevels: trustLevelsOf(row.trust_levels_json) }),
  };
}

/** `trust_levels_json` as stored: an object of strings; anything else is corrupt. */
function trustLevelsOf(json: string): Record<string, string> {
  const parsed: unknown = JSON.parse(json);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new InvariantError('mission_resource_sets.trust_levels_json is not an object');
  }
  const trustLevels: Record<string, string> = {};
  for (const [id, trustLevel] of Object.entries(parsed)) {
    if (typeof trustLevel !== 'string') {
      throw new InvariantError(`mission_resource_sets.trust_levels_json: '${id}' is not a string`);
    }
    trustLevels[id] = trustLevel;
  }
  return trustLevels;
}

/** What `trust_levels_json` stores: NULL for no trust level, so an empty record reads back absent. */
function trustLevelsJsonOf(c: {
  readonly trustLevels?: Readonly<Record<string, string>>;
}): string | null {
  return c.trustLevels && Object.keys(c.trustLevels).length > 0
    ? JSON.stringify(c.trustLevels)
    : null;
}

/** True for a risk id of this service: its first segment, before `.` or `[`. */
export function isRiskOfService(riskId: RiskId, service: string): boolean {
  return riskId.startsWith(`${service}.`) || riskId.startsWith(`${service}[`);
}

/** An account of a write, with its sets and their lines. */
interface ResolvedAccountInput {
  readonly accountId: string;
  readonly resourceSets: readonly MissionResourceSetInput[];
}

/** A set of a write with its environment read from its resources (`assertAccountSelections`). */
interface CheckedSetInput extends MissionResourceSetInput {
  readonly future: boolean;
  readonly env: string | null;
}

/** An account of a write whose sets were checked. */
interface CheckedAccountInput {
  readonly accountId: string;
  readonly resourceSets: readonly CheckedSetInput[];
}

/**
 * The accounts of a write with their sets: an account given with its selection
 * directly becomes one set holding the `policy` lines of its service. A line no
 * account of that shape is for is refused.
 */
function resolveAccountInputs(
  ctx: RepoContext,
  accounts: readonly MissionAccountInput[],
  policy: readonly MissionPolicyLineInput[] = [],
): ResolvedAccountInput[] {
  const serviceOf = ctx.db.prepare<[string], { service: string }>(
    'SELECT service FROM accounts WHERE id = ?',
  );
  const placed = new Set<MissionPolicyLineInput>();
  const resolved = accounts.map((c): ResolvedAccountInput => {
    if ('resourceSets' in c) return { accountId: c.accountId, resourceSets: c.resourceSets };
    const service = serviceOf.get(c.accountId)?.service;
    if (service === undefined) throw new NotFoundError('account', c.accountId);
    const lines = policy.filter((line) => isRiskOfService(line.riskId, service));
    for (const line of lines) placed.add(line);
    return {
      accountId: c.accountId,
      resourceSets: [
        {
          resourceIds: c.resourceIds,
          ...(c.future !== undefined ? { future: c.future } : {}),
          ...(c.env !== undefined ? { env: c.env } : {}),
          ...(c.trustLevels ? { trustLevels: c.trustLevels } : {}),
          policy: lines,
        },
      ],
    };
  });
  const unplaced = policy.filter((line) => !placed.has(line));
  if (unplaced.length > 0) {
    throw new InvariantError(
      `policy line(s) ${unplaced.map((l) => l.riskId).join(', ')} name no account of the mission`,
    );
  }
  return resolved;
}

/**
 * Every account carries at least one set; each set an explicit list of resources of
 * that account, all of one effective environment (own label, else the account's
 * default), which is the set's `env` — or the `env` given, which every resource must
 * carry (ADR resource-set-is-one-environment-with-optional-future-resources). The sets of
 * an account partition its selection: a resource in one set only, and one set at most
 * with future on per environment. Returns the sets with their environment.
 */
function assertAccountSelections(
  ctx: RepoContext,
  accounts: readonly ResolvedAccountInput[],
): CheckedAccountInput[] {
  if (accounts.length === 0) {
    throw new InvariantError('a mission carries at least one account');
  }
  const resourceOf = ctx.db.prepare<[string], { account_id: string; env: string | null }>(
    `SELECT r.account_id, COALESCE(r.env, c.default_env) AS env
     FROM account_resources r JOIN accounts c ON c.id = r.account_id WHERE r.id = ?`,
  );
  const seenAccounts = new Set<string>();
  return accounts.map((c): CheckedAccountInput => {
    if (seenAccounts.has(c.accountId)) {
      throw new InvariantError(`account ${c.accountId} is listed twice`);
    }
    seenAccounts.add(c.accountId);
    if (c.resourceSets.length === 0) {
      throw new InvariantError(`account ${c.accountId}: no resource set`);
    }
    const seenResources = new Set<string>();
    const seenSets = new Set<string>();
    const futureEnvs = new Set<string | null>();
    const resourceSets = c.resourceSets.map((set): CheckedSetInput => {
      if (set.id !== undefined) {
        if (seenSets.has(set.id)) {
          throw new InvariantError(`resource set ${set.id} is listed twice`);
        }
        seenSets.add(set.id);
      }
      const envs = new Set<string | null>();
      for (const resourceId of set.resourceIds) {
        if (seenResources.has(resourceId)) {
          throw new InvariantError(
            `resource ${resourceId} is in two resource sets of account ${c.accountId}`,
          );
        }
        seenResources.add(resourceId);
        const owner = resourceOf.get(resourceId);
        if (!owner) throw new NotFoundError('account_resource', resourceId);
        if (owner.account_id !== c.accountId) {
          throw new InvariantError(
            `resource ${resourceId} does not belong to account ${c.accountId}`,
          );
        }
        envs.add(owner.env);
      }
      if (set.env !== undefined) envs.add(set.env);
      if (envs.size > 1) {
        throw new InvariantError(
          `account ${c.accountId}: a resource set holds several environments`,
        );
      }
      const [env = null] = envs;
      const future = set.future ?? false;
      if (future) {
        if (futureEnvs.has(env)) {
          throw new InvariantError(
            `account ${c.accountId}: two resource sets take the future resources of one environment`,
          );
        }
        futureEnvs.add(env);
      }
      return { ...set, future, env };
    });
    return { accountId: c.accountId, resourceSets };
  });
}

function validateLines(
  ctx: RepoContext,
  lines: readonly MissionPolicyLineInput[],
  where: string,
): void {
  const ids = lines.map((p) => p.riskId);
  if (new Set(ids).size !== ids.length) {
    throw new InvariantError(`duplicate risk id in the policy of ${where}`);
  }
  assertKnownRiskIds(ctx.catalog, ids);
  for (const entry of lines) {
    if (!Number.isInteger(entry.quota) || entry.quota < 0) {
      throw new InvariantError(`quota must be a non-negative integer (${entry.riskId})`);
    }
    if (!Number.isInteger(entry.rateLimit) || entry.rateLimit < 0) {
      throw new InvariantError(`rate limit must be a non-negative integer (${entry.riskId})`);
    }
    if (!Number.isInteger(entry.rateWindowSeconds) || entry.rateWindowSeconds <= 0) {
      throw new InvariantError(`rate window must be a positive integer (${entry.riskId})`);
    }
  }
}

/** Every line of every set, checked; a line of one set appears once in it. */
function validateSets(ctx: RepoContext, accounts: readonly ResolvedAccountInput[]): void {
  for (const c of accounts) {
    for (const [index, set] of c.resourceSets.entries()) {
      validateLines(ctx, set.policy, `resource set ${index + 1} of account ${c.accountId}`);
    }
  }
}

/** A flat policy whose lines name sets: each (set, risk) once, each set one of `sets`. */
function validateFlatPolicy(
  ctx: RepoContext,
  policy: readonly MissionPolicyEntry[],
  sets: ReadonlySet<string>,
): void {
  const keys = policy.map((p) => `${p.resourceSetId}\n${p.riskId}`);
  if (new Set(keys).size !== keys.length) throw new InvariantError('duplicate line in policy');
  for (const line of policy) {
    if (!sets.has(line.resourceSetId)) {
      throw new InvariantError(`resource set ${line.resourceSetId} is not one of the mission's`);
    }
  }
  validateLines(
    ctx,
    policy
      .map(({ resourceSetId: _set, ...line }) => line)
      .filter((line, i, all) => all.findIndex((other) => other.riskId === line.riskId) === i),
    'the mission',
  );
}

/** The ids of every set of a mission. */
function setIdsOf(mission: MissionRecord): Set<string> {
  return new Set(mission.accounts.flatMap((c) => c.resourceSets.map((set) => set.id)));
}

/** The one key of a line, for maps: its set and its risk. */
function lineKey(line: { readonly resourceSetId: string; readonly riskId: RiskId }): string {
  return `${line.resourceSetId}\n${line.riskId}`;
}

/**
 * The set a resource joins among `candidates` (by position): the one with future on in
 * the resource's environment, else one in its environment, else the first (risk model
 * §4.7). `candidates` is never empty.
 */
function placementOf(candidates: readonly SetRow[], env: string | null): SetRow {
  const sameEnv = candidates.filter((set) => set.mixed_env === 0 && set.env === env);
  const [first] = candidates;
  const chosen = sameEnv.find((set) => set.future === 1) ?? sameEnv[0] ?? first;
  if (!chosen) throw new InvariantError('a mission account carries at least one resource set');
  return chosen;
}

export function createMissionsRepo(ctx: RepoContext): MissionsRepo {
  const { db } = ctx;
  const byId = db.prepare<[string], MissionRow>(`SELECT ${COLUMNS} FROM missions WHERE id = ?`);
  const activeCount = db.prepare<[string], { readonly n: number }>(
    `SELECT COUNT(*) AS n FROM missions
      WHERE status = 'active' AND (expires_at IS NULL OR expires_at > ?)`,
  );
  const byCreator = db.prepare<[string], MissionRow>(
    `SELECT ${COLUMNS} FROM missions WHERE creator_user_id = ? ORDER BY created_at`,
  );
  const byMember = db.prepare<[string], MissionRow>(
    `SELECT m.id, m.name, m.creator_user_id, m.status, m.period_anchor, m.period_seconds,
       m.expires_at, m.issued_by_mission_id, m.issued_via_client_name, m.created_at,
       m.updated_at, m.closed_at
     FROM missions m JOIN mission_members mm ON mm.mission_id = m.id
     WHERE mm.user_id = ? AND mm.removed_at IS NULL ORDER BY m.created_at`,
  );
  const byAccount = db.prepare<[string], MissionRow>(
    `SELECT m.id, m.name, m.creator_user_id, m.status, m.period_anchor, m.period_seconds,
       m.expires_at, m.issued_by_mission_id, m.issued_via_client_name, m.created_at,
       m.updated_at, m.closed_at
     FROM missions m JOIN mission_accounts mc ON mc.mission_id = m.id
     WHERE mc.account_id = ? ORDER BY m.created_at`,
  );
  const insert = db.prepare<
    [string, string, string, string, number | null, string | null, string | null, string, string]
  >(
    `INSERT INTO missions (id, name, creator_user_id, status, period_anchor, period_seconds,
       expires_at, issued_by_mission_id, created_at, updated_at)
     VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?, ?)`,
  );
  const insertAccount = db.prepare<[string, string]>(
    'INSERT INTO mission_accounts (mission_id, account_id) VALUES (?, ?)',
  );
  const insertSet = db.prepare<
    [string, string, string, number, number, string | null, string | null]
  >(
    `INSERT INTO mission_resource_sets
       (id, mission_id, account_id, position, future, env, trust_levels_json)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertResource = db.prepare<[string, string, string, string, string]>(
    `INSERT INTO mission_resources (mission_id, account_id, resource_id, resource_set_id, source)
     VALUES (?, ?, ?, ?, ?)`,
  );
  const insertPolicy = db.prepare<[string, string, string, number, number, number, string]>(
    `INSERT INTO mission_policy
       (mission_id, resource_set_id, risk_id, quota, rate_limit, rate_window_seconds, gate)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const deletePolicy = db.prepare<[string]>('DELETE FROM mission_policy WHERE mission_id = ?');
  // Risk order first, the order a policy was always read in; a risk in two sets by position.
  const policyOf = db.prepare<[string], PolicyRow>(
    `SELECT p.resource_set_id, p.risk_id, p.quota, p.rate_limit, p.rate_window_seconds, p.gate
     FROM mission_policy p JOIN mission_resource_sets s ON s.id = p.resource_set_id
     WHERE p.mission_id = ? ORDER BY p.risk_id, s.account_id, s.position`,
  );
  const accountsOf = db.prepare<[string], AccountRow>(
    'SELECT account_id FROM mission_accounts WHERE mission_id = ? ORDER BY account_id',
  );
  const setsOf = db.prepare<[string], SetRow>(
    `SELECT ${SET_COLUMNS}
     FROM mission_resource_sets WHERE mission_id = ? ORDER BY account_id, position, id`,
  );
  const setsOfAccount = db.prepare<[string, string], SetRow>(
    `SELECT ${SET_COLUMNS}
     FROM mission_resource_sets WHERE mission_id = ? AND account_id = ? ORDER BY position, id`,
  );
  const resourcesOf = db.prepare<[string], SelectedRow>(
    'SELECT resource_id, resource_set_id, source FROM mission_resources WHERE mission_id = ? ORDER BY resource_id',
  );
  const insertResourceFrom = db.prepare<[string, string, string, string, string]>(
    `INSERT INTO mission_resources (mission_id, account_id, resource_id, resource_set_id, source)
     VALUES (?, ?, ?, ?, ?) ON CONFLICT (mission_id, resource_id) DO NOTHING`,
  );
  const resourceAccountOf = db.prepare<
    [string],
    { account_id: string; ref: string; env: string | null; hidden: number }
  >(
    `SELECT r.account_id, r.ref, COALESCE(r.env, c.default_env) AS env, r.hidden
     FROM account_resources r JOIN accounts c ON c.id = r.account_id WHERE r.id = ?`,
  );
  // Running: stored `active` and not past its expiry (an `orphaned` one is derived, still stored active).
  const runningOnAccount = db.prepare<[string, string], { id: string }>(
    `SELECT DISTINCT m.id FROM missions m JOIN mission_accounts mc ON mc.mission_id = m.id
     WHERE mc.account_id = ? AND m.status = 'active' AND (m.expires_at IS NULL OR m.expires_at > ?)
     ORDER BY m.id`,
  );
  const heldOnAccount = db.prepare<
    [string, string],
    { resource_id: string; resource_set_id: string }
  >(
    'SELECT resource_id, resource_set_id FROM mission_resources WHERE mission_id = ? AND account_id = ?',
  );
  const futureAccounts = db.prepare<[string], { account_id: string }>(
    `SELECT DISTINCT s.account_id FROM mission_resource_sets s JOIN missions m ON m.id = s.mission_id
     WHERE s.future = 1 AND m.status = 'active' AND (m.expires_at IS NULL OR m.expires_at > ?)
     ORDER BY s.account_id`,
  );
  const setStatusStmt = db.prepare<[string, string | null, string, string]>(
    'UPDATE missions SET status = ?, closed_at = COALESCE(?, closed_at), updated_at = ? WHERE id = ?',
  );
  const setExpiry = db.prepare<[string | null, string, string]>(
    'UPDATE missions SET expires_at = ?, updated_at = ? WHERE id = ?',
  );
  const touch = db.prepare<[string, string]>('UPDATE missions SET updated_at = ? WHERE id = ?');
  const setsOfRisk = db.prepare<[string, string], { resource_set_id: string }>(
    'SELECT resource_set_id FROM mission_policy WHERE mission_id = ? AND risk_id = ?',
  );
  const lineOf = db.prepare<
    [string, string, string],
    { quota: number; rate_limit: number; rate_window_seconds: number; gate: string }
  >(
    `SELECT quota, rate_limit, rate_window_seconds, gate FROM mission_policy
     WHERE mission_id = ? AND resource_set_id = ? AND risk_id = ?`,
  );
  const setGateStmt = db.prepare<[string, string, string]>(
    'UPDATE mission_policy SET gate = ? WHERE resource_set_id = ? AND risk_id = ?',
  );
  const setLimitsStmt = db.prepare<[number, number, string, string]>(
    'UPDATE mission_policy SET quota = ?, rate_limit = ? WHERE resource_set_id = ? AND risk_id = ?',
  );
  // The session's events belong to the sessions repository: its primitives run here,
  // inside this repository's transaction.
  const sessions = createSessionPrimitives(ctx);
  // Rotation retires the token of ONE holder: the other holders keep working.
  const activeOfMember = db.prepare<[string, string], TokenRow>(
    `SELECT ${TOKEN_COLUMNS} FROM mission_tokens
     WHERE mission_id = ? AND holder_user_id = ? AND kind = 'member' AND status = 'active'`,
  );
  const activeOfName = db.prepare<[string, string], TokenRow>(
    `SELECT ${TOKEN_COLUMNS} FROM mission_tokens
     WHERE mission_id = ? AND name = ? AND kind = 'named' AND status = 'active'`,
  );
  const retireOne = db.prepare<[string, string]>(
    `UPDATE mission_tokens SET status = 'rotated', retired_at = ? WHERE id = ? AND status = 'active'`,
  );
  const insertToken = db.prepare<
    [string, string, string, string, string, string, string | null, string | null, string, string]
  >(
    `INSERT INTO mission_tokens (id, mission_id, prefix, hash, hash_alg, status, kind,
       holder_user_id, name, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)`,
  );
  const tokenById = db.prepare<[string], TokenRow>(
    `SELECT ${TOKEN_COLUMNS} FROM mission_tokens WHERE id = ?`,
  );
  const tokenByPrefix = db.prepare<[string], TokenRow>(
    `SELECT ${TOKEN_COLUMNS} FROM mission_tokens WHERE prefix = ?`,
  );
  const tokensOf = db.prepare<[string], TokenRow>(
    `SELECT ${TOKEN_COLUMNS} FROM mission_tokens WHERE mission_id = ? ORDER BY created_at`,
  );
  const revokeTokensStmt = db.prepare<[string, string]>(
    `UPDATE mission_tokens SET status = 'revoked', retired_at = ? WHERE mission_id = ? AND status = 'active'`,
  );
  const revokeOne = db.prepare<[string, string]>(
    `UPDATE mission_tokens SET status = 'revoked', retired_at = ? WHERE id = ? AND status = 'active'`,
  );
  const tokenOfMission = db.prepare<[string, string], TokenRow>(
    `SELECT ${TOKEN_COLUMNS} FROM mission_tokens WHERE mission_id = ? AND id = ?`,
  );
  const revokeOneOfMission = db.prepare<[string, string, string]>(
    `UPDATE mission_tokens SET status = 'revoked', retired_at = ?
     WHERE mission_id = ? AND id = ? AND status = 'active'`,
  );
  const activeHeldAsMember = db.prepare<[string, string], TokenRow>(
    `SELECT ${TOKEN_COLUMNS} FROM mission_tokens
     WHERE holder_user_id = ? AND kind = 'member' AND status = 'active'
       AND mission_id NOT IN (SELECT id FROM missions WHERE creator_user_id = ?)
     ORDER BY created_at`,
  );
  // Written only when the stored instant is older than the granularity: one statement,
  // so two concurrent calls write once.
  const markUsed = db.prepare<[string, string, string, string]>(
    `UPDATE mission_tokens SET last_used_at = ?
     WHERE mission_id = ? AND id = ? AND (last_used_at IS NULL OR last_used_at < ?)`,
  );
  const memberOf = db.prepare<[string, string], MemberRow>(
    `SELECT ${MEMBER_COLUMNS} FROM mission_members WHERE mission_id = ? AND user_id = ?`,
  );
  const membersOf = db.prepare<[string], MemberRow>(
    `SELECT ${MEMBER_COLUMNS} FROM mission_members
     WHERE mission_id = ? AND removed_at IS NULL ORDER BY added_at, user_id`,
  );
  const upsertMember = db.prepare<[string, string, string, string]>(
    `INSERT INTO mission_members (mission_id, user_id, added_by, added_at, removed_at)
     VALUES (?, ?, ?, ?, NULL)
     ON CONFLICT (mission_id, user_id)
     DO UPDATE SET added_by = excluded.added_by, added_at = excluded.added_at, removed_at = NULL`,
  );
  const markMemberRemoved = db.prepare<[string, string, string]>(
    `UPDATE mission_members SET removed_at = ?
     WHERE mission_id = ? AND user_id = ? AND removed_at IS NULL`,
  );

  const userStatus = db.prepare<[string], { status: string }>(
    'SELECT status FROM users WHERE id = ?',
  );
  /** The status of a user, as the membership rule reads it; `null` for an unknown user. */
  function userStatusOf(userId: string): { status: 'active' | 'removed' } | null {
    const row = userStatus.get(userId);
    return row ? { status: parseEnum(USER_STATUSES, row.status, 'users.status') } : null;
  }

  function requireToken(id: string): MissionTokenRecord {
    return tokenToRecord(requireRow(tokenById.get(id), 'mission_token', id));
  }

  function toRecord(row: MissionRow): MissionRecord {
    // perf: three queries per mission (sets, resources, policy); a Postgres port joins.
    const selected = new Map<string, SelectedRow[]>();
    for (const r of resourcesOf.all(row.id)) {
      const list = selected.get(r.resource_set_id) ?? [];
      list.push(r);
      selected.set(r.resource_set_id, list);
    }
    const sets = setsOf.all(row.id);
    return {
      id: row.id,
      name: row.name,
      creatorUserId: row.creator_user_id,
      status: parseEnum(STORED_MISSION_STATUSES, row.status, 'missions.status'),
      periodAnchor: row.period_anchor,
      periodSeconds: row.period_seconds,
      expiresAt: row.expires_at,
      issuedByMissionId: row.issued_by_mission_id,
      issuedViaClientName: row.issued_via_client_name,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      closedAt: row.closed_at,
      accounts: accountsOf.all(row.id).map((c): MissionAccountRecord => ({
        accountId: c.account_id,
        resourceSets: sets
          .filter((set) => set.account_id === c.account_id)
          .map((set) => setToRecord(set, selected.get(set.id) ?? [])),
      })),
      policy: policyOf.all(row.id).map(policyToRecord),
    };
  }

  function requireMission(id: string): MissionRecord {
    const row = byId.get(id);
    if (!row) throw new NotFoundError('mission', id);
    return toRecord(row);
  }

  function writeLine(missionId: string, setId: string, p: MissionPolicyLineInput): void {
    insertPolicy.run(missionId, setId, p.riskId, p.quota, p.rateLimit, p.rateWindowSeconds, p.gate);
  }

  function writePolicy(missionId: string, policy: readonly MissionPolicyEntry[]): void {
    for (const p of policy) writeLine(missionId, p.resourceSetId, p);
  }

  /** The set a line names: given, or the one set of the mission that accepts the risk. */
  function lineOfInput(
    missionId: string,
    line: RiskId | { readonly resourceSetId?: string; readonly riskId: RiskId },
  ): RequestLine | null {
    if (typeof line !== 'string' && line.resourceSetId !== undefined) {
      return { resourceSetId: line.resourceSetId, riskId: line.riskId };
    }
    const riskId = typeof line === 'string' ? line : line.riskId;
    const sets = setsOfRisk.all(missionId, riskId);
    const [only] = sets;
    return sets.length === 1 && only ? { resourceSetId: only.resource_set_id, riskId } : null;
  }

  const renameStmt = db.prepare<[string, string]>('UPDATE missions SET name = ? WHERE id = ?');
  // Every expression of an UPDATE reads the row as it was: `closed_at` sees the old status.
  const reviveStmt = db.prepare<[string | null, string]>(
    `UPDATE missions SET expires_at = ?,
       status = CASE WHEN status = 'expired' THEN 'active' ELSE status END,
       closed_at = CASE WHEN status = 'expired' THEN NULL ELSE closed_at END
     WHERE id = ?`,
  );
  // An edit judged the set whole: a legacy mixed set is one environment again.
  const updateSetStmt = db.prepare<[number, number, string | null, string | null, string]>(
    `UPDATE mission_resource_sets SET position = ?, future = ?, env = ?, mixed_env = 0,
       trust_levels_json = ? WHERE id = ?`,
  );
  const deleteSetStmt = db.prepare<[string]>('DELETE FROM mission_resource_sets WHERE id = ?');
  // A trust level an edit changes restarts the count of its raise proposal (§4.7).
  const levelChangedStmt = db.prepare<[string, string, string, string]>(
    `INSERT INTO mission_trust_marks (mission_id, resource_set_id, macro_action_id, level_changed_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (resource_set_id, macro_action_id) DO UPDATE SET level_changed_at = excluded.level_changed_at`,
  );
  const snoozeStmt = db.prepare<[string, string, string, string, string, string]>(
    `INSERT INTO mission_trust_marks (mission_id, resource_set_id, macro_action_id, snoozed_at)
     SELECT ?, ?, ?, ? FROM mission_resource_sets WHERE id = ? AND mission_id = ?
     ON CONFLICT (resource_set_id, macro_action_id) DO UPDATE SET snoozed_at = excluded.snoozed_at`,
  );
  const trustMarksOf = db.prepare<
    [string],
    {
      resource_set_id: string;
      macro_action_id: string;
      level_changed_at: string | null;
      snoozed_at: string | null;
    }
  >(
    `SELECT resource_set_id, macro_action_id, level_changed_at, snoozed_at
     FROM mission_trust_marks WHERE mission_id = ? ORDER BY resource_set_id, macro_action_id`,
  );
  const deleteAccountStmt = db.prepare<[string, string]>(
    'DELETE FROM mission_accounts WHERE mission_id = ? AND account_id = ?',
  );
  const deleteResourceStmt = db.prepare<[string, string]>(
    'DELETE FROM mission_resources WHERE mission_id = ? AND resource_id = ?',
  );
  const moveResourceStmt = db.prepare<[string, string, string]>(
    'UPDATE mission_resources SET resource_set_id = ? WHERE mission_id = ? AND resource_id = ?',
  );
  const deleteLineStmt = db.prepare<[string, string]>(
    'DELETE FROM mission_policy WHERE resource_set_id = ? AND risk_id = ?',
  );
  const updateLineStmt = db.prepare<[number, number, number, string, string, string]>(
    `UPDATE mission_policy SET quota = ?, rate_limit = ?, rate_window_seconds = ?, gate = ?
     WHERE resource_set_id = ? AND risk_id = ?`,
  );
  const openRequestsStmt = db.prepare<
    [string],
    { id: string; kind: string; risk_id: string; risk_ids_json: string | null }
  >(
    `SELECT id, kind, risk_id, risk_ids_json FROM requests
     WHERE mission_id = ? AND state = 'open' AND kind IN ('claim', 'approval')`,
  );
  const closeRequestStmt = db.prepare<[string, string, string, string]>(
    `UPDATE requests SET state = 'refused', decided_at = ?, decided_by_user_id = ?,
       decision_json = ?, args_blob = NULL, key_version = NULL
     WHERE id = ? AND state = 'open'`,
  );
  const retireApprovalsStmt = db.prepare<[string, string, string, string]>(
    `UPDATE approvals SET consumed_at = ? WHERE mission_id = ? AND consumed_at IS NULL
     AND (risk_id = ? OR EXISTS (SELECT 1 FROM json_each(approvals.risk_ids_json) WHERE value = ?))`,
  );

  function sameLimits(a: MissionPolicyLineInput, b: MissionPolicyLineInput): boolean {
    return (
      a.quota === b.quota &&
      a.rateLimit === b.rateLimit &&
      a.rateWindowSeconds === b.rateWindowSeconds
    );
  }

  /** The limits and gate of a line, as an event names them. */
  function lineDetails(p: MissionPolicyLineInput): {
    quota: number;
    rate_limit_max: number;
    rate_window_seconds: number;
    gate: Gate;
  } {
    return {
      quota: p.quota,
      rate_limit_max: p.rateLimit,
      rate_window_seconds: p.rateWindowSeconds,
      gate: p.gate,
    };
  }

  /** The open claims and approval requests about a removed line, closed. In-transaction. */
  function closeMootRequests(
    missionId: string,
    gone: ReadonlySet<string>,
    actorUserId: string,
    now: Iso,
    record: (event: NewEvent) => void,
  ): { id: string; kind: string }[] {
    const closed: { id: string; kind: string }[] = [];
    if (gone.size === 0) return closed;
    for (const row of openRequestsStmt.all(missionId)) {
      const lines = requestLinesOf(
        riskIdsOf(row.risk_id, row.risk_ids_json),
        storedLinesOf(ctx, row.id),
      );
      const moot = [...new Set(lines.filter((l) => gone.has(lineKey(l))).map((l) => l.riskId))];
      if (moot.length === 0) continue;
      const decision = JSON.stringify({ resolution: 'mission-changed', removed: moot });
      if (closeRequestStmt.run(now, actorUserId, decision, row.id).changes === 0) continue;
      closed.push({ id: row.id, kind: row.kind });
      record({
        kind: 'request',
        riskId: row.risk_id,
        resourceSetId: lines[0]?.resourceSetId ?? null,
        details: {
          request_id: row.id,
          request_kind: row.kind === 'claim' ? 'claim' : 'approval',
          state: 'refused',
          reason: 'mission-changed',
        },
      });
    }
    return closed;
  }

  /** A set of a write, with the id it is stored under. */
  interface PlannedSet {
    readonly id: string;
    readonly kept: boolean;
    readonly position: number;
    readonly accountId: string;
    readonly input: CheckedSetInput;
  }

  /** Inserts one account with its sets, resources and lines. In-transaction. */
  function insertAccountWithSets(missionId: string, c: CheckedAccountInput): void {
    insertAccount.run(missionId, c.accountId);
    c.resourceSets.forEach((set, index) => {
      const setId = ctx.newId();
      insertSet.run(
        setId,
        missionId,
        c.accountId,
        index + 1,
        set.future ? 1 : 0,
        set.env,
        trustLevelsJsonOf(set),
      );
      for (const resourceId of set.resourceIds) {
        insertResource.run(missionId, c.accountId, resourceId, setId, 'issuance');
      }
      for (const line of set.policy) writeLine(missionId, setId, line);
    });
  }

  return {
    async edit(id, raw) {
      const unchecked = resolveAccountInputs(ctx, raw.accounts, raw.policy);
      validateSets(ctx, unchecked);
      const resolved = assertAccountSelections(ctx, unchecked);
      const now = nowIso(ctx);
      return withImmediateTransaction(db, () => {
        const before = requireMission(id);
        // An account given flat keeps its one stored set.
        const input = {
          ...raw,
          accounts: resolved.map((c, i): CheckedAccountInput => {
            const given = raw.accounts[i];
            const flat = given !== undefined && !('resourceSets' in given);
            const stored = before.accounts.find((b) => b.accountId === c.accountId);
            const [only] = stored?.resourceSets ?? [];
            const [set] = c.resourceSets;
            return flat && only && set && stored?.resourceSets.length === 1
              ? { ...c, resourceSets: [{ ...set, id: only.id }] }
              : c;
          }),
        };
        if (
          before.creatorUserId !== input.actorUserId ||
          before.status === 'revoked' ||
          !input.unchanged(before)
        ) {
          return null;
        }
        if (before.name !== input.name) renameStmt.run(input.name, id);
        if (before.expiresAt !== input.expiresAt) {
          // An end moved into the future, or removed, brings an expired mission back.
          if (input.expiresAt === null || input.expiresAt > now)
            reviveStmt.run(input.expiresAt, id);
          else setExpiry.run(input.expiresAt, now, id);
        }

        // ── Which set is which: a stored id on the same account keeps its set. ──
        const stored = new Map<string, { accountId: string; set: MissionResourceSetRecord }>();
        for (const c of before.accounts) {
          for (const set of c.resourceSets) stored.set(set.id, { accountId: c.accountId, set });
        }
        const planned: PlannedSet[] = input.accounts.flatMap((c) =>
          c.resourceSets.map((set, index): PlannedSet => {
            const kept = set.id !== undefined && stored.get(set.id)?.accountId === c.accountId;
            return {
              id: kept && set.id !== undefined ? set.id : ctx.newId(),
              kept,
              position: index + 1,
              accountId: c.accountId,
              input: set,
            };
          }),
        );
        const keptIds = new Set(planned.filter((p) => p.kept).map((p) => p.id));
        const nextAccounts = new Set(input.accounts.map((c) => c.accountId));

        const session = sessions.sessionOfMission(id);
        const record = (event: NewEvent): void => {
          if (session) sessions.recordEvent(session.id, event, now);
        };
        const actorUserId = input.actorUserId;

        // ── The lines removed go first, while their sets still exist. ──
        const linesBefore = new Map(before.policy.map((p) => [lineKey(p), p]));
        const linesAfter = new Map<string, MissionPolicyEntry>();
        for (const set of planned) {
          for (const line of set.input.policy) {
            const entry: MissionPolicyEntry = { ...line, resourceSetId: set.id };
            linesAfter.set(lineKey(entry), entry);
          }
        }
        const removed = before.policy.filter((p) => !linesAfter.has(lineKey(p)));
        for (const p of removed) {
          deleteLineStmt.run(p.resourceSetId, p.riskId);
          // An approval must not survive the removal and re-addition of its risk.
          retireApprovalsStmt.run(now, id, p.riskId, p.riskId);
          record({
            kind: 'permission-removed',
            riskId: p.riskId,
            resourceSetId: p.resourceSetId,
            actorUserId,
            details: lineDetails(p),
          });
        }

        // ── The sets and their resources. Order matters: a resource row always names a
        // set that exists.
        const removedSets = [...stored.entries()].filter(([setId]) => !keptIds.has(setId));
        for (const c of input.accounts) {
          if (!before.accounts.some((b) => b.accountId === c.accountId)) {
            insertAccount.run(id, c.accountId);
          }
        }
        for (const set of planned) {
          if (set.kept) continue;
          insertSet.run(
            set.id,
            id,
            set.accountId,
            set.position,
            set.input.future ? 1 : 0,
            set.input.env,
            trustLevelsJsonOf(set.input),
          );
        }
        for (const c of before.accounts) {
          if (nextAccounts.has(c.accountId)) continue;
          // Its sets, resources and lines go with it (foreign keys, ON DELETE CASCADE).
          deleteAccountStmt.run(id, c.accountId);
        }
        const placedBefore = new Map<string, string>();
        for (const c of before.accounts) {
          if (!nextAccounts.has(c.accountId)) continue;
          for (const set of c.resourceSets) {
            for (const resourceId of set.resourceIds) placedBefore.set(resourceId, set.id);
          }
        }
        const placedAfter = new Map<string, PlannedSet>();
        for (const set of planned) {
          for (const resourceId of set.input.resourceIds) placedAfter.set(resourceId, set);
        }
        for (const [resourceId] of placedBefore) {
          if (!placedAfter.has(resourceId)) deleteResourceStmt.run(id, resourceId);
        }
        for (const [resourceId, set] of placedAfter) {
          const was = placedBefore.get(resourceId);
          if (was === undefined) insertResource.run(id, set.accountId, resourceId, set.id, 'edit');
          else if (was !== set.id) moveResourceStmt.run(set.id, id, resourceId);
        }
        for (const [setId, { accountId }] of removedSets) {
          if (nextAccounts.has(accountId)) deleteSetStmt.run(setId);
        }
        for (const set of planned) {
          if (!set.kept) continue;
          const was = stored.get(set.id)?.set;
          const trustLevels = trustLevelsJsonOf(set.input);
          if (
            !was ||
            was.position !== set.position ||
            was.future !== set.input.future ||
            was.env !== set.input.env ||
            was.mixedEnv ||
            trustLevelsJsonOf(was) !== trustLevels
          ) {
            updateSetStmt.run(
              set.position,
              set.input.future ? 1 : 0,
              set.input.env,
              trustLevels,
              set.id,
            );
          }
          if (was) {
            const before = was.trustLevels ?? {};
            const after = set.input.trustLevels ?? {};
            for (const macroActionId of new Set([...Object.keys(before), ...Object.keys(after)])) {
              if (before[macroActionId] !== after[macroActionId]) {
                levelChangedStmt.run(id, set.id, macroActionId, now);
              }
            }
          }
        }

        // ── The lines added or changed. ──
        for (const [key, p] of linesAfter) {
          const old = linesBefore.get(key);
          if (!old) {
            writeLine(id, p.resourceSetId, p);
            record({
              kind: 'permission-added',
              riskId: p.riskId,
              resourceSetId: p.resourceSetId,
              actorUserId,
              details: lineDetails(p),
            });
            continue;
          }
          const limitsMove = !sameLimits(old, p);
          if (!limitsMove && old.gate === p.gate) continue;
          updateLineStmt.run(
            p.quota,
            p.rateLimit,
            p.rateWindowSeconds,
            p.gate,
            p.resourceSetId,
            p.riskId,
          );
          if (limitsMove) {
            const windowMoves = old.rateWindowSeconds !== p.rateWindowSeconds;
            record({
              kind: 'limits-changed',
              riskId: p.riskId,
              resourceSetId: p.resourceSetId,
              actorUserId,
              details: {
                quota: p.quota,
                quota_before: old.quota,
                rate_limit_max: p.rateLimit,
                rate_limit_max_before: old.rateLimit,
                ...(windowMoves
                  ? {
                      rate_window_seconds: p.rateWindowSeconds,
                      rate_window_seconds_before: old.rateWindowSeconds,
                    }
                  : {}),
              },
            });
          }
          if (old.gate !== p.gate) {
            record({
              kind: 'gate-changed',
              riskId: p.riskId,
              resourceSetId: p.resourceSetId,
              actorUserId,
              details: { gate: p.gate, gate_before: old.gate },
            });
          }
        }
        const gone = new Set(removed.map(lineKey));
        const closed = closeMootRequests(id, gone, actorUserId, now, record);
        touch.run(now, id);
        record(input.summary(closed.length));
        return { before, mission: requireMission(id), closedRequests: closed };
      });
    },
    async issuersOf(missionIds) {
      const issuers = new Map<string, MissionIssuerRecord>();
      const ids = [...new Set(missionIds)];
      if (ids.length === 0) return issuers;
      const rows = db
        .prepare<string[], IssuerRow>(
          `SELECT m.id AS mission_id, m.issued_by_mission_id, i.name AS issuer_name,
                  m.issued_via_client_name
           FROM missions m LEFT JOIN missions i ON i.id = m.issued_by_mission_id
           WHERE m.id IN (${ids.map(() => '?').join(', ')})
             AND (m.issued_by_mission_id IS NOT NULL OR m.issued_via_client_name IS NOT NULL)`,
        )
        .all(...ids);
      for (const row of rows) {
        issuers.set(row.mission_id, {
          missionId: row.mission_id,
          issuedByMissionId: row.issued_by_mission_id,
          issuedByMissionName: row.issuer_name,
          clientName: row.issued_via_client_name,
        });
      }
      return issuers;
    },
    async create(input) {
      const unchecked = resolveAccountInputs(ctx, input.accounts, input.policy);
      validateSets(ctx, unchecked);
      const accounts = assertAccountSelections(ctx, unchecked);
      const id = ctx.newId();
      const now = nowIso(ctx);
      withImmediateTransaction(db, () => {
        insert.run(
          id,
          input.name,
          input.creatorUserId,
          input.periodAnchor ?? now,
          input.periodSeconds,
          input.expiresAt ?? null,
          input.issuedByMissionId ?? null,
          now,
          now,
        );
        for (const c of accounts) insertAccountWithSets(id, c);
      });
      return requireMission(id);
    },
    async addResources(missionId, accountId, resourceIds, source, created, judgedSetIds) {
      if (!MISSION_RESOURCE_SOURCES.includes(source)) {
        throw new InvariantError(`unknown mission resource source '${String(source)}'`);
      }
      const now = nowIso(ctx);
      return withImmediateTransaction(db, (): AddedMissionResources => {
        const sets = setsOfAccount.all(missionId, accountId);
        if (sets.length === 0) {
          throw new NotFoundError('mission_account', `${missionId}/${accountId}`);
        }
        const judged = sets.filter((set) => judgedSetIds?.includes(set.id) ?? false);
        const candidates = judged.length > 0 ? judged : sets;
        const held = new Map(
          heldOnAccount.all(missionId, accountId).map((r) => [r.resource_id, r.resource_set_id]),
        );
        const refs: string[] = [];
        const placed: { resourceId: string; resourceSetId: string }[] = [];
        const added: string[] = [];
        for (const resourceId of resourceIds) {
          const owner = resourceAccountOf.get(resourceId);
          if (!owner) throw new NotFoundError('account_resource', resourceId);
          if (owner.account_id !== accountId) {
            throw new InvariantError(
              `resource ${resourceId} does not belong to account ${accountId}`,
            );
          }
          if (!refs.includes(owner.ref)) refs.push(owner.ref);
          const already = held.get(resourceId);
          if (already !== undefined) {
            placed.push({ resourceId, resourceSetId: already });
            continue;
          }
          const target = placementOf(candidates, owner.env);
          insertResourceFrom.run(missionId, accountId, resourceId, target.id, source);
          held.set(resourceId, target.id);
          placed.push({ resourceId, resourceSetId: target.id });
          added.push(resourceId);
        }
        if (added.length > 0) touch.run(now, missionId);
        // What the mission created is in its activity.
        const session =
          source === 'created' && created && refs.length > 0
            ? sessions.sessionOfMission(missionId)
            : null;
        if (session && created) {
          sessions.recordEvent(
            session.id,
            {
              kind: 'resources-created',
              actorUserId: created.actorUserId,
              details: { tool: created.tool, account_id: accountId, refs },
            },
            now,
          );
        }
        return { placed, added };
      });
    },
    async applyResourceChanges(accountId, changes, neverJoin) {
      const now = nowIso(ctx);
      const excluded = new Set(neverJoin);
      return withImmediateTransaction(db, (): ResourceMove[] => {
        const resources = new Map<string, { ref: string; env: string | null; hidden: boolean }>();
        for (const change of changes) {
          const row = resourceAccountOf.get(change.resourceId);
          if (row?.account_id !== accountId) continue;
          resources.set(change.resourceId, {
            ref: row.ref,
            env: row.env,
            hidden: row.hidden === 1,
          });
        }
        const moves: ResourceMove[] = [];
        for (const { id: missionId } of runningOnAccount.all(accountId, now)) {
          const sets = setsOfAccount.all(missionId, accountId);
          const held = new Map(
            heldOnAccount.all(missionId, accountId).map((r) => [r.resource_id, r.resource_set_id]),
          );
          const before = moves.length;
          for (const change of changes) {
            const resource = resources.get(change.resourceId);
            if (!resource) continue;
            const move = (resourceSetId: string, kind: ResourceMove['change']): void => {
              moves.push({
                missionId,
                accountId,
                resourceSetId,
                resourceId: change.resourceId,
                ref: resource.ref,
                change: kind,
                reason: change.reason,
              });
            };
            const holding = sets.find((set) => set.id === held.get(change.resourceId));
            if (holding) {
              // A resource that just appeared and is held already was placed by its
              // creating call (`addResources`): only a relabel moves a held resource.
              if (change.reason !== 'relabelled') continue;
              if (holding.mixed_env === 1 || holding.env === resource.env) continue;
              deleteResourceStmt.run(missionId, change.resourceId);
              held.delete(change.resourceId);
              move(holding.id, 'left');
            }
            if (resource.hidden || excluded.has(change.resourceId)) continue;
            const target =
              sets.find(
                (set) => set.future === 1 && set.mixed_env === 0 && set.env === resource.env,
              ) ?? sets.find((set) => set.future === 1 && set.mixed_env === 1);
            if (!target) continue;
            insertResource.run(missionId, accountId, change.resourceId, target.id, 'future');
            held.set(change.resourceId, target.id);
            move(target.id, 'joined');
          }
          if (moves.length > before) touch.run(now, missionId);
        }
        return moves;
      });
    },
    async accountsWithFutureSets(now) {
      return futureAccounts.all(now).map((r) => r.account_id);
    },
    async getById(id) {
      const row = byId.get(id);
      return row ? toRecord(row) : null;
    },
    async countActive(now) {
      return activeCount.get(now)?.n ?? 0;
    },
    async listForCreator(userId) {
      return byCreator.all(userId).map(toRecord);
    },
    async listForMember(userId) {
      return byMember.all(userId).map(toRecord);
    },
    async listForAccount(accountId) {
      return byAccount.all(accountId).map(toRecord);
    },
    async setStatus(id, status) {
      const now = nowIso(ctx);
      const terminal = status === 'revoked' || status === 'expired';
      const result = setStatusStmt.run(status, terminal ? now : null, now, id);
      if (result.changes === 0) throw new NotFoundError('mission', id);
      return requireMission(id);
    },
    async setExpiresAt(id, expiresAt) {
      const result = setExpiry.run(expiresAt, nowIso(ctx), id);
      if (result.changes === 0) throw new NotFoundError('mission', id);
      return requireMission(id);
    },
    async replacePolicy(id, policy) {
      const now = nowIso(ctx);
      return withImmediateTransaction(db, () => {
        const mission = requireMission(id);
        validateFlatPolicy(ctx, policy, setIdsOf(mission));
        deletePolicy.run(id);
        writePolicy(id, policy);
        touch.run(now, id);
        return requireMission(id);
      });
    },
    async changePermissions(id, policy, expected, actor, requestId) {
      const key = (lines: readonly MissionPolicyEntry[]) =>
        JSON.stringify(
          [...lines]
            .sort((a, b) => lineKey(a).localeCompare(lineKey(b)))
            .map((p) => [
              p.resourceSetId,
              p.riskId,
              p.quota,
              p.rateLimit,
              p.rateWindowSeconds,
              p.gate,
            ]),
        );
      return withImmediateTransaction(db, () => {
        const mission = requireMission(id);
        validateFlatPolicy(ctx, policy, setIdsOf(mission));
        if (
          mission.creatorUserId !== actor ||
          mission.status === 'revoked' ||
          key(mission.policy) !== key(expected)
        )
          return null;
        const now = nowIso(ctx);
        if (requestId) {
          const request = db.prepare<
            [string, string, string],
            { risk_id: string; risk_ids_json: string | null }
          >(
            `SELECT risk_id, risk_ids_json FROM requests
             WHERE id = ? AND mission_id = ? AND kind = 'permission' AND state = 'open' AND expires_at > ?`,
          );
          const row = request.get(requestId, id, now);
          if (!row) return null;
          const asked = requestLinesOf(
            riskIdsOf(row.risk_id, row.risk_ids_json),
            storedLinesOf(ctx, requestId),
          );
          const granted = new Set(policy.map(lineKey));
          if (asked.length === 0 || !asked.every((line) => granted.has(lineKey(line)))) return null;
        }
        const kept = new Set(policy.map(lineKey));
        const removed = mission.policy.filter((p) => !kept.has(lineKey(p)));
        deletePolicy.run(id);
        writePolicy(id, policy);
        touch.run(now, id);
        const session = sessions.sessionOfMission(id);
        if (session) {
          for (const p of removed)
            sessions.recordEvent(
              session.id,
              {
                kind: 'gate-changed',
                riskId: p.riskId,
                resourceSetId: p.resourceSetId,
                actorUserId: actor,
                details: { gate: 'approval', gate_before: p.gate },
              },
              now,
            );
          sessions.recordEvent(
            session.id,
            {
              kind: 'permissions-changed',
              actorUserId: actor,
              details: { before: mission.policy, after: policy, request_id: requestId ?? null },
            },
            now,
          );
        }
        // An unconsumed approval must not survive removal and re-addition of its risk.
        for (const p of removed) retireApprovalsStmt.run(now, id, p.riskId, p.riskId);
        if (requestId)
          db.prepare(
            `UPDATE requests SET state = 'granted', decided_at = ?, decided_by_user_id = ?,
          decision_json = ?, args_blob = NULL, key_version = NULL WHERE id = ?`,
          ).run(now, actor, JSON.stringify({ resolution: 'add-permissions' }), requestId);
        return requireMission(id);
      });
    },
    async setGate(id, line, gate, actorUserId, options = {}) {
      const now = nowIso(ctx);
      return withImmediateTransaction(db, () => {
        const mission = requireMission(id);
        const target = lineOfInput(id, line);
        if (!target) return null;
        const row = lineOf.get(id, target.resourceSetId, target.riskId);
        if (!row) return null;
        const previous = parseEnum(GATES, row.gate, 'mission_policy.gate');
        const closing = previous === gate && gate === 'approval' && options.closeOpening === true;
        if (previous === gate && !closing) return { mission, previous, openingClosed: false };
        if (!closing) setGateStmt.run(gate, target.resourceSetId, target.riskId);
        touch.run(now, id);
        const session = sessions.sessionOfMission(id);
        if (session) {
          sessions.recordEvent(
            session.id,
            {
              kind: 'gate-changed',
              riskId: target.riskId,
              resourceSetId: target.resourceSetId,
              actorUserId,
              details: { gate, gate_before: previous },
            } satisfies NewEvent,
            now,
          );
        }
        return {
          mission: requireMission(id),
          previous,
          openingClosed: closing && session !== null,
        };
      });
    },
    async setLimits(id, changes, actorUserId) {
      for (const change of changes) {
        if (!Number.isInteger(change.quota) || change.quota < 0) {
          throw new InvariantError(`quota must be a non-negative integer (${change.riskId})`);
        }
        if (!Number.isInteger(change.rateLimit) || change.rateLimit < 0) {
          throw new InvariantError(`rate limit must be a non-negative integer (${change.riskId})`);
        }
      }
      const now = nowIso(ctx);
      return withImmediateTransaction(db, () => {
        requireMission(id);
        const applied: AppliedLimitChange[] = [];
        const seen = new Set<string>();
        for (const change of changes) {
          const target = lineOfInput(id, change);
          if (!target) return null;
          if (seen.has(lineKey(target))) throw new InvariantError('duplicate line in limits');
          seen.add(lineKey(target));
          const row = lineOf.get(id, target.resourceSetId, target.riskId);
          if (!row) return null;
          const moved = row.quota !== change.quota || row.rate_limit !== change.rateLimit;
          applied.push({
            resourceSetId: target.resourceSetId,
            riskId: target.riskId,
            before: { quota: row.quota, rateLimit: row.rate_limit },
            after: { quota: change.quota, rateLimit: change.rateLimit },
            rateWindowSeconds: row.rate_window_seconds,
            changed: moved,
          });
        }
        const moved = applied.filter((a) => a.changed);
        if (moved.length === 0) return { mission: requireMission(id), changes: applied };
        for (const a of moved) {
          setLimitsStmt.run(a.after.quota, a.after.rateLimit, a.resourceSetId, a.riskId);
        }
        touch.run(now, id);
        const session = sessions.sessionOfMission(id);
        if (session) {
          for (const a of moved) {
            sessions.recordEvent(
              session.id,
              {
                kind: 'limits-changed',
                riskId: a.riskId,
                resourceSetId: a.resourceSetId,
                actorUserId,
                details: {
                  quota: a.after.quota,
                  quota_before: a.before.quota,
                  rate_limit_max: a.after.rateLimit,
                  rate_limit_max_before: a.before.rateLimit,
                },
              } satisfies NewEvent,
              now,
            );
          }
        }
        return { mission: requireMission(id), changes: applied };
      });
    },
    async issueToken(input) {
      const id = ctx.newId();
      const now = nowIso(ctx);
      const { holder } = input;
      const replacedId = withImmediateTransaction(db, () => {
        const mission = requireMission(input.missionId);
        // The caller checked all of this before it computed the hash, which takes
        // tens of milliseconds: a revocation, a removal or a deactivation committed
        // meanwhile must not be undone by the insert. Checked again here, in the
        // transaction that writes.
        if (mission.status !== 'active') {
          throw new TokenNotIssuableError('mission-not-active', input.missionId);
        }
        let previous: TokenRow | undefined;
        if (holder.kind === 'member') {
          const row = memberOf.get(input.missionId, holder.userId);
          const membership = membershipOf(
            mission,
            holder.userId,
            userStatusOf(holder.userId),
            row ? { removedAt: row.removed_at } : null,
          );
          if (!isOnMission(membership)) {
            throw new TokenNotIssuableError('holder-not-a-member', input.missionId);
          }
          previous = activeOfMember.get(input.missionId, holder.userId);
          if (previous) retireOne.run(now, previous.id);
        } else if (input.replacing !== undefined) {
          const old = tokenById.get(input.replacing);
          if (
            !old ||
            old.mission_id !== input.missionId ||
            old.kind !== 'named' ||
            old.status !== 'active' ||
            old.name !== holder.name
          ) {
            throw new TokenNotIssuableError('token-not-replaceable', input.missionId);
          }
          retireOne.run(now, old.id);
          previous = old;
        } else if (activeOfName.get(input.missionId, holder.name)) {
          throw new TokenNotIssuableError('name-taken', input.missionId);
        }
        insertToken.run(
          id,
          input.missionId,
          input.prefix,
          input.hash,
          input.hashAlg,
          holder.kind,
          holder.kind === 'member' ? holder.userId : null,
          holder.kind === 'named' ? holder.name : null,
          input.createdBy,
          now,
        );
        return previous?.id ?? null;
      });
      return {
        token: requireToken(id),
        replaced: replacedId === null ? null : requireToken(replacedId),
      };
    },
    async findTokenByPrefix(prefix) {
      const row = tokenByPrefix.get(prefix);
      if (!row) return null;
      return { token: tokenToRecord(row), mission: requireMission(row.mission_id) };
    },
    async listTokens(missionId) {
      return tokensOf.all(missionId).map(tokenToRecord);
    },
    async getToken({ missionId, tokenId }) {
      const row = tokenOfMission.get(missionId, tokenId);
      return row ? tokenToRecord(row) : null;
    },
    async revokeTokens(missionId) {
      return revokeTokensStmt.run(nowIso(ctx), missionId).changes;
    },
    async revokeToken({ missionId, tokenId }) {
      const changed = revokeOneOfMission.run(nowIso(ctx), missionId, tokenId).changes;
      return changed === 1 ? requireToken(tokenId) : null;
    },
    async revokeMemberTokensOf(userId) {
      const now = nowIso(ctx);
      const ids = withImmediateTransaction(db, () => {
        const held = activeHeldAsMember.all(userId, userId);
        return held.filter((row) => revokeOne.run(now, row.id).changes === 1).map((row) => row.id);
      });
      return ids.map(requireToken);
    },
    async markTokenUsed({ missionId, tokenId }, granularitySeconds) {
      const stale = new Date(ctx.clock.now().getTime() - granularitySeconds * MS_PER_SECOND);
      return markUsed.run(nowIso(ctx), missionId, tokenId, stale.toISOString()).changes === 1;
    },
    async addMember(input) {
      const now = nowIso(ctx);
      const staleId = withImmediateTransaction(db, () => {
        const mission = requireMission(input.missionId);
        if (mission.creatorUserId === input.userId) {
          throw new InvariantError('the creator is a member by construction, never a member row');
        }
        // A member starts with no token. A working row found here predates this
        // membership (it should not exist: removal revokes, and `issueToken` refuses
        // a holder who is not on the mission): it is revoked with the same write.
        const stale = activeOfMember.get(input.missionId, input.userId);
        if (stale) revokeOne.run(now, stale.id);
        upsertMember.run(input.missionId, input.userId, input.addedBy, now);
        return stale?.id ?? null;
      });
      return {
        member: memberToRecord(
          requireRow(memberOf.get(input.missionId, input.userId), 'mission_member', input.userId),
        ),
        tokenRevoked: staleId === null ? null : requireToken(staleId),
      };
    },
    async removeMember(missionId, userId) {
      const now = nowIso(ctx);
      const revokedId = withImmediateTransaction(db, () => {
        if (markMemberRemoved.run(now, missionId, userId).changes === 0) return undefined;
        const held = activeOfMember.get(missionId, userId);
        if (!held) return null;
        revokeOne.run(now, held.id);
        return held.id;
      });
      if (revokedId === undefined) return null;
      return {
        member: memberToRecord(
          requireRow(memberOf.get(missionId, userId), 'mission_member', userId),
        ),
        tokenRevoked: revokedId === null ? null : requireToken(revokedId),
      };
    },
    async getMember(missionId, userId) {
      const row = memberOf.get(missionId, userId);
      return row ? memberToRecord(row) : null;
    },
    async listMembers(missionId) {
      return membersOf.all(missionId).map(memberToRecord);
    },
    async trustMarks(missionId) {
      return trustMarksOf.all(missionId).map((row) => ({
        resourceSetId: row.resource_set_id,
        macroActionId: row.macro_action_id,
        levelChangedAt: row.level_changed_at,
        snoozedAt: row.snoozed_at,
      }));
    },
    async snoozeTrustRaise(missionId, resourceSetId, macroActionId) {
      if (macroActionId === '') return false;
      const now = nowIso(ctx);
      const { changes } = snoozeStmt.run(
        missionId,
        resourceSetId,
        macroActionId,
        now,
        resourceSetId,
        missionId,
      );
      return changes > 0;
    },
  };
}
