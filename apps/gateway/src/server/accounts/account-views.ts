/**
 * What the account service takes and returns: its inputs, results and the views the pages and
 * the API read (`service.ts` re-exports every one). Types only.
 */
import type { CredentialKind } from '@vaubaan/shared';
import type {
  CredentialAlternative,
  CredentialField,
  GuideStep,
  PluginRegistry,
  ResourceNoun,
  ServiceIcon,
  TokenExpiry,
  TokenPermission,
  TokenPermissionAccess,
  TokenReach,
} from '@vaubaan/plugin-sdk';
import type { AuditWriter } from '@vaubaan/gateway-core';
import type { MissionGrounds } from '../authority';
import type { RateLimiter } from '../compose/ports';
import type { CeilingCheck } from '../limits';
import type { Logger } from '../logging';
import type { ResourceMoveReason, Store } from '../store';
import type { Clock } from '../store/clock';
import type { AccountRecord, AccountResourceRecord, GroupRecord, UserRecord } from '../store/types';
import type { CredentialBroker } from './credentials';
import type { OAuth2Clients } from './oauth2-clients';
import type { OAuthBrokers } from './oauth-broker';
import type { StoredCredentialKind } from './mapping';
import type { PendingConnectStore } from './pending';
import type { SshKeyPair } from './ssh-keypair';
import type { FutureResources } from './future-resources';

/**
 * The human behind a request, with their *current* groups (never a snapshot):
 * what an act on an account is checked against. Not a `Subject` (authority),
 * which is trusted by id only and reads nothing else from the caller.
 */
export interface Actor {
  readonly user: UserRecord;
  readonly groups: readonly GroupRecord[];
}

/**
 * One permission to tick at the service and its access. The tools it serves
 * stay in the plugin's declaration (coverage), not on the connect page.
 */
export interface TokenPermissionView {
  readonly name: string;
  readonly access: TokenPermissionAccess;
}

/**
 * A screenshot under a step: where the page loads it from (`connectFileUrl`), what it
 * shows, and the provenance line derived from its declaration (`screenshotAttribution`).
 */
export interface GuideFigureView {
  readonly url: string;
  readonly alt: string;
  readonly attribution: string;
}

/** A step of the guide as the connect page draws it: the plugin's step and its figure. */
export interface GuideStepView extends GuideStep {
  /** `null` when the step names no screenshot. */
  readonly figure: GuideFigureView | null;
}

/** How to create the token by hand, read from the plugin's declaration. */
export interface TokenGuideView {
  readonly steps: readonly GuideStepView[];
  readonly reach: TokenReach;
  readonly permissions: readonly TokenPermissionView[];
  readonly expiry: TokenExpiry;
  readonly docsUrl: string;
}

/** An alternative of the key, its steps with their figures. */
export interface AlternativeView extends CredentialAlternative {
  readonly steps: readonly GuideStepView[];
}

/**
 * A service as the connect page shows it: its one way of connecting, read
 * from the plugin's declaration, and whether it can be used now.
 */
export interface ConnectableService {
  readonly id: string;
  readonly displayName: string;
  readonly description: string | null;
  /** The service's mark, path and colour (`serviceIconOf`); `null` when the plugin declares no icon. */
  readonly icon: ServiceIcon | null;
  /** What one resource of this service is called (`resourceNounOf`): "board" / "boards". */
  readonly resource_noun: ResourceNoun;
  readonly kind: CredentialKind;
  /**
   * The service signs the person in itself (`oauth2`): the connect page sends
   * them there and they come back, through an OAuth client the gateway
   * registers itself, so nobody declares anything before connecting. False
   * for a key pasted or generated here.
   */
  readonly redirects: boolean;
  /** The service's `oauth2` client is an OAuth broker's (ADR google-calendar-through-an-oauth-broker). */
  readonly viaBroker: boolean;
  /**
   * The broker that serves it is attested (ADR
   * oauth-broker-stateless-in-an-attested-enclave D4): false when the
   * configuration declares it `attestation: none`; `null` when the service
   * takes no broker or none is configured.
   */
  readonly brokerAttested: boolean | null;
  /**
   * The service's client is Vaubaan's installed-app client on this computer (local mode;
   * ADR local-instance-carries-installed-oauth-clients): its consent opens in the default
   * browser of the desktop app, and the page finishes the connection by itself.
   */
  readonly viaInstalledClient: boolean;
  /** The fields of the connect form (`api-key`, `ssh-key`); empty for the redirect flow. */
  readonly fields: readonly CredentialField[];
  /** The shapes the key comes in, one chosen at connect (`api-key`); empty when it has one. */
  readonly alternatives: readonly AlternativeView[];
  /** Where the user creates the key (`api-key`). */
  readonly createUrl: string | null;
  /** What the person creates, in the service's words (`api-key`): "fine-grained personal access token". */
  readonly label: string | null;
  readonly guide: TokenGuideView | null;
  /**
   * Why the service cannot be connected on this instance, in a person's words;
   * `null` when it can. Today: an OAuth broker the plugin needs is not
   * configured (ADR google-calendar-through-an-oauth-broker D1).
   */
  readonly unavailable: string | null;
}

