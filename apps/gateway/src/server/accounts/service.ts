/**
 * Accounts (spec §0 "Account", "Resource"; §2.3 states; §7.2).
 *
 * One generic driver over the `CredentialSpec` kinds — the plugin declares one way of
 * connecting, the host runs the flow (`connect.ts`; ADR
 * one-place-to-authorize-services-token-first).
 *
 * An account is created under the name of the user who connected it. An
 * owner may transfer it to a group they belong to (`transfer`); when that
 * group empties the account is `unowned` and the operator hands it to a new
 * owner (`reassign`, the operator's only act on the domain — spec §2.3). Its
 * credential is the serialized `CredentialSecret`, sealed by the store with
 * the account id as associated data. Resources are discovered by the
 * plugin at connect time and merged by `syncDiscoveredResources`, which
 * never overwrites an owner edit and never deletes a row.
 */
import type { Resource } from '@vaubaan/plugin-sdk';

import { toIso } from '../store/clock';
import type { AccountRecord, AccountResourceRecord, GroupRecord } from '../store/types';
import { AccountReads } from './account-reads';
import { AccountSettings } from './account-settings';
import { AccountConnect } from './connect';
import { AccountDiscovery } from './discovery';
import { ConnectError } from './errors';
import { AccountOwnership } from './ownership';

export { CHECK_NOW_RATE_LIMIT, CHECK_NOW_RATE_WINDOW_MS, DISCOVERY_TIMEOUT_MS } from './discovery';
export { isHostAccount } from './host-account';
export type {
  Actor,
  TokenPermissionView,
  GuideFigureView,
  GuideStepView,
  TokenGuideView,
  AlternativeView,
  ConnectableService,
  DiscoveryRecord,
  DiscoveryAfterCallCause,
  AfterCallDiscovery,
  AutomaticRefreshCause,
  AutomaticRefresh,
  ServiceGrantView,
  AccountView,
  AccountDetail,
  StartInput,
  Connected,
  StartResult,
  ResourcePatch,
  ImportedFrom,
  ImportPastedInput,
  ImportSshInput,
  NewOwner,
  AccountServiceDeps,
  MissionResourceCheck,
  MissionResourceMoves,
} from './account-views';
import type {
  Actor,
  ConnectableService,
  DiscoveryRecord,
  DiscoveryAfterCallCause,
  AfterCallDiscovery,
  AutomaticRefreshCause,
  AutomaticRefresh,
  ServiceGrantView,
  AccountView,
  AccountDetail,
  StartInput,
  Connected,
  StartResult,
  ResourcePatch,
  ImportPastedInput,
  ImportSshInput,
  NewOwner,
  AccountServiceDeps,
  MissionResourceCheck,
} from './account-views';

/** The pages of the accounts a person can use ("accounts" in the spec and the store). */
export const ACCOUNTS_PATH = '/accounts';
/**
 * Where a service sends the browser back after an authorization. This path is
 * registered at the service (the redirect URI of the company's OAuth client):
 * it is part of the protocol, so it kept its name when the pages moved to
 * `/accounts`.
 */
export const CONNECT_CALLBACK_PATH = '/connections/callback';

/**
 * The accounts' one entry point. Each group of use cases lives in its own module and
 * the service delegates to it: the connect flows (`connect.ts`), the discovery of
 * resources (`discovery.ts`), the owner's edits (`account-settings.ts`), revocation and
 * ownership (`ownership.ts`), the reads of the pages (`account-reads.ts`). What they
 * share stays here: who owns an account, the callback URL, the clock.
 */
export class AccountService {
  /** The discovery of resources (`discovery.ts`). */
  readonly #discovery: AccountDiscovery;
  /** The connect flows (`connect.ts`). */
  readonly #connect: AccountConnect;
  /** What the pages read (`account-reads.ts`). */
  readonly #reads: AccountReads;
  /** The owner's edits (`account-settings.ts`). */
  readonly #settings: AccountSettings;
  /** Revoke, transfer, reassign (`ownership.ts`). */
  readonly #ownership: AccountOwnership;

