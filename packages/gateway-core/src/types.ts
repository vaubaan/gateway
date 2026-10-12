/**
 * v5 domain types the gateway core needs before any door exists.
 *
 * Spec: docs/spec/vaubaan-gateway.md §0 (vocabulary), §2 (domain), §3
 * (authority, budget, session), §4.1 (refusal codes), §6 (three credentials).
 *
 * TODO(P0 merge): move to @vaubaan/shared. Feature P0.2 adds the same
 * mission / session / request types and `RefusalCode` to `packages/shared`
 * in parallel; this file is the gateway-core-local copy so the two features
 * do not collide on one package. The orchestrator reconciles at merge by
 * re-exporting the shared definitions from here.
 */

import type { RiskId } from '@vaubaan/shared';

// ─────────────────────────────────────────────────────────────────────────────
// Refusals
// ─────────────────────────────────────────────────────────────────────────────

/** The eight structured refusal codes of spec §4.1 and §6. */
export const REFUSAL_CODES = [
  'risk-not-accepted',
  'budget-exhausted',
  'approval-required',
  'resource-not-in-mission',
  'rate-limited',
  'connection-unavailable',
  'mission-inactive',
  'wrong-credential-kind',
] as const;

export type RefusalCode = (typeof REFUSAL_CODES)[number];

// ─────────────────────────────────────────────────────────────────────────────
// Doors and credentials (spec §4.1, §4.1 bis, §6)
// ─────────────────────────────────────────────────────────────────────────────

/** The two MCP doors of an instance. The human surface is not a door: it is
 *  authenticated by a session cookie and never receives a bearer. */
export type Door = 'execution' | 'management';

/** The three credential kinds the instance recognizes. None crosses over. */
export type CredentialKind = 'mission-token' | 'delegated-token' | 'human-session';

// ─────────────────────────────────────────────────────────────────────────────
// Identities
// ─────────────────────────────────────────────────────────────────────────────

/** A user or a group, where a rule applies to both alike (spec §0). */
export interface Principal {
  readonly kind: 'user' | 'group';
  readonly id: string;
  /** Email for a user, name for a group. What a refusal shows an agent so a
   *  human can be contacted. */
  readonly display: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Connections and resources
// ─────────────────────────────────────────────────────────────────────────────

/** Spec §2.3. `unowned` keeps missions running but blocks share/reconnect. */
export type ConnectionStatus = 'active' | 'expired' | 'revoked' | 'unowned';

/** The slice of a connection a mission context carries. Credentials are
 *  never part of the context: the upstream stage decrypts them in memory
 *  for the duration of one call (spec §2.4). */
export interface MissionConnection {
  readonly id: string;
  readonly provider: string;
  readonly name: string;
  readonly status: ConnectionStatus;
  readonly owner: Principal;
}

/** One resource a mission may touch, inside one of its connections
 *  (spec §0 "Resource", §3.1 "Resource selection"). Replaces the v4
 *  `ProviderBinding`: the connection carries the credential, the resource
 *  carries the ref and the environment label. */
export interface MissionResource {
  readonly connection_id: string;
  readonly provider: string;
  /** What the agent cites in its arguments and what the gateway checks. */
  readonly ref: string;
  /** Environment label set by the owner (`prod`, `staging`, ...), or null
   *  when the resource has no parallel instances. */
  readonly env: string | null;
  readonly display_name: string | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Missions, policy, budget, session
// ─────────────────────────────────────────────────────────────────────────────

/** Spec §2.3. `exhausted` is per risk, never a mission status. */
export type MissionStatus = 'active' | 'expired' | 'orphaned' | 'revoked';

/** Spec §0 "Gate". */
export type Gate = 'auto' | 'approval';

/** Spec §0 "Budget": quota per period and rate limit per sliding window. */
export interface Budget {
  /** Number of actions allowed per period. Always a number (spec §3.2
   *  "No infinite budget"). */
  readonly quota: number;
  /** Number of actions allowed per short sliding window. */
  readonly rate_limit: RateLimit;
}

export interface RateLimit {
  readonly max: number;
  readonly window_seconds: number;
}

/** One policy entry: the value side of `RiskId → (budget, gate)`. */
export interface PolicyEntry {
  readonly budget: Budget;
  readonly gate: Gate;
}

/**
 * The mission policy, `RiskId → (budget, gate)` (spec §0 "Mission policy").
 * The keys are the accepted risks. Always an explicit enumeration: no
 * wildcard, no sentinel, no preset reference is ever a key.
 */
export type MissionPolicy = Readonly<Record<RiskId, PolicyEntry>>;

/** The accepted risks of a policy are its keys. The policy is the single
 *  source of truth; nothing stores `accepted_risks` beside it. */
export function acceptedRisksOf(policy: MissionPolicy): readonly RiskId[] {
  return Object.keys(policy);
}

/** Recurrence of a mission (spec §0 "Period"). A one-off mission has a single
 *  non-renewed period and no `Period`. */
export interface Period {
  /** ISO timestamp of the first period start. */
  readonly anchor: string;
  readonly length_seconds: number;
}

export interface MissionSummary {
  readonly id: string;
  readonly name: string;
  readonly status: MissionStatus;
  /** The only identity that can enlarge the mission or answer its requests. */
  readonly creator_id: string;
  /** ISO timestamp or null: a mission may be unlimited in time (ADR D4). */
  readonly expires_at: string | null;
  readonly period: Period | null;
}

/** Handle on the mission's session (spec §3.3). Created on the first call;
 *  a context loaded before that call carries `null`. */
export interface SessionHandle {
  readonly id: string;
  readonly started_at: string;
}

/**
 * Everything the pipeline knows about an authenticated mission token.
 * Loaded once per call (cached by the door), read-only afterwards.
 */
export interface MissionContext {
  readonly mission: MissionSummary;
  /** The token that authenticated the call. Only the prefix is ever logged. */
  readonly token: { readonly id: string; readonly prefix: string };
  readonly connections: readonly MissionConnection[];
  /** Resource selection, all connections together. Empty for a connection
   *  means the mission may touch nothing on it. */
  readonly resources: readonly MissionResource[];
  readonly policy: MissionPolicy;
  readonly session: SessionHandle | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Delegated tokens (management door) — the parts the door check needs
// ─────────────────────────────────────────────────────────────────────────────

/** A delegated token resolved at the management door (spec §0
 *  "Delegation"). Its shape beyond identity is feature P2.3's. */
export interface DelegationContext {
  readonly delegation_id: string;
  readonly user_id: string;
  readonly client_id: string;
  readonly scopes: readonly string[];
  readonly expires_at: string;
}
