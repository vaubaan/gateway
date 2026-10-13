/**
 * v5 domain types — the instance, its identities, connections, missions.
 *
 * Spec : docs/spec/vaubaan-gateway.md §0 (vocabulary), §2 (domain), §3
 *        (authority, budget, session, requests, approvals).
 * ADR  : docs/decisions/pivot-v4-to-v5-on-prem-mission-tokens.md.
 *
 * These are domain values, not storage rows : the store (P0.3) maps them to
 * its tables behind repository interfaces. Timestamps are ISO-8601 strings.
 * Field names follow the spec's own notation (`accepted_risks`,
 * `expires_at`). The plugin-facing value object `Resource` follows the SDK's
 * camelCase convention, as the plan writes it.
 */

import type { RiskId } from './risk.ts';
import type { RefusalCode } from './refusal.ts';

export type Iso8601 = string;

// ─────────────────────────────────────────────────────────────────────────────
// Identities
// ─────────────────────────────────────────────────────────────────────────────

/** A human authenticated by the IdP. Stable id = the IdP subject. */
export interface User {
  readonly id: string;
  readonly idp_subject: string;
  readonly email: string;
  readonly display_name: string | null;
  readonly created_at: Iso8601;
  readonly last_login_at: Iso8601 | null;
}

/** Where a group's membership comes from. */
export type GroupSource = 'idp' | 'local';

export interface Group {
  readonly id: string;
  readonly name: string;
  readonly source: GroupSource;
  readonly created_at: Iso8601;
}

/** A user or a group, where a rule applies to both (owner, share target). */
export type Principal =
  | { readonly kind: 'user'; readonly id: string }
  | { readonly kind: 'group'; readonly id: string };