  constructor(private readonly deps: AccountServiceDeps) {
    this.#discovery = new AccountDiscovery(deps, this);
    this.#connect = new AccountConnect(deps, this, this.#discovery);
    this.#reads = new AccountReads(deps, this);
    this.#settings = new AccountSettings(deps, this);
    this.#ownership = new AccountOwnership(deps, this);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Discovery: discovery.ts
  // ───────────────────────────────────────────────────────────────────────────

  /** A person's "Refresh": the account's resources read again at its service. */
  discover(actor: Actor, accountId: string): Promise<DiscoveryRecord> {
    return this.#discovery.discover(actor, accountId);
  }

  /** "Check now" from a mission: its creator asks the account's service what is there. */
  checkForMission(
    actor: Actor,
    missionId: string,
    accountId: string,
  ): Promise<MissionResourceCheck> {
    return this.#discovery.checkForMission(actor, missionId, accountId);
  }

  /** The automatic refresh of an account, scheduled or when its page opens. */
  refreshOnItsOwn(
    accountId: string,
    cause: AutomaticRefreshCause,
  ): Promise<AutomaticRefresh | null> {
    return this.#discovery.refreshOnItsOwn(accountId, cause);
  }

  /** The discovery after a call that created a resource at the service. */
  discoverAfterCall(
    accountId: string,
    cause: DiscoveryAfterCallCause,
    createdRefs: readonly string[] = [],
  ): Promise<AfterCallDiscovery | null> {
    return this.#discovery.discoverAfterCall(accountId, cause, createdRefs);
  }

  /** The audit entry of a discovery after a call, once its attempts are over. */
  auditDiscoveryAfterCall(
    accountId: string,
    cause: DiscoveryAfterCallCause & { readonly userId: string },
    outcome: AfterCallDiscovery & { readonly attempts: number },
  ): Promise<void> {
    return this.#discovery.auditDiscoveryAfterCall(accountId, cause, outcome);
  }

  /** The URL the service sends the browser back to — always on `public_url`. */
  callbackUrl(serviceId: string): URL {
    return new URL(
      `${CONNECT_CALLBACK_PATH}/${encodeURIComponent(serviceId)}`,
      this.deps.publicUrl,
    );
  }

  // ── Services and reads: account-reads.ts ─────────────────────────────────

  /** Every registered plugin, in registry order. */
  services(): Promise<ConnectableService[]> {
    return this.#reads.services();
  }

  service(serviceId: string): Promise<ConnectableService | null> {
    return this.#reads.service(serviceId);
  }

  /** The accounts the actor owns, directly or through a group they belong to now. */
  listFor(actor: Actor): Promise<AccountView[]> {
    return this.#reads.listFor(actor);
  }

  get(actor: Actor, accountId: string): Promise<AccountDetail> {
    return this.#reads.get(actor, accountId);
  }

  /** The environment labels of the service's catalog: what a default may be. */
  defaultEnvChoices(serviceId: string): string[] {
    return this.#reads.defaultEnvChoices(serviceId);
  }

  /** Operator: the accounts nobody owns any more (`unowned`, or expired with an empty owner group). */
  listOwnerless(): Promise<AccountView[]> {
    return this.#reads.listOwnerless();
  }

  /** What the plugin of an account says about withdrawing its grant, with the service's label. */
  serviceGrantOf(
    account: Pick<AccountRecord, 'service'> & Partial<Pick<AccountRecord, 'metadata'>>,
  ): {
    readonly serviceLabel: string;
    readonly grant: ServiceGrantView;
  } {
    return this.#reads.serviceGrantOf(account);
  }

  // ── Connect: connect.ts ───────────────────────────────────────────────────

  start(actor: Actor, serviceId: string, input: StartInput = {}): Promise<StartResult> {
    return this.#connect.start(actor, serviceId, input);
  }

  /** The service's callback: the pending flow its `state` names, completed. */
  complete(actor: Actor, serviceId: string, query: URLSearchParams): Promise<Connected> {
    return this.#connect.complete(actor, serviceId, query);
  }

  /** An account from a key taken from the v4 SaaS (docs/handbook/import-from-v4.md). */
  importPastedKey(actor: Actor, serviceId: string, input: ImportPastedInput): Promise<Connected> {
    return this.#connect.importPastedKey(actor, serviceId, input);
  }

  /** An `ssh-key` account from a key pair taken from v4, already installed at the host. */
  importSshKey(actor: Actor, input: ImportSshInput): Promise<Connected> {
    return this.#connect.importSshKey(actor, input);
  }

  // ── Owner edits: account-settings.ts ──────────────────────────────────────

  updateResource(
    actor: Actor,
    accountId: string,
    resourceId: string,
    patch: ResourcePatch,
  ): Promise<AccountResourceRecord> {
    return this.#settings.updateResource(actor, accountId, resourceId, patch);
  }

  /** The owner's default environment for the account's unlabelled resources. */
  setDefaultEnv(actor: Actor, accountId: string, raw: string): Promise<AccountRecord> {
    return this.#settings.setDefaultEnv(actor, accountId, raw);
  }

  /** The owner's name for the account. */
  rename(actor: Actor, accountId: string, raw: string): Promise<AccountRecord> {
    return this.#settings.rename(actor, accountId, raw);
  }

  // ── Revoke and ownership: ownership.ts ────────────────────────────────────

  /** Terminal: the credential erased, the grant withdrawn at the service when it says how. */
  revoke(actor: Actor, accountId: string): Promise<AccountRecord> {
    return this.#ownership.revoke(actor, accountId);
  }

  /** The groups the actor may hand this account to. */
  transferTargets(actor: Actor, account: AccountRecord): GroupRecord[] {
    return this.#ownership.transferTargets(actor, account);
  }

  /** Transfers ownership to a group the actor belongs to (spec §7.2). */
  transfer(actor: Actor, accountId: string, groupId: string): Promise<AccountRecord> {
    return this.#ownership.transfer(actor, accountId, groupId);
  }

  /** Operator only: gives an ownerless account a new owner. */
  reassign(operatorId: string, accountId: string, newOwner: NewOwner): Promise<AccountRecord> {
    return this.#ownership.reassign(operatorId, accountId, newOwner);
  }

  /** Operator: the groups `reassign` would accept as the new owner. */
  reassignTargets(): Promise<GroupRecord[]> {
    return this.#ownership.reassignTargets();
  }

  // ── Shared by the use cases ───────────────────────────────────────────────

  owns(actor: Actor, account: AccountRecord): boolean {
    return account.owner.kind === 'user'
      ? account.owner.id === actor.user.id
      : actor.groups.some((g) => g.id === account.owner.id);
  }

  /** An account of another owner is reported exactly like a missing one. */
  async requireOwned(actor: Actor, accountId: string): Promise<AccountRecord> {
    const account = await this.deps.store.accounts.getById(accountId);
    if (!account || !this.owns(actor, account)) throw new ConnectError('not-found');
    return account;
  }

  nowIso(): string {
    return toIso(this.deps.clock.now());
  }
}

/** The plugin-facing `Resource` of a stored row (what `classify` and `execute` receive). */

export function toPluginResource(service: string, record: AccountResourceRecord): Resource {
  return {
    service,
    ref: record.ref,
    env: record.env,
    displayName: record.displayName,
    ...(record.metadata ? { metadata: record.metadata } : {}),
  };
}
