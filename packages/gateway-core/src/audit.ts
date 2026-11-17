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
  /** Account and resource the call targeted, when resolved. */
  readonly account_id: string | null;
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
   *  service did. */
  readonly decision: AuditDecision;
  readonly refusal_code: RefusalCode | null;
  /** The refusal's hint, or the structural reason for a refusal that has no
   *  code (unknown tool, classifier denial, catalog missing). */
  readonly refusal_reason: string | null;
  /** The approval consumed by this call, if any (spec §3.5). */
  readonly approval_id: string | null;
  /** Remaining quota per risk after the call, for the risks the call touched:
   *  the least left in the resource sets it was charged on. Null when the budget
   *  was not consulted. */
  readonly remaining_budget: Readonly<Record<RiskId, number>> | null;
  /** The resource sets of its account the call was judged against (risk model
   *  §4.7) and, when allowed, charged on. Absent or empty: the risk step did not run. */
  readonly resource_set_ids?: readonly string[];
  /** Free-form attribution label sent by the agent; no effect on
   *  authorization. */
  readonly agent_label: string | null;
  readonly upstream_latency_ms: number | null;
  /**
   * Bytes the call sent to the service and received from it (`CallMeter`,
   * `bytes.ts`). Set on a forwarded call only; absent or null on a refused
   * one, on `response_bytes` of a call that failed, and on entries written
   * before they were counted (migration 0038).
   */
  readonly request_bytes?: number | null;
  readonly response_bytes?: number | null;
  /** Set when an allowed call failed upstream; the business effect did not
   *  happen (or is unknown). */
  readonly upstream_error: string | null;
  readonly client_ip: string | null;
  readonly client_user_agent: string | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Administrative entries
// ─────────────────────────────────────────────────────────────────────────────

/** Spec §8: "account, share, revocation, issuance, extension, reset,
 *  approval, rotation, delegation granted or revoked, configuration change". */