export interface DiscoveryRecord {
  readonly at: string;
  readonly ok: boolean;
  readonly count: number;
  /** The service's (or the plugin's) own message when the discovery failed. */
  readonly error: string | null;
  /**
   * Set when the gateway ran this discovery itself, after a call that created a
   * resource (ADR created-resources-join-the-mission): the tool and its
   * mission. `null` for a discovery a person ran (connect, "Refresh").
   */
  readonly afterCall: DiscoveryAfterCallCause | null;
}

/** The successful call a discovery the gateway ran itself follows. */
export interface DiscoveryAfterCallCause {
  readonly missionId: string;
  readonly tool: string;
}

/** What the gateway's own discovery after a creating call did. */
export interface AfterCallDiscovery {
  readonly record: DiscoveryRecord;
  /** Refs discovery returned that the account did not list before (or listed as stale). */
  readonly added: number;
  /**
   * How many of the refs the call created (`createdResources`, already recorded on the
   * account) this discovery did not return yet; 0 when the call named none (ADR
   * created-resources-join-the-mission).
   */
  readonly missing: number;
}

/** Who asked for a refresh the gateway ran on its own (`AccountRefresher`). */
export type AutomaticRefreshCause = 'scheduled' | 'on-open';

/** What a refresh the gateway ran on its own did. */
export interface AutomaticRefresh {
  readonly record: DiscoveryRecord;
  /** Resources the account did not list before (or listed as stale). */
  readonly added: number;
  /** Resources it listed that the service no longer returns (now stale). */
  readonly removed: number;
  /** What the key may do, who it acts as or until when, as the service says it now. */
  readonly rightsChanged: boolean;
  /** The service rejected the key: the account now needs reconnecting. */
  readonly expired: boolean;
  /** Any of the above: audited, and a page that asked reads the account again. */
  readonly changed: boolean;
}

/**
 * What revoking an account does to the grant at its service — said before
 * the act (the confirmation) and after it (the revoked account's page).
 */
export interface ServiceGrantView {
  /** True when the gateway asks the service to withdraw the grant on revocation. */
  readonly withdrawnByGateway: boolean;
  /** Where the person removes the grant themselves; `null` when the plugin gives no sentence. */
  readonly byHand: string | null;
}

export interface AccountView {
  readonly account: AccountRecord;
  readonly service_label: string;
  /** What one resource of this service is called (`resourceNounOf`); the fallback when the plugin is gone. */
  readonly resource_noun: ResourceNoun;
  /** The service's mark, path and colour (`serviceIconOf`); `null` when the plugin declares no icon or is gone. */
  readonly service_icon: ServiceIcon | null;
  readonly service_grant: ServiceGrantView;
  /** How this account was made (`accountCredentialKind`); `null` when unknown and the plugin is gone. */
  readonly credential_kind: StoredCredentialKind | null;
  /**
   * The account was made a way its plugin no longer declares (`isRetiredWay`):
   * it runs nothing until its owner reconnects it.
   */
  readonly way_retired: boolean;
  /** What the service said the pasted token acts as, at connect time (`octocat`); `null` when not said. */
  readonly token_account: string | null;
  /**
   * The OAuth broker a brokered account was made through, and whether it is
   * attested (false: declared `attestation: none`; ADR
   * oauth-broker-stateless-in-an-attested-enclave D4). `null` for any other
   * account, or when the broker is no longer configured (`attested` unknown).
   */
  readonly oauth_broker: {
    readonly name: string;
    readonly attested: boolean | null;
    /** Vaubaan's installed-app client on this computer, not a broker (local mode). */
    readonly installed: boolean;
  } | null;
  /** When the pasted token stops working, as the service said at connect time; `null` when it did not. */
  readonly token_expires_at: string | null;
  /**
   * The permissions of the plugin's guide the pasted token does not hold, as the
   * service confirmed at connect time (`CredentialCheck.granted`): empty when it holds
   * them all, `null` when the service could not say.
   */
  readonly token_lacks: readonly TokenPermission[] | null;
  readonly owner_label: string;
  /** `ssh-key`: the line to append to `authorized_keys`. */
  readonly public_key: string | null;
  /** Non-secret values the user entered (team id, host, user…). */
  readonly fields: Readonly<Record<string, string>>;
  readonly discovery: DiscoveryRecord | null;
}

