import { permissionEditSchema, policyKey } from './permission-edit';
/**
 * `MissionService` — preview, issue, duplicate, rotate, revoke, and the gate
 * of a risk edited after issuance (spec §3.1, §3.2, §3.5, §7.4, §7.8; pivot
 * ADR D4).
 *
 * Reads accounts and resources through the store repositories only, asks
 * the `AuthorityService` what the creator may accept, and leaves the decision
 * to the pure `previewDraft`. A mission is persisted as an explicit
 * enumeration: explicit resource ids (even for "all"), explicit policy
 * entries (never a macro-action or trust level), and the creator's own token, whose
 * secret is returned once. Members and the other tokens of a mission are the
 * `MissionTeamService`'s (`team-service.ts`); this service says who may read a
 * mission (`access`) and what a presented token is worth (`verifyToken`).
 *
 * One rule for what a mission reaches on an account, shared with the
 * execution door (`execution/mission-context.ts`): exactly the resource ids
 * stored at issuance that discovery still returns. Scope `all` with an empty
 * list means "none known at issuance", never "everything discovered later";
 * the detail page and the bootstrap kit read it the same way.
 *
 * Store records are translated by `budget/mapping.ts` and
 * `accounts/mapping.ts` only; no record is written into an audit payload.
 */
import type { TokenHolder } from '@vaubaan/gateway-core';
import type { PluginRegistry, ResourceNoun } from '@vaubaan/plugin-sdk';
import {
  isGate,
  lineKeyOf,
  parseRiskId,
  policyLineKey,
  type Gate,
  type Iso8601,
  type MacroAction,
  type MissionPolicyEntry,
  type PolicyLineKey,
  type RateLimit,
  type RiskId,
  type SessionEventDetails,
} from '@vaubaan/shared';

import type {
  AuthorityService,
  Subject,
  InspectedMission,
  LostPart,
  MissionGrounds,
  OrphanCause,
  PartLossCause,
} from '../authority';
import { isFinalLoss } from '../authority';
import {
  budgetMissionOf,
  currentPeriod,
  GATE_EVENT_KINDS,
  isStale,
  missionUsageReader,
  openedGatesOf,
  policyEntryOf,
  policyEntryRecordOf,
  policyLineInputOf,
  statedPeriodOf,
  type CurrentPeriod,
  type MissionState,
  type SessionService,
} from '../budget';
import { isSelfResource, type SelfResource } from '../config';
import { accountSummaryOf, lastDiscoveryAt } from '../accounts/mapping';
import { revivesEndedMission, type CeilingCheck, type LimitReached } from '../limits';
import type { Logger } from '../logging';
import type { Store } from '../store';
import { TokenNotIssuableError } from '../store/errors';
import { isOnMission, membershipOf, type Membership } from '../store/membership';
import { reachedResourcesBySet, takesFutureResources } from '../store/mission-reach';
import { toIso, type Clock } from '../store/clock';
import type {
  AccountRecord,
  AccountResourceRecord,
  MissionAccountInput,
  MissionAccountRecord,
  MissionRecord,
  MissionResourceSetInput,
  MissionResourceSetRecord,
  MissionTokenRecord,
  RequestLine,
  MissionVersionRecord,
  UserRecord,
} from '../store/types';
import {
  buildBootstrapKit,
  type BootstrapKit,
  type KitGitRemote,
  type KitPolicyLine,
} from './bootstrap-kit';
import { gitRemoteBase } from '../git/paths';
import { enumerateCatalog } from '../../lib/missions/catalog-view';
import { macroActionsOf } from '../../lib/missions/macro-actions';
import { resourceNounOf } from '../../lib/services/resource-noun';
import type {
  CatalogRisk,
  DraftAccount,
  DraftPeriod,
  DraftResourceSet,
  IssuanceAccount,
  IssuanceResource,
  MissionDraft,
  MissionIssuer,
  MissionPreview,
  PreviewIssue,
  PreviewNotice,
  ResolvedDraftAccount,
  ResolvedDraftSet,
  Row,
} from '../../lib/missions/model';
import { parseMissionDraft } from './draft-schema';
import {
  auditOfChanges,
  changeSummaryOf,
  draftOfSnapshot,
  hasChanges,
  judgeEdit,
  type EditJudgement,
  revisionOf,
  type MissionChanges,
  type MissionSnapshot,
  type MissionSnapshotAccount,
} from '../../lib/missions/mission-edit';
import { checkPolicyLines, previewDraft } from '../../lib/missions/preview';
import { judgeRestore, type RestoreDropped } from '../../lib/missions/versions';
import {
  historyViewOf,
  type HistoryWords,
  type MissionHistoryView,
  type RestoreResult,
} from './history';
import { bearerMatches, mintMissionToken, prefixOfBearer, type TokenMinter } from './token';
import { reissueMemberToken } from './member-token';
import { issueTokenTo, type IssuedSecret } from './token-issuer';
import { trustRaiseOffers, type TrustRaiseOffer } from './trust-raise';
import type { NotificationEvents } from '../notifications/events';

const COPY_SUFFIX = ' (copy)';

export interface MissionServiceDeps {
  readonly store: Pick<
    Store,
    'missions' | 'missionVersions' | 'accounts' | 'sessions' | 'users' | 'auditWriter' | 'requests'
  >;
  readonly registry: PluginRegistry;
  readonly authority: AuthorityService;
  /**
   * `orphaned` is derived, never stored (spec §2.3): every mission this service
   * loads is read through `grounds.inspect`, so the pages, the gate edit, the
   * rotation and the session view all see the state of this instant.
   */
  readonly grounds: Pick<MissionGrounds, 'inspect'>;
  /** `InstanceConfig.publicUrl` — the instance URL of the bootstrap kit. */
  readonly publicUrl: URL;
  /**
   * `InstanceConfig.selfResources` — the instance's own resources: flagged and
   * never selectable at issuance, left out of a mission's detail and kit.
   */
  readonly selfResources: readonly SelfResource[];
  readonly clock: Clock;
  readonly logger: Logger;
  /** Tests inject a deterministic minter; production stores the SHA-256 digest. */
  readonly mint?: TokenMinter;
  /**
   * The budget's "load counters, derive state" read (`SessionService.stateOf`).
   * Defaults to the same read over `store.sessions`, for a module wired before
   * the `SessionService` exists.
   */
  readonly budget?: Pick<SessionService, 'stateOf'>;
  /**
   * The `limits.active_missions` ceiling (spec §4.3 bis): asked before a mission is
   * added and before an ended one is given a new end. Absent: no ceiling.
   */
  readonly ceilings?: CeilingCheck;
  /**
   * `trust_raise.after_approvals` (risk model §4.7): approvals granted on one
   * macro-action of one set before a raise is offered. Default 10.
   */
  readonly trustRaiseAfterApprovals?: number;
  /** Told of a revocation, after it is written; the creator hears of one by someone else. */
  readonly notifications?: Pick<NotificationEvents, 'missionRevoked'>;
}

/** The default of `trust_raise.after_approvals`. */
const DEFAULT_TRUST_RAISE_AFTER_APPROVALS = 10;

export interface PreviewOptions {
  /**
   * Environment labels to read as set, by resource id, without writing them.
   * Only the label changes: the accounts, the authority and the catalog are
   * the store's.
   */
  readonly assumedEnvs?: ReadonlyMap<string, string>;
}

/** The issuance context with some resources read under the labels a dry run would set. */
export function withAssumedEnvs(
  accounts: IssuanceAccount[],
  assumed: ReadonlyMap<string, string> | undefined,
): IssuanceAccount[] {
  if (!assumed || assumed.size === 0) return accounts;
  return accounts.map((account) => ({
    ...account,
    resources: account.resources.map((resource) => {
      const env = assumed.get(resource.id);
      return env === undefined ? resource : { ...resource, env };
    }),
  }));
}

/**
 * Set when the act comes through the `vaubaan` plugin (spec §4.1 bis): the
 * mission whose key made the call. The user — that mission's creator — stays
 * the actor and, for an issuance, the creator; the new mission records the
 * issuing one (`issued_via`) and the audit entry names it (`via_mission_id`,
 * spec §8).
 */
export interface IssueOptions {
  readonly issuedBy?: { readonly missionId: string };
}

export interface RevealedToken {
  /** The Bearer. This is the only time it exists outside the caller's hands. */
  readonly secret: string;
  readonly prefix: string;
}

export type IssueResult =
  | {
      readonly ok: true;
      readonly mission: MissionRecord;
      readonly token: RevealedToken;
      readonly kit: BootstrapKit;
      readonly preview: MissionPreview;
    }
  | { readonly ok: false; readonly reason: 'refused'; readonly preview: MissionPreview }
  | { readonly ok: false; readonly reason: 'not-found' }
  /** The instance holds as many active missions as its ceiling: nothing was issued. */
  | LimitReachedResult;

/** An addition refused by the `limits.active_missions` ceiling (spec §4.3 bis). */
export interface LimitReachedResult {
  readonly ok: false;
  readonly reason: 'limit-reached';
  /** "This gateway holds 3 active missions; its ceiling is 3." */
  readonly message: string;
  readonly limit: LimitReached;
}

export type RotateResult =
  | {
      readonly ok: true;
      readonly mission: MissionRecord;
      readonly token: RevealedToken;
      readonly kit: BootstrapKit;
    }
  | { readonly ok: false; readonly reason: 'not-found' }
  /** A mission asked to rotate a mission it did not issue. */
  | { readonly ok: false; readonly reason: 'not-issued-by-mission' }
  | { readonly ok: false; readonly reason: 'inactive'; readonly state: MissionState['kind'] };

export type RevokeResult =
  | { readonly ok: true; readonly mission: MissionRecord; readonly tokensRevoked: number }
  | { readonly ok: false; readonly reason: 'not-found' };

/** An orphaned mission as an owner of one of its accounts reads it. */
export interface OrphanedOnAccount {
  readonly id: string;
  readonly name: string;
  /** Who issued it: the only other person who can close it. */
  readonly creator_label: string;
  readonly cause: OrphanCause;
}

/**
 * A mission as an owner of one of its accounts reads it on the page of that
 * account ("Missions using this account"). An owner already reads the audit
 * entries of their account, mission names included (spec §8); this is the same
 * disclosure as a list. Nothing of another account of the mission is in it.
 */
export interface MissionOnAccount {
  readonly id: string;
  readonly name: string;
  /** Who issued it; `label` is the email, or "unknown user" when the row is gone. */
  readonly creator: { readonly id: string; readonly label: string };
  /** Derived now, like every reading of a mission's state. */
  readonly state: MissionState['kind'];
  /** Accepted risks whose quota is spent for the current period; `0` unless `active`. */
  readonly exhausted: number;
  readonly expires_at: Iso8601 | null;
  /** Why it reads `orphaned`; `null` otherwise. */
  readonly orphan_cause: OrphanCause | null;
  /**
   * Set when THIS account no longer serves the mission (revoked, or the creator's
   * access withdrawn) while the mission may still serve through its others.
   */
  readonly part_lost: PartLossCause | null;
  /** The resources of THIS account the mission was issued on: explicit ids. */
  readonly resource_ids: readonly string[];
  /** True when a set of it takes the resources that later appear in its environment. */
  readonly future: boolean;
  /** Accepted risks that belong to this account's service. */
  readonly permissions: number;
  /** How many of them wait for the creator's approval. */
  readonly asks_first: number;
  /** Whether the reader may open the mission's own page: its creator, a current member. */
  readonly readable: boolean;
  readonly created_at: Iso8601;
}

/** Who may close a mission, and on what ground (spec §2.3). */
type Closer =
  { readonly as: 'creator' } | { readonly as: 'account-owner'; readonly accountId: string };

export type SetGateResult =
  | {
      readonly ok: true;
      readonly mission: MissionRecord;
      readonly risk_id: RiskId;
      readonly gate: Gate;
      /** The gate before the edit; equal to `gate` when the stored gate did not move. */
      readonly previous: Gate;
      /**
       * `approval` was asked on a risk already gated whose gate the creator had
       * opened for the period: the opening is over (the stored gate did not move).
       */
      readonly opening_closed: boolean;
    }
  | { readonly ok: false; readonly reason: 'not-found' }
  | { readonly ok: false; readonly reason: 'invalid-gate' }
  | { readonly ok: false; readonly reason: 'risk-not-in-policy' }
  | {
      readonly ok: false;
      readonly reason: 'inactive';
      readonly state: 'revoked' | 'orphaned';
    };

