/**
 * Domain vocabulary of the gateway core.
 *
 * Spec: docs/spec/vaubaan-gateway.md §0 (vocabulary), §2 (domain), §3
 * (authority, budget, mission log), §4.1 (refusal codes), §6 (three credentials).
 *
 * The domain types themselves live in `@vaubaan/shared` (ADR
 * plugin-contract-and-credential-spec D8): one source of truth for the
 * refusal codes, the account and mission states, the policy entries, the
 * budget shape, the period, the resources. This module re-exports what the
 * pipeline consumes, so `@vaubaan/gateway-core` stays a one-stop import for
 * the door, and adds only what is specific to the core: the two doors, the
 * three kinds of bearers, and the read-only *projections* of the shared
 * records the pipeline reads at call time (`MissionContext`).
 */

import type {
  Account,
  AccountResource,
  Mission,
  MissionPolicy,
  Principal,
  MissionLog,
  TokenAttribution,
} from '@vaubaan/shared';

// ─────────────────────────────────────────────────────────────────────────────
// Re-exported shared vocabulary (one source of truth: `@vaubaan/shared`)
// ─────────────────────────────────────────────────────────────────────────────

export {
  REFUSAL_CODES,
  isRefusalCode,
  acceptedRisksOf,
  GATES,
  MISSION_TOKEN_KINDS,
  isMissionTokenKind,
} from '@vaubaan/shared';
export type {
  Budget,
  AccountResource,
  AccountStatus,
  Gate,
  MissionPolicy,
  MissionPolicyEntry,
  MissionStatus,
  MissionTokenKind,
  Period,
  Principal,
  RateLimit,
  RefusalCode,
  TokenAttribution,
} from '@vaubaan/shared';

// ─────────────────────────────────────────────────────────────────────────────
// Doors and bearers (spec §4.1, §4.1 bis, §6)
// ─────────────────────────────────────────────────────────────────────────────

/** The MCP door of an instance (the git remote shares its admission). The
 *  human surface is not a door: it is authenticated by a session cookie and
 *  never receives a bearer. The management door was retired on 2026-11-14 (ADR
 *  platform-management-is-a-plugin-on-the-execution-door). */
export type Door = 'execution';

/**
 * The two kinds of bearers the instance recognizes (spec §6 "Separation
 * of the credentials"). Neither crosses over: a session presented at the
 * door is the `wrong-credential-kind` refusal.
 *
 * Not to be confused with `CredentialKind` in `@vaubaan/shared`, which is
 * how a *account* authenticates to its service (`api-key`, `oauth2`,
 * `ssh-key`) and belongs to the plugin contract.
 */
export type BearerKind = 'mission-token' | 'human-session';

// ─────────────────────────────────────────────────────────────────────────────
// Mission context — what the pipeline reads at call time
// ─────────────────────────────────────────────────────────────────────────────

/** A principal with what a refusal shows an agent so a human can be
 *  contacted: the user's email or the group's name. */
export type AccountOwner = Principal & { readonly display: string };

/** The slice of an account a mission context carries. Credentials are
 *  never part of the context: the upstream stage decrypts them in memory
 *  for the duration of one call (spec §2.4). */
/** Why an account no longer serves a mission that keeps serving through its others
 *  (ADR orphaned-missions-and-ownerless-connections, amendment 2026-10-21):
 *  `account-revoked` — revoked by an owner, for good; `access-withdrawn` — the
 *  creator holds nothing on it any more, and it serves again if the access returns. */
export const ACCOUNT_LOSSES = ['account-revoked', 'access-withdrawn'] as const;
export type AccountLoss = (typeof ACCOUNT_LOSSES)[number];