export type AdminAct =
  | 'account-created'
  | 'account-reconnected'
  /** A connect attempt the host refused before anything was stored (kept for
   *  the entries of the GitHub App installations of earlier builds). */
  | 'account-refused'
  | 'account-transferred'
  /** The operator gave an owner to an account that had none left (spec §2.3:
   *  "the operator's only act on the domain"). `before` / `after` carry the owner. */
  | 'account-reassigned'
  | 'account-revoked'
  /** An account's resources were discovered again: the outcome (count or the
   *  service's error), never the resource list. Object: the account.
   *  `after.cause` says who ran it: `by-owner` ("Refresh", the actor is the
   *  owner) or `after-a-call` (the gateway, after a call that created a
   *  resource; the actor is the human behind the call's key, `after` adds
   *  `mission_id`, `tool`, `added`, `attempts`; ADR
   *  created-resources-join-the-mission), `check-now` (a mission card), or
   *  `scheduled` / `on-open` (the gateway's own refresh, hourly or because a
   *  page showed the account stale; actor `DISCOVERY_ACTOR_ID`, written only
   *  when it changed something, `after` adds `added`, `removed`,
   *  `rights_changed` and `expired` when the key was rejected). */
  | 'resources-discovered'
  /** The owner edited one resource (name, environment label, hidden flag,
   *  editable settings). Object: the account; `before` / `after` name the
   *  resource and carry the edited fields. */
  | 'resource-edited'
  /** The owner set or cleared the account's default environment label for its
   *  unlabelled resources. Object: the account; `before` / `after` carry
   *  `default_env` (a label or null). */
  | 'account-default-env-set'
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
   *  act removed it (the owner who revoked a share or an account, the operator
   *  who edited a group, the user whose sign-in changed their groups); `after`
   *  carries the cause and the uncovered risks. */
  | 'mission-orphaned'
  /** The authority behind an orphaned mission came back: it serves calls again,
   *  session and counters intact. The entry names the human whose act returned
   *  it (the owner who shared again, the operator who reassigned the account
   *  or added a group member, the user whose sign-in carried the group again);
   *  `before` carries the cause the mission was orphaned for. */
  | 'mission-restored'
  /** An account of a mission that keeps serving through its others stopped serving it
   *  (ADR orphaned-missions-and-ownerless-connections, amendment 2026-10-21): it was
   *  revoked, or the creator's access to it was withdrawn. The entry names the human
   *  whose act did it; `after.newly_lost` lists the accounts and their cause. */
  | 'mission-account-lost'
  /** An account whose access had been withdrawn serves a mission again (a share made
   *  again, a membership back). `after.restored` lists the accounts. */
  | 'mission-account-restored'
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
   *  the human behind the call's key, `after` carries `account_id`, `tool`,
   *  `refs`, `resource_set_ids` and `added_to_selection` (the refs written now; one
   *  already in a set is not). Object: the mission. */
  | 'mission-resources-added'
  /** A resource joined a resource set with future on after issuance (ADR
   *  resource-set-is-one-environment-with-optional-future-resources): it appeared on the
   *  account (`after.reason` `discovered`) or was relabelled into the set's
   *  environment (`relabelled`). `after` carries `account_id`, `resource_set_id`,
   *  `refs`, `reason`. The actor is the human whose act caused it (an owner's relabel or
   *  refresh, a creator's "check now"), or `DISCOVERY_ACTOR_ID`. Object: the mission. */
  | 'mission-resource-joined'
  /** A resource left a resource set because its environment is no longer the set's (a
   *  relabel, or a change of the account's default environment); it may join the set
   *  of its new environment in the same act (`mission-resource-joined`). Same `after`
   *  as `mission-resource-joined`. Object: the mission. */
  | 'mission-resource-left'
  | 'permission-requested'
  | 'limits-changed'
  /** The creator edited the mission (ADR mission-editable-after-issuance): `before` and
   *  `after` hold the sections that moved — `name`, `expires_at`, `accounts`,
   *  `resources`, `permissions` — each in full; `after.requests_closed` lists the
   *  requests the edit made moot. */
  | 'mission-changed'
  | 'approval-granted'
  | 'request-refused'
  /** History (the management door was retired on 2026-11-14): a user authorized an app. */
  | 'delegation-granted'
  /** History. A delegation ended: by its user, by its client, by an operator disabling
   *  the client or deactivating the user, or by the instance on a replayed
   *  refresh token or authorization code (`after.reason` says which; after a
   *  replay `after.missions_to_review` names the missions it issued that still
   *  run). */
  | 'delegation-revoked'
  /** Local groups, kept by the operator (spec §0 "Group", §11.2). Object: the group. */
  | 'group-created'
  | 'group-member-added'
  | 'group-member-removed'
  /** History. An operator allowed a registered OAuth client of the management door to
   *  ask users for a delegation. Object: the client. */
  | 'oauth-client-approved'
  /** History. An operator barred an OAuth client; its delegations are revoked with it. */
  | 'oauth-client-disabled'
  /** An operator deactivated a user: no sign-in, no session, no authority; their
   *  group memberships are removed (`after` lists them). Their missions get their own `mission-orphaned` entries. Object: the user. */
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
  /** A single-use link was made for a sign-in account (ADR local-accounts-sign-in-provider):
   *  an invitation to create one, or a password reset. Object: `instance-config` /
   *  `sign-in-account:<sign-in provider>`; `after` carries the kind, the address and the expiry —
   *  never the link. The actor is the administrator, `bootstrap`, or the person
   *  (`self`, a reset asked from the sign-in page). */
  | 'local-link-created'
  /** A sign-in account was created: by its person through an invitation link (the actor
   *  is who invited), or by the setup for the first administrator. `after`: the address. */
  | 'sign-in-account-created'
  /** The password of a sign-in account was set again, through a reset link or from Settings. */
  | 'local-password-changed'
  /** The second factor of a sign-in account was enrolled, replaced or reset (by the person,
   *  or by an administrator for them: `after.by`). Never the secret. */
  | 'local-second-factor-changed'
  /** An administrator removed a sign-in account; the person can no longer sign in through it. */
  | 'sign-in-account-removed'
  /** An administrator downloaded the master key file (the setup's handover, or
   *  Administration → Encryption). Object: `instance-config` / `master-key`;
   *  `after` carries the key version and the page it was asked from. Never the key. */
  | 'master-key-downloaded'
  /** A designation of an administrator was made (ADR administrators-live-in-the-instance):
   *  a user made administrator, an address or a group of a sign-in provider named, or a pending
   *  address turned into its user at their first sign-in. Object: `instance-config` /
   *  `administrators`; `after` carries the designation (kind, user, address, sign-in provider,
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
  /** The second factor was waived for a sign-in provider, or the waiver was changed or removed:
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
  /** A person subscribed one of their devices to notifications (spec §4.2 bis). Object: the
   *  user; `after` carries the device id, its label and whether it took over a subscription
   *  stored before. Never the endpoint or the keys of the subscription. */
  | 'device-added'
  /** A person removed one of their devices: `before` carries its id and label. */
  | 'device-removed'
  /** A person added a messaging address to their notifications, after its test message was
   *  taken (spec §4.2 bis). Object: the user; `after` carries the address id, its kind and
   *  its label. Never the URL. */
  | 'address-added'
  /** A person removed one of their messaging addresses: `before` carries its id, kind, label. */
  | 'address-removed'
  /** A person switched mail notifications on or off: `before` / `after` carry `{ on }`.
   *  Never the address. */
  | 'mail-notifications-changed'
  /** A plugin archive was uploaded and is pending (ADR
   *  plugins-activated-by-an-administrator-on-trial). Object: the version (its digest);
   *  `after` carries the plugin, version, digest, state and trust. `via_mission_id` when an
   *  agent uploaded it. */
  | 'plugin-uploaded'
  /** A version was marked to start on trial at the next start (an activation, or going
   *  back to a kept version). `before` / `after` carry its summary. */
  | 'plugin-activated'
  /** A pending version was refused; its files are deleted. */
  | 'plugin-refused'
  /** A plugin follows the image again: its installed version is no longer active.
   *  Object: the plugin id. */
  | 'plugin-followed-image'
  /** What a start made of a version on trial: `after` carries `{ outcome, failure? }`.
   *  Written by the gateway at start (`STARTUP_ACTOR_ID`). */
  | 'plugin-trial-ended'
  /** An administrator restarted the instance from Administration › Plugins. */
  | 'instance-restarted'
  | 'config-changed';