/** The new limits of one accepted line, as the creator asks for them. */
export interface LimitEdit {
  readonly risk_id: RiskId;
  /** The set of the line; absent when exactly one set of the mission accepts the risk. */
  readonly resource_set_id?: string;
  /** Actions per period. */
  readonly quota: number;
  /** Calls per rate window; the window is the one the mission was issued with. */
  readonly rate_limit_max: number;
}

/** One line whose limits moved, before and after. */
export interface LimitChangeView {
  readonly risk_id: RiskId;
  readonly resource_set_id: string;
  readonly before: { readonly quota: number; readonly rate_limit: RateLimit };
  readonly after: { readonly quota: number; readonly rate_limit: RateLimit };
}

export type SetLimitsResult =
  | {
      readonly ok: true;
      readonly mission: MissionRecord;
      /** The risks whose limits moved; empty when every value asked was already the stored one. */
      readonly changed: readonly LimitChangeView[];
    }
  | { readonly ok: false; readonly reason: 'not-found' }
  /** No line, or a risk listed twice: the request is not a change of limits. */
  | { readonly ok: false; readonly reason: 'invalid-limits'; readonly problem: string }
  /** A change of limits never adds a permission: every risk must be in the policy. */
  | {
      readonly ok: false;
      readonly reason: 'risk-not-in-policy';
      readonly risk_ids: readonly RiskId[];
    }
  /** What issuance would refuse: outside the authority, above the catalog's ceiling, not a whole number. */
  | { readonly ok: false; readonly reason: 'refused'; readonly issues: readonly PreviewIssue[] }
  | {
      readonly ok: false;
      readonly reason: 'inactive';
      readonly state: 'revoked' | 'orphaned';
    };

/** What the creator's edit form starts from (`MissionService.editView`). */
export interface MissionEditView {
  readonly mission: MissionRecord;
  /** The mission as it stands, everything an edit may move. */
  readonly snapshot: MissionSnapshot;
  /** The draft that stands for it: sent back unchanged, an edit that moves nothing. */
  readonly draft: MissionDraft;
  /** What the edit must carry back (`MissionService.edit`'s `revision`). */
  readonly revision: string;
  /** Why the mission cannot be edited now; `null` when it can. */
  readonly blocked: 'revoked' | 'orphaned' | null;
}

/** What an edit would do, or why it is refused; writes nothing. */
export type EditPreviewResult =
  | {
      readonly ok: boolean;
      readonly reason?: undefined;
      readonly issues: readonly PreviewIssue[];
      readonly notices: readonly PreviewNotice[];
      readonly changes: MissionChanges;
      /** The mission's revision now: a different one than the editor's means a conflict. */
      readonly revision: string;
    }
  | { readonly ok: false; readonly reason: 'not-found' }
  | { readonly ok: false; readonly reason: 'invalid-edit'; readonly problems: readonly string[] }
  | { readonly ok: false; readonly reason: 'inactive'; readonly state: 'revoked' | 'orphaned' };

export type EditResult =
  | {
      readonly ok: true;
      readonly mission: MissionRecord;
      readonly changes: MissionChanges;
      /** The open requests the edit made moot, now closed. */
      readonly requests_closed: readonly string[];
    }
  | { readonly ok: false; readonly reason: 'not-found' }
  | { readonly ok: false; readonly reason: 'invalid-edit'; readonly problems: readonly string[] }
  | { readonly ok: false; readonly reason: 'inactive'; readonly state: 'revoked' | 'orphaned' }
  /** The mission changed since the editor read it: nothing was written. */
  | { readonly ok: false; readonly reason: 'conflict' }
  /** What issuance would refuse, about what the edit moves. */
  | {
      readonly ok: false;
      readonly reason: 'refused';
      readonly issues: readonly PreviewIssue[];
      readonly changes: MissionChanges;
    }
  /** A new end for an ended mission would add an active one past the ceiling. */
  | LimitReachedResult;

/** The body of an edit: the edited draft and the revision it was made from. */
function parseEditBody(
  raw: unknown,
):
  | { readonly ok: true; readonly draft: MissionDraft; readonly revision: string }
  | { readonly ok: false; readonly problems: readonly string[] } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, problems: ['The edit is an object { draft, revision }.'] };
  }
  const body = raw as Record<string, unknown>;
  const extra = Object.keys(body).filter((key) => key !== 'draft' && key !== 'revision');
  if (extra.length > 0) {
    return { ok: false, problems: [`Unexpected field(s): ${extra.join(', ')}.`] };
  }
  if (
    typeof body.revision !== 'string' ||
    body.revision.length === 0 ||
    body.revision.length > 64
  ) {
    return { ok: false, problems: ['revision: the revision the edit was made from.'] };
  }
  const parsed = parseMissionDraft(body.draft);
  if (!parsed.ok) return { ok: false, problems: parsed.problems.map((p) => `draft.${p}`) };
  return { ok: true, draft: parsed.draft, revision: body.revision };
}

/** The revision of a stored mission, computed without IO (inside a store transaction too). */
function revisionOfRecord(mission: MissionRecord): string {
  return revisionOf({
    name: mission.name,
    expires_at: mission.expiresAt,
    period: statedPeriodOf(mission),
    accounts: mission.accounts.map((c) => ({
      account_id: c.accountId,
      resource_sets: c.resourceSets.map((set) => ({
        id: set.id,
        position: set.position,
        future: set.future,
        env: set.env,
        resource_ids: set.resourceIds,
      })),
    })),
    policy: mission.policy.map(policyEntryOf),
  });
}

/**
 * The public part of a verified token: what the execution door needs — the row,
 * the prefix and who it belongs to — never the hash.
 */
export interface VerifiedToken {
  readonly id: string;
  readonly prefix: string;
  readonly holder: TokenHolder;
}

/**
 * Why a token whose secret matched does not authenticate: `rotated` and
 * `revoked` are the stored status; `holder-removed` and `holder-deactivated`
 * are derived at every verification from the member's row and the user's
 * status, so a member token stops at the very next call (spec §0).
 */
export type TokenRetirement = 'rotated' | 'revoked' | 'holder-removed' | 'holder-deactivated';

/**
 * A presented Bearer, resolved. `retired` still names the mission: the
 * execution door answers `mission-inactive` for a revoked mission and an
 * authentication failure stating the reason for every other retirement.
 */
export type TokenVerification =
  | {
      readonly outcome: 'verified';
      readonly mission: MissionRecord;
      readonly token: VerifiedToken;
    }
  | {
      readonly outcome: 'retired';
      readonly reason: TokenRetirement;
      readonly mission: MissionRecord;
      readonly token: VerifiedToken;
    }
  | { readonly outcome: 'unknown' };

/** What a user is to a mission they can read (spec §0 "Mission member"). */
export type MissionRole = 'creator' | 'member';

/** A mission as one user may read it: derived state, and their role on it. */
export interface MissionAccess extends InspectedMission {
  readonly role: MissionRole;
}

/**
 * An account of a mission that no longer serves it (ADR
 * orphaned-missions-and-ownerless-connections, amendment 2026-10-21): the mission
 * keeps serving through its other accounts, and nothing is ever added back in
 * its place.
 */
export interface MissionLostAccount {
  readonly account_id: string;
  readonly cause: PartLossCause;
  /** True when it never comes back (revoked or gone); false while the access may return. */
  readonly final: boolean;
}

/** Why a mission reads `orphaned` right now (handbook authority, Invariants). */
export interface MissionOrphanReason {
  readonly cause: OrphanCause;
  /** The account the cause was met on; `null` when the creator is gone. */
  readonly account_id: string | null;
  /** The accepted risks the creator no longer covers. */
  readonly uncovered: readonly RiskId[];
}

export interface MissionOverview {
  /** `status` is derived: `orphaned` while the creator's authority is missing. */
  readonly mission: MissionRecord;
  /** What the reader is to this mission: its creator, or a member it is shared with. */
  readonly role: MissionRole;
  /** Who created it; `email` is `null` when the user row is gone. */
  readonly creator: { readonly id: string; readonly email: string | null };
  readonly state: MissionState;
  /** Set while the mission is orphaned; `null` as soon as the authority is back. */
  readonly orphan: MissionOrphanReason | null;
  /** The accounts that no longer serve it, in the mission's order; empty when all serve. */
  readonly lost: readonly MissionLostAccount[];
  /**
   * The public part of the reader's own active token of this mission; `null`
   * when they have none (a member who has not generated theirs, a revoked token).
   */
  readonly token: { readonly prefix: string; readonly created_at: string } | null;
  /** Who prepared it for its creator; `null` for a mission issued in the interface. */
  readonly issued_via: MissionIssuer | null;
}

/** One resource set of an account of a mission, as its page reads it (risk model §4.7). */
export interface MissionDetailSet {
  readonly id: string;
  /** From 1: "Resource set 2". */
  readonly position: number;
  /** What the set reaches now. */
  readonly resources: readonly IssuanceResource[];
  /** Resources that later appear in `env` join the set. */
  readonly future: boolean;
  /** The set's environment; `null` for none (or a legacy set mixing environments). */
  readonly env: string | null;
  /** Legacy (migration 0033): the set mixes environments; its next edit must split it. */
  readonly mixed_env: boolean;
  /** The trust levels the set was composed from; absent when none was recorded. */
  readonly trust_levels?: Readonly<Record<string, string>>;
}

export interface MissionDetailAccount {
  readonly id: string;
  readonly service: string;
  readonly service_label: string;
  /** What one resource of this service is called (`resourceNounOf`): "board" / "boards". */
  readonly resource_noun: ResourceNoun;
  readonly display_name: string;
  readonly status: string;
  /** What the mission reaches now (`reachedResources`). */
  readonly resources: readonly IssuanceResource[];
  /** A set of it takes the resources that later appear in its environment. */
  readonly future: boolean;
  /**
   * When discovery last ran on the account (any trigger: connect, refresh, after a
   * creating call, hourly, "check now"); `null` when never.
   */
  readonly last_checked_at: Iso8601 | null;
  /** Its resource sets, in order; one for an account given without sets. */
  readonly resource_sets: readonly MissionDetailSet[];
  /** Why this account no longer serves the mission; `null` while it serves. */
  readonly lost: PartLossCause | null;
  /**
   * The ids among `resources` the mission created itself and reaches since (ADR
   * created-resources-join-the-mission); absent when there is none.
   */
  readonly created_resource_ids?: readonly string[];
}

export interface MissionDetailRisk extends MissionPolicyEntry {
  readonly label: string;
  /** The row of the permission (risk model §4.6); `null` when its catalog no longer knows it. */
  readonly row: Row | null;
  /** Remaining actions this period; `null` when the mission is not active. */
  readonly remaining: number | null;
  /**
   * End of the period the creator opened this risk's gate for (spec §3.5): until then
   * calls pass without asking, although `gate` reads `approval`. `null` otherwise.
   */
  readonly gate_open_until: Iso8601 | null;
}

/**
 * The statuses on which a mission's gates are not edited: the ones from which it does
 * not come back by itself (spec §2.3). `status` is the derived one, so the edit is
 * open again as soon as an orphaned mission's authority is back. An EXPIRED mission is
 * not in the list: its creator can extend the expiry (a claim's `extend-expiry`), and
 * the gates they set meanwhile are the ones it serves with again. `setGate` refuses on
 * it and the mission page reads it from `MissionDetail.gates_editable`.
 */
export function gateEditBlockedBy(
  mission: Pick<MissionRecord, 'status'>,
): 'revoked' | 'orphaned' | null {
  return mission.status === 'revoked' || mission.status === 'orphaned' ? mission.status : null;
}

