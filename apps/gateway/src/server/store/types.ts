/**
 * Store-level record types — the shapes the repositories read and write.
 *
 * Spec: docs/spec/vaubaan-gateway.md §2.1–2.3. These are persistence records (camelCase,
 * one per table), not the gateway's domain model: `@vaubaan/shared` owns the domain
 * vocabulary and every closed set below (statuses, gate, principal, request kind and
 * status, timestamps) is the shared type, re-exported under the store's names. The
 * record shapes themselves are mapped to the shared snake_case records by the domain
 * layer (P1), not here.
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

export type UserStatus = 'active' | 'removed';

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

export type ResourceScope = 'all' | 'selected';

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
export type MissionTokenStatus = 'active' | 'rotated' | 'revoked';

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

export interface NewEvent {
  readonly kind: string;
  readonly riskId?: RiskId | null;
  readonly actorUserId?: string | null;
  readonly details?: Record<string, unknown> | null;
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

export type DelegationStatus = 'active' | 'revoked';

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

export interface OAuthCodeRecord {
  readonly id: string;
  readonly delegationId: string;
  readonly redirectUri: string;
  readonly codeChallenge: string;
  readonly codeChallengeMethod: 'S256';
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
