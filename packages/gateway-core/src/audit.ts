/**
 * Audit model — one immutable entry per MCP call (allowed or refused) and per
 * administrative act.
 *
 * Spec: docs/spec/vaubaan-gateway.md §8 (fields), §6 ("Immutable audit",
 * "No secret in logs": arguments are hashed, never stored in clear);
 * docs/spec/gateway-risk-model.md §12 (shape of the risk fields).
 *
 * This module owns the entry shape and the `AuditWriter` contract. The
 * persistent writer (SQLite, append-only triggers) lives in the store of the
 * application and implements `AuditWriter`; `MemoryAuditWriter`
 * serves tests. The interface name and the `write(entry)` signature are the
 * contract between the two and must stay stable.
 */

import type { AuditDecision, MissionTokenKind, RefusalCode, RiskId, Slice } from '@vaubaan/shared';

export type { AuditDecision } from '@vaubaan/shared';

// ─────────────────────────────────────────────────────────────────────────────
// Call entries
// ─────────────────────────────────────────────────────────────────────────────

export interface CallAuditEntry {
  readonly kind: 'call';
  /** ISO timestamp of the decision. */
  readonly ts: string;
  readonly mission_id: string;
  /**
   * The token the call presented and its holder (spec §8 "the token used and
   * its holder"): the token row, its kind, and the member's user id (`member`)
   * or the token's name (`named`). Authenticated, unlike `agent_label`. All
   * three are null only on an entry written before tokens had a holder.
   */
  readonly token_id: string | null;
  readonly token_kind: MissionTokenKind | null;
  readonly token_holder: string | null;
  /** Null when the call was refused before the session was touched. */
  readonly session_id: string | null;
  /** Connection and resource the call targeted, when resolved. */
  readonly connection_id: string | null;
  readonly resource_ref: string | null;
  readonly tool: string;
  /** `fingerprintArguments(args)`: sha256 (64 hex) of the canonical JSON of
   *  the arguments — the same value that binds approvals. Never the
   *  arguments themselves. */
  readonly arguments_hash: string;
  /** Slices the plugin emitted for the call (empty when refused before
   *  classification). */
  readonly slices_executed: readonly Slice[];
  /** Risks those slices intersected in the catalog. */
  readonly risks_touched: readonly RiskId[];
  /** Snapshot of the mission's accepted risks at call time, for forensic
   *  reproducibility: the mission may be re-issued or revoked later. */
  readonly accepted_risks_snapshot: readonly RiskId[];
  /** Decision of the gateway (`AuditDecision` in `@vaubaan/shared`). An
   *  upstream failure after an allow stays `allowed` with `upstream_error`
   *  set: the decision is what the gateway did; the outcome is what the
   *  provider did. */
  readonly decision: AuditDecision;
  readonly refusal_code: RefusalCode | null;
  /** The refusal's hint, or the structural reason for a refusal that has no
   *  code (unknown tool, classifier denial, catalog missing). */
  readonly refusal_reason: string | null;
  /** The approval consumed by this call, if any (spec §3.5). */
  readonly approval_id: string | null;
  /** Remaining quota per risk after the call, for the risks the call touched.
   *  Null when the budget was not consulted. */
  readonly remaining_budget: Readonly<Record<RiskId, number>> | null;
  /** Free-form attribution label sent by the agent; no effect on
   *  authorization. */
  readonly agent_label: string | null;
  readonly upstream_latency_ms: number | null;
  /** Set when an allowed call failed upstream; the business effect did not
   *  happen (or is unknown). */
  readonly upstream_error: string | null;
  readonly client_ip: string | null;
  readonly client_user_agent: string | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Administrative entries
// ─────────────────────────────────────────────────────────────────────────────

/** Spec §8: "connection, share, revocation, issuance, extension, reset,
 *  approval, rotation, delegation granted or revoked, configuration change". */
export type AdminAct =
  | 'connection-created'
  | 'connection-reconnected'
  /** A connect attempt the host refused before anything was stored (kept for
   *  the entries of the GitHub App installations of earlier builds). */
  | 'connection-refused'
  | 'connection-transferred'
  /** The operator gave an owner to a connection that had none left (spec §2.3:
   *  "the operator's only act on the domain"). `before` / `after` carry the owner. */
  | 'connection-reassigned'
  | 'connection-revoked'
  /** A connection's resources were discovered again: the outcome (count or the
   *  provider's error), never the resource list. Object: the connection.
   *  `after.cause` says who ran it: `by-owner` ("Refresh", the actor is the
   *  owner) or `after-a-call` (the gateway, after a call that created a
   *  resource; the actor is the human behind the call's key, `after` adds
   *  `mission_id`, `tool`, `added`, `attempts`). ADR
   *  discovery-runs-after-a-creating-call. */
  | 'resources-discovered'
  /** The owner edited one resource (name, environment label, hidden flag,
   *  editable settings). Object: the connection; `before` / `after` name the
   *  resource and carry the edited fields. */
  | 'resource-edited'
  /** The owner set or cleared the connection's default environment label for its
   *  unlabelled resources. Object: the connection; `before` / `after` carry
   *  `default_env` (a label or null). */
  | 'connection-default-env-set'
  | 'share-created'
  | 'share-revoked'
  | 'mission-issued'
  /** A holder replaced their own token of the mission; the previous one stops
   *  working. `before` / `after` carry the prefixes, the kind and the holder. */
  | 'mission-rotated'
  | 'mission-revoked'
  /** The creator gave a user access to the mission (spec §0 "Mission member").
   *  Object: the mission; `after` names the member. */
  | 'mission-member-added'
  /** The creator removed a member; their token, if any, is revoked with them. */
  | 'mission-member-removed'
  /** A member left the mission by themselves; their token, if any, is revoked with it. */
  | 'mission-member-left'
  /** A token of the mission was issued: a member generated their first one, or
   *  the creator created a named token. Never the secret. */
  | 'mission-token-issued'
  /** One token was revoked on its own: by its holder, by the creator, or by an
   *  operator deactivating its holder (`after.reason`). */
  | 'mission-token-revoked'
  | 'mission-closed'
  /** The authority behind a mission went missing (spec §2.3 "orphaned", a state
   *  derived on every read and never stored). The entry names the human whose
   *  act removed it (the owner who revoked a share or a connection, the operator
   *  who edited a group, the user whose sign-in changed their groups); `after`
   *  carries the cause and the uncovered risks. */
  | 'mission-orphaned'
  /** The authority behind an orphaned mission came back: it serves calls again,
   *  session and counters intact. The entry names the human whose act returned
   *  it (the owner who shared again, the operator who reassigned the connection
   *  or added a group member, the user whose sign-in carried the group again);
   *  `before` carries the cause the mission was orphaned for. */
  | 'mission-restored'
  /** A connection of a mission that keeps serving through its others stopped serving it
   *  (ADR orphaned-missions-and-ownerless-connections, amendment 2026-10-21): it was
   *  revoked, or the creator's access to it was withdrawn. The entry names the human
   *  whose act did it; `after.newly_lost` lists the connections and their cause. */
  | 'mission-connection-lost'
  /** A connection whose access had been withdrawn serves a mission again (a share made
   *  again, a membership back). `after.restored` lists the connections. */
  | 'mission-connection-restored'
  | 'budget-extended'
  | 'period-reset'
  | 'expiry-extended'
  /** The creator opened a risk's gate for the rest of the period, on a request. */
  | 'gate-opened'
  /** The creator edited a risk's gate on the mission itself (`auto` ⇄ `approval`). */
  | 'gate-changed'
  /** The creator changed the limits of accepted risks on the mission itself (quota per
   *  period, calls per rate window): `before` and `after` list each changed risk. */
  | 'permissions-changed'
  /** Resources joined the mission's selection. `after.cause` says how:
   *  `created-by-the-mission` — the mission created them through a creating call
   *  and reaches them at once (ADR created-resources-join-the-mission); the actor is
   *  the human behind the call's key, `after` carries `connection_id`, `tool`,
   *  `refs`, `resource_scope` and `added_to_selection` (empty under scope
   *  `connection`, which reaches them already). Object: the mission. */
  | 'mission-resources-added'
  | 'permission-requested'
  | 'limits-changed'
  | 'approval-granted'
  | 'request-refused'
  | 'delegation-granted'
  /** A delegation ended: by its user, by its client, by an operator disabling
   *  the client or deactivating the user, or by the instance on a replayed
   *  refresh token or authorization code (`after.reason` says which; after a
   *  replay `after.missions_to_review` names the missions it issued that still
   *  run). */
  | 'delegation-revoked'
  /** Local groups, kept by the operator (spec §0 "Group", §11.2). Object: the group. */
  | 'group-created'
  | 'group-member-added'
  | 'group-member-removed'
  /** An operator allowed a registered OAuth client of the management door to
   *  ask users for a delegation. Object: the client. */
  | 'oauth-client-approved'
  /** An operator barred an OAuth client; its delegations are revoked with it. */
  | 'oauth-client-disabled'
  /** An operator deactivated a user: no sign-in, no session, no authority; their
   *  delegations are revoked and their group memberships removed (`after` lists
   *  both). Their missions get their own `mission-orphaned` entries. Object: the user. */
  | 'user-deactivated'
  /** An operator let a deactivated user sign in again. Object: the user. */
  | 'user-reactivated'
  /** Every web session of a user was ended ("sign out everywhere"): by the user,
   *  or by an operator for them. Nothing else changes. Object: the user. */
  | 'user-sessions-ended'
  /** An administrator allowed an email address to sign in (spec §0 "Invitation").
   *  Object: `instance-config` / `invitations`; `after.email` is the address. */
  | 'invitation-added'
  /** An administrator removed an address from the invitation list; `before.email`. */
  | 'invitation-removed'
  /** A single-use link was made for a local account (ADR local-accounts-sign-in-provider):
   *  an invitation to create one, or a password reset. Object: `instance-config` /
   *  `local-account:<provider>`; `after` carries the kind, the address and the expiry —
   *  never the link. The actor is the administrator, `bootstrap`, or the person
   *  (`self`, a reset asked from the sign-in page). */
  | 'local-link-created'
  /** A local account was created: by its person through an invitation link (the actor
   *  is who invited), or by the setup for the first administrator. `after`: the address. */
  | 'local-account-created'
  /** The password of a local account was set again, through a reset link or from Settings. */
  | 'local-password-changed'
  /** The second factor of a local account was enrolled, replaced or reset (by the person,
   *  or by an administrator for them: `after.by`). Never the secret. */
  | 'local-second-factor-changed'
  /** An administrator removed a local account; the person can no longer sign in through it. */
  | 'local-account-removed'
  /** An administrator downloaded the master key file (the setup's handover, or
   *  Administration → Encryption). Object: `instance-config` / `master-key`;
   *  `after` carries the key version and the page it was asked from. Never the key. */
  | 'master-key-downloaded'
  /** A designation of an administrator was made (ADR administrators-live-in-the-instance):
   *  a user made administrator, an address or a group of a provider named, or a pending
   *  address turned into its user at their first sign-in. Object: `instance-config` /
   *  `administrators`; `after` carries the designation (kind, user, address, provider,
   *  group, origin). The actor is an administrator, `bootstrap`, `configuration` or
   *  `recovery`. */
  | 'administrator-granted'
  /** A designation was removed: a user unmade, a pending address or a group dropped. */
  | 'administrator-revoked'
  /** The configuration's admin rule was applied while the store named nobody (the
   *  first boot of an instance, or its upgrade). `after` lists what it named. */
  | 'administrators-seeded'
  /** The setup ended: "Finish setup" revoked the bootstrap token. */
  | 'setup-finished'
  /** A sign-in provider was tested beside the session: `after` carries the outcome, the
   *  identity seen and the verdict. Nothing was created. Object: `sign-in:<id>`. */
  | 'sign-in-provider-tested'
  /** A sign-in provider was switched on after a passed test. Object: `sign-in:<id>`. */
  | 'sign-in-provider-enabled'
  /** A sign-in provider was switched off; its users' sessions ended (the actor's kept). */
  | 'sign-in-provider-disabled'
  /** The second factor was waived for a provider, or the waiver was changed or removed:
   *  `before` / `after` carry the waiver (`always`, `amr`, or none). */
  | 'second-factor-waiver-changed'
  /** A person's second factor was enrolled, replaced or reset (by the person, or by an
   *  administrator for them: `after.by`). Never the secret. Object: the user. */
  | 'second-factor-changed'
  /** The master key's holder named an administrator through the recovery page:
   *  `after` carries what was named. The actor is `recovery`. */
  | 'administrator-recovered'
  /** The scheduled backup uploaded one (ADR scheduled-encrypted-backup-to-object-storage):
   *  `after` carries the object key, size, SHA-256, key versions, the self-check and what
   *  the retention deleted. Object: `instance-config` / `backup`; actor `schedule`. */
  | 'backup-made'
  /** A scheduled backup failed and nothing was uploaded: `after` carries the stage and the
   *  reason (never a URL or a secret). Object: `instance-config` / `backup`. */
  | 'backup-failed'
  | 'config-changed';

export type AdminObjectType =
  | 'connection'
  | 'share'
  | 'mission'
  | 'request'
  | 'delegation'
  | 'group'
  | 'oauth-client'
  | 'user'
  | 'instance-config';

/**
 * The `user_id` of administrative entries written by the bootstrap operator:
 * the holder of the one-time bootstrap token, who has no user row yet. One
 * constant for every writer (auth, connections) and every reader (audit).
 */
export const BOOTSTRAP_ACTOR_ID = 'bootstrap';

/** How the bootstrap operator is named wherever an actor is shown. */
export const BOOTSTRAP_ACTOR_LABEL = 'Bootstrap operator';

/**
 * The `user_id` of entries the boot wrote by applying the configuration's admin rule
 * (ADR administrators-live-in-the-instance): nobody signed in did it.
 */
export const CONFIGURATION_ACTOR_ID = 'configuration';

/** How the configuration is named wherever an actor is shown. */
export const CONFIGURATION_ACTOR_LABEL = 'The configuration';

/** The `user_id` of entries written through the recovery by the master key. */
export const RECOVERY_ACTOR_ID = 'recovery';

/** How a recovery is named wherever an actor is shown. */
export const RECOVERY_ACTOR_LABEL = 'Recovery with the master key';

/** The `user_id` of entries the scheduled backup writes: the instance, on its schedule. */
export const SCHEDULE_ACTOR_ID = 'schedule';

/** How the scheduled backup is named wherever an actor is shown. */
export const SCHEDULE_ACTOR_LABEL = 'The backup schedule';

export interface AdminAuditEntry {
  readonly kind: 'admin';
  readonly ts: string;
  /** The human behind the act: a user id (a delegated client acts on behalf
   *  of one), or `BOOTSTRAP_ACTOR_ID` for the bootstrap operator. */
  readonly user_id: string;
  readonly act: AdminAct;
  readonly object: { readonly type: AdminObjectType; readonly id: string };
  /** Previous and new state, when meaningful; `null` when not. Never a secret. */
  readonly before: unknown;
  readonly after: unknown;
  /** Set when the act came through the management door (spec §4.1 bis). */
  readonly delegated_client_id: string | null;
}

export type AuditEntry = CallAuditEntry | AdminAuditEntry;

// ─────────────────────────────────────────────────────────────────────────────
// Writer contract
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Stable contract with the store's writer. A writer must not
 * swallow failures: the pipeline treats a rejected `write` as an internal
 * error, so a call never completes without its audit entry.
 */
export interface AuditWriter {
  write(entry: AuditEntry): Promise<void>;
}

/** In-memory writer for tests. */
export class MemoryAuditWriter implements AuditWriter {
  readonly entries: AuditEntry[] = [];

  async write(entry: AuditEntry): Promise<void> {
    this.entries.push(entry);
  }

  get calls(): CallAuditEntry[] {
    return this.entries.filter((e): e is CallAuditEntry => e.kind === 'call');
  }

  get admin(): AdminAuditEntry[] {
    return this.entries.filter((e): e is AdminAuditEntry => e.kind === 'admin');
  }
}