export type MissionAccount = Pick<Account, 'id' | 'service' | 'display_name' | 'status'> & {
  readonly owner: AccountOwner;
  /** Set when this account's part of the mission is lost: every call through it is
   *  refused `account-revoked`, and its tools leave `tools/list`. Absent: it serves. */
  readonly lost?: AccountLoss;
  /** How the account was made, when its plugin connects in more than one
   *  way: a tool its way cannot run is refused before the budget and left out
   *  of `tools/list`. Absent or `null`: the plugin's primary way. */
  /** As stored by the account: a kind of the contract, or a word it no longer knows (refused by the host). */
  readonly credential_kind?: string | null;
  /** The account can reach a resource that hosts this gateway (`self_resources`):
   *  the plugin's `unboundTools` are unavailable on it. Absent: false. */
  readonly hosts_instance?: boolean;
  /** The non-secret fields of the account's form (a Fly organization
   *  slug), handed to the plugin's classifier so a slice can name what the
   *  account is bound to. Absent: none. */
  readonly public_fields?: Readonly<Record<string, string>>;
  /** A set of the mission takes the resources that later appear in its
   *  environment (ADR resource-set-is-one-environment-with-optional-future-resources).
   *  Said in the `resource-not-in-mission` hint. Absent: false. */
  readonly takes_future_resources?: boolean;
};

/** One resource a mission may touch, hydrated from its selection (spec §0
 *  "Resource", §3.1 "Resource selection"). The shared `AccountResource`
 *  as-is, so `ctx.resources` feeds `resourceEnvResolver` and the plugin's
 *  `classify` without an adapter. */
export type MissionResource = AccountResource;

/**
 * One resource set of an account of the mission (risk model §4.7): the resources it
 * holds now and, through the lines of `MissionContext.policy` that name it, its policy.
 * An account has one set or more; a resource is in exactly one.
 */
export interface MissionResourceSet {
  readonly id: string;
  readonly account_id: string;
  /** Its place among the sets of its account, from 1 ("Resource set 2"). */
  readonly position: number;
  /** The ids of the mission resources (`MissionContext.resources`) it holds now. */
  readonly resource_ids: readonly string[];
}

/** What the pipeline needs of the mission row. `period` is the shared
 *  discriminated union: `{ kind: 'one-off' }` or a recurring period. */
export type MissionSummary = Pick<
  Mission,
  'id' | 'name' | 'status' | 'creator_id' | 'expires_at' | 'period'
>;

/** Handle on the mission log (spec §3.3). Created on the first call;
 *  a context loaded before that call carries `null`. */
export type MissionLogHandle = Pick<MissionLog, 'id' | 'started_at'>;

/**
 * Who a mission token belongs to (spec §0 "Mission token": each token
 * identifies one mission and one holder). A `member` token was generated by a
 * member of the mission for themselves; a `named` token was created by the
 * creator for something that has no account. `display` is what a human or an
 * agent is shown (the member's email); the audit keeps the id.
 */
export type TokenHolder =
  | { readonly kind: 'member'; readonly user_id: string; readonly display: string }
  | { readonly kind: 'named'; readonly name: string };

/** The token that authenticated a call: its row, its public prefix, its holder. */
export interface AuthenticatedToken {
  readonly id: string;
  readonly prefix: string;
  readonly holder: TokenHolder;
}

/** What the audit entry and the mission log event of a call keep of its token. */
export function tokenAttributionOf(token: AuthenticatedToken): TokenAttribution {
  return {
    token_id: token.id,
    token_kind: token.holder.kind,
    holder: token.holder.kind === 'member' ? token.holder.user_id : token.holder.name,
  };
}

/** How a holder is named to a reader: the member's email, or the token's name. */
export function tokenHolderLabel(holder: TokenHolder): string {
  return holder.kind === 'member' ? holder.display : holder.name;
}

/**
 * Everything the pipeline knows about an authenticated mission token.
 * Loaded once per call (cached by the door), read-only afterwards.
 */
export interface MissionContext {
  readonly mission: MissionSummary;
  /** The token that authenticated the call, and its holder. Only the prefix
   *  is ever logged. */
  readonly token: AuthenticatedToken;
  readonly accounts: readonly MissionAccount[];
  /** Resource selection, all accounts together. Empty for an account
   *  means the mission may touch nothing on it. */
  readonly resources: readonly MissionResource[];
  /** The resource sets of every account, by account then position. */
  readonly resource_sets: readonly MissionResourceSet[];
  /** The explicit policy, every line naming its resource set (`resource_set_id`); the
   *  accepted risks of a set are the `risk_id`s of its lines. Nothing stores
   *  `accepted_risks` beside it. */
  readonly policy: MissionPolicy;
  readonly missionLog: MissionLogHandle | null;
}
