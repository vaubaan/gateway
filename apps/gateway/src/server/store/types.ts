/**
 * Store-level record types — the shapes the repositories read and write.
 *
 * Spec: docs/spec/vaubaan-gateway.md §2.1–2.3. These are persistence records (camelCase,
 * one per table), not the gateway's domain model: `@vaubaan/shared` owns the domain
 * vocabulary and every closed set below (statuses, gate, principal, request kind and
 * status, timestamps) is the shared type, re-exported under the store's names. The
 * records stay inside `server/**`: each service builds its own view from them, and only
 * missions and counters are translated to the shared snake_case shapes, in
 * `server/budget/mapping.ts`. The closed sets the store owns (statuses that exist only
 * here) are `as const` lists from which the union is derived, so the row mappers validate
 * against the list that defines the type; the lists of the shared unions are in
 * `repositories/enums.ts`.
 */

import type {
  AccountStatus,
  Gate,
  GroupSource,
  Iso8601,
  MissionStatus,
  MissionTokenKind,
  Principal,
  RequestKind,
  RequestStatus,
  RiskId,
  SessionEventDetails,
  ShareStatus,
} from '@vaubaan/shared';

export type {
  AccountStatus,
  Gate,
  GroupSource,
  MissionStatus,
  Principal,
  RequestKind,
  RiskId,
  ShareStatus,
};

/** ISO-8601 UTC timestamp, e.g. `2026-10-13T09:00:00.000Z`. Lexicographically sortable. */
export type Iso = Iso8601;

export type PrincipalKind = Principal['kind'];

// --- identities ---------------------------------------------------------------------

