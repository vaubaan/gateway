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
  ConnectionStatus,
  Gate,
  GroupSource,
  Iso8601,
  MissionStatus,
  Principal,
  RequestKind,
  RequestStatus,
  RiskId,
  SessionEventDetails,
  ShareStatus,
} from '@vaubaan/shared';

export type {
  ConnectionStatus,
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
  readonly subject: string;
  readonly email: string;
  readonly displayName: string | null;
  readonly status: UserStatus;
  readonly createdAt: Iso;
  readonly lastLoginAt: Iso | null;
  readonly removedAt: Iso | null;
}

export interface GroupRecord {
  readonly id: string;
  readonly name: string;
  readonly source: GroupSource;
  readonly createdAt: Iso;
}

// --- connections, resources, shares -------------------------------------------------

export interface ConnectionRecord {
  readonly id: string;
  readonly provider: string;
  readonly owner: Principal;
  readonly displayName: string;
  readonly status: ConnectionStatus;
  /** Master-key version the credential blob was sealed with; null when no credential. */
  readonly keyVersion: number | null;
  readonly credentialExpiresAt: Iso | null;
  readonly metadata: Record<string, unknown> | null;
  readonly createdAt: Iso;
  readonly updatedAt: Iso;
  readonly revokedAt: Iso | null;
}

export interface ConnectionResourceRecord {
  readonly id: string;
  readonly connectionId: string;
  readonly ref: string;
  readonly env: string | null;
  readonly displayName: string;
  readonly discoveredAt: Iso;
  /** Who set `env`: the plugin at discovery (read-only for the owner) or the owner. */
  readonly envSource: ResourceEnvSource;
  /** Effective metadata: the provider facts of the last discovery overlaid by the owner's edits. */
  readonly metadata: Record<string, unknown> | null;
  /** The owner's edits alone (keys that override the discovered metadata). */
  readonly ownerMetadata: Record<string, unknown> | null;
  /** True once the owner renamed the resource; discovery then keeps `displayName`. */
  readonly displayNameEdited: boolean;
  /** Hidden by the owner: kept and selectable by ref, left out of default listings. */
  readonly hidden: boolean;
  /** Set when the last discovery no longer returned the ref; `null` while it is reachable. */
  readonly staleSince: Iso | null;
}

export const RESOURCE_ENV_SOURCES = ['owner', 'plugin'] as const;
export type ResourceEnvSource = (typeof RESOURCE_ENV_SOURCES)[number];

export interface DiscoveredResource {
  readonly ref: string;
  readonly displayName: string;
  /** Environment label; omitted keeps the label an owner already set. */
  readonly env?: string | null;
  /** Provider-specific, non-secret facts (`Resource.metadata`); only `syncDiscoveredResources` stores them. */
  readonly metadata?: Readonly<Record<string, unknown>> | null;
}

export interface ShareRecord {
  readonly id: string;
  readonly connectionId: string;
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
  readonly riskId: RiskId;
  /** Actions per period. Always a number: no infinite budget (spec §3.2). */
  readonly quota: number;
  /** Actions per sliding window of `rateWindowSeconds`. */
  readonly rateLimit: number;
  readonly rateWindowSeconds: number;
  readonly gate: Gate;
}

export const RESOURCE_SCOPES = ['all', 'selected'] as const;
export type ResourceScope = (typeof RESOURCE_SCOPES)[number];

export interface MissionConnection {
  readonly connectionId: string;
  readonly resourceScope: ResourceScope;
  /** Selected resource ids; empty when `resourceScope` is `all`. */
  readonly resourceIds: readonly string[];
}

export interface MissionRecord {
  readonly id: string;
  readonly name: string;
  readonly creatorUserId: string;
  readonly status: MissionStatus;
  readonly periodAnchor: Iso;
  /** Period length; null for a one-off mission with a single period. */
  readonly periodSeconds: number | null;
  readonly expiresAt: Iso | null;
  /** Set when the mission was issued through the management door. */
  readonly delegationId: string | null;
  readonly createdAt: Iso;
  readonly updatedAt: Iso;
  readonly closedAt: Iso | null;
  readonly connections: readonly MissionConnection[];
  readonly policy: readonly MissionPolicyEntry[];
}

/** The store distinguishes a token retired by rotation from a revoked one; the shared
 *  domain (`MissionTokenStatus` there) only knows `active | revoked`. */
export const MISSION_TOKEN_STATUSES = ['active', 'rotated', 'revoked'] as const;
export type MissionTokenStatus = (typeof MISSION_TOKEN_STATUSES)[number];

export interface MissionTokenRecord {
  readonly id: string;
  readonly missionId: string;
  readonly prefix: string;
  readonly hash: string;
  readonly hashAlg: string;
  readonly status: MissionTokenStatus;
  readonly createdAt: Iso;
  readonly retiredAt: Iso | null;
}

// --- sessions -----------------------------------------------------------------------

export interface SessionRecord {
  readonly id: string;
  readonly missionId: string;
  readonly createdAt: Iso;
}

export interface SessionCounterRecord {
  readonly sessionId: string;
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
  readonly actorUserId?: string | null;
};

/**
 * What the `events` table can hold, whatever the kind. Only the sessions repository
 * accepts it, for its own tests that store free-form rows; a writer builds a `NewEvent`.
 */
export interface UntypedNewEvent {
  readonly kind: string;
  readonly riskId?: RiskId | null;
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
  readonly riskId: RiskId;
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

export interface ApprovalRecord {
  readonly id: string;
  readonly missionId: string;
  readonly requestId: string;
  readonly riskId: RiskId;
  readonly fingerprint: string;
  readonly createdAt: Iso;
  readonly expiresAt: Iso;
  readonly consumedAt: Iso | null;
}

// --- delegations --------------------------------------------------------------------

export interface OAuthClientRecord {
  readonly id: string;
  readonly clientId: string;
  readonly name: string;
  /** Null for public (PKCE-only) clients. */
  readonly clientSecretHash: string | null;
  readonly redirectUris: readonly string[];
  readonly createdAt: Iso;
}

export const DELEGATION_STATUSES = ['active', 'revoked'] as const;
export type DelegationStatus = (typeof DELEGATION_STATUSES)[number];

export interface DelegationRecord {
  readonly id: string;
  readonly userId: string;
  /** `oauth_clients.id`, not the public `client_id`. */
  readonly clientId: string;
  readonly scope: string;
  readonly status: DelegationStatus;
  readonly createdAt: Iso;
  readonly revokedAt: Iso | null;
}

export const CODE_CHALLENGE_METHODS = ['S256'] as const;
export type CodeChallengeMethod = (typeof CODE_CHALLENGE_METHODS)[number];

export interface OAuthCodeRecord {
  readonly id: string;
  readonly delegationId: string;
  readonly redirectUri: string;
  readonly codeChallenge: string;
  readonly codeChallengeMethod: CodeChallengeMethod;
  readonly createdAt: Iso;
  readonly expiresAt: Iso;
  readonly consumedAt: Iso | null;
}

export interface RefreshTokenRecord {
  readonly id: string;
  readonly delegationId: string;
  readonly createdAt: Iso;
  readonly expiresAt: Iso;
  readonly revokedAt: Iso | null;
  readonly replacedById: string | null;
}

export interface AccessTokenRecord {
  readonly id: string;
  readonly delegationId: string;
  readonly createdAt: Iso;
  readonly expiresAt: Iso;
  readonly revokedAt: Iso | null;
}