/** A user's standing authorization for an agent to manage missions on their behalf. */
export interface Delegation {
  readonly id: string;
  readonly user_id: string;
  /** OAuth client the consent was given to (the MCP client). */
  readonly client_id: string;
  readonly client_name: string | null;
  readonly created_at: Iso8601;
  readonly expires_at: Iso8601 | null;
  readonly revoked_at: Iso8601 | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Connections, resources, shares
// ─────────────────────────────────────────────────────────────────────────────

/** How a connection authenticates to its provider. Declared by the plugin. */
export type CredentialKind = 'api-key' | 'oauth2' | 'app-install' | 'ssh-key';

export const CREDENTIAL_KINDS: readonly CredentialKind[] = [
  'api-key',
  'oauth2',
  'app-install',
  'ssh-key',
];

/**
 * A connection's credential as the instance stores it : an opaque payload
 * encrypted at rest, plus what the gateway needs without decrypting.
 * The decrypted material only exists in memory, typed by the plugin SDK
 * (`CredentialSecret`).
 */
export interface Credential {
  readonly kind: CredentialKind;
  readonly ciphertext: Uint8Array;
  /** Which master-key version encrypted `ciphertext` (rotation). */
  readonly key_version: number;
  /** When the provider will reject the credential ; `null` when it does not expire. */
  readonly expires_at: Iso8601 | null;
  /** Non-secret facts a plugin needs at call time (`team_id`, `installation_id`, account name). */
  readonly metadata: Readonly<Record<string, string>>;
}

export type ConnectionStatus = 'active' | 'expired' | 'revoked' | 'unowned';

export interface Connection {
  readonly id: string;
  readonly provider: string;
  readonly display_name: string;
  readonly owner: Principal;
  readonly status: ConnectionStatus;
  readonly credential: Credential;
  readonly created_by: string | null;
  readonly created_at: Iso8601;
  readonly updated_at: Iso8601;
}

/**
 * One thing reachable through a connection : a repository, a database
 * project, a hosting project. Discovered by the plugin at connection time,
 * labelled with an environment by the owner. Replaces the v4
 * `ProviderBinding`.
 */
export interface Resource {
  readonly provider: string;
  /** The identifier the agent cites in its arguments and the gateway checks (`owner/repo`, `prj_xxx`). */
  readonly ref: string;
  /** Environment label set by the owner (`prod`, `staging`) ; absent or null when not labelled. */
  readonly env?: string | null;
  readonly displayName: string;
  /** Provider-specific, non-secret facts the classifier may need (Gmail allowlists, etc.). */
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/** A resource as kept on a connection (discovered, then edited by the owner). */
export interface ConnectionResource extends Resource {
  readonly id: string;
  readonly connection_id: string;
  readonly discovered_at: Iso8601;
}

/** Explicit enumeration of RiskIds ; the upper bound of what a target may accept. */
export type Restriction = readonly RiskId[];

export type ShareStatus = 'active' | 'revoked';

export interface Share {
  readonly id: string;
  readonly connection_id: string;
  readonly target: Principal;
  readonly restriction: Restriction;
  readonly status: ShareStatus;
  readonly created_by: string;
  readonly created_at: Iso8601;
  readonly revoked_at: Iso8601 | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Missions
// ─────────────────────────────────────────────────────────────────────────────

/** `auto` : passes within the budget ; `approval` : each action needs the creator's grant. */
export type Gate = 'auto' | 'approval';

export const GATES: readonly Gate[] = ['auto', 'approval'];

/** Actions allowed per short sliding window. */
export interface RateLimit {
  readonly max: number;
  readonly window_seconds: number;
}

/** The two numeric dimensions of a policy entry. Always numbers, never unbounded. */
export interface Budget {
  /** Actions allowed per period. */
  readonly quota: number;
  readonly rate_limit: RateLimit;
}

/** One line of the mission policy : `RiskId → (budget, gate)`. */
export interface MissionPolicyEntry extends Budget {
  readonly risk_id: RiskId;
  readonly gate: Gate;
}

/**
 * The mission policy : an explicit enumeration of entries, one per accepted
 * risk, `risk_id` unique within the list (the store enforces it at write
 * time). The accepted risks are its `risk_id`s — see `acceptedRisksOf`. No
 * wildcard, no sentinel, no preset reference is ever an entry.
 */
export type MissionPolicy = readonly MissionPolicyEntry[];

/** A one-off mission has a single period ; a recurring one reloads its quotas. */
export type Period =
  | { readonly kind: 'one-off' }
  | {
      readonly kind: 'recurring';
      readonly length_seconds: number;
      /** Start of the first period ; later periods are derived on read. */
      readonly anchor_at: Iso8601;
    };

/** `exhausted` is per risk, not a mission state (spec §2.3). */
export type MissionStatus = 'active' | 'expired' | 'orphaned' | 'revoked';

/** The resources a mission may touch on one connection. */
export interface MissionResourceSelection {
  readonly connection_id: string;
  /** Explicit refs ; the UI's "all resources" resolves to the list known at issuance. */
  readonly resource_refs: readonly string[];
}

export interface Mission {
  readonly id: string;
  readonly name: string;
  readonly creator_id: string;
  readonly status: MissionStatus;
  readonly resources: readonly MissionResourceSelection[];
  /** Explicit enumeration ; never a preset reference. */
  readonly policy: MissionPolicy;
  readonly period: Period;
  readonly expires_at: Iso8601 | null;
  /** Set when the mission was issued through a delegated token. */
  readonly issued_by_delegation_id: string | null;
  readonly created_at: Iso8601;
  readonly updated_at: Iso8601;
}

/** The accepted risks of a mission are the keys of its policy. */
export function acceptedRisksOf(mission: Pick<Mission, 'policy'>): readonly RiskId[] {
  return mission.policy.map((entry) => entry.risk_id);
}

export type MissionTokenStatus = 'active' | 'revoked';

/** The Bearer of a mission ; one active token per mission, rotation keeps the mission. */
export interface MissionToken {
  readonly id: string;
  readonly mission_id: string;
  readonly api_key_prefix: string;
  readonly api_key_hash: string;
  readonly status: MissionTokenStatus;
  readonly created_at: Iso8601;
  readonly revoked_at: Iso8601 | null;
  readonly last_used_at: Iso8601 | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Session, events, requests, approvals
// ─────────────────────────────────────────────────────────────────────────────

export interface Session {
  readonly id: string;
  readonly mission_id: string;
  /** First call received with the mission's token. */
  readonly started_at: Iso8601;
}

export type SessionEventKind =
  | 'call-allowed'
  | 'call-refused'
  | 'request'
  | 'extension'
  | 'reset'
  | 'approval'
  | 'gate-opened'
  | 'rotation'
  | 'revocation';

export interface SessionEvent {
  readonly id: string;
  readonly session_id: string;
  readonly kind: SessionEventKind;
  readonly at: Iso8601;
  /** Risks the event concerns (touched by a call, extended, reset, approved). */
  readonly risk_ids: readonly RiskId[];
  readonly refusal_code: RefusalCode | null;
  /** Free-form agent label copied from the call ; attribution only. */
  readonly agent_label: string | null;
  /** Audit entry of the call, for call events. */
  readonly audit_entry_id: string | null;
  readonly details: Readonly<Record<string, unknown>>;
}

/** Consumed actions for one risk in one period. */
export interface SessionCounter {
  readonly session_id: string;
  readonly risk_id: RiskId;
  readonly period_start: Iso8601;
  readonly consumed: number;
}

export type RequestKind = 'claim' | 'approval';
export type RequestStatus = 'open' | 'granted' | 'refused' | 'expired';

/** A message from the executor to the creator, dropped by the gateway. */
export interface Request {
  readonly id: string;
  readonly mission_id: string;
  readonly kind: RequestKind;
  readonly status: RequestStatus;
  readonly risk_id: RiskId;
  /** Tool and argument fingerprint, for approval requests. */
  readonly tool: string | null;
  readonly argument_fingerprint: string | null;
  readonly created_at: Iso8601;
  readonly expires_at: Iso8601;
  readonly decided_at: Iso8601 | null;
}

/** What the creator may do with a claim. */
export type ClaimResolution = 'reset-period' | 'extend-quota' | 'extend-expiry' | 'refuse';

/** The creator's grant for one exact action. Single-use, short-lived. */
export interface Approval {
  readonly id: string;
  readonly request_id: string;
  readonly mission_id: string;
  readonly risk_id: RiskId;
  readonly argument_fingerprint: string;
  readonly granted_at: Iso8601;
  readonly expires_at: Iso8601;
  readonly consumed_at: Iso8601 | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Audit
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What the gateway decided for a call (spec §8 : "one entry per call,
 * allowed or refused"). An allowed call whose provider then failed stays
 * `allowed` with `upstream_error` set ; a structural rejection without a
 * code is `refused` with a null `refusal_code`. The v4 rows said `denied`
 * (`AuditLogRow` in `legacy-v4.ts`).
 */
export type AuditDecision = 'allowed' | 'refused';