export const USER_STATUSES = ['active', 'removed'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

export interface UserRecord {
  readonly id: string;
  /**
   * The identity provider that vouches for the account: the `iss` of its sign-ins. A
   * user is `(issuer, subject)`. `null` only for an account created before migration
   * 0011 that no sign-in has bound yet; such an account matches no sign-in.
   */
  readonly issuer: string | null;
  /** The subject claim, unique within `issuer` only. */
  readonly subject: string;
  readonly email: string;
  readonly displayName: string | null;
  readonly status: UserStatus;
  readonly createdAt: Iso;
  readonly lastLoginAt: Iso | null;
  readonly removedAt: Iso | null;
  /**
   * When the user was last deactivated; kept after a reactivation. A web session
   * created at or before it is refused (`Authenticator`).
   */
  readonly sessionsEndedAt: Iso | null;
}

export interface GroupRecord {
  readonly id: string;
  readonly name: string;
  readonly source: GroupSource;
  /**
   * The sign-in provider that claims an IdP-sourced group (its id); `null` for a local
   * group. A group of provider A never counts for a user of provider B (migration 0014).
   */
  readonly provider: string | null;
  readonly createdAt: Iso;
}

// --- accounts, resources, shares -------------------------------------------------

/**
 * What became of the grant at the provider when an account was revoked.
 * `revoked`: the provider confirmed the withdrawal. `manual`: the gateway
 * cannot withdraw it for this provider. `failed`: it asked and was refused or
 * not answered. In the last two cases the person removes the grant by hand.
 */
export const PROVIDER_GRANT_OUTCOMES = ['revoked', 'manual', 'failed'] as const;
export type ProviderGrantOutcome = (typeof PROVIDER_GRANT_OUTCOMES)[number];

export interface AccountRecord {
  readonly id: string;
  readonly provider: string;
  readonly owner: Principal;
  readonly displayName: string;
  readonly status: AccountStatus;
  /** Master-key version the credential blob was sealed with; null when no credential. */
  readonly keyVersion: number | null;
  readonly credentialExpiresAt: Iso | null;
  readonly metadata: Record<string, unknown> | null;
  readonly createdAt: Iso;
  readonly updatedAt: Iso;
  readonly revokedAt: Iso | null;
  /**
   * Null for an account that is not revoked, and for one revoked before the
   * gateway asked providers anything (nothing is known: remove it by hand).
   */
  readonly providerGrant: ProviderGrantOutcome | null;
  /**
   * The environment label its owner chose for the resources that carry none of
   * their own (migration 0017); `null` when none was chosen. Resources read
   * through the repository already carry it (`envSource: 'account-default'`).
   */
  readonly defaultEnv: string | null;
}

export interface AccountResourceRecord {
  readonly id: string;
  readonly accountId: string;
  readonly ref: string;
  /**
   * The effective environment label: the resource's own, else its account's
   * `defaultEnv`, else `null` (`effectiveResourceEnv`). Every reader of
   * environments reads this one.
   */
  readonly env: string | null;
  readonly displayName: string;
  readonly discoveredAt: Iso;
  /**
   * Who set `env`: the plugin at discovery (read-only for the owner), the owner, or
   * the account's default (`account-default`: the resource has no label of its
   * own). An unlabelled resource on an account without a default reads `owner`.
   */
  readonly envSource: ResourceEnvSource;
  /** Effective metadata: the provider facts of the last discovery overlaid by the owner's edits. */
  readonly metadata: Record<string, unknown> | null;
  /** The owner's edits alone (keys that override the discovered metadata). */
  readonly ownerMetadata: Record<string, unknown> | null;
  /** True once the owner renamed the resource; discovery then keeps `displayName`. */
  readonly displayNameEdited: boolean;
  /** Hidden from new missions: kept and selectable by ref, left out of default listings. */
  readonly hidden: boolean;
  /**
   * True once the owner hid or showed the resource; discovery then keeps `hidden`. While
   * false, `hidden` is the plugin's hint of the last discovery (`Resource.hiddenByDefault`).
   */
  readonly hiddenEdited: boolean;
  /** Set when the last discovery no longer returned the ref; `null` while it is reachable. */
  readonly staleSince: Iso | null;
}

/** The values `account_resources.env_source` stores (migration 0004's `CHECK`). */
export const RESOURCE_ENV_SOURCES = ['owner', 'plugin'] as const;
export type StoredResourceEnvSource = (typeof RESOURCE_ENV_SOURCES)[number];
/** Where a resource's effective label comes from; the default is never stored on the resource. */
export type ResourceEnvSource = StoredResourceEnvSource | 'account-default';

export interface DiscoveredResource {
  readonly ref: string;
  readonly displayName: string;
  /** Environment label; omitted keeps the label an owner already set. */
  readonly env?: string | null;
  /** Provider-specific, non-secret facts (`Resource.metadata`); only `syncDiscoveredResources` stores them. */
  readonly metadata?: Readonly<Record<string, unknown>> | null;
  /** The plugin's hint (`Resource.hiddenByDefault`); applied only while the owner never chose. */
  readonly hidden?: boolean;
}

export interface ShareRecord {
  readonly id: string;
  readonly accountId: string;
  readonly target: Principal;
  /** Explicit enumeration, one row per risk in the store. Never a wildcard. */
  readonly restriction: readonly RiskId[];
  readonly status: ShareStatus;
  readonly createdByUserId: string;
  readonly createdAt: Iso;
  readonly revokedAt: Iso | null;
}

// --- missions -----------------------------------------------------------------------

/** `exhausted` is per risk and derived from counters; it is never a stored status. The
 *  status set and `Gate` are `@vaubaan/shared`'s. */
export interface MissionPolicyEntry {
  /** The resource set of its account the line belongs to (risk model §4.7, migration 0029). */
  readonly resourceSetId: string;
  readonly riskId: RiskId;
  /** Actions per period. Always a number: no infinite budget (spec §3.2). */
  readonly quota: number;
  /** Actions per sliding window of `rateWindowSeconds`. */
  readonly rateLimit: number;
  readonly rateWindowSeconds: number;
  readonly gate: Gate;
}

/** A policy line as a writer gives it, inside the set it belongs to. */
export type MissionPolicyLineInput = Omit<MissionPolicyEntry, 'resourceSetId'>;

/**
 * Where a selected resource came from (`mission_resources.source`, migrations 0024 and
 * 0033): stored at issuance, created by the mission itself (ADR
 * created-resources-join-the-mission), added by the creator after issuance ("Edit
 * mission"), or joined a set with future on after issuance (discovered, or relabelled
 * into its environment).
 */
export const MISSION_RESOURCE_SOURCES = ['issuance', 'created', 'edit', 'future'] as const;
export type MissionResourceSource = (typeof MISSION_RESOURCE_SOURCES)[number];

/**
 * The marks of one macro-action of one resource set that start the count of a
 * trust-raise proposal (risk model §4.7): when an edit last changed its trust level,
 * and when the creator last answered "Not now". `null`: never.
 */
export interface MissionTrustMarkRecord {
  readonly resourceSetId: string;
  readonly macroActionId: string;
  readonly levelChangedAt: Iso | null;
  readonly snoozedAt: Iso | null;
}

/**
 * One resource set of an account of a mission (risk model §4.7, ADRs
 * resource-sets-partition-a-mission-connection and
 * resource-set-is-one-environment-with-optional-future-resources, migrations 0029 and
 * 0033): an explicit list of resources of one environment, and the lines of the
 * mission's policy that name it. A resource is in exactly one set of its account.
 * What a mission reaches is these lists only (`reachedResources`).
 */
export interface MissionResourceSetRecord {
  readonly id: string;
  /** Its place among the sets of the account, from 1: "Resource set 1", "Resource set 2". */
  readonly position: number;
  /** The resource ids of the set; may be empty (none known, or every one left it). */
  readonly resourceIds: readonly string[];
  /**
   * True when a resource that later appears on the account with `env` (discovered,
   * or relabelled into it) is written into `resourceIds`, unless another set of the
   * mission holds it.
   */
  readonly future: boolean;
  /** The effective environment every resource of the set carries; `null`: no label. */
  readonly env: string | null;
  /**
   * Legacy (migration 0033): stored before the one-environment rule with resources of
   * several environments, or as a whole account with none. `env` is `null`; with
   * `future`, a later resource of any environment joins it, and a relabel moves nothing
   * out of it, until the creator's next edit splits it.
   */
  readonly mixedEnv: boolean;
  /**
   * The source of each selected id that was not stored at issuance, keyed by resource id;
   * absent when every id was.
   */
  readonly resourceSources?: Readonly<Record<string, MissionResourceSource>>;
  /**
   * The trust level of each ticked macro-action, by macro-action id (`trust_levels_json`):
   * display only, it redraws the form; absent when none was recorded.
   */
  readonly trustLevels?: Readonly<Record<string, string>>;
}

export interface MissionAccountRecord {
  readonly accountId: string;
  /** The sets of the account, by `position`; never empty. */
  readonly resourceSets: readonly MissionResourceSetRecord[];
}

/**
 * One set as a writer gives it: an `id` keeps a stored set (an edit), none makes a new one.
 * `env` absent: read from the resources (all must carry the same effective label); given,
 * every resource must carry it — it names the environment of a set with no resource yet.
 */
export interface MissionResourceSetInput {
  readonly id?: string;
  readonly resourceIds: readonly string[];
  readonly future?: boolean;
  readonly env?: string | null;
  readonly trustLevels?: Readonly<Record<string, string>>;
  /** Every line of the set. */
  readonly policy: readonly MissionPolicyLineInput[];
}

/**
 * One account as a writer gives it: its sets, each with its lines, or — the shape of
 * a mission with one set per account — the selection directly, the lines then given
 * once for the whole mission (`CreateMissionInput.policy`) and placed by provider.
 */
export type MissionAccountInput =
  | { readonly accountId: string; readonly resourceSets: readonly MissionResourceSetInput[] }
  | {
      readonly accountId: string;
      readonly resourceIds: readonly string[];
      readonly future?: boolean;
      readonly env?: string | null;
      readonly trustLevels?: Readonly<Record<string, string>>;
    };

export interface MissionRecord {
  readonly id: string;
  readonly name: string;
  readonly creatorUserId: string;
  readonly status: MissionStatus;
  readonly periodAnchor: Iso;
  /** Period length; null for a one-off mission with a single period. */
  readonly periodSeconds: number | null;
  readonly expiresAt: Iso | null;
  /** The mission whose agent issued this one through its `vaubaan` account; `null` otherwise. */
  readonly issuedByMissionId: string | null;
  /**
   * History: the app that issued it by delegation before the management door was
   * retired (migration 0035); `null` for every mission issued since.
   */
  readonly issuedViaClientName: string | null;
  readonly createdAt: Iso;
  readonly updatedAt: Iso;
  readonly closedAt: Iso | null;
  readonly accounts: readonly MissionAccountRecord[];
  readonly policy: readonly MissionPolicyEntry[];
}

/**
 * Who prepared a mission for its creator (spec §2.4 "every mission issued this
 * way is visible to the user and marked as prepared by an agent"): the mission
 * whose agent issued it through its `vaubaan` account, or — history — the app
 * that issued it by delegation before migration 0035.
 */
export interface MissionIssuerRecord {
  readonly missionId: string;
  /** The issuing mission; `null` for a mission an app issued by delegation. */
  readonly issuedByMissionId: string | null;
  /** Its name, read now; `null` with no issuing mission. */
  readonly issuedByMissionName: string | null;
  /** History: the name the app gave itself (a claim, never verified); `null` otherwise. */
  readonly clientName: string | null;
}

/** The store distinguishes a token retired by rotation from a revoked one; the shared
 *  domain (`MissionTokenStatus` there) only knows `active | revoked`. */
export const MISSION_TOKEN_STATUSES = ['active', 'rotated', 'revoked'] as const;
export type MissionTokenStatus = (typeof MISSION_TOKEN_STATUSES)[number];

/**
 * Who a token belongs to (spec §0 "Mission token"): the member who generated it, or
 * the name its creator gave it. The two columns of the row (`holder_user_id`, `name`)
 * as one value, so a holder is never half of each.
 */
export type TokenHolderRecord =
  | { readonly kind: 'member'; readonly userId: string }
  | { readonly kind: 'named'; readonly name: string };

export interface MissionTokenRecord {
  readonly id: string;
  readonly missionId: string;
  readonly prefix: string;
  /** Hash of the secret. The secret itself is stored nowhere. */
  readonly hash: string;
  readonly hashAlg: string;
  readonly status: MissionTokenStatus;
  readonly kind: MissionTokenKind;
  readonly holder: TokenHolderRecord;
  /** The user who generated (member token) or created (named token) it. */
  readonly createdBy: string;
  readonly createdAt: Iso;
  readonly retiredAt: Iso | null;
  /** The last call the door authenticated with it, to the minute; `null`: never used. */
  readonly lastUsedAt: Iso | null;
}

/**
 * A user the creator gave access to a mission (spec §0 "Mission member"). The creator
 * is a member by construction and has no row. One row per (mission, user): a removed
 * member keeps theirs with `removedAt` set, and adding them again clears it.
 */
export interface MissionMemberRecord {
  readonly missionId: string;
  readonly userId: string;
  readonly addedBy: string;
  readonly addedAt: Iso;
  readonly removedAt: Iso | null;
}

// --- sessions -----------------------------------------------------------------------

export interface SessionRecord {
  readonly id: string;
  readonly missionId: string;
  readonly createdAt: Iso;
}

export interface SessionCounterRecord {
  readonly sessionId: string;
  readonly resourceSetId: string;
  readonly riskId: RiskId;
  readonly periodStart: Iso;
  readonly consumed: number;
}

export interface EventRecord {
  readonly id: string;
  readonly sessionId: string;
  readonly ts: Iso;
  readonly kind: string;
  readonly riskId: RiskId | null;
  /** The resource set the event is about, beside its risk (migration 0029); `null` otherwise. */
  readonly resourceSetId: string | null;
  readonly actorUserId: string | null;
  readonly details: Record<string, unknown> | null;
}

/**
 * An event to write: a kind and the details of that kind (`SessionEventDetails`,
 * `@vaubaan/shared`), so a writer cannot rename a stored key. Every writer of the
 * gateway builds a `NewEvent`. `EventRecord` stays loose on purpose: a stored row is
 * read back through `parseEventDetails`.
 */
export type NewEvent = SessionEventDetails & {
  readonly riskId?: RiskId | null;
  /** The resource set of `riskId`, for an event about one line of the policy. */
  readonly resourceSetId?: string | null;
  readonly actorUserId?: string | null;
};

/**
 * What the `events` table can hold, whatever the kind. Only the sessions repository
 * accepts it, for its own tests that store free-form rows; a writer builds a `NewEvent`.
 */
export interface UntypedNewEvent {
  readonly kind: string;
  readonly riskId?: RiskId | null;
  readonly resourceSetId?: string | null;
  readonly actorUserId?: string | null;
  /** A JSON object, stored as text. */
  readonly details?: object | null;
}

// --- requests and approvals ---------------------------------------------------------

/** Column name `state`; the shared domain calls the same set `RequestStatus`. */
export type RequestState = RequestStatus;

export interface RequestRecord {
  readonly id: string;
  readonly missionId: string;
  readonly sessionId: string | null;
  readonly kind: RequestKind;
  readonly state: RequestState;
  /** The claimed risk; for an approval request, the first of `riskIds`. */
  readonly riskId: RiskId;
  /**
   * Every risk the request is about. A claim: the one risk. An approval request: every
   * risk of the call that was gated `approval` when it was dropped (spec §3.5 "one
   * request covers the call"). Never empty; `riskId` is its first element.
   */
  readonly riskIds: readonly RiskId[];
  /**
   * Every (set, risk) line the request is about (migration 0029): a claim, its one line;
   * an approval request, the gated line of each set the call was judged against; a
   * permission request, the missing ones. A row older than 0029 reads its risks in the
   * set it was attributed to; one attributed to none reads none.
   */
  readonly lines: readonly RequestLine[];
  readonly tool: string | null;
  readonly fingerprint: string | null;
  /** True while the encrypted arguments are still held (open approval request). */
  readonly hasArguments: boolean;
  readonly createdAt: Iso;
  readonly expiresAt: Iso;
  readonly decidedAt: Iso | null;
  readonly decidedByUserId: string | null;
  readonly decision: Record<string, unknown> | null;
}

/** One line of the policy a request is about: a risk in one resource set. */
export interface RequestLine {
  readonly resourceSetId: string;
  readonly riskId: RiskId;
}

export interface ApprovalRecord {
  readonly id: string;
  readonly missionId: string;
  readonly requestId: string;
  /** The first of `riskIds`. */
  readonly riskId: RiskId;
  /** Every gated risk of the call the approval covers. Never empty. */
  readonly riskIds: readonly RiskId[];
  /** The tool of the approved call; empty only on a row older than migration 0005. */
  readonly tool: string;
  readonly fingerprint: string;
  readonly createdAt: Iso;
  readonly expiresAt: Iso;
  readonly consumedAt: Iso | null;
}