export interface MissionDetail extends MissionOverview {
  /** Whether `setGate` would take an edit now, from this reader. A member edits nothing. */
  readonly gates_editable: boolean;
  /**
   * Whether `setLimits` would take a change now, from this reader: the same rule as the
   * gates (the creator, on a mission that can serve again).
   */
  readonly limits_editable: boolean;
  readonly accounts: readonly MissionDetailAccount[];
  readonly policy: readonly MissionDetailRisk[];
  readonly period: DraftPeriod;
  /** The kit with the masked prefix; `null` when no token is active. */
  readonly kit: BootstrapKit | null;
  /**
   * The trust-raise proposals of the mission (risk model §4.7): to its creator, while it
   * runs; empty otherwise.
   */
  readonly trust_raises: readonly TrustRaiseOffer[];
}

/** The reached resources the mission created itself, as `created_resource_ids` (or nothing). */
function createdIdsOf(
  selection: MissionAccountRecord,
  reached: readonly Pick<AccountResourceRecord, 'id'>[],
): { readonly created_resource_ids?: readonly string[] } {
  const sources = new Map(
    selection.resourceSets.flatMap((set) => Object.entries(set.resourceSources ?? {})),
  );
  const ids = reached.filter((r) => sources.get(r.id) === 'created').map((r) => r.id);
  return ids.length > 0 ? { created_resource_ids: ids } : {};
}

function toIssuanceResource(r: AccountResourceRecord, self: boolean): IssuanceResource {
  return {
    id: r.id,
    ref: r.ref,
    display_name: r.displayName,
    env: r.env,
    hidden: r.hidden,
    stale: isStale(r),
    self,
  };
}

/** What a mission stores per resource set: its explicit list, `future` and environment. */
function setInputOf(resolved: ResolvedDraftSet): MissionResourceSetInput {
  return {
    resourceIds: resolved.resources.resource_ids,
    future: resolved.future,
    env: resolved.env,
    ...(Object.keys(resolved.trust_levels).length > 0
      ? { trustLevels: resolved.trust_levels }
      : {}),
    policy: resolved.policy.map(policyLineInputOf),
  };
}

/** What a mission stores per account: its sets, each with its lines. */
function accountInputOf(resolved: ResolvedDraftAccount): MissionAccountInput {
  return {
    accountId: resolved.account_id,
    resourceSets: resolved.resource_sets.map(setInputOf),
  };
}

/**
 * The `after` payload of the immutable `mission-issued` audit entry: snake_case
 * domain shapes only, built field by field so a rename in the store's types
 * never changes what the audit keeps.
 */
export interface MissionIssuedAudit {
  readonly [key: string]: unknown;
  readonly name: string;
  readonly accounts: readonly {
    readonly account_id: string;
    /** Every set's explicit ids together. */
    readonly resource_ids: readonly string[];
    /** The resource sets of the account (risk model §4.7). */
    readonly resource_sets: readonly {
      readonly resource_set_id: string;
      readonly position: number;
      /** Resources that later appear in `env` join the set. */
      readonly future: boolean;
      readonly env: string | null;
      readonly resource_ids: readonly string[];
    }[];
  }[];
  /** Every line, naming its set (`resource_set_id`). */
  readonly policy: readonly MissionPolicyEntry[];
  readonly period: DraftPeriod;
  readonly expires_at: string | null;
  readonly token_prefix: string;
}

function issuedAuditOf(mission: MissionRecord, tokenPrefix: string): MissionIssuedAudit {
  return {
    name: mission.name,
    accounts: mission.accounts.map((c) => ({
      account_id: c.accountId,
      resource_ids: c.resourceSets.flatMap((set) => [...set.resourceIds]),
      resource_sets: c.resourceSets.map((set) => ({
        resource_set_id: set.id,
        position: set.position,
        future: set.future,
        env: set.env,
        resource_ids: [...set.resourceIds],
      })),
    })),
    policy: mission.policy.map(policyEntryOf),
    period: statedPeriodOf(mission),
    expires_at: mission.expiresAt,
    token_prefix: tokenPrefix,
  };
}

export class MissionService {
  private readonly mint: TokenMinter;
  /** Catalog rows per service. The catalogs are immutable for the life of the registry. */
  private readonly catalogRows = new Map<string, readonly CatalogRisk[]>();
  /** Macro-actions per service, "Anything else" included; immutable like the catalogs. */
  private readonly catalogActions = new Map<string, readonly MacroAction[]>();

  private readonly budget: Pick<SessionService, 'stateOf'>;

