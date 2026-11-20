/**
 * What the mission service takes and returns: its options, results and the views the pages
 * and the API read (`mission-service.ts` re-exports every one). Types only.
 */
import type { TokenHolder } from '@vaubaan/gateway-core';
import type { PluginRegistry, ResourceNoun } from '@vaubaan/plugin-sdk';
import type { Gate, Iso8601, MissionPolicyEntry, RateLimit, RiskId } from '@vaubaan/shared';
import type {
  AuthorityService,
  InspectedMission,
  MissionGrounds,
  OrphanCause,
  PartLossCause,
} from '../authority';
import type { MissionState, SessionService } from '../budget';
import type { SelfResource } from '../config';
import type { CeilingCheck, LimitReached } from '../limits';
import type { Logger } from '../logging';
import type { Store } from '../store';
import type { Clock } from '../store/clock';
import type { MissionRecord } from '../store/types';
import type { BootstrapKit } from './bootstrap-kit';
import type {
  DraftPeriod,
  IssuanceResource,
  MissionDraft,
  MissionIssuer,
  MissionPreview,
  PreviewIssue,
  PreviewNotice,
  Row,
} from '../../lib/missions/model';
import type { MissionChanges, MissionSnapshot } from '../../lib/missions/mission-edit';
import type { TokenMinter } from './token';
import type { TrustRaiseOffer } from './trust-raise';
import type { NotificationEvents } from '../notifications/events';

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

export interface PreviewOptions {
  /**
   * Environment labels to read as set, by resource id, without writing them.
   * Only the label changes: the accounts, the authority and the catalog are
   * the store's.
   */
  readonly assumedEnvs?: ReadonlyMap<string, string>;
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
  /**
   * The accounts of the mission that no longer serve it: the form shows each as a red
   * card the creator may remove ("Remove from mission"); nothing else removes it.
   */
  readonly lost: readonly MissionLostAccount[];
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