export type AdminObjectType =
  | 'account'
  | 'share'
  | 'mission'
  | 'request'
  | 'delegation'
  | 'group'
  | 'oauth-client'
  | 'user'
  | 'instance-config'
  /** An installed plugin version (by its digest) or a plugin (by its id). */
  | 'plugin';

/**
 * The `user_id` of administrative entries written by the bootstrap operator:
 * the holder of the one-time bootstrap token, who has no user row yet. One
 * constant for every writer (auth, accounts) and every reader (audit).
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

/**
 * The `user_id` of entries the gateway's own discovery writes: the hourly discovery of
 * the accounts a mission's future resources depend on, and the discovery after a
 * creating call (ADR resource-set-is-one-environment-with-optional-future-resources).
 */
export const DISCOVERY_ACTOR_ID = 'discovery';

/** How the gateway's own discovery is named wherever an actor is shown. */
export const DISCOVERY_ACTOR_LABEL = 'The gateway’s discovery';

/**
 * The `user_id` of entries a store migration wrote at boot: nobody signed in did it
 * (migration 0040 revoking a person's second Vaubaan account).
 */
export const MIGRATION_ACTOR_ID = 'migration';

/** How a migration is named wherever an actor is shown. */
export const MIGRATION_ACTOR_LABEL = 'A gateway upgrade';

/**
 * The `user_id` of entries the gateway wrote while starting: what a plugin version on
 * trial became (ADR plugins-activated-by-an-administrator-on-trial).
 */
export const STARTUP_ACTOR_ID = 'startup';

/** How the start is named wherever an actor is shown. */
export const STARTUP_ACTOR_LABEL = 'The gateway’s start';

export interface AdminAuditEntry {
  readonly kind: 'admin';
  readonly ts: string;
  /** The human behind the act: a user id (an agent acting through the
   *  `vaubaan` plugin acts on behalf of its mission's creator), or
   *  `BOOTSTRAP_ACTOR_ID` for the bootstrap operator. */
  readonly user_id: string;
  readonly act: AdminAct;
  readonly object: { readonly type: AdminObjectType; readonly id: string };
  /** Previous and new state, when meaningful; `null` when not. Never a secret. */
  readonly before: unknown;
  readonly after: unknown;
  /**
   * Set when the act came through the `vaubaan` plugin (spec §4.1 bis, §8): the
   * mission whose key made the call. Stored in the entry's `mission_id`.
   */
  readonly via_mission_id?: string | null;
  /**
   * History: the OAuth client that acted through the retired management door.
   * Nothing writes it any more; entries written before 2026-11-14 still carry it.
   */
  readonly delegated_client_id?: string | null;
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
