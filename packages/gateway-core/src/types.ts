/**
 * Domain vocabulary of the gateway core.
 *
 * Spec: docs/spec/vaubaan-gateway.md §0 (vocabulary), §2 (domain), §3
 * (authority, budget, session), §4.1 (refusal codes), §6 (three credentials).
 *
 * The domain types themselves live in `@vaubaan/shared` (ADR
 * plugin-contract-and-credential-spec D8): one source of truth for the
 * refusal codes, the connection and mission states, the policy entries, the
 * budget shape, the period, the resources. This module re-exports what the
 * pipeline consumes, so `@vaubaan/gateway-core` stays a one-stop import for
 * the door, and adds only what is specific to the core: the two doors, the
 * three kinds of bearers, and the read-only *projections* of the shared
 * records the pipeline reads at call time (`MissionContext`).
 */

import type {
  Connection,
  ConnectionResource,
  Mission,
  MissionPolicy,
  Principal,
  Session,
} from '@vaubaan/shared';

// ─────────────────────────────────────────────────────────────────────────────
// Re-exported shared vocabulary (one source of truth: `@vaubaan/shared`)
// ─────────────────────────────────────────────────────────────────────────────

export { REFUSAL_CODES, isRefusalCode, acceptedRisksOf, GATES } from '@vaubaan/shared';
export type {
  Budget,
  ConnectionResource,
  ConnectionStatus,
  Gate,
  MissionPolicy,
  MissionPolicyEntry,
  MissionStatus,
  Period,
  Principal,
  RateLimit,
  RefusalCode,
} from '@vaubaan/shared';

// ─────────────────────────────────────────────────────────────────────────────
// Doors and bearers (spec §4.1, §4.1 bis, §6)
// ─────────────────────────────────────────────────────────────────────────────

/** The two MCP doors of an instance. The human surface is not a door: it is
 *  authenticated by a session cookie and never receives a bearer. */
export type Door = 'execution' | 'management';

/**
 * The three kinds of bearers the instance recognizes (spec §6 "Separation
 * of the three credentials"). None crosses over: a mismatch at a door is the
 * `wrong-credential-kind` refusal.
 *
 * Not to be confused with `CredentialKind` in `@vaubaan/shared`, which is
 * how a *connection* authenticates to its provider (`api-key`, `oauth2`,
 * `app-install`, `ssh-key`) and belongs to the plugin contract.
 */
export type BearerKind = 'mission-token' | 'delegated-token' | 'human-session';

// ─────────────────────────────────────────────────────────────────────────────
// Mission context — what the pipeline reads at call time
// ─────────────────────────────────────────────────────────────────────────────

/** A principal with what a refusal shows an agent so a human can be
 *  contacted: the user's email or the group's name. */
export type ConnectionOwner = Principal & { readonly display: string };

/** The slice of a connection a mission context carries. Credentials are
 *  never part of the context: the upstream stage decrypts them in memory
 *  for the duration of one call (spec §2.4). */
export type MissionConnection = Pick<Connection, 'id' | 'provider' | 'display_name' | 'status'> & {
  readonly owner: ConnectionOwner;
};

/** One resource a mission may touch, hydrated from its selection (spec §0
 *  "Resource", §3.1 "Resource selection"). The shared `ConnectionResource`
 *  as-is, so `ctx.resources` feeds `resourceEnvResolver` and the plugin's
 *  `classify` without an adapter. */
export type MissionResource = ConnectionResource;

/** What the pipeline needs of the mission row. `period` is the shared
 *  discriminated union: `{ kind: 'one-off' }` or a recurring period. */
export type MissionSummary = Pick<
  Mission,
  'id' | 'name' | 'status' | 'creator_id' | 'expires_at' | 'period'
>;

/** Handle on the mission's session (spec §3.3). Created on the first call;
 *  a context loaded before that call carries `null`. */
export type SessionHandle = Pick<Session, 'id' | 'started_at'>;

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
  /** The explicit policy; its `risk_id`s are the accepted risks
   *  (`acceptedRisksOf(ctx)`). Nothing stores `accepted_risks` beside it. */
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