export interface AccountDetail extends AccountView {
  /** Each with its effective label: its own, else the account's `defaultEnv`. */
  readonly resources: readonly AccountResourceRecord[];
  /**
   * The labels the owner may choose as the default environment for unlabelled
   * resources (`catalogEnvsOf`); empty when the catalog has no env-scoped risk.
   */
  readonly default_env_choices: readonly string[];
}

export interface StartInput {
  readonly displayName?: string | null;
  /** Where to land afterwards; must resolve inside `public_url`. */
  readonly returnTo?: string | null;
  /** Re-authenticate this account instead of creating one. */
  readonly reconnectId?: string | null;
  /** Form values for `api-key` / `ssh-key`. */
  readonly fields?: Readonly<Record<string, string>>;
  /**
   * The `CredentialAlternative` the person chose (the form's radio); absent,
   * the one whose own fields hold a value (`chooseAlternative`).
   */
  readonly alternative?: string | null;
}

export interface Connected {
  readonly account: AccountRecord;
  readonly discovery: DiscoveryRecord | null;
  readonly reconnected: boolean;
  readonly returnTo: string | null;
}

export type StartResult =
  | { readonly kind: 'redirect'; readonly url: string }
  | ({ readonly kind: 'connected' } & Connected);

export interface ResourcePatch {
  /** Blank hands the name back to discovery. */
  readonly displayName?: string;
  /** Blank clears the label. Refused when the plugin sets it. */
  readonly env?: string;
  readonly hidden?: boolean;
  /** Raw list text per editable metadata key. */
  readonly metadata?: Readonly<Record<string, string>>;
}

/**
 * Where an imported account came from, kept in its metadata
 * (`imported_from`): the system, the v4 organization and the v4 row.
 */
export interface ImportedFrom {
  readonly system: 'vaubaan-v4';
  readonly org: string;
  readonly source: string;
}

export interface ImportPastedInput {
  readonly displayName: string;
  /** The values of the plugin's `api-key` form, by field name. */
  readonly fields: Readonly<Record<string, string>>;
  readonly importedFrom: ImportedFrom;
}

export interface ImportSshInput {
  readonly serviceId: string;
  readonly displayName: string;
  /** host, port, user, host_key_fingerprint: the plugin's `ssh-key` form. */
  readonly fields: Readonly<Record<string, string>>;
  readonly keyPair: SshKeyPair;
  readonly importedFrom: ImportedFrom;
}

/** Who the operator hands an ownerless account to: a user by email, or a group. */
export type NewOwner =
  | { readonly kind: 'user'; readonly email: string }
  | { readonly kind: 'group'; readonly groupId: string };

export interface AccountServiceDeps {
  /** The repositories the service reads and writes; never the raw handle. */
  readonly store: Pick<Store, 'accounts' | 'users' | 'groups' | 'missions'>;
  readonly registry: PluginRegistry;
  /** The OAuth client of an `oauth2` service, registered by the gateway. */
  readonly clients: OAuth2Clients;
  /** The OAuth brokers the instance is enrolled with, for a brokered `oauth2` service. */
  readonly brokers: Pick<OAuthBrokers, 'forProvider' | 'byName'>;
  readonly broker: CredentialBroker;
  /** Re-checks the missions of an account after an act that may have removed an authority. */
  readonly grounds: Pick<MissionGrounds, 'watchAccount'>;
  readonly pending: PendingConnectStore;
  readonly rateLimiter: RateLimiter;
  readonly audit: AuditWriter;
  readonly publicUrl: URL;
  readonly fetch: typeof fetch;
  readonly clock: Clock;
  readonly logger: Logger;
  /**
   * The `limits.accounts` ceiling (spec §4.3 bis): asked before a connect flow
   * reaches the service and again before a new account is stored; never for a
   * reconnection. Absent: no ceiling.
   */
  readonly ceilings?: CeilingCheck;
  /**
   * Brings the running missions' future resources in line after a discovery, a
   * relabel or a change of the default environment (ADR
   * resource-set-is-one-environment-with-optional-future-resources). Absent: nothing
   * joins or leaves a mission (tests of the connect flows alone).
   */
  readonly futureResources?: Pick<FutureResources, 'snapshot' | 'settle'>;
}

/** What "check now" on a mission found (`AccountService.checkForMission`). */
export interface MissionResourceCheck {
  readonly account_id: string;
  readonly discovery: DiscoveryRecord;
  /** When discovery last ran on the account: this one. */
  readonly last_checked_at: string;
  /** What joined or left the sets of THIS mission, by set; other missions are audited only. */
  readonly joined: readonly MissionResourceMoves[];
  readonly left: readonly MissionResourceMoves[];
}

export interface MissionResourceMoves {
  readonly resource_set_id: string;
  readonly refs: readonly string[];
  readonly reason: ResourceMoveReason;
}