  constructor(private readonly deps: MissionServiceDeps) {
    this.mint = deps.mint ?? mintMissionToken;
    this.budget = deps.budget ?? missionUsageReader(deps.store.sessions);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Issuance context and preview
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * The accounts the user may build a mission from: every non-revoked
   * account on which they hold a non-empty authority, with its resources,
   * its catalog as explicit ids and its macro-actions.
   */
  async issuanceContext(user: Subject): Promise<IssuanceAccount[]> {
    const candidates = await this.deps.authority.accountsOf(user);
    const context: IssuanceAccount[] = [];
    for (const account of candidates) {
      if (account.status === 'revoked') continue;
      const built = await this.issuanceAccount(user, account);
      if (built) context.push(built);
    }
    return context;
  }

  private async issuanceAccount(
    user: Subject,
    account: AccountRecord,
  ): Promise<IssuanceAccount | null> {
    const registered = this.deps.registry.get(account.service);
    if (!registered) return null;
    const authority = await this.deps.authority.authorityOf(user, account);
    if (authority.basis === 'none' || authority.riskIds.length === 0) return null;
    const resources = await this.deps.store.accounts.listResources(account.id);
    const { plugin } = registered;
    return {
      ...accountSummaryOf(account),
      service_label: plugin.displayName,
      resource_noun: resourceNounOf(plugin),
      derives_env: typeof plugin.envOf === 'function',
      default_env: account.defaultEnv,
      basis: authority.basis,
      resources: resources.map((r) => toIssuanceResource(r, this.isSelf(account.service, r))),
      risks: this.risksOf(account.service),
      authority: authority.riskIds,
      macro_actions: this.macroActionsOf(account.service),
    };
  }

  private macroActionsOf(service: string): readonly MacroAction[] {
    const cached = this.catalogActions.get(service);
    if (cached) return cached;
    const registered = this.deps.registry.get(service);
    const actions = registered ? macroActionsOf(registered.plugin.catalog) : [];
    this.catalogActions.set(service, actions);
    return actions;
  }

  private risksOf(service: string): readonly CatalogRisk[] {
    const cached = this.catalogRows.get(service);
    if (cached) return cached;
    const registered = this.deps.registry.get(service);
    const rows = registered ? enumerateCatalog(registered.plugin.catalog) : [];
    this.catalogRows.set(service, rows);
    return rows;
  }

  /**
   * What passes, what exceeds the authority, what becomes callable. Writes
   * nothing. `assumedEnvs` reads some resources as if they carried another
   * environment label — a dry run that would set those labels first (the v4
   * importer) — so that the preview and the later issuance agree.
   */
  async preview(
    user: Subject,
    draft: MissionDraft,
    options: PreviewOptions = {},
  ): Promise<MissionPreview> {
    const accounts = withAssumedEnvs(await this.issuanceContext(user), options.assumedEnvs);
    return previewDraft({ accounts, now: this.deps.clock.now() }, draft);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Issue, duplicate
  // ───────────────────────────────────────────────────────────────────────────

  async issue(
    user: Subject,
    draft: MissionDraft,
    options: IssueOptions = {},
  ): Promise<IssueResult> {
    const context = await this.issuanceContext(user);
    const preview = previewDraft({ accounts: context, now: this.deps.clock.now() }, draft);
    if (!preview.ok) return { ok: false, reason: 'refused', preview };
    const ceiling = await this.activeMissionCeiling();
    if (ceiling) return ceiling;

    const mission = await this.deps.store.missions.create({
      name: preview.name,
      creatorUserId: user.id,
      periodSeconds: draft.period.kind === 'recurring' ? draft.period.length_seconds : null,
      expiresAt: draft.expires_at === null ? null : new Date(draft.expires_at).toISOString(),
      issuedByMissionId: options.issuedBy?.missionId ?? null,
      accounts: preview.resolved.map(accountInputOf),
    });
    // The creator is a member by construction: the mission is born with their own token.
    const token = await this.issueCreatorToken(mission);

    await this.deps.store.auditWriter.write({
      kind: 'admin',
      ts: toIso(this.deps.clock.now()),
      user_id: user.id,
      act: 'mission-issued',
      object: { type: 'mission', id: mission.id },
      before: null,
      after: issuedAuditOf(mission, token.prefix),
      via_mission_id: options.issuedBy?.missionId ?? null,
    });
    this.deps.logger.info('mission issued', {
      mission_id: mission.id,
      creator_id: user.id,
      accounts: mission.accounts.length,
      risks: mission.policy.length,
      token_prefix: token.prefix,
      issued_by_mission_id: options.issuedBy?.missionId ?? null,
    });

    return {
      ok: true,
      mission,
      token: { secret: token.secret, prefix: token.prefix },
      kit: await this.kitOf(mission, { secret: token.secret }),
      preview,
    };
  }

  /**
   * The draft that re-issues an existing mission of the user: same
   * accounts, resources still present, same explicit policy, same period;
   * no expiry carried over (a past date would refuse the copy). `null` when
   * the mission is not theirs.
   *
   * Each set is drafted as a set: its surviving resources, `future` and, when
   * it lists none, its environment; a set that lists none and takes nothing later
   * is drafted `{ scope: 'all' }`, resolved against the resources known at the copy. A legacy set mixing environments (migration
   * 0033) is drafted the legacy way — `{ scope: 'account' }` when it took future
   * resources, its resources otherwise — so that the copy is split by environment
   * (or refused as mixed, inside `resource_sets`): never wider than its source.
   */
  async draftFrom(user: Subject, missionId: string): Promise<MissionDraft | null> {
    const mission = await this.ownMission(user, missionId);
    if (!mission) return null;
    const accounts: DraftAccount[] = [];
    const policy = mission.policy.map(policyEntryOf);
    for (const c of mission.accounts) {
      const account = await this.deps.store.accounts.getById(c.accountId);
      if (!account) continue;
      const service = account.service;
      const sets: DraftResourceSet[] = [];
      for (const set of c.resourceSets) {
        const ids = await this.survivingResources(c.accountId, set, service);
        const legacyWhole = set.mixedEnv && set.future;
        // A set that holds nothing and takes nothing later: "all", resolved at the copy.
        const nothing = ids.length === 0 && !set.future;
        sets.push({
          resources: legacyWhole
            ? { scope: 'account' }
            : nothing
              ? { scope: 'all' }
              : { scope: 'selected', resource_ids: ids },
          ...(set.mixedEnv ? {} : { future: set.future }),
          ...(!set.mixedEnv && ids.length === 0 ? { env: set.env } : {}),
          everything_i_hold: false,
          policy: policy
            .filter((entry) => entry.resource_set_id === set.id)
            .map(({ resource_set_id: _set, ...line }) => line),
          ...(set.trustLevels ? { trust_levels: set.trustLevels } : {}),
        });
      }
      const [only] = sets;
      // A legacy mixed set alone is drafted flat, so that it is split by environment.
      const flat = c.resourceSets.length === 1 && c.resourceSets[0]?.mixedEnv === true && only;
      if (flat) {
        const { future: _future, env: _env, ...fields } = only;
        accounts.push({ account_id: c.accountId, ...fields });
      } else {
        accounts.push({ account_id: c.accountId, resource_sets: sets });
      }
    }
    return {
      name: `${mission.name}${COPY_SUFFIX}`,
      accounts,
      period: statedPeriodOf(mission),
      expires_at: null,
    };
  }

  private async survivingResources(
    accountId: string,
    set: MissionResourceSetRecord,
    service: string,
  ): Promise<string[]> {
    const current = await this.deps.store.accounts.listResources(accountId);
    // A stale resource would refuse the copy: it is dropped like a vanished one.
    // So is one of the instance's own resources, which no mission may reach.
    const known = new Set(
      current.filter((r) => !isStale(r) && !this.isSelf(service, r)).map((r) => r.id),
    );
    return set.resourceIds.filter((id) => known.has(id));
  }

  /** True when the resource is one of this instance's own (`selfResources`). */
  private isSelf(service: string, resource: Pick<AccountResourceRecord, 'ref'>): boolean {
    return isSelfResource(this.deps.selfResources, service, resource.ref);
  }

  /** The refusal of one more active mission, or `null` while one more fits. */
  private async activeMissionCeiling(): Promise<LimitReachedResult | null> {
    const reached = await this.deps.ceilings?.refusal('active-missions');
    if (!reached) return null;
    this.deps.logger.warn('mission refused at the ceiling of active missions', {
      count: reached.count,
      ceiling: reached.limit,
    });
    return { ok: false, reason: 'limit-reached', message: reached.message, limit: reached };
  }

  /**
   * "Duplicate mission": re-issues the source's draft under the creator's
   * *current* authority (a risk they no longer hold refuses the copy) and
   * returns a new mission with its own token and its own budget.
   */
  async duplicate(
    user: Subject,
    missionId: string,
    overrides: Partial<Pick<MissionDraft, 'name' | 'period' | 'expires_at'>> = {},
    options: IssueOptions = {},
  ): Promise<IssueResult> {
    const draft = await this.draftFrom(user, missionId);
    if (!draft) return { ok: false, reason: 'not-found' };
    return this.issue(user, { ...draft, ...overrides }, options);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Token: mint, rotate, revoke, verify
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Mints and stores the creator's own member token; their previous active one,
   * if any, becomes `rotated`. The tokens of the other holders are untouched.
   */
  private issueCreatorToken(mission: MissionRecord): Promise<IssuedSecret> {
    return issueTokenTo(
      { missions: this.deps.store.missions, mint: this.mint },
      {
        missionId: mission.id,
        holder: { kind: 'member', userId: mission.creatorUserId },
        createdBy: mission.creatorUserId,
      },
    );
  }

  /**
   * A new token for the creator, same mission, same session, same budget
   * (spec §7.8): the creator's previous token stops working; every other
   * holder's token is untouched. A member rotates their own token through
   * `MissionTeamService.generateToken`, which the creator may use as well.
   *
   * Through the `vaubaan` plugin (`options.issuedBy`) only a mission that very
   * mission issued is rotated: the new token is handed to the caller, so
   * rotating a mission the human issued — wider, perhaps with a gate they
   * opened — would hand an agent an authority nobody issued to it
   * (docs/spec/vaubaan-gateway.md §6). The human rotates any of their missions
   * in the interface.
   */
  async rotate(
    user: Subject,
    missionId: string,
    options: IssueOptions = {},
  ): Promise<RotateResult> {
    const mission = await this.ownMission(user, missionId);
    if (!mission) return { ok: false, reason: 'not-found' };
    if (options.issuedBy && mission.issuedByMissionId !== options.issuedBy.missionId) {
      return { ok: false, reason: 'not-issued-by-mission' };
    }
    const state = await this.stateOf(mission);
    if (state.kind !== 'active') return { ok: false, reason: 'inactive', state: state.kind };

    let token: IssuedSecret;
    try {
      // The one implementation of "a member's own token, issued or replaced"
      // (`member-token.ts`), shared with `MissionTeamService.generateToken`.
      token = await reissueMemberToken(
        { store: this.deps.store, mint: this.mint, clock: this.deps.clock },
        {
          missionId: mission.id,
          userId: user.id,
          viaMissionId: options.issuedBy?.missionId ?? null,
        },
      );
    } catch (err) {
      // Revoked while the hash was computed: the store refused the insert.
      if (!(err instanceof TokenNotIssuableError)) throw err;
      return { ok: false, reason: 'inactive', state: await this.stateAfterRefusal(mission.id) };
    }
    this.deps.logger.info('mission token rotated', {
      mission_id: mission.id,
      token_prefix: token.prefix,
      issued_by_mission_id: options.issuedBy?.missionId ?? null,
    });
    return {
      ok: true,
      mission,
      token: { secret: token.secret, prefix: token.prefix },
      kit: await this.kitOf(mission, { secret: token.secret }),
    };
  }

  /**
   * The orphaned missions that carry an account, for someone who owns that
   * account now (spec §2.3: "the creator, or an owner of the account, may close
   * it"). Anyone else reads none. Derived at this instant, like every reading of
   * `orphaned`.
   */
  async orphanedOn(user: Subject, accountId: string): Promise<OrphanedOnAccount[]> {
    const account = await this.deps.store.accounts.getById(accountId);
    if (!account || !(await this.owns(user, account))) return [];
    const orphaned: OrphanedOnAccount[] = [];
    for (const mission of await this.deps.store.missions.listForAccount(accountId)) {
      const { orphan } = await this.deps.grounds.inspect(mission);
      if (!orphan) continue;
      const creator = await this.deps.store.users.getById(mission.creatorUserId);
      orphaned.push({
        id: mission.id,
        name: mission.name,
        creator_label: creator?.email ?? 'unknown user',
        cause: orphan.cause,
      });
    }
    return orphaned;
  }

  /**
   * Every mission that carries an account, newest first, for someone who owns that
   * account now. Anyone else reads none, like `orphanedOn`. Read-only: the page of
   * the account lists them, so that its owner knows what removing an access or
   * disconnecting would stop.
   */
  async onAccount(user: Subject, accountId: string): Promise<MissionOnAccount[]> {
    const account = await this.deps.store.accounts.getById(accountId);
    if (!account || !(await this.owns(user, account))) return [];
    const listed: MissionOnAccount[] = [];
    for (const stored of await this.deps.store.missions.listForAccount(accountId)) {
      const { mission, orphan, lost } = await this.deps.grounds.inspect(stored);
      const state = await this.stateOf(mission);
      const creator = await this.deps.store.users.getById(mission.creatorUserId);
      const membership = await this.membershipOf(mission, user.id);
      const accepted = mission.policy.filter(
        (entry) => parseRiskId(entry.riskId)?.service === account.service,
      );
      const selection = mission.accounts.find((c) => c.accountId === accountId);
      listed.push({
        id: mission.id,
        name: mission.name,
        creator: { id: mission.creatorUserId, label: creator?.email ?? 'unknown user' },
        state: state.kind,
        exhausted: state.kind === 'active' ? state.exhausted.length : 0,
        expires_at: mission.expiresAt,
        orphan_cause: orphan?.cause ?? null,
        part_lost: lost.find((part) => part.accountId === accountId)?.cause ?? null,
        resource_ids: selection?.resourceSets.flatMap((set) => [...set.resourceIds]) ?? [],
        future: selection ? takesFutureResources(selection) : false,
        permissions: accepted.length,
        asks_first: accepted.filter((entry) => entry.gate === 'approval').length,
        readable: membership === 'creator' || membership === 'member',
        created_at: mission.createdAt,
      });
    }
    return listed.sort((a, b) =>
      a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0,
    );
  }

  /**
   * The mission refuses everything from now on; every token of every holder is revoked.
   * Idempotent. An orphaned mission is revoked like any other: this is how it is
   * closed for good (the stored status goes `active` → `revoked`).
   *
   * Who may (spec §2.3): the creator, always; and, **only while the mission is
   * orphaned**, an owner of one of its accounts — the authority that grounded it is
   * gone, and it would serve again, with the token its agent holds, the day a share is
   * made again. A mission that serves is its creator's alone. A mission acting through
   * the `vaubaan` plugin acts for its creator only.
   */
  async revoke(
    user: Subject,
    missionId: string,
    options: IssueOptions = {},
  ): Promise<RevokeResult> {
    const closing = await this.closableBy(user, missionId, options);
    if (!closing) return { ok: false, reason: 'not-found' };
    const { mission, closer } = closing;
    if (mission.status === 'revoked') return { ok: true, mission, tokensRevoked: 0 };

    const revoked = await this.deps.store.missions.setStatus(mission.id, 'revoked');
    const tokensRevoked = await this.deps.store.missions.revokeTokens(mission.id);
    await this.deps.store.auditWriter.write({
      kind: 'admin',
      ts: toIso(this.deps.clock.now()),
      user_id: user.id,
      act: 'mission-revoked',
      object: { type: 'mission', id: mission.id },
      before: { status: mission.status },
      after: {
        status: revoked.status,
        tokens_revoked: tokensRevoked,
        // Named only when it is not the creator: the entry says on what ground they acted.
        ...(closer.as === 'account-owner'
          ? { closed_as: closer.as, account_id: closer.accountId }
          : {}),
      },
      via_mission_id: options.issuedBy?.missionId ?? null,
    });
    await this.recordEvent(mission.id, user.id, {
      kind: 'revocation',
      details: { tokens_revoked: tokensRevoked },
    });
    this.deps.logger.info('mission revoked', {
      mission_id: mission.id,
      closed_as: closer.as,
      via_mission_id: options.issuedBy?.missionId ?? null,
    });
    this.deps.notifications?.missionRevoked(mission.id, user.id);
    return { ok: true, mission: revoked, tokensRevoked };
  }

  /**
   * The mission as derived now, when `user` may close it, and on what ground.
   * `null` — "not found" — for everyone else, so that an owner learns nothing about
   * the missions of their account that serve.
   */
  private async closableBy(
    user: Subject,
    missionId: string,
    options: IssueOptions,
  ): Promise<{ mission: MissionRecord; closer: Closer } | null> {
    const stored = await this.deps.store.missions.getById(missionId);
    if (!stored) return null;
    const { mission } = await this.deps.grounds.inspect(stored);
    if (stored.creatorUserId === user.id) return { mission, closer: { as: 'creator' } };
    // A mission acts for its creator through the `vaubaan` plugin, never as an owner.
    if (options.issuedBy) return null;
    // Orphaned now; or already closed, which is answered the same to who could close it.
    if (mission.status !== 'orphaned' && mission.status !== 'revoked') return null;
    for (const { accountId } of stored.accounts) {
      const account = await this.deps.store.accounts.getById(accountId);
      if (account && (await this.owns(user, account))) {
        return { mission, closer: { as: 'account-owner', accountId } };
      }
    }
    return null;
  }

  /** The one definition of "owns the account now": the authority's (`basis: 'owner'`). */
  private async owns(user: Subject, account: AccountRecord): Promise<boolean> {
    return (await this.deps.authority.authorityOf(user, account)).basis === 'owner';
  }

  /**
   * The creator edits the gate of one accepted risk after issuance (spec §3.5 "at
   * issuance, or later"): `auto` ⇄ `approval`. Only the gate moves — the accepted
   * risks, quotas and rate limits are the mission's as issued, and a gate is not part
   * of what a share restricts, so no authority is re-checked. The edit applies to the
   * next call, ends an opening "for the rest of the period" granted earlier on that
   * risk, and leaves the open requests where they are.
   */
  async setGate(
    user: Subject,
    missionId: string,
    riskId: RiskId,
    gate: string,
    /** The set of the line; absent when exactly one set of the mission accepts the risk. */
    resourceSetId?: string,
  ): Promise<SetGateResult> {
    const mission = await this.ownMission(user, missionId);
    if (!mission) return { ok: false, reason: 'not-found' };
    if (!isGate(gate)) return { ok: false, reason: 'invalid-gate' };
    const blocked = gateEditBlockedBy(mission);
    if (blocked) return { ok: false, reason: 'inactive', state: blocked };
    // "Ask me again" on a risk that is gated but open for the period must end the
    // opening: the stored gate would not move, so the store is told what was found.
    // The opening is looked for in the period that runs NOW, whether or not the mission
    // serves at this instant: an expired mission whose expiry is then extended in the
    // same period would otherwise come back with the opening the creator just closed.
    //
    // single-process only: the read and the write are two store calls, so an opening
    // granted between them is missed. Not reachable while every store call is
    // synchronous in one process; with a second process, decide inside
    // `MissionsRepo.setGate`'s transaction (it owns the session's events).
    const line = lineOfRisk(mission, riskId, resourceSetId);
    if (!line) return { ok: false, reason: 'risk-not-in-policy' };
    const openNow =
      gate === 'approval' &&
      (await this.openGatesIn(mission, this.periodNow(mission))).has(
        policyLineKey(line.resourceSetId, riskId),
      );
    const changed = await this.deps.store.missions.setGate(mission.id, line, gate, user.id, {
      closeOpening: openNow,
    });
    if (!changed) return { ok: false, reason: 'risk-not-in-policy' };
    const { previous, openingClosed } = changed;
    if (previous !== gate || openingClosed) {
      await this.deps.store.auditWriter.write({
        kind: 'admin',
        ts: toIso(this.deps.clock.now()),
        user_id: user.id,
        act: 'gate-changed',
        object: { type: 'mission', id: mission.id },
        before: {
          risk_id: riskId,
          resource_set_id: line.resourceSetId,
          gate: previous,
          ...(openingClosed ? { open_for_period: true } : {}),
        },
        after: {
          risk_id: riskId,
          resource_set_id: line.resourceSetId,
          gate,
          ...(openingClosed ? { open_for_period: false } : {}),
        },
      });
      this.deps.logger.info('mission gate changed', {
        mission_id: mission.id,
        risk_id: riskId,
        gate,
        opening_closed: openingClosed,
      });
    }
    return {
      ok: true,
      mission: changed.mission,
      risk_id: riskId,
      gate,
      previous,
      opening_closed: openingClosed,
    };
  }

  /**
   * The creator changes the limits of accepted risks after issuance (spec §3.2): per
   * risk already in the mission, its quota per period and its calls per rate window, up
   * or down. Never a risk added or removed, never the period nor the rate window, never
   * the gate (that is `setGate`). Creator only, like every mutation of a mission; there
   * is no delegated variant: the management door is not handed this method.
   *
   * A value that moves is judged by issuance's own check of a policy line
   * (`checkPolicyLines`): inside the creator's authority on the account NOW, a whole
   * number of at least one, a rate under the catalog's ceiling. Whatever caps a creation
   * caps the change; a value that does not move is not judged again.
   *
   * The change applies to the current period at once: what was used stays used, and a
   * quota lowered under it leaves the risk exhausted until the reset. The budget reads
   * the stored limits inside its decision transaction (`DecideContext.limits`), so no
   * call decided after the write commits passes above the new limit. One
   * `limits-changed` audit entry carries every risk that moved, before and after.
   *
   * Between the authority check and the write, the creator's authority may go: the
   * mission then reads `orphaned` and serves nothing, as an issuance racing the same
   * revocation would.
   */
  async setLimits(
    user: Subject,
    missionId: string,
    edits: readonly LimitEdit[],
  ): Promise<SetLimitsResult> {
    const mission = await this.ownMission(user, missionId);
    if (!mission) return { ok: false, reason: 'not-found' };
    const blocked = gateEditBlockedBy(mission);
    if (blocked) return { ok: false, reason: 'inactive', state: blocked };
    if (edits.length === 0) {
      return { ok: false, reason: 'invalid-limits', problem: 'No permission is listed.' };
    }
    const ids = edits.map((edit) => edit.risk_id);
    const placed = edits.map((edit) => lineOfRisk(mission, edit.risk_id, edit.resource_set_id));
    const outside = edits.filter((_, i) => placed[i] === null).map((edit) => edit.risk_id);
    if (outside.length > 0) return { ok: false, reason: 'risk-not-in-policy', risk_ids: outside };
    const keys = placed.map((line) =>
      line ? policyLineKey(line.resourceSetId, line.riskId) : null,
    );
    const twice = [
      ...new Set(edits.filter((_, i) => keys.indexOf(keys[i] ?? null) !== i).map((e) => e.risk_id)),
    ];
    if (twice.length > 0) {
      return {
        ok: false,
        reason: 'invalid-limits',
        problem: `Listed more than once: ${twice.join(', ')}.`,
      };
    }
    const stored = new Map(
      mission.policy.map(
        (entry) => [policyLineKey(entry.resourceSetId, entry.riskId), entry] as const,
      ),
    );

    // The lines that move, as issuance would read them: same gate, same window.
    const moving: MissionPolicyEntry[] = [];
    edits.forEach((edit, i) => {
      const key = keys[i];
      const entry = key ? stored.get(key) : undefined;
      if (!entry || (entry.quota === edit.quota && entry.rateLimit === edit.rate_limit_max)) {
        return;
      }
      moving.push({
        resource_set_id: entry.resourceSetId,
        risk_id: edit.risk_id,
        quota: edit.quota,
        rate_limit: { max: edit.rate_limit_max, window_seconds: entry.rateWindowSeconds },
        gate: entry.gate,
      });
    });
    const issues = await this.limitIssues(user, mission, moving);
    if (issues.length > 0) return { ok: false, reason: 'refused', issues };

    const written = await this.deps.store.missions.setLimits(
      mission.id,
      edits.map((edit, i) => ({
        ...(placed[i] ? { resourceSetId: placed[i].resourceSetId } : {}),
        riskId: edit.risk_id,
        quota: edit.quota,
        rateLimit: edit.rate_limit_max,
      })),
      user.id,
    );
    if (!written) return { ok: false, reason: 'risk-not-in-policy', risk_ids: ids };
    const changed: LimitChangeView[] = written.changes
      .filter((change) => change.changed)
      .map((change) => ({
        risk_id: change.riskId,
        resource_set_id: change.resourceSetId,
        before: {
          quota: change.before.quota,
          rate_limit: { max: change.before.rateLimit, window_seconds: change.rateWindowSeconds },
        },
        after: {
          quota: change.after.quota,
          rate_limit: { max: change.after.rateLimit, window_seconds: change.rateWindowSeconds },
        },
      }));
    if (changed.length > 0) {
      await this.deps.store.auditWriter.write({
        kind: 'admin',
        ts: toIso(this.deps.clock.now()),
        user_id: user.id,
        act: 'limits-changed',
        object: { type: 'mission', id: mission.id },
        before: { limits: changed.map((c) => ({ risk_id: c.risk_id, ...c.before })) },
        after: { limits: changed.map((c) => ({ risk_id: c.risk_id, ...c.after })) },
      });
      this.deps.logger.info('mission limits changed', {
        mission_id: mission.id,
        risks: changed.length,
      });
    }
    return { ok: true, mission: written.mission, changed };
  }

  async permissionOptions(user: Subject, missionId: string) {
    const mission = await this.ownMission(user, missionId);
    if (!mission || gateEditBlockedBy(mission)) return null;
    const reached = await this.detailAccounts(mission);
    const candidates: {
      risk_id: string;
      /** The set the line would join (risk model §4.7). */
      resource_set_id: string;
      /** "Resource set 2" when the account has several; `null` otherwise. */
      resource_set_label: string | null;
      label: string;
      row: Row;
      reason: string;
      available: boolean;
      ceiling: number | null;
    }[] = [];
    for (const selected of mission.accounts) {
      const account = await this.deps.store.accounts.getById(selected.accountId);
      // A revoked account serves the mission no more: nothing is added on it.
      if (!account || account.status === 'revoked') continue;
      const context = await this.issuanceAccount(user, account);
      if (!context) continue;
      const sets = reached.find((r) => r.id === account.id)?.resource_sets ?? [];
      for (const set of sets) {
        for (const risk of context.risks) {
          const line: MissionPolicyEntry = {
            risk_id: risk.risk_id,
            quota: 1,
            rate_limit: { max: 1, window_seconds: 60 },
            gate: 'approval',
          };
          const issues = checkPolicyLines(context, set.resources, [line], 0).issues;
          candidates.push({
            risk_id: risk.risk_id,
            resource_set_id: set.id,
            resource_set_label: sets.length > 1 ? `Resource set ${set.position}` : null,
            label: risk.label,
            row: risk.row,
            reason: issues.map((i) => i.message).join(' '),
            available: issues.length === 0,
            ceiling: risk.rate_ceiling_per_minute,
          });
        }
      }
    }
    return {
      missionId: mission.id,
      missionName: mission.name,
      policy: budgetMissionOf(mission).policy,
      periodSeconds: mission.periodSeconds,
      candidates,
    };
  }

  /** Shared by a direct edit and the creator's answer to a permission request. */
  async changePermissions(user: Subject, missionId: string, raw: unknown) {
    const mission = await this.ownMission(user, missionId);
    if (!mission) return { ok: false as const, reason: 'not-found' };
    const parsed = permissionEditSchema.safeParse(raw);
    if (!parsed.success) return { ok: false as const, reason: 'invalid-edit' };
    const edit = parsed.data;
    const blocked = gateEditBlockedBy(mission);
    if (blocked) return { ok: false as const, reason: 'inactive', state: blocked };
    const before = budgetMissionOf(mission).policy;
    const asked = edit.request_id
      ? ((await this.deps.store.requests.getById(edit.request_id))?.lines ?? [])
      : [];
    const firstSets = new Map<string, string>();
    for (const c of mission.accounts) {
      const account = await this.deps.store.accounts.getById(c.accountId);
      const first = c.resourceSets[0];
      if (account && first) firstSets.set(account.service, first.id);
    }
    const expected = placeLines(mission, edit.expected_policy, asked, firstSets);
    const policy = placeLines(mission, edit.policy, asked, firstSets);
    if (!expected || !policy) return { ok: false as const, reason: 'invalid-edit' };
    if (policyKey(before) !== policyKey(expected))
      return { ok: false as const, reason: 'conflict' };
    if (new Set(policy.map(lineKeyOf)).size !== policy.length)
      return { ok: false as const, reason: 'invalid-edit' };
    // Existing lines use the dedicated limits and gate controls; this edit adds/removes.
    const previous = new Map(before.map((p) => [lineKeyOf(p), p]));
    if (
      policy.some((p) => {
        const was = previous.get(lineKeyOf(p));
        return was !== undefined && policyKey([p]) !== policyKey([was]);
      })
    ) {
      return { ok: false as const, reason: 'invalid-edit' };
    }
    const additions = policy.filter((p) => !previous.has(lineKeyOf(p)));
    const issues = await this.limitIssues(user, mission, additions);
    if (issues.length) return { ok: false as const, reason: 'refused', issues };
    const asStored = (lines: readonly MissionPolicyEntry[]) =>
      lines.map((p) => policyEntryRecordOf({ ...p, resource_set_id: p.resource_set_id ?? '' }));
    if (policyKey(before) === policyKey(policy) && !edit.request_id)
      return { ok: true as const, mission };
    const written = await this.deps.store.missions.changePermissions(
      mission.id,
      asStored(policy),
      asStored(before),
      user.id,
      edit.request_id,
    );
    if (!written) return { ok: false as const, reason: 'conflict' };
    await this.deps.store.auditWriter.write({
      kind: 'admin',
      ts: toIso(this.deps.clock.now()),
      user_id: user.id,
      act: 'permissions-changed',
      object: { type: 'mission', id: mission.id },
      before: { policy: before },
      after: { policy, request_id: edit.request_id ?? null },
    });
    return { ok: true as const, mission: written };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Edit after issuance (ADR mission-editable-after-issuance)
  // ───────────────────────────────────────────────────────────────────────────

  /** The mission as everything an edit may move, its policy partitioned per account. */
  private async snapshotOf(mission: MissionRecord): Promise<MissionSnapshot> {
    const policy = mission.policy.map(policyEntryOf);
    const accounts: MissionSnapshotAccount[] = [];
    for (const c of mission.accounts) {
      const account = await this.deps.store.accounts.getById(c.accountId);
      accounts.push({
        account_id: c.accountId,
        service: account?.service ?? '',
        display_name: account?.displayName ?? c.accountId,
        resource_sets: c.resourceSets.map((set) => ({
          key: set.id,
          id: set.id,
          position: set.position,
          future: set.future,
          env: set.env,
          resource_ids: [...set.resourceIds],
          policy: policy.filter((entry) => entry.resource_set_id === set.id),
          ...(set.trustLevels ? { trust_levels: set.trustLevels } : {}),
        })),
      });
    }
    return {
      name: mission.name,
      expires_at: mission.expiresAt,
      period: statedPeriodOf(mission),
      accounts,
    };
  }

  /**
   * What the creator's edit form starts from: the mission as a snapshot and as a
   * draft, and its revision. `null` ("not found") for anyone but the creator.
   */
  async editView(user: Subject, missionId: string): Promise<MissionEditView | null> {
    const mission = await this.ownMission(user, missionId);
    if (!mission) return null;
    const snapshot = await this.snapshotOf(mission);
    return {
      mission,
      snapshot,
      draft: draftOfSnapshot(snapshot),
      revision: revisionOfRecord(mission),
      blocked: gateEditBlockedBy(mission),
    };
  }

  /** The judgement of an edit against the mission as it stands. */
  private async judged(user: Subject, missionId: string, raw: unknown) {
    const mission = await this.ownMission(user, missionId);
    if (!mission) return { ok: false as const, reason: 'not-found' as const };
    const blocked = gateEditBlockedBy(mission);
    if (blocked) return { ok: false as const, reason: 'inactive' as const, state: blocked };
    const body = parseEditBody(raw);
    if (!body.ok) {
      return { ok: false as const, reason: 'invalid-edit' as const, problems: body.problems };
    }
    const snapshot = await this.snapshotOf(mission);
    const accounts = await this.issuanceContext(user);
    const judgement = judgeEdit({ accounts, now: this.deps.clock.now() }, snapshot, body.draft);
    return {
      ok: true as const,
      mission,
      snapshot,
      judgement,
      asked: body.revision,
      revision: revisionOfRecord(mission),
    };
  }

  /** What an edit would change, or why it would be refused. Writes nothing. */
  async previewEdit(user: Subject, missionId: string, raw: unknown): Promise<EditPreviewResult> {
    const judged = await this.judged(user, missionId, raw);
    if (!judged.ok) return judged;
    const { judgement } = judged;
    return {
      ok: judgement.ok,
      issues: judgement.issues,
      notices: judgement.notices,
      changes: judgement.changes,
      revision: judged.revision,
    };
  }

  /**
   * The creator edits the mission after issuance, without limit on what moves but its
   * period (ADR mission-editable-after-issuance): `{ draft, revision }`, the edited
   * draft and the revision of the mission it was made from. Creator only — anyone
   * else is "not found" — and no delegated variant: the management door is not handed
   * this method. Revoked and orphaned missions are not edited; an expired one is.
   *
   * Judged by issuance's own check on what moves (`judgeEdit`): the creation's preview
   * under the creator's authority now, its issues kept when they are about something
   * the edit moves. Applied at once, in one store transaction (`MissionsRepo.edit`),
   * to the same token, session and counters; requests a removal makes moot are closed.
   * One `mission-changed` audit entry; an edit that moves nothing writes nothing.
   *
   * Between the authority check and the write, the creator's authority may go: the
   * mission then reads `orphaned` and serves nothing, as an issuance racing the same
   * revocation would.
   */
  async edit(user: Subject, missionId: string, raw: unknown): Promise<EditResult> {
    const judged = await this.judged(user, missionId, raw);
    if (!judged.ok) return judged;
    const { mission, snapshot, judgement, revision } = judged;
    if (judged.asked !== revision) return { ok: false, reason: 'conflict' };
    if (!judgement.ok) {
      return { ok: false, reason: 'refused', issues: judgement.issues, changes: judgement.changes };
    }
    return this.writeEdit(user, mission, snapshot, judgement, revision);
  }

  /**
   * Writes a judged edit (an ordinary one, or a rollback's with `restoredFrom`): one
   * store transaction, which leaves one version of the mission when something moved,
   * then one `mission-changed` audit entry. An edit that moves nothing writes nothing.
   */
  private async writeEdit(
    user: Subject,
    mission: MissionRecord,
    snapshot: MissionSnapshot,
    judgement: EditJudgement,
    revision: string,
    restoredFrom?: number,
  ): Promise<EditResult> {
    const { after, changes } = judgement;
    if (!hasChanges(changes)) return { ok: true, mission, changes, requests_closed: [] };
    if (revivesEndedMission(mission, after.expires_at, this.deps.clock.now())) {
      const ceiling = await this.activeMissionCeiling();
      if (ceiling) return ceiling;
    }

    const written = await this.deps.store.missions.edit(mission.id, {
      actorUserId: user.id,
      ...(restoredFrom !== undefined ? { restoredFrom } : {}),
      unchanged: (current) => revisionOfRecord(current) === revision,
      name: after.name,
      expiresAt: after.expires_at,
      accounts: after.accounts.map((c) => ({
        accountId: c.account_id,
        resourceSets: c.resource_sets.map((set) => ({
          ...(set.id !== null ? { id: set.id } : {}),
          resourceIds: [...set.resource_ids],
          future: set.future,
          env: set.env,
          ...(set.trust_levels && Object.keys(set.trust_levels).length > 0
            ? { trustLevels: set.trust_levels }
            : {}),
          policy: set.policy.map(policyLineInputOf),
        })),
      })),
      summary: (closed) => ({
        kind: 'mission-changed',
        actorUserId: user.id,
        details: changeSummaryOf(changes, closed),
      }),
    });
    if (!written) return { ok: false, reason: 'conflict' };
    const closed = written.closedRequests.map((r) => r.id);
    const audit = auditOfChanges(snapshot, after, changes);
    await this.deps.store.auditWriter.write({
      kind: 'admin',
      ts: toIso(this.deps.clock.now()),
      user_id: user.id,
      act: 'mission-changed',
      object: { type: 'mission', id: mission.id },
      before: audit.before,
      after: {
        ...audit.after,
        requests_closed: closed,
        ...(restoredFrom !== undefined ? { restored_from: restoredFrom } : {}),
      },
    });
    this.deps.logger.info(restoredFrom === undefined ? 'mission edited' : 'mission restored', {
      mission_id: mission.id,
      ...(restoredFrom !== undefined ? { restored_from: restoredFrom } : {}),
      accounts_added: changes.accounts_added.length,
      accounts_removed: changes.accounts_removed.length,
      permissions_added: changes.permissions_added.length,
      permissions_removed: changes.permissions_removed.length,
      permissions_changed: changes.permissions_changed.length,
      requests_closed: closed.length,
    });
    return { ok: true, mission: written.mission, changes, requests_closed: closed };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // History and rollback (spec §4.2 "History")
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * The versions of the mission's configuration, newest first, worded: to its creator
   * and its current members (`access`); `null` ("not found") to anyone else.
   * `restorable` says whether this reader may restore a past version now — the rule of
   * an edit: the creator, on a mission neither revoked nor orphaned.
   */
  async history(user: Subject, missionId: string): Promise<MissionHistoryView | null> {
    const access = await this.access(user, missionId);
    if (!access) return null;
    const records = await this.deps.store.missionVersions.list(missionId);
    const words = await this.historyWords(records);
    return historyViewOf(records, words, {
      restorable: access.role === 'creator' && gateEditBlockedBy(access.mission) === null,
    });
  }

  /**
   * "Restore this version": the creator brings a past version of the configuration
   * back, as an edit judged against the mission now (`judgeRestore`, `judgeEdit`):
   * bounded by their authority today — an account, a resource or a permission they can
   * no longer give is left out, and said in `dropped`; an end already past keeps the
   * current one. Written as an edit, which leaves a NEW version (cause `rollback`,
   * restored from `number`): history is never rewritten. Keys, teammates and counters
   * are untouched. A version that is already the configuration writes nothing
   * (`version: null`).
   */
  async restore(user: Subject, missionId: string, number: number): Promise<RestoreResult> {
    const mission = await this.ownMission(user, missionId);
    if (!mission) return { ok: false, reason: 'not-found' };
    const blocked = gateEditBlockedBy(mission);
    if (blocked) return { ok: false, reason: 'inactive', state: blocked };
    const version = await this.deps.store.missionVersions.get(missionId, number);
    if (!version) return { ok: false, reason: 'not-found' };
    const snapshot = await this.snapshotOf(mission);
    const accounts = await this.issuanceContext(user);
    const restored = judgeRestore(
      { accounts, now: this.deps.clock.now() },
      snapshot,
      version.config,
    );
    const dropped = await this.droppedWords(restored.dropped, number);
    if (!restored.judgement.ok) {
      return { ok: false, reason: 'refused', issues: restored.judgement.issues, dropped };
    }
    const written = await this.writeEdit(
      user,
      mission,
      snapshot,
      restored.judgement,
      revisionOfRecord(mission),
      number,
    );
    if (!written.ok) return written.reason === 'refused' ? { ...written, dropped } : written;
    if (!hasChanges(written.changes)) {
      return { ok: true, mission: written.mission, version: null, restored_from: number, dropped };
    }
    const [latest] = await this.deps.store.missionVersions.list(missionId);
    return {
      ok: true,
      mission: written.mission,
      version: latest?.number ?? null,
      restored_from: number,
      dropped,
    };
  }

  /** The names the history is worded with: people, missions, accounts, resources, risks. */
  private async historyWords(records: readonly MissionVersionRecord[]): Promise<HistoryWords> {
    const people = new Map<string, string>();
    const missions = new Map<string, string>();
    const accounts = new Map<string, { service: string; display_name: string }>();
    const resources = new Map<string, string>();
    for (const record of records) {
      const author = record.author;
      if (author.kind !== 'gateway' && author.userId && !people.has(author.userId)) {
        const person = await this.deps.store.users.getById(author.userId);
        people.set(author.userId, person?.email ?? 'a former user');
      }
      if (author.kind === 'mission' && !missions.has(author.missionId)) {
        const issuer = await this.deps.store.missions.getById(author.missionId);
        missions.set(author.missionId, issuer?.name ?? 'a mission');
      }
      for (const c of record.config.accounts) {
        if (accounts.has(c.account_id)) continue;
        const account = await this.deps.store.accounts.getById(c.account_id);
        if (!account) continue;
        accounts.set(c.account_id, {
          service: account.service,
          display_name: account.displayName,
        });
        for (const r of await this.deps.store.accounts.listResources(c.account_id)) {
          resources.set(r.id, r.displayName);
        }
      }
    }
    return {
      personOf: (userId) => people.get(userId) ?? 'a former user',
      missionOf: (missionId) => missions.get(missionId) ?? 'a mission',
      accountOf: (accountId) => accounts.get(accountId),
      resourceName: (_accountId, resourceId) => resources.get(resourceId) ?? 'a former resource',
      riskLabel: (riskId) => this.riskLabelOf(riskId),
    };
  }

  /** A permission's label in its service's catalog; its id when the catalog no longer knows it. */
  private riskLabelOf(riskId: RiskId): string {
    const service = parseRiskId(riskId)?.service;
    if (!service) return riskId;
    return this.risksOf(service).find((r) => r.risk_id === riskId)?.label ?? riskId;
  }

  /** What a restore left out, in sentences. */
  private async droppedWords(dropped: RestoreDropped, number: number): Promise<string[]> {
    const lines: string[] = [];
    const accountName = async (id: string) =>
      (await this.deps.store.accounts.getById(id))?.displayName ?? 'an account removed since';
    for (const id of dropped.accounts) {
      lines.push(`${await accountName(id)} is left out: you no longer hold it, or it was revoked.`);
    }
    for (const r of dropped.resources) {
      const resource = (await this.deps.store.accounts.listResources(r.account_id)).find(
        (row) => row.id === r.resource_id,
      );
      lines.push(
        `${resource?.displayName ?? 'A resource'} on ${await accountName(r.account_id)} is left out: it no longer exists.`,
      );
    }
    for (const p of dropped.permissions) {
      lines.push(
        `${this.riskLabelOf(p.risk_id)} on ${await accountName(p.account_id)} is left out: you no longer hold it there.`,
      );
    }
    if (dropped.expiry_kept) {
      lines.push(`The end of version ${number} has passed: the current end is kept.`);
    }
    return lines;
  }

  /**
   * Why issuance would refuse these lines on the mission's accounts now: each line
   * checked against the creator's authority on the account of its service, on the
   * resources the mission reaches there. Empty when every line passes.
   */
  private async limitIssues(
    user: Subject,
    mission: MissionRecord,
    lines: readonly MissionPolicyEntry[],
  ): Promise<PreviewIssue[]> {
    if (lines.length === 0) return [];
    const issues: PreviewIssue[] = [];
    const judged = new Set<RiskId>();
    const reached = await this.detailAccounts(mission);
    for (const [index, c] of mission.accounts.entries()) {
      const account = await this.deps.store.accounts.getById(c.accountId);
      if (!account) continue;
      const own = lines.filter((line) => parseRiskId(line.risk_id)?.service === account.service);
      if (own.length === 0) continue;
      for (const line of own) judged.add(line.risk_id);
      // A revoked account's part of the mission is lost for good: nothing widens on it.
      const context =
        account.status === 'revoked' ? null : await this.issuanceAccount(user, account);
      if (!context) {
        issues.push({
          code: 'exceeds-authority',
          message: `Outside your authority on "${account.displayName}": ${own
            .map((line) => line.risk_id)
            .join(', ')}.`,
          risk_ids: own.map((line) => line.risk_id),
          account_index: index,
          account_id: account.id,
        });
        continue;
      }
      const sets = reached.find((r) => r.id === account.id)?.resource_sets ?? [];
      for (const set of sets) {
        const ofSet = own.filter((line) => (line.resource_set_id ?? set.id) === set.id);
        if (ofSet.length === 0) continue;
        issues.push(...checkPolicyLines(context, set.resources, ofSet, index).issues);
      }
    }
    const unplaced = lines.filter((line) => !judged.has(line.risk_id)).map((l) => l.risk_id);
    if (unplaced.length > 0) {
      // A risk of a service none of the mission's accounts is for: nothing grounds it.
      issues.push({
        code: 'exceeds-authority',
        message: `No account of this mission carries ${unplaced.join(', ')}.`,
        risk_ids: unplaced,
      });
    }
    return issues;
  }

  /** Session events exist only once the session does (born on the first call). */
  private async recordEvent(
    missionId: string,
    actorUserId: string,
    event: Extract<SessionEventDetails, { kind: 'rotation' | 'revocation' }>,
  ): Promise<void> {
    const session = await this.deps.store.sessions.getByMission(missionId);
    if (!session) return;
    await this.deps.store.sessions.recordEvent(session.id, { ...event, actorUserId });
  }

  /**
   * Resolves a presented Bearer: prefix lookup, the comparison with the stored
   * SHA-256 digest, then what the token is worth at this instant
   * (`standingOf`). A malformed Bearer, an unknown prefix and a wrong secret
   * are the same answer (`unknown`).
   */
  async verifyToken(bearer: string): Promise<TokenVerification> {
    const prefix = prefixOfBearer(bearer);
    if (!prefix) return { outcome: 'unknown' };
    const found = await this.deps.store.missions.findTokenByPrefix(prefix);
    if (!found) return { outcome: 'unknown' };
    if (!bearerMatches(found.token, bearer)) return { outcome: 'unknown' };
    return this.standingOf(found);
  }

  /**
   * The one place that says whether a token whose secret matched authenticates
   * (spec §0 "Mission token"), read from the store on every call:
   *
   *   - a member token must belong to someone who is, right now, an active user
   *     and a current member of the mission. Nothing is cached and nothing needs
   *     to have been written: a member removed, or a user deactivated, a
   *     millisecond ago is refused;
   *   - the row must be `active` (a holder's rotation and any revocation retire it).
   *
   * The creator is a member by construction and has no row. Their deactivation
   * is not judged here: the mission then reads `orphaned` (derived by
   * `MissionGrounds`), every holder is refused `mission-inactive`, and the
   * same tokens serve again if the creator is reactivated.
   *
   * The record (and its hash) stops here: the door gets the id, the prefix and
   * the holder.
   */
  private async standingOf(found: {
    readonly token: MissionTokenRecord;
    readonly mission: MissionRecord;
  }): Promise<TokenVerification> {
    const { mission } = found;
    const record = found.token;
    const user =
      record.holder.kind === 'member'
        ? await this.deps.store.users.getById(record.holder.userId)
        : null;
    const token: VerifiedToken = {
      id: record.id,
      prefix: record.prefix,
      holder: tokenHolderOf(record, user),
    };
    // The holder is judged first: a member who was removed is told so whatever
    // became of their token or of the mission since (they are no longer told the
    // mission's state). The membership rule is the one `access` reads.
    if (record.holder.kind === 'member') {
      const membership = await this.membershipOf(mission, record.holder.userId, user);
      if (membership === 'deactivated') {
        return { outcome: 'retired', reason: 'holder-deactivated', mission, token };
      }
      if (!isOnMission(membership)) {
        return { outcome: 'retired', reason: 'holder-removed', mission, token };
      }
    }
    if (record.status !== 'active') {
      return { outcome: 'retired', reason: record.status, mission, token };
    }
    return { outcome: 'verified', mission, token };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Reads for the Missions pages
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * The missions the user can read, newest first: the ones they created
   * (`role: 'creator'`) and the ones shared with them as a member
   * (`role: 'member'`, spec §4.2 "Missions").
   */
  async list(user: Subject): Promise<MissionOverview[]> {
    const created = await this.deps.store.missions.listForCreator(user.id);
    const shared = (await this.isActiveUser(user.id))
      ? await this.deps.store.missions.listForMember(user.id)
      : [];
    const issuers = await this.issuersOf(created);
    const overviews: MissionOverview[] = [];
    for (const [role, missions] of [
      ['creator', created],
      ['member', shared],
    ] as const) {
      for (const mission of missions) {
        // The listing's SQL selects the current member rows; the rule has the last word.
        if (role === 'member' && (await this.membershipOf(mission, user.id)) !== 'member') {
          continue;
        }
        overviews.push(
          await this.overviewOf(
            { ...(await this.deps.grounds.inspect(mission)), role },
            user,
            issuers.get(mission.id) ?? null,
          ),
        );
      }
    }
    // Newest first: the mission just issued is the one the creator looks for.
    return overviews.sort((a, b) =>
      a.mission.createdAt < b.mission.createdAt
        ? 1
        : a.mission.createdAt > b.mission.createdAt
          ? -1
          : 0,
    );
  }

  /**
   * One mission, for its creator or for a current member (spec §0: a member
   * "can read it"). A member reads the same policy, resources and counters,
   * and the kit with their own token's prefix; they edit nothing
   * (`gates_editable: false`, and every mutation of this service answers
   * `not-found` to anyone but the creator).
   */
  async get(user: Subject, missionId: string): Promise<MissionDetail | null> {
    const inspected = await this.access(user, missionId);
    if (!inspected) return null;
    const { mission } = inspected;
    const issuers = await this.issuersOf([mission]);
    const overview = await this.overviewOf(inspected, user, issuers.get(mission.id) ?? null);
    const accounts = await this.detailAccounts(mission, inspected.lost);
    const remaining = overview.state.kind === 'active' ? overview.state.remaining : null;
    const rows = this.catalogRowsOf(accounts);
    const openUntil = await this.openGatesOf(mission, overview.state);
    const policy: MissionDetailRisk[] = mission.policy.map(policyEntryOf).map((entry) => {
      const row = rows.get(entry.risk_id);
      return {
        ...entry,
        label: row?.label ?? entry.risk_id,
        row: row?.row ?? null,
        remaining: remaining ? (remaining[lineKeyOf(entry)] ?? null) : null,
        gate_open_until: openUntil.get(lineKeyOf(entry)) ?? null,
      };
    });
    const editable = inspected.role === 'creator' && gateEditBlockedBy(overview.mission) === null;
    return {
      ...overview,
      gates_editable: editable,
      limits_editable: editable,
      accounts,
      policy,
      period: statedPeriodOf(mission),
      kit: overview.token
        ? await this.kitOf(mission, { prefix: overview.token.prefix }, accounts)
        : null,
      trust_raises:
        inspected.role === 'creator' && overview.state.kind === 'active'
          ? await this.trustRaisesOf(mission)
          : [],
    };
  }

  /**
   * The trust-raise proposals of every running mission the user created (risk model
   * §4.7), for the Now page: each with its mission's id and name.
   */
  async trustRaisesFor(user: Subject): Promise<
    {
      readonly mission_id: string;
      readonly mission_name: string;
      readonly offers: readonly TrustRaiseOffer[];
    }[]
  > {
    const out: { mission_id: string; mission_name: string; offers: readonly TrustRaiseOffer[] }[] =
      [];
    for (const created of await this.deps.store.missions.listForCreator(user.id)) {
      const { mission, orphan } = await this.deps.grounds.inspect(created);
      if (orphan || (await this.stateOf(mission)).kind !== 'active') continue;
      const offers = await this.trustRaisesOf(mission);
      if (offers.length > 0)
        out.push({ mission_id: mission.id, mission_name: mission.name, offers });
    }
    return out;
  }

  /**
   * "Not now" on a trust-raise proposal (risk model §4.7): the offer is hidden until as
   * many approvals again. The creator only; `null` is "not found" for anyone else, or a
   * set that is not the mission's. Not an edit of the mission: nothing it allows moves.
   */
  async snoozeTrustRaise(
    user: Subject,
    missionId: string,
    target: { readonly resource_set_id: string; readonly macro_action_id: string },
  ): Promise<{ readonly ok: true } | null> {
    const mission = await this.ownMission(user, missionId);
    if (!mission) return null;
    const done = await this.deps.store.missions.snoozeTrustRaise(
      mission.id,
      target.resource_set_id,
      target.macro_action_id,
    );
    return done ? { ok: true } : null;
  }

  /**
   * The one trust-raise proposal "Raise" opens the edit with: offered now on that
   * macro-action of that set of a running mission the user created; `null` otherwise
   * (the edit then opens as usual).
   */
  async trustRaiseOffer(
    user: Subject,
    missionId: string,
    target: { readonly resource_set_id: string; readonly macro_action_id: string },
  ): Promise<TrustRaiseOffer | null> {
    const inspected = await this.ownInspected(user, missionId);
    if (!inspected || inspected.orphan) return null;
    if ((await this.stateOf(inspected.mission)).kind !== 'active') return null;
    const offers = await this.trustRaisesOf(inspected.mission);
    return (
      offers.find(
        (o) =>
          o.resource_set_id === target.resource_set_id &&
          o.macro_action_id === target.macro_action_id,
      ) ?? null
    );
  }

  private async trustRaisesOf(mission: MissionRecord): Promise<TrustRaiseOffer[]> {
    const accounts = new Map<string, { name: string; macroActions: readonly MacroAction[] }>();
    for (const c of mission.accounts) {
      const account = await this.deps.store.accounts.getById(c.accountId);
      if (!account || !this.deps.registry.get(account.service)) continue;
      accounts.set(c.accountId, {
        name: account.displayName,
        macroActions: this.macroActionsOf(account.service),
      });
    }
    return trustRaiseOffers({
      mission,
      accountOf: (accountId) => accounts.get(accountId) ?? null,
      requests: await this.deps.store.requests.listForMission(mission.id),
      marks: await this.deps.store.missions.trustMarks(mission.id),
      threshold: this.deps.trustRaiseAfterApprovals ?? DEFAULT_TRUST_RAISE_AFTER_APPROVALS,
    });
  }

  /**
   * The gated risks the creator opened for the current period, with the instant the
   * gate closes again — the budget's own derivation (`openedGatesOf`) over the session's
   * gate events, so this page and `decide()` cannot disagree.
   */
  private async openGatesOf(
    mission: MissionRecord,
    state: MissionState,
  ): Promise<Map<PolicyLineKey, Iso8601>> {
    // What the page shows: a mission that serves no call has no gate "open" to show.
    return state.kind === 'active' ? this.openGatesIn(mission, state.period) : new Map();
  }

  /** The period that runs at this instant, whatever the mission's state. */
  private periodNow(mission: MissionRecord): CurrentPeriod {
    return currentPeriod(budgetMissionOf(mission).period, this.deps.clock.now());
  }

  /** The gates opened for `period`, read from the session's gate events since it started. */
  private async openGatesIn(
    mission: MissionRecord,
    period: CurrentPeriod,
  ): Promise<Map<PolicyLineKey, Iso8601>> {
    const open = new Map<PolicyLineKey, Iso8601>();
    // A one-off mission has no period end: a gate is never opened "for the period" on it.
    if (period.end === null) return open;
    if (!mission.policy.some((entry) => entry.gate === 'approval')) return open;
    const session = await this.deps.store.sessions.getByMission(mission.id);
    if (!session) return open;
    const events = await this.deps.store.sessions.listEvents(session.id, {
      kinds: GATE_EVENT_KINDS,
      since: period.start,
    });
    for (const line of openedGatesOf(events, period)) open.set(line, period.end);
    return open;
  }

  private async overviewOf(
    { mission, orphan, lost, role }: MissionAccess,
    reader: Subject,
    issuedVia: MissionIssuer | null,
  ): Promise<MissionOverview> {
    const token = await this.ownToken(mission.id, reader.id);
    const creator = await this.deps.store.users.getById(mission.creatorUserId);
    return {
      mission,
      role,
      creator: { id: mission.creatorUserId, email: creator?.email ?? null },
      state: await this.stateOf(mission),
      orphan: orphan && {
        cause: orphan.cause,
        account_id: orphan.accountId,
        uncovered: [...orphan.uncovered],
      },
      lost: lost.map((part) => ({
        account_id: part.accountId,
        cause: part.cause,
        final: isFinalLoss(part.cause),
      })),
      token: token ? { prefix: token.prefix, created_at: token.createdAt } : null,
      issued_via: issuedVia,
    };
  }

  /**
   * Who prepared the missions of the list: the issuing mission (its name read
   * now) or, for a mission issued before migration 0035, the app. One read, and
   * none at all when every mission of the list was issued by a person.
   */
  private async issuersOf(missions: readonly MissionRecord[]): Promise<Map<string, MissionIssuer>> {
    const prepared = missions
      .filter((m) => m.issuedByMissionId !== null || m.issuedViaClientName !== null)
      .map((m) => m.id);
    const issuers = new Map<string, MissionIssuer>();
    if (prepared.length === 0) return issuers;
    for (const [missionId, issuer] of await this.deps.store.missions.issuersOf(prepared)) {
      issuers.set(missionId, {
        mission_id: issuer.issuedByMissionId,
        mission_name: issuer.issuedByMissionName,
        client_name: issuer.clientName,
      });
    }
    return issuers;
  }

  /**
   * The state to report when the store refused a token insert because the mission
   * stopped serving between the check and the write: what it reads now, `revoked`
   * if it somehow reads active again (the refusal itself is the fact).
   */
  async stateAfterRefusal(missionId: string): Promise<Exclude<MissionState['kind'], 'active'>> {
    const mission = await this.deps.store.missions.getById(missionId);
    if (!mission) return 'revoked';
    const state = await this.stateOf((await this.deps.grounds.inspect(mission)).mission);
    return state.kind === 'active' ? 'revoked' : state.kind;
  }

  /** The mission's state at this instant (the budget's single derivation). */
  stateOf(mission: MissionRecord): Promise<MissionState> {
    return this.budget.stateOf(budgetMissionOf(mission), this.deps.clock.now());
  }

  /**
   * A stored mission as it stands now, for a reader the caller already scoped (the
   * Overview of Activity reads the missions of the Timeline's scope): its derived status
   * (`orphaned` while its authority is missing) and its state with the period's
   * remaining budget. Reads only; no authority check of the reader here.
   */
  async standing(
    stored: MissionRecord,
  ): Promise<{ readonly mission: MissionRecord; readonly state: MissionState }> {
    const { mission } = await this.deps.grounds.inspect(stored);
    return { mission, state: await this.stateOf(mission) };
  }

  /** The active member token this user holds on the mission, if any. */
  private async ownToken(missionId: string, userId: string): Promise<MissionTokenRecord | null> {
    const tokens = await this.deps.store.missions.listTokens(missionId);
    return (
      tokens.find(
        (t) => t.status === 'active' && t.holder.kind === 'member' && t.holder.userId === userId,
      ) ?? null
    );
  }

  private async isActiveUser(userId: string): Promise<boolean> {
    return (await this.deps.store.users.getById(userId))?.status === 'active';
  }

  /**
   * Who may READ a mission, and as what: its creator, or a current member who
   * is an active user. One answer (`null`) for "does not exist", "not yours"
   * and "no longer shared with you". Every mutation of the mission itself goes
   * through `ownMission` instead, which knows the creator only.
   */
  async access(user: Subject, missionId: string): Promise<MissionAccess | null> {
    const mission = await this.deps.store.missions.getById(missionId);
    if (!mission) return null;
    const membership = await this.membershipOf(mission, user.id);
    if (membership !== 'creator' && membership !== 'member') return null;
    return { ...(await this.deps.grounds.inspect(mission)), role: membership };
  }

  /**
   * What `userId` is to the mission right now (`membershipOf`, the store's one
   * statement of the rule). The creator costs no read; anyone else costs their
   * user row (unless the caller already holds it) and their member row.
   */
  private async membershipOf(
    mission: MissionRecord,
    userId: string,
    known?: UserRecord | null,
  ): Promise<Membership> {
    if (mission.creatorUserId === userId) return membershipOf(mission, userId, null, null);
    const user = known === undefined ? await this.deps.store.users.getById(userId) : known;
    const row = await this.deps.store.missions.getMember(mission.id, userId);
    return membershipOf(mission, userId, user, row);
  }

  /**
   * One answer for "does not exist" and "not yours". The mission is returned as
   * it stands now: `orphaned` when the creator's authority is missing.
   */
  private async ownMission(user: Subject, missionId: string): Promise<MissionRecord | null> {
    return (await this.ownInspected(user, missionId))?.mission ?? null;
  }

  private async ownInspected(user: Subject, missionId: string): Promise<InspectedMission | null> {
    const mission = await this.deps.store.missions.getById(missionId);
    if (!mission || mission.creatorUserId !== user.id) return null;
    return this.deps.grounds.inspect(mission);
  }

  /**
   * The accounts of a mission with the resources it reaches — the rule of
   * `loadMissionContext`, the same function (`reachedResources`): the ids its
   * resource sets store, never the ones discovery no longer returns nor the
   * instance's own.
   */
  private async detailAccounts(
    mission: MissionRecord,
    lost: readonly LostPart[] = [],
  ): Promise<MissionDetailAccount[]> {
    const details: MissionDetailAccount[] = [];
    for (const c of mission.accounts) {
      const account = await this.deps.store.accounts.getById(c.accountId);
      if (!account) continue;
      const discovered = await this.deps.store.accounts.listResources(c.accountId);
      const bySet = reachedResourcesBySet(c, discovered, (r) => this.isSelf(account.service, r));
      const reachedIds = new Set([...bySet.values()].flat().map((r) => r.id));
      const reached = discovered.filter((r) => reachedIds.has(r.id));
      details.push({
        ...accountSummaryOf(account),
        service_label:
          this.deps.registry.get(account.service)?.plugin.displayName ?? account.service,
        resource_noun: resourceNounOf(this.deps.registry.get(account.service)?.plugin ?? null),
        resources: reached.map((r) => toIssuanceResource(r, false)),
        future: takesFutureResources(c),
        last_checked_at: lastDiscoveryAt(account),
        resource_sets: c.resourceSets.map((set) => ({
          id: set.id,
          position: set.position,
          resources: (bySet.get(set.id) ?? []).map((r) => toIssuanceResource(r, false)),
          future: set.future,
          env: set.env,
          mixed_env: set.mixedEnv,
          ...(set.trustLevels ? { trust_levels: set.trustLevels } : {}),
        })),
        lost: lost.find((part) => part.accountId === c.accountId)?.cause ?? null,
        ...createdIdsOf(c, reached),
      });
    }
    return details;
  }

  private catalogRowsOf(
    accounts: readonly Pick<MissionDetailAccount, 'service'>[],
  ): Map<string, CatalogRisk> {
    return new Map(
      accounts.flatMap((c) => this.risksOf(c.service).map((r) => [r.risk_id, r] as const)),
    );
  }

  /**
   * The bootstrap kit of the mission around one token: its secret (shown once,
   * to the holder who just generated it) or its masked prefix. The same kit
   * for every holder but for that token: same resources, same policy, same
   * budget (spec §0 "Mission member").
   */
  async kitOf(
    mission: MissionRecord,
    token: { secret: string } | { prefix: string },
    known?: readonly MissionDetailAccount[],
  ): Promise<BootstrapKit> {
    // An account that no longer serves the mission is not handed to its agents.
    const accounts = (
      known ?? (await this.detailAccounts(mission, (await this.deps.grounds.inspect(mission)).lost))
    ).filter((account) => account.lost === null);
    const rows = this.catalogRowsOf(accounts);
    const setLabel = new Map(
      accounts.flatMap((c) =>
        c.resource_sets.length > 1
          ? c.resource_sets.map((set) => [set.id, `resource set ${set.position}`] as const)
          : [],
      ),
    );
    const policy: KitPolicyLine[] = mission.policy.map(policyEntryOf).map((entry) => {
      const label = setLabel.get(entry.resource_set_id ?? '');
      return {
        ...entry,
        label: rows.get(entry.risk_id)?.label ?? entry.risk_id,
        ...(label ? { resource_set: label } : {}),
      };
    });
    return buildBootstrapKit({
      instanceUrl: this.deps.publicUrl.href,
      mission: {
        name: mission.name,
        period: statedPeriodOf(mission),
        expires_at: mission.expiresAt,
      },
      accounts: accounts.map((c) => ({
        service_label: c.service_label,
        display_name: c.display_name,
        resources: c.resources.map((r) => ({ ref: r.ref, env: r.env })),
        future: c.future,
        ...(c.resource_sets.length > 1
          ? {
              resource_sets: c.resource_sets.map((set) => ({
                label: `Resource set ${set.position}`,
                resources: set.resources.map((r) => ({ ref: r.ref, env: r.env })),
                future: set.future,
              })),
            }
          : {}),
      })),
      policy,
      token,
      git: this.gitRemotesOf(accounts),
    });
  }

  /** The git remotes of the kit: per service whose plugin declares one, the mission's repositories there. */
  private gitRemotesOf(accounts: readonly MissionDetailAccount[]): readonly KitGitRemote[] {
    const services = [...new Set(accounts.map((c) => c.service))];
    return services.flatMap((serviceId) => {
      const remote = this.deps.registry.gitRemoteOf(serviceId)?.plugin.gitRemote;
      if (!remote) return [];
      const repositories = accounts
        .filter((c) => c.service === serviceId)
        .flatMap((c) => c.resources.map((r) => r.ref));
      if (repositories.length === 0) return [];
      return [
        {
          base: gitRemoteBase(this.deps.publicUrl, serviceId),
          insteadOf: remote.insteadOf ?? null,
          repositories: [...new Set(repositories)],
        },
      ];
    });
  }
}

/**
 * The holder of a token as the door and the audit name it. A member is shown
 * by their email; a member whose user row is gone keeps their id.
 */
export function tokenHolderOf(
  token: Pick<MissionTokenRecord, 'holder'>,
  user: Pick<UserRecord, 'email'> | null,
): TokenHolder {
  if (token.holder.kind === 'named') return { kind: 'named', name: token.holder.name };
  return {
    kind: 'member',
    user_id: token.holder.userId,
    display: user?.email ?? token.holder.userId,
  };
}

/**
 * The line of a risk in the mission: in `resourceSetId` when given, else the one set
 * that accepts the risk. `null` when absent, or when the risk alone names several lines.
 */
function lineOfRisk(
  mission: Pick<MissionRecord, 'policy'>,
  riskId: RiskId,
  resourceSetId: string | undefined,
): RequestLine | null {
  const lines = mission.policy.filter(
    (entry) =>
      entry.riskId === riskId &&
      (resourceSetId === undefined || entry.resourceSetId === resourceSetId),
  );
  const [only] = lines;
  return lines.length === 1 && only ? { resourceSetId: only.resourceSetId, riskId } : null;
}

/**
 * The lines of a permission edit, each in its set: the one it names, else the set of the
 * mission's line of that risk (when only one set accepts it), else the set the answered
 * request names for it, else the first set of the account of its service. `null` when
 * a line cannot be placed (several sets accept the risk, or no account is for it).
 */
function placeLines(
  mission: Pick<MissionRecord, 'policy'>,
  lines: readonly MissionPolicyEntry[],
  asked: readonly RequestLine[],
  /** The first set of the account of each service of the mission. */
  firstSets: ReadonlyMap<string, string>,
): MissionPolicyEntry[] | null {
  const placed: MissionPolicyEntry[] = [];
  for (const line of lines) {
    if (line.resource_set_id !== undefined) {
      placed.push(line);
      continue;
    }
    const held = mission.policy.filter((entry) => entry.riskId === line.risk_id);
    const [only] = held;
    if (held.length > 1) return null;
    const setId =
      only?.resourceSetId ??
      asked.find((a) => a.riskId === line.risk_id)?.resourceSetId ??
      firstSets.get(parseRiskId(line.risk_id)?.service ?? '');
    if (setId === undefined) return null;
    placed.push({ ...line, resource_set_id: setId });
  }
  return placed;
}
