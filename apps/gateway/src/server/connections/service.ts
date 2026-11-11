/**
 * Connections (spec §0 "Connection", "Resource"; §2.3 states; §7.2).
 *
 * One generic driver over the three `CredentialSpec` kinds — the plugin
 * declares one way of connecting, the host runs the flow (ADR
 * one-place-to-authorize-services-token-first):
 *
 *   api-key      start(): the form values, checked at paste and by a first discovery
 *   oauth2       start(): authorization redirect with a single-use `state` and PKCE
 *                complete(): code exchange with the OAuth client the gateway
 *                registered at the service itself (`OAuth2Clients`) — or, for a
 *                brokered spec, `POST /flows` at the OAuth broker, then the
 *                one-time grant redeemed there (`OAuthBrokers`; ADR
 *                google-calendar-through-an-oauth-broker)
 *   ssh-key      start(): an ed25519 key pair generated here, public key shown
 *
 * A connection is created under the name of the user who connected it. An
 * owner may transfer it to a group they belong to (`transfer`); when that
 * group empties the connection is `unowned` and the operator hands it to a new
 * owner (`reassign`, the operator's only act on the domain — spec §2.3). Its
 * credential is the serialized `CredentialSecret`, sealed by the store with
 * the connection id as associated data. Resources are discovered by the
 * plugin at connect time and merged by `syncDiscoveredResources`, which
 * never overwrites an owner edit and never deletes a row.
 */
import { type CredentialKind, isUpstreamAuthError, UpstreamAuthError } from '@vaubaan/shared';
import {
  type ApiKeyCredentialSpec,
  type ConnectionContext,
  type CredentialCheck,
  type CredentialAlternative,
  type CredentialField,
  type CredentialSecret,
  type GuideStep,
  isBrokeredSpec,
  type OAuth2BrokeredSpec,
  type OAuth2RegisteredClientSpec,
  type PluginRegistry,
  type ProviderPlugin,
  type Resource,
  type ResourceNoun,
  type ServiceIcon,
  type SshKeyCredentialSpec,
  type TokenExpiry,
  type TokenPermission,
  type TokenPermissionAccess,
  type TokenReach,
  serviceIconOf,
} from '@vaubaan/plugin-sdk';
import { DISCOVERY_ACTOR_ID, type AuditWriter } from '@vaubaan/gateway-core';

import { findActiveUserByEmail, type MissionGrounds } from '../authority';
import type { RateLimiter } from '../compose/ports';
import type { CeilingCheck } from '../limits';
import type { Logger } from '../logging';
import { catalogEnvsOf } from '../../lib/missions/catalog-view';
import { resourceNounOf } from '../../lib/providers/resource-noun';
import type { ResourceMove, ResourceMoveReason, Store } from '../store';
import { ownResourceEnv } from '../store/resource-env';
import { toIso, type Clock } from '../store/clock';
import type {
  ConnectionRecord,
  ConnectionResourceRecord,
  GroupRecord,
  Principal,
  UserRecord,
} from '../store/types';
import { serializeSecret } from './credential-codec';
import type { CredentialBroker, ResolvedCredential } from './credentials';
import { canWithdraw } from './credentials';
import { ConnectError } from './errors';
import { providerFailureReason } from './failure-reason';
import { grantedNames, tokenLacks } from './token-permissions';
import {
  cleanName,
  usableResourcesOf,
  editableMetadataKeys,
  parseEnvLabel,
  parseListValue,
  readCredentialForm,
  resolveReturnTo,
  type FieldValues,
  type FormFields,
} from './input';
import {
  buildAuthorizationUrl,
  exchangeCode,
  newCodeVerifier,
  OAuth2RegistrationError,
  OAuth2TokenError,
  type OAuth2Client,
} from './oauth2';
import { OAuth2ClientMissing, type OAuth2Clients } from './oauth2-clients';
import {
  brokerNotConfiguredReason,
  OAuthBrokerError,
  type OAuthBrokerClient,
  type OAuthBrokers,
} from './oauth-broker';
import type { BrokerGrant } from './credential-codec';
import {
  connectionCredentialKind,
  connectionOwnerOf,
  connectionPublicFields,
  isRetiredWay,
  retiredWayReason,
  type StoredCredentialKind,
} from './mapping';
import type { PendingConnect, PendingConnectStore, PendingFlowKind } from './pending';
import { generateEd25519KeyPair, type SshKeyPair } from './ssh-keypair';
import type { FutureResources } from './future-resources';

/** An OAuth `error` code is a token of the protocol (RFC 6749 §4.1.2.1), never free text. */
const PROTOCOL_ERROR_CODE = /^[a-z_]{1,40}$/;

/** Connect attempts (starts, callbacks, form posts) one user may make per window. */
export const CONNECT_RATE_LIMIT = 10;
export const CONNECT_RATE_WINDOW_MS = 60_000;
/** A discovery that does not finish within this delay is reported as failed. */
export const DISCOVERY_TIMEOUT_MS = 30_000;
/** "Check now" on mission cards: this many discoveries per user per window. */
export const CHECK_NOW_RATE_LIMIT = 10;
export const CHECK_NOW_RATE_WINDOW_MS = 60_000;
/** The pages of the accounts a person can use ("connections" in the spec and the store). */
export const CONNECTIONS_PATH = '/accounts';
/**
 * Where a provider sends the browser back after an authorization. This path is
 * registered at the provider (the redirect URI of the company's OAuth client):
 * it is part of the protocol, so it kept its name when the pages moved to
 * `/accounts`.
 */
export const CONNECT_CALLBACK_PATH = '/connections/callback';
const SSH_KEY_COMMENT = 'vaubaan-gateway';

/**
 * The human behind a request, with their *current* groups (never a snapshot):
 * what an act on a connection is checked against. Not a `Subject` (authority),
 * which is trusted by id only and reads nothing else from the caller.
 */
export interface Actor {
  readonly user: UserRecord;
  readonly groups: readonly GroupRecord[];
}

/** A tool of the plugin, as a person reads it: its title and its name. */
export interface ToolLabel {
  readonly name: string;
  /** The plugin's title (`Merge a pull request`), or the name when it has none. */
  readonly title: string;
}

/** One permission to tick at the provider, with the tools it serves. */
export interface TokenPermissionView {
  readonly name: string;
  readonly access: TokenPermissionAccess;
  readonly tools: readonly ToolLabel[];
}

/** How to create the token by hand, read from the plugin's declaration. */
export interface TokenGuideView {
  readonly steps: readonly GuideStep[];
  readonly reach: TokenReach;
  readonly permissions: readonly TokenPermissionView[];
  readonly expiry: TokenExpiry;
  readonly docsUrl: string;
}

/**
 * A service as the connect page shows it: its one way of connecting, read
 * from the plugin's declaration, and whether it can be used now.
 */
export interface ConnectableProvider {
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
  /** The fields of the connect form (`api-key`, `ssh-key`); empty for the redirect flow. */
  readonly fields: readonly CredentialField[];
  /** The shapes the key comes in, one chosen at connect (`api-key`); empty when it has one. */
  readonly alternatives: readonly CredentialAlternative[];
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
  /** The provider's (or the plugin's) own message when the discovery failed. */
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
  /** Refs discovery returned that the connection did not list before (or listed as stale). */
  readonly added: number;
  /**
   * How many of the refs the call created (`createdResources`, already recorded on the
   * connection) this discovery did not return yet; 0 when the call named none (ADR
   * created-resources-join-the-mission).
   */
  readonly missing: number;
}

/**
 * What revoking a connection does to the grant at its provider — said before
 * the act (the confirmation) and after it (the revoked connection's page).
 */
export interface ProviderGrantView {
  /** True when the gateway asks the provider to withdraw the grant on revocation. */
  readonly withdrawnByGateway: boolean;
  /** Where the person removes the grant themselves; `null` when the plugin gives no sentence. */
  readonly byHand: string | null;
}

export interface ConnectionView {
  readonly connection: ConnectionRecord;
  readonly provider_label: string;
  /** What one resource of this provider is called (`resourceNounOf`); the fallback when the plugin is gone. */
  readonly resource_noun: ResourceNoun;
  /** The service's mark, path and colour (`serviceIconOf`); `null` when the plugin declares no icon or is gone. */
  readonly provider_icon: ServiceIcon | null;
  readonly provider_grant: ProviderGrantView;
  /** How this account was made (`connectionCredentialKind`); `null` when unknown and the plugin is gone. */
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
  readonly oauth_broker: { readonly name: string; readonly attested: boolean | null } | null;
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

export interface ConnectionDetail extends ConnectionView {
  /** Each with its effective label: its own, else the connection's `defaultEnv`. */
  readonly resources: readonly ConnectionResourceRecord[];
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
  /** Re-authenticate this connection instead of creating one. */
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
  readonly connection: ConnectionRecord;
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
 * Where an imported connection came from, kept in its metadata
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
  readonly providerId: string;
  readonly displayName: string;
  /** host, port, user, host_key_fingerprint: the plugin's `ssh-key` form. */
  readonly fields: Readonly<Record<string, string>>;
  readonly keyPair: SshKeyPair;
  readonly importedFrom: ImportedFrom;
}

/** Who the operator hands an ownerless connection to: a user by email, or a group. */
export type NewOwner =
  | { readonly kind: 'user'; readonly email: string }
  | { readonly kind: 'group'; readonly groupId: string };

/**
 * Why this connection takes no owner act (share, transfer, reconnect), or `null` when it
 * does (spec §2.3): revocation is final, and nobody acts on a connection without owner
 * until the operator reassigns one. The one statement of the rule: the service's own
 * refusals, the shares service and the pages (through `transferTargets` and
 * `ShareContext.unshareable`) all read it here.
 */
export function ownerActRefusal(
  connection: Pick<ConnectionRecord, 'status'>,
): 'connection-revoked' | 'connection-unowned' | null {
  if (connection.status === 'revoked') return 'connection-revoked';
  if (connection.status === 'unowned') return 'connection-unowned';
  return null;
}

export interface ConnectionServiceDeps {
  /** The repositories the service reads and writes; never the raw handle. */
  readonly store: Pick<Store, 'connections' | 'users' | 'groups' | 'missions'>;
  readonly registry: PluginRegistry;
  /** The OAuth client of an `oauth2` service, registered by the gateway. */
  readonly clients: OAuth2Clients;
  /** The OAuth brokers the instance is enrolled with, for a brokered `oauth2` service. */
  readonly brokers: Pick<OAuthBrokers, 'forProvider' | 'byName'>;
  readonly broker: CredentialBroker;
  /** Re-checks the missions of a connection after an act that may have removed an authority. */
  readonly grounds: Pick<MissionGrounds, 'watchConnection'>;
  readonly pending: PendingConnectStore;
  readonly rateLimiter: RateLimiter;
  readonly audit: AuditWriter;
  readonly publicUrl: URL;
  readonly fetch: typeof fetch;
  readonly clock: Clock;
  readonly logger: Logger;
  /**
   * The `limits.connections` ceiling (spec §4.3 bis): asked before a connect flow
   * reaches the provider and again before a new connection is stored; never for a
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

/** What "check now" on a mission found (`ConnectionService.checkForMission`). */
export interface MissionResourceCheck {
  readonly connection_id: string;
  readonly discovery: DiscoveryRecord;
  /** When discovery last ran on the connection: this one. */
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

/** How a failed first discovery is treated when a credential has just been obtained. */
type DiscoveryPolicy =
  /** Any failure refuses the connection: the user can simply retry (api-key form). */
  | 'required'
  /** The credential is kept whatever happens: the authorization code is spent. */
  | 'best-effort'
  /** Not attempted: the public key is not installed yet (ssh-key). */
  | 'deferred';

/** What every credential kind needs to start a flow, resolved once by `start`. */
interface FlowStart {
  readonly actor: Actor;
  readonly plugin: ProviderPlugin;
  readonly displayName: string;
  readonly returnTo: string | null;
  /** The connection being re-authenticated, already checked as reconnectable. */
  readonly reconnectId: string | null;
}

/** What `finalize` stores once a credential has been obtained. */
interface FinalizeOptions {
  readonly displayName: string;
  readonly reconnectId: string | null;
  readonly returnTo: string | null;
  readonly discovery: DiscoveryPolicy;
  readonly metadata: Record<string, unknown>;
  /** When the credential stops working, as the provider said; else an OAuth token's own expiry. */
  readonly expiresAt?: string | null;
  /** The OAuth broker's grant of a brokered connection, sealed beside the secret. */
  readonly brokerGrant?: BrokerGrant | null;
}

/** The outcome of the discovery attempted before the connection is written. */
interface FirstDiscovery {
  /** `null` when the discovery was deferred or failed. */
  readonly resources: readonly Resource[] | null;
  /** The failure a `best-effort` policy tolerated, recorded on the connection. */
  readonly error: string | null;
}

export class ConnectionService {
  constructor(private readonly deps: ConnectionServiceDeps) {}

  /** The URL the provider sends the browser back to — always on `public_url`. */
  callbackUrl(providerId: string): URL {
    return new URL(
      `${CONNECT_CALLBACK_PATH}/${encodeURIComponent(providerId)}`,
      this.deps.publicUrl,
    );
  }

  // ── Providers ─────────────────────────────────────────────────────────────

  /** Every registered plugin, in registry order. */
  async providers(): Promise<ConnectableProvider[]> {
    return Promise.all(this.deps.registry.ids.map((id) => this.describe(id)));
  }

  async provider(providerId: string): Promise<ConnectableProvider | null> {
    return this.deps.registry.has(providerId) ? this.describe(providerId) : null;
  }

  private async describe(providerId: string): Promise<ConnectableProvider> {
    const { plugin } = this.deps.registry.require(providerId);
    const spec = plugin.credential;
    const guide = spec.kind === 'api-key' ? spec.guide : undefined;
    return {
      id: plugin.id,
      displayName: plugin.displayName,
      description: plugin.description ?? null,
      icon: serviceIconOf(plugin),
      resource_noun: resourceNounOf(plugin),
      kind: spec.kind,
      redirects: spec.kind === 'oauth2',
      viaBroker: spec.kind === 'oauth2' && isBrokeredSpec(spec),
      brokerAttested:
        spec.kind === 'oauth2' && isBrokeredSpec(spec)
          ? (this.deps.brokers.forProvider(spec.broker.provider)?.attested ?? null)
          : null,
      fields: spec.kind === 'api-key' || spec.kind === 'ssh-key' ? spec.fields : [],
      alternatives: spec.kind === 'api-key' ? (spec.alternatives ?? []) : [],
      createUrl: spec.kind === 'api-key' ? (spec.createUrl ?? null) : null,
      label: spec.kind === 'api-key' ? (spec.label ?? null) : null,
      guide: guide
        ? {
            steps: guide.steps,
            reach: guide.reach,
            permissions: guide.permissions.map((p) => ({
              name: p.name,
              access: p.access,
              tools: p.tools.map((tool) => toolLabel(plugin, tool)),
            })),
            expiry: guide.expiry,
            docsUrl: guide.docsUrl,
          }
        : null,
      unavailable: this.unavailableReason(plugin),
    };
  }

  /** Why a plugin cannot be connected here, or `null`: a broker it needs is not configured. */
  private unavailableReason(plugin: ProviderPlugin): string | null {
    const spec = plugin.credential;
    if (spec.kind !== 'oauth2' || !isBrokeredSpec(spec)) return null;
    return this.deps.brokers.forProvider(spec.broker.provider)
      ? null
      : brokerNotConfiguredReason(plugin.displayName, spec.broker.provider);
  }

  // ── Reads ─────────────────────────────────────────────────────────────────

  /** The connections the actor owns, directly or through a group they belong to now. */
  async listFor(actor: Actor): Promise<ConnectionView[]> {
    const owned = await this.deps.store.connections.listOwnedBy([
      { kind: 'user', id: actor.user.id },
      ...actor.groups.map((g) => ({ kind: 'group' as const, id: g.id })),
    ]);
    return Promise.all(owned.map((c) => this.view(c)));
  }

  async get(actor: Actor, connectionId: string): Promise<ConnectionDetail> {
    const connection = await this.requireOwned(actor, connectionId);
    return {
      ...(await this.view(connection)),
      resources: await this.deps.store.connections.listResources(connection.id),
      default_env_choices: this.defaultEnvChoices(connection.provider),
    };
  }

  /** The environment labels of the provider's catalog: what a default may be. */
  defaultEnvChoices(providerId: string): string[] {
    const registered = this.deps.registry.get(providerId);
    return registered ? catalogEnvsOf(registered.plugin.catalog) : [];
  }

  // ── Connect ───────────────────────────────────────────────────────────────

  async start(actor: Actor, providerId: string, input: StartInput = {}): Promise<StartResult> {
    await this.limit(actor);
    const plugin = this.requirePlugin(providerId);
    const returnTo = this.returnToOf(input.returnTo);
    const reconnect = input.reconnectId
      ? await this.requireReconnectable(actor, input.reconnectId, providerId)
      : null;
    // Before the provider is reached: a refused flow spends no authorization code.
    if (!reconnect) await this.refuseAtCeiling();
    const flow: FlowStart = {
      actor,
      plugin,
      displayName: cleanName(input.displayName) ?? reconnect?.displayName ?? plugin.displayName,
      returnTo,
      reconnectId: reconnect?.id ?? null,
    };
    const spec = plugin.credential;

    switch (spec.kind) {
      case 'oauth2':
        return isBrokeredSpec(spec) ? this.startBrokered(flow, spec) : this.startOAuth2(flow, spec);
      case 'api-key':
        return this.connectWithApiKey(flow, spec, input);
      case 'ssh-key':
        return this.connectWithSshKey(flow, spec, input);
    }
  }

  private async startOAuth2(
    flow: FlowStart,
    spec: OAuth2RegisteredClientSpec,
  ): Promise<StartResult> {
    const pending = this.newPending('oauth2', flow, spec.pkce ? newCodeVerifier() : null);
    const client = await this.clientOrThrow(flow.plugin, () =>
      this.deps.clients.forAuthorization(flow.plugin, spec, pending.redirectUri),
    );
    const state = await this.deps.pending.create(pending);
    const url = buildAuthorizationUrl(spec, client, {
      redirectUri: pending.redirectUri,
      state,
      codeVerifier: pending.codeVerifier,
    });
    return { kind: 'redirect', url: url.href };
  }

  /**
   * A brokered flow (ADR google-calendar-through-an-oauth-broker D2): the
   * broker that serves the plugin's provider answers `POST /flows` with the
   * provider's page; the S256 PKCE verifier and the broker's name stay in the
   * pending flow, whose `state` the browser brings back with the grant.
   */
  private async startBrokered(flow: FlowStart, spec: OAuth2BrokeredSpec): Promise<StartResult> {
    const broker = this.brokerOrThrow(flow.plugin, spec);
    const pending: PendingConnect = {
      ...this.newPending('oauth2', flow, newCodeVerifier()),
      broker: broker.name,
    };
    const state = await this.deps.pending.create(pending);
    try {
      const url = await broker.startFlow({
        provider: spec.broker.provider,
        scopes: spec.scopes,
        returnUrl: pending.redirectUri,
        state,
        verifier: pending.codeVerifier ?? '',
      });
      return { kind: 'redirect', url: url.href };
    } catch (err) {
      throw this.brokerFailure(flow.plugin, err);
    }
  }

  /** The broker that serves a brokered plugin, or `broker-not-configured`. */
  private brokerOrThrow(plugin: ProviderPlugin, spec: OAuth2BrokeredSpec): OAuthBrokerClient {
    const broker = this.deps.brokers.forProvider(spec.broker.provider);
    if (!broker) {
      throw new ConnectError(
        'broker-not-configured',
        brokerNotConfiguredReason(plugin.displayName, spec.broker.provider),
      );
    }
    return broker;
  }

  /** What the page shows when the broker failed: its failure, never an expiry or the broker's text. */
  private brokerFailure(plugin: ProviderPlugin, err: unknown): unknown {
    if (!(err instanceof OAuthBrokerError)) return err;
    this.deps.logger.warn('OAuth broker call failed', {
      provider: plugin.id,
      broker: err.broker,
      call: err.call,
      upstream_status: err.status,
      code: err.code,
    });
    return new ConnectError(
      err.grantGone ? 'token-exchange-failed' : 'broker-failed',
      `${plugin.displayName}: ${err.message}`,
    );
  }

  private async connectWithApiKey(
    flow: FlowStart,
    spec: ApiKeyCredentialSpec,
    input: StartInput,
  ): Promise<StartResult> {
    const connected = await this.connectPasted(flow, spec, input, {});
    return { kind: 'connected', ...connected };
  }

  /**
   * The form values of an `api-key` way, checked by the plugin's `verify`
   * then by a first discovery, before anything is stored. `extra` is merged
   * into the connection's metadata (the importer's marker).
   */
  private async connectPasted(
    flow: FlowStart,
    spec: ApiKeyCredentialSpec,
    input: StartInput,
    extra: Readonly<Record<string, unknown>>,
  ): Promise<Connected> {
    const read = this.readFormOrThrow(spec, input);
    const secret: CredentialSecret = {
      kind: 'api-key',
      fields: read.values,
      metadata: read.visible,
    };
    const check = await this.verifyPasted(flow.plugin, spec, secret);
    return this.finalize(flow.actor, flow.plugin, secret, {
      displayName: flow.displayName,
      reconnectId: flow.reconnectId,
      returnTo: flow.returnTo,
      discovery: 'required',
      metadata: {
        ...extra,
        fields: read.visible,
        ...(check ? { account: check.account, expires_at: check.expiresAt } : {}),
        // What the service confirmed the token holds; the account page names what it lacks.
        ...(check?.granted ? { granted: check.granted } : {}),
      },
      expiresAt: check?.expiresAt ?? null,
    });
  }

  // ── Import from v4 (docs/handbook/import-from-v4.md) ────────────────

  /**
   * Creates a connection from a key taken from the v4 SaaS, through the same
   * path as a key pasted in the form: the plugin's check, the first
   * discovery (a failure refuses it, nothing is stored), the seal, the
   * `connection-created` entry under `actor`. `importedFrom` is kept in the
   * connection's metadata so a second run recognises it. No connect rate
   * limit: the operator's command is not a web request.
   */
  async importPastedKey(
    actor: Actor,
    providerId: string,
    input: ImportPastedInput,
  ): Promise<Connected> {
    const plugin = this.requirePlugin(providerId);
    const spec = plugin.credential;
    if (spec.kind !== 'api-key') {
      throw new ConnectError('invalid-input', `${plugin.displayName} takes no pasted key`);
    }
    return this.connectPasted(
      this.importFlow(actor, plugin, input.displayName),
      spec,
      { fields: input.fields },
      { imported_from: input.importedFrom },
    );
  }

  /**
   * Creates an `ssh-key` connection with a key pair that already exists
   * (`importEd25519PrivateKey`) instead of a new one: the key is already in
   * the host's `authorized_keys`, so the first discovery runs at once and is
   * the probe — it verifies the pinned host key and the key pair, and a
   * failure refuses the connection.
   */
  async importSshKey(actor: Actor, input: ImportSshInput): Promise<Connected> {
    const plugin = this.requirePlugin(input.providerId);
    const spec = plugin.credential;
    if (spec.kind !== 'ssh-key') {
      throw new ConnectError('invalid-input', `${plugin.displayName} takes no ssh key`);
    }
    const read = this.readFormOrThrow({ fields: spec.fields }, { fields: input.fields });
    const secret: CredentialSecret = {
      kind: 'ssh-key',
      privateKeyPem: input.keyPair.privateKeyPem,
      publicKey: input.keyPair.publicKey,
      fields: read.values,
      metadata: read.visible,
    };
    return this.finalize(actor, plugin, secret, {
      displayName: cleanName(input.displayName) ?? plugin.displayName,
      reconnectId: null,
      returnTo: null,
      discovery: 'required',
      metadata: {
        imported_from: input.importedFrom,
        fields: read.visible,
        public_key: input.keyPair.publicKey,
      },
    });
  }

  private importFlow(actor: Actor, plugin: ProviderPlugin, displayName: string): FlowStart {
    return {
      actor,
      plugin,
      displayName: cleanName(displayName) ?? plugin.displayName,
      returnTo: null,
      reconnectId: null,
    };
  }

  /**
   * Asks the provider about pasted values before anything is stored (the
   * spec's `verify`): who they act as and when they stop working. A
   * rejection, an answer that is not understood or a credential already
   * expired refuses the connection; an unreachable provider says so. `null`
   * when the spec declares no check (the first discovery is then the check).
   */
  private async verifyPasted(
    plugin: ProviderPlugin,
    spec: ApiKeyCredentialSpec,
    secret: CredentialSecret,
  ): Promise<CredentialCheck | null> {
    if (!spec.verify) return null;
    let check: CredentialCheck;
    try {
      check = await spec.verify({
        credential: secret,
        fetch: this.deps.fetch,
        signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
      });
    } catch (err) {
      const rejected = isUpstreamAuthError(err) || !isTransportFailure(err);
      throw new ConnectError(
        rejected ? 'credential-rejected' : 'provider-unreachable',
        `${plugin.displayName}: ${providerFailureReason(err, secret)}`,
      );
    }
    const expiresAt = check.expiresAt === null ? null : Date.parse(check.expiresAt);
    if (expiresAt !== null && !Number.isFinite(expiresAt)) {
      throw new ConnectError(
        'credential-rejected',
        `${plugin.displayName}: the expiry date it gave cannot be read`,
      );
    }
    if (expiresAt !== null && expiresAt <= this.deps.clock.now().getTime()) {
      throw new ConnectError(
        'credential-rejected',
        `${plugin.displayName}: this token expired on ${new Date(expiresAt).toISOString().slice(0, 10)}`,
      );
    }
    return {
      account: cleanName(check.account),
      expiresAt: expiresAt === null ? null : new Date(expiresAt).toISOString(),
      ...(check.granted === undefined ? {} : { granted: grantedNames(check.granted) }),
    };
  }

  private async connectWithSshKey(
    flow: FlowStart,
    spec: SshKeyCredentialSpec,
    input: StartInput,
  ): Promise<StartResult> {
    const read = this.readFormOrThrow({ fields: spec.fields }, input);
    const pair = generateEd25519KeyPair(SSH_KEY_COMMENT);
    const secret: CredentialSecret = {
      kind: 'ssh-key',
      privateKeyPem: pair.privateKeyPem,
      publicKey: pair.publicKey,
      fields: read.values,
      metadata: read.visible,
    };
    const connected = await this.finalize(flow.actor, flow.plugin, secret, {
      displayName: flow.displayName,
      reconnectId: flow.reconnectId,
      returnTo: flow.returnTo,
      discovery: 'deferred',
      metadata: { fields: read.visible, public_key: pair.publicKey },
    });
    return { kind: 'connected', ...connected };
  }

  /** The record a redirect flow leaves behind for its callback. */
  private newPending(
    kind: PendingFlowKind,
    flow: FlowStart,
    codeVerifier: string | null,
  ): PendingConnect {
    return {
      kind,
      providerId: flow.plugin.id,
      userId: flow.actor.user.id,
      displayName: flow.displayName,
      codeVerifier,
      redirectUri: this.callbackUrl(flow.plugin.id).href,
      returnTo: flow.returnTo,
      reconnectId: flow.reconnectId,
      broker: null,
      createdAt: this.nowIso(),
    };
  }

  /**
   * The form values of an `api-key` / `ssh-key` connect, read under the
   * alternative chosen (only its fields and the shared ones are kept), or
   * `invalid-input` naming each problem.
   */
  private readFormOrThrow(form: FormFields, input: StartInput): FieldValues {
    const read = readCredentialForm(form, input.fields ?? {}, input.alternative);
    if (read.problems.length > 0) throw new ConnectError('invalid-input', read.problems.join('; '));
    return read;
  }

  /**
   * The provider's callback. `query` is the query string the browser came
   * back with; its `state` must name a pending flow of this user and this
   * provider, and is consumed whatever the outcome.
   */
  async complete(actor: Actor, providerId: string, query: URLSearchParams): Promise<Connected> {
    await this.limit(actor);
    const pending = await this.deps.pending.take(query.get('state'), actor.user.id);
    if (!pending || pending.providerId !== providerId) throw new ConnectError('state-invalid');
    const plugin = this.requirePlugin(providerId);
    const spec = plugin.credential;
    if (pending.kind === 'oauth2' && spec.kind === 'oauth2') {
      return isBrokeredSpec(spec)
        ? this.completeBrokered(actor, plugin, pending, query)
        : this.completeOAuth2(actor, plugin, spec, pending, query);
    }
    throw new ConnectError('state-invalid');
  }

  /**
   * The browser is back from the broker with `grant` (and the `state` already
   * checked): the grant is redeemed with the verifier of the pending flow at
   * the broker that started it. The access token is the plugin's secret; the
   * refresh token is sealed beside it, host only (`BrokerGrant`): the broker
   * keeps no token (ADR oauth-broker-stateless-in-an-attested-enclave D1).
   */
  private async completeBrokered(
    actor: Actor,
    plugin: ProviderPlugin,
    pending: PendingConnect,
    query: URLSearchParams,
  ): Promise<Connected> {
    const denied = query.get('error');
    if (denied) {
      throw new ConnectError(
        'provider-denied',
        PROTOCOL_ERROR_CODE.test(denied) ? `${plugin.displayName}: ${denied}` : null,
      );
    }
    const grant = query.get('grant');
    if (!grant) throw new ConnectError('provider-denied', 'no grant was returned');
    // The broker that started the flow, by name: a grant is redeemed where it was issued.
    const broker = pending.broker ? this.deps.brokers.byName(pending.broker) : null;
    if (!broker || !pending.codeVerifier) throw new ConnectError('state-invalid');
    let redeemed;
    try {
      redeemed = await broker.redeem(grant, pending.codeVerifier);
    } catch (err) {
      throw this.brokerFailure(plugin, err);
    }
    const secret: CredentialSecret = {
      kind: 'oauth2',
      accessToken: redeemed.accessToken,
      refreshToken: null,
      expiresAt: redeemed.expiresAt,
      scopes: [...redeemed.scopes],
      metadata: {},
    };
    return this.finalize(actor, plugin, secret, {
      displayName: pending.displayName,
      reconnectId: pending.reconnectId,
      returnTo: pending.returnTo,
      discovery: 'best-effort',
      metadata: {
        oauth_broker: broker.name,
        ...(redeemed.account ? { account: redeemed.account } : {}),
      },
      brokerGrant: { broker: broker.name, refreshToken: redeemed.refreshToken },
    });
  }

  private async completeOAuth2(
    actor: Actor,
    plugin: ProviderPlugin,
    spec: OAuth2RegisteredClientSpec,
    pending: PendingConnect,
    query: URLSearchParams,
  ): Promise<Connected> {
    const denied = query.get('error');
    if (denied) {
      // The protocol code only (RFC 6749 §4.1.2.1): `error_description` is the provider's text.
      throw new ConnectError(
        'provider-denied',
        PROTOCOL_ERROR_CODE.test(denied) ? `${plugin.displayName}: ${denied}` : null,
      );
    }
    const code = query.get('code');
    if (!code) throw new ConnectError('provider-denied', 'no authorization code was returned');
    const client = await this.clientOrThrow(plugin, () =>
      this.deps.clients.forTokenRequest(plugin, spec),
    );
    let secret: CredentialSecret;
    try {
      secret = await exchangeCode(
        spec,
        client,
        { code, redirectUri: pending.redirectUri, codeVerifier: pending.codeVerifier },
        { fetch: this.deps.fetch, now: () => this.deps.clock.now() },
      );
    } catch (err) {
      if (err instanceof OAuth2TokenError) {
        if (err.oauthError === 'invalid_client') {
          await this.deps.clients.rejected(plugin, spec, client.clientId);
        }
        throw new ConnectError(
          err.rejected ? 'token-exchange-failed' : 'provider-unreachable',
          `${plugin.displayName}: ${providerFailureReason(err)}`,
        );
      }
      throw err;
    }
    return this.finalize(actor, plugin, secret, {
      displayName: pending.displayName,
      reconnectId: pending.reconnectId,
      returnTo: pending.returnTo,
      discovery: 'best-effort',
      metadata: {},
    });
  }

  /** First discovery, then the write, then the discovery's outcome on the connection. */
  private async finalize(
    actor: Actor,
    plugin: ProviderPlugin,
    secret: CredentialSecret,
    options: FinalizeOptions,
  ): Promise<Connected> {
    const first = await this.firstDiscovery(plugin, secret, options.discovery);
    const connection = await this.persist(actor, plugin, secret, options);

    let discovery: DiscoveryRecord | null = null;
    if (first.resources) {
      discovery = await this.storeDiscovery(connection, plugin, first.resources, {
        actorId: actor.user.id,
      });
    } else if (first.error) {
      discovery = await this.recordDiscovery(connection.id, 0, first.error);
    }

    this.deps.logger.info(options.reconnectId ? 'connection reconnected' : 'connection created', {
      connection_id: connection.id,
      provider: plugin.id,
      user_id: actor.user.id,
      credential_kind: secret.kind,
      resources: discovery?.count ?? 0,
    });
    return {
      connection: (await this.deps.store.connections.getById(connection.id)) ?? connection,
      discovery,
      reconnected: options.reconnectId !== null,
      returnTo: options.returnTo,
    };
  }

  /**
   * Tries the credential that was just obtained, before anything is stored.
   * Throws the `ConnectError` of a failure the policy does not tolerate.
   */
  private async firstDiscovery(
    plugin: ProviderPlugin,
    secret: CredentialSecret,
    policy: DiscoveryPolicy,
  ): Promise<FirstDiscovery> {
    if (policy === 'deferred') return { resources: null, error: null };
    try {
      const resources = await this.discoverWith(plugin, {
        credential: secret,
        fetch: this.deps.fetch,
      });
      return { resources, error: null };
    } catch (err) {
      const rejected = isUpstreamAuthError(err);
      if (policy === 'required') {
        throw new ConnectError(
          rejected || !isTransportFailure(err) ? 'credential-rejected' : 'provider-unreachable',
          `${plugin.displayName}: ${providerFailureReason(err, secret)}`,
        );
      }
      // Recorded on the account, which other owners read: the status only.
      return { resources: null, error: providerFailureReason(err) };
    }
  }

  /** Throws the `ConnectError` of the ceiling of connections when one more does not fit. */
  private async refuseAtCeiling(): Promise<void> {
    const reached = await this.deps.ceilings?.refusal('connections');
    if (!reached) return;
    this.deps.logger.warn('connection refused at the ceiling of connections', {
      count: reached.count,
      ceiling: reached.limit,
    });
    throw new ConnectError('connection-limit-reached', reached.message);
  }

  /** Creates the connection, or reconnects the one the flow named; audited either way. */
  private async persist(
    actor: Actor,
    plugin: ProviderPlugin,
    secret: CredentialSecret,
    options: FinalizeOptions,
  ): Promise<ConnectionRecord> {
    const { connections } = this.deps.store;
    const expiresAt = options.expiresAt ?? (secret.kind === 'oauth2' ? secret.expiresAt : null);
    const sealed = serializeSecret(secret, options.brokerGrant ?? null);
    const metadata = { credential_kind: secret.kind, ...options.metadata };
    if (!options.reconnectId) {
      // Again when the account is stored: a redirect flow may end long after it started.
      await this.refuseAtCeiling();
      const created = await connections.create({
        provider: plugin.id,
        owner: { kind: 'user', id: actor.user.id },
        displayName: options.displayName,
        credential: sealed,
        credentialExpiresAt: expiresAt,
        metadata,
      });
      await this.audit(actor.user.id, 'connection-created', created, null);
      return created;
    }
    // Ownership is checked again: a redirect flow may complete minutes after it started.
    await this.requireReconnectable(actor, options.reconnectId, plugin.id);
    if (!(await connections.reconnect(options.reconnectId, sealed, expiresAt))) {
      // The status changed between the check and the write.
      const now = await connections.getById(options.reconnectId);
      throw new ConnectError(
        now?.status === 'unowned' ? 'connection-unowned' : 'connection-revoked',
      );
    }
    const previous = await connections.getById(options.reconnectId);
    // Reconnected another way (an app account now on a token, or back): the
    // facts of the old way (installation id, token account) no longer hold.
    const sameWay = previous?.metadata?.credential_kind === secret.kind;
    const before = previous?.metadata ?? {};
    let kept: Record<string, unknown> = before;
    if (!sameWay) kept = 'discovery' in before ? { discovery: before.discovery } : {};
    const reconnected = await connections.setMetadata(options.reconnectId, {
      ...kept,
      ...metadata,
    });
    await this.audit(actor.user.id, 'connection-reconnected', reconnected, null);
    return reconnected;
  }

  // ── Resources ─────────────────────────────────────────────────────────────

  /**
   * The owner's "refresh discovery". On a rejected credential the broker
   * refreshes once; a second rejection leaves the connection `expired`. The
   * outcome is recorded on the connection and returned, never thrown: a
   * failed discovery leaves the known resources as they were.
   */
  async discover(actor: Actor, connectionId: string): Promise<DiscoveryRecord> {
    const connection = await this.requireOwned(actor, connectionId);
    if (connection.status === 'revoked') throw new ConnectError('connection-revoked');
    const record = await this.rediscover(connection, null, { actorId: actor.user.id });
    await this.auditDiscovery(actor.user.id, connection, record, null);
    return record;
  }

  /**
   * "Check now" on a mission card (ADR
   * resource-set-is-one-environment-with-optional-future-resources): runs the discovery
   * of one connection of the mission and says what joined or left that mission. The
   * mission's creator, or an owner of the connection, may ask; anyone else, a mission
   * without that connection, or a missing one reads `not-found`. Rate-limited per user
   * (`CHECK_NOW_RATE_LIMIT`); audited as a `resources-discovered` entry, cause `check-now`.
   */
  async checkForMission(
    actor: Actor,
    missionId: string,
    connectionId: string,
  ): Promise<MissionResourceCheck> {
    const mission = await this.deps.store.missions.getById(missionId);
    const connection = await this.deps.store.connections.getById(connectionId);
    if (
      !mission ||
      !connection ||
      !mission.connections.some((c) => c.connectionId === connectionId) ||
      (mission.creatorUserId !== actor.user.id && !this.owns(actor, connection))
    ) {
      throw new ConnectError('not-found');
    }
    if (connection.status === 'revoked') throw new ConnectError('connection-revoked');
    const decision = await this.deps.rateLimiter.take(
      `check-resources:${actor.user.id}`,
      CHECK_NOW_RATE_LIMIT,
      CHECK_NOW_RATE_WINDOW_MS,
    );
    if (!decision.allowed) throw new ConnectError('rate-limited', null, decision.retryAfterMs);
    const moves: ResourceMove[] = [];
    const record = await this.rediscover(connection, null, { actorId: actor.user.id, moves });
    await this.auditDiscovery(actor.user.id, connection, record, null, {
      cause: 'check-now',
      mission_id: missionId,
    });
    const own = moves.filter((m) => m.missionId === missionId);
    return {
      connection_id: connectionId,
      discovery: record,
      last_checked_at: record.at,
      joined: movesBySet(own.filter((m) => m.change === 'joined')),
      left: movesBySet(own.filter((m) => m.change === 'left')),
    };
  }

  /**
   * The hourly discovery of a connection a running mission's future resources depend
   * on (`HourlyDiscovery`). Not audited itself — the joins and leaves it causes are,
   * in the name of `DISCOVERY_ACTOR_ID`; a failure is recorded on the connection and
   * logged without the provider's words. `null` when the connection no longer serves
   * (gone, revoked, expired).
   */
  async discoverOnSchedule(connectionId: string): Promise<DiscoveryRecord | null> {
    const connection = await this.deps.store.connections.getById(connectionId);
    if (!connection || connection.status === 'revoked' || connection.status === 'expired') {
      return null;
    }
    return this.rediscover(connection, null, { actorId: DISCOVERY_ACTOR_ID });
  }

  /**
   * The gateway's own discovery after a call that created a resource of the
   * connection (ADR created-resources-join-the-mission): the same merge as
   * the owner's "Refresh", run by `DiscoveryAfterCall` off the request path.
   * Nothing is audited here: the scheduler may look again (a provider that
   * lists a new resource a moment late) and audits the outcome once, through
   * `auditDiscoveryAfterCall`. `null` when the connection no longer serves
   * (gone, revoked, expired): there is nothing to look for with it.
   * `createdRefs`: the refs the call created, read from its answer and already
   * recorded (ADR created-resources-join-the-mission); the outcome says how many
   * of them this discovery did not return yet.
   */
  async discoverAfterCall(
    connectionId: string,
    cause: DiscoveryAfterCallCause,
    createdRefs: readonly string[] = [],
  ): Promise<AfterCallDiscovery | null> {
    const connection = await this.deps.store.connections.getById(connectionId);
    if (!connection || connection.status === 'revoked' || connection.status === 'expired') {
      return null;
    }
    const liveRefs = async (): Promise<Set<string>> =>
      new Set(
        (await this.deps.store.connections.listResources(connection.id))
          .filter((r) => r.staleSince === null)
          .map((r) => r.ref),
      );
    const before = await liveRefs();
    const returned = new Set<string>();
    const record = await this.rediscover(connection, cause, {
      actorId: DISCOVERY_ACTOR_ID,
      returned,
    });
    if (!record.ok) return { record, added: 0, missing: createdRefs.length };
    let added = 0;
    for (const ref of await liveRefs()) if (!before.has(ref)) added += 1;
    const missing = createdRefs.filter((ref) => !returned.has(ref)).length;
    return { record, added, missing };
  }

  /** The `resources-discovered` entry of a discovery the gateway ran after a call. */
  async auditDiscoveryAfterCall(
    connectionId: string,
    cause: DiscoveryAfterCallCause & { readonly userId: string },
    outcome: AfterCallDiscovery & { readonly attempts: number },
  ): Promise<void> {
    const connection = await this.deps.store.connections.getById(connectionId);
    if (!connection) return;
    await this.auditDiscovery(cause.userId, connection, outcome.record, {
      mission_id: cause.missionId,
      tool: cause.tool,
      added: outcome.added,
      attempts: outcome.attempts,
    });
  }

  /**
   * One discovery of a connection that is not revoked, merged into its
   * resources, its outcome recorded on the connection and returned — never
   * thrown. On a rejected credential the broker refreshes once.
   */
  private async rediscover(
    connection: ConnectionRecord,
    afterCall: DiscoveryAfterCallCause | null,
    sinks: DiscoverySinks,
  ): Promise<DiscoveryRecord> {
    // An account made a way the plugin no longer declares: its stored secret is not
    // what the plugin reads, so the plugin is not called; the owner reconnects it.
    const retired = this.retiredWayOf(connection);
    if (retired !== null) return this.recordDiscovery(connection.id, 0, retired, afterCall);
    try {
      let resolved = await this.deps.broker.resolve(connection.id);
      let resources: readonly Resource[];
      try {
        resources = await this.discoverWith(resolved.plugin, this.discoveryContextOf(resolved));
      } catch (err) {
        if (!isUpstreamAuthError(err)) throw err;
        try {
          resolved = await this.deps.broker.refresh(connection.id);
        } catch (refreshErr) {
          if (!isUpstreamAuthError(refreshErr)) throw refreshErr;
          // Keep the provider's own words: they say what is wrong with the credential.
          throw new UpstreamAuthError(
            `${err.message} — the credential could not be refreshed, the connection is now expired; reconnect it`,
            err.upstreamStatus,
          );
        }
        resources = await this.discoverWith(resolved.plugin, this.discoveryContextOf(resolved));
      }
      return await this.storeDiscovery(connection, resolved.plugin, resources, sinks, afterCall);
    } catch (err) {
      this.deps.logger.warn('resource discovery failed', {
        connection_id: connection.id,
        provider: connection.provider,
        failure: providerFailureReason(err),
        ...(afterCall ? { after_call_of: afterCall.tool, mission_id: afterCall.missionId } : {}),
      });
      return this.recordDiscovery(connection.id, 0, providerFailureReason(err), afterCall);
    }
  }

  async updateResource(
    actor: Actor,
    connectionId: string,
    resourceId: string,
    patch: ResourcePatch,
  ): Promise<ConnectionResourceRecord> {
    const connection = await this.requireOwned(actor, connectionId);
    const { connections } = this.deps.store;
    let resource = await connections.getResource(resourceId);
    if (!resource || resource.connectionId !== connection.id) throw new ConnectError('not-found');
    const before = resourceAuditView(resource);

    // Validate everything before the first write.
    let env: string | null | undefined;
    if (patch.env !== undefined) {
      const parsed = parseEnvLabel(patch.env);
      if (!parsed.ok) throw new ConnectError('invalid-input', parsed.problem);
      // Compared with the resource's own label: one inherited from the connection's
      // default is not the resource's, and naming the same label pins it.
      if (parsed.env !== ownResourceEnv(resource)) {
        if (resource.envSource === 'plugin') throw new ConnectError('label-read-only');
        env = parsed.env;
      }
    }
    let ownerMetadata: Record<string, unknown> | undefined;
    if (patch.metadata) {
      const editable = new Set(editableMetadataKeys(resource.metadata));
      for (const [key, raw] of Object.entries(patch.metadata)) {
        if (!editable.has(key)) {
          throw new ConnectError('invalid-input', `'${key}' is not an editable setting`);
        }
        const parsed = parseListValue(raw);
        if (!parsed.ok) throw new ConnectError('invalid-input', `${key}: ${parsed.problem}`);
        if (sameList(parsed.list, resource.metadata?.[key])) continue;
        ownerMetadata = { ...(ownerMetadata ?? resource.ownerMetadata ?? {}), [key]: parsed.list };
      }
    }

    if (patch.displayName !== undefined) {
      const name = cleanName(patch.displayName);
      if (name === null) {
        if (resource.displayNameEdited) await connections.setResourceDisplayName(resource.id, null);
      } else if (name !== resource.displayName) {
        await connections.setResourceDisplayName(resource.id, name);
      }
    }
    if (env !== undefined) {
      const before = await this.deps.futureResources?.snapshot(connection.id);
      await connections.setResourceEnv(resource.id, env);
      if (before) await this.deps.futureResources?.settle(connection.id, before, actor.user.id);
    }
    if (patch.hidden !== undefined && patch.hidden !== resource.hidden) {
      await connections.setResourceHidden(resource.id, patch.hidden);
    }
    if (ownerMetadata) await connections.setResourceOwnerMetadata(resource.id, ownerMetadata);

    resource = (await connections.getResource(resource.id)) ?? resource;
    await this.auditResourceEdit(actor, connection, before, resourceAuditView(resource));
    this.deps.logger.info('resource edited by its owner', {
      connection_id: connection.id,
      resource_id: resource.id,
      user_id: actor.user.id,
    });
    return resource;
  }

  /**
   * The owner's default environment for the connection's unlabelled resources
   * (ADR connect-driver-and-resource-curation). `raw` is one of the catalog's
   * environment labels (`defaultEnvChoices`), or blank for none. A resource's own
   * label, the owner's or the plugin's, always wins over it. Audited
   * (`connection-default-env-set`) when it changes; an unchanged value writes nothing.
   */
  async setDefaultEnv(actor: Actor, connectionId: string, raw: string): Promise<ConnectionRecord> {
    const connection = await this.requireOwned(actor, connectionId);
    if (connection.status === 'revoked') throw new ConnectError('connection-revoked');
    const parsed = parseEnvLabel(raw);
    if (!parsed.ok) throw new ConnectError('invalid-input', parsed.problem);
    const choices = this.defaultEnvChoices(connection.provider);
    if (parsed.env !== null && !choices.includes(parsed.env)) {
      throw new ConnectError(
        'invalid-input',
        choices.length === 0
          ? 'no permission of this service depends on an environment'
          : `'${parsed.env}' is not an environment of this service (${choices.join(', ')})`,
      );
    }
    if (parsed.env === connection.defaultEnv) return connection;
    const before = await this.deps.futureResources?.snapshot(connection.id);
    const updated = await this.deps.store.connections.setDefaultEnv(connection.id, parsed.env);
    await this.deps.audit.write({
      kind: 'admin',
      ts: this.nowIso(),
      user_id: actor.user.id,
      act: 'connection-default-env-set',
      object: { type: 'connection', id: connection.id },
      before: { default_env: connection.defaultEnv },
      after: { default_env: updated.defaultEnv },
      delegated_client_id: null,
    });
    this.deps.logger.info('connection default environment set by its owner', {
      connection_id: connection.id,
      user_id: actor.user.id,
      default_env: updated.defaultEnv,
    });
    // The resources inheriting the default were relabelled with it.
    if (before) await this.deps.futureResources?.settle(connection.id, before, actor.user.id);
    return updated;
  }

  // ── Revoke ────────────────────────────────────────────────────────────────

  /**
   * Terminal. The sealed credential is erased, and the missions that carry
   * the connection lose their part on it for good: they keep serving through
   * their other connections, and one with no other part left is `orphaned`
   * and stays so — a revoked connection never comes back (spec §2.3, §7.8; ADR
   * orphaned-missions-and-ownerless-connections, amendment 2026-10-21).
   *
   * The grant at the provider is withdrawn too when the provider documents
   * how (`CredentialBroker.withdrawAtProvider`). In this order, on purpose:
   * the credential is read, the connection is revoked here, and only then is
   * the provider asked — the local revocation never waits for the provider
   * and never depends on its answer. What the provider answered is stored on
   * the connection (`providerGrant`) and written in the entry, so that a
   * grant that still stands stays visible until somebody removes it by hand.
   */
  async revoke(actor: Actor, connectionId: string): Promise<ConnectionRecord> {
    const connection = await this.requireOwned(actor, connectionId);
    if (connection.status === 'revoked') return connection;
    const watch = await this.deps.grounds.watchConnection(connection.id);
    // Read before the erase: the provider's endpoint wants the token the store is about to drop.
    const held = await this.deps.broker.forRevocation(connection.id);
    let revoked = await this.deps.store.connections.revoke(connection.id);
    const providerGrant = await this.deps.broker.withdrawAtProvider(revoked, held);
    try {
      revoked =
        (await this.deps.store.connections.recordProviderGrant(revoked.id, providerGrant)) ??
        revoked;
    } catch (err) {
      // The revocation stands and the entry below still says what the provider answered.
      this.deps.logger.error('provider grant outcome not stored', {
        connection_id: revoked.id,
        provider_grant: providerGrant,
        error_class: err instanceof Error ? err.name : typeof err,
      });
    }
    // Settled whatever happens to the act's own entry: the revocation is committed, and
    // the entries that say which missions stopped serving must not depend on it.
    try {
      await this.audit(
        actor.user.id,
        'connection-revoked',
        revoked,
        { status: connection.status },
        { provider_grant: providerGrant },
      );
    } finally {
      await watch.settle(actor.user.id);
    }
    this.deps.logger.info('connection revoked', {
      connection_id: revoked.id,
      provider: revoked.provider,
      user_id: actor.user.id,
      provider_grant: providerGrant,
    });
    return revoked;
  }

  // ── Ownership ─────────────────────────────────────────────────────────────

  /**
   * The groups the actor may hand this connection to: the ones they belong to
   * now, the current owner group excepted (spec §11.2: never a group one is
   * not a member of). None for a connection that takes no owner act, which
   * `transfer` refuses.
   */
  transferTargets(actor: Actor, connection: ConnectionRecord): GroupRecord[] {
    if (ownerActRefusal(connection)) return [];
    return actor.groups.filter(
      (g) => !(connection.owner.kind === 'group' && connection.owner.id === g.id),
    );
  }

  /**
   * Transfers ownership to a group the actor belongs to (spec §7.2): every
   * current and future member of that group is then a full owner. Shares of
   * the connection are kept. Members of a previous owner group who are not in
   * the new one lose their authority, members of the new one gain it: the
   * missions of the connection are watched across the transfer.
   */
  async transfer(actor: Actor, connectionId: string, groupId: string): Promise<ConnectionRecord> {
    const connection = await this.requireOwned(actor, connectionId);
    const refusal = ownerActRefusal(connection);
    if (refusal) throw new ConnectError(refusal);
    const group = actor.groups.find((g) => g.id === groupId);
    if (!group) throw new ConnectError('transfer-not-member');
    if (connection.owner.kind === 'group' && connection.owner.id === group.id) return connection;

    const watch = await this.deps.grounds.watchConnection(connection.id);
    const transferred = await this.deps.store.connections.transferOwner(connection.id, {
      kind: 'group',
      id: group.id,
    });
    try {
      await this.audit(actor.user.id, 'connection-transferred', transferred, {
        owner: connection.owner,
      });
    } finally {
      await watch.settle(actor.user.id);
    }
    this.deps.logger.info('connection transferred', {
      connection_id: transferred.id,
      group_id: group.id,
      user_id: actor.user.id,
    });
    return transferred;
  }

  /** Operator: the connections nobody owns any more (`unowned`, or expired with an empty owner group). */
  async listOwnerless(): Promise<ConnectionView[]> {
    const ownerless = await this.deps.store.connections.listOwnerless();
    return Promise.all(ownerless.map((c) => this.view(c)));
  }

  /**
   * Operator only (the caller authorizes; `operatorId` is the audit actor):
   * gives an ownerless connection a new owner. An `unowned` connection is
   * `active` again; an `expired` one stays `expired` until its new owner
   * reconnects. Nothing else of the connection is reachable from here: no
   * credential, no share, no mission. The missions the emptied owner group
   * had left orphaned serve again when their creator is the new owner, or a
   * member of the new owner group.
   *
   * The rule "only a connection that has no owner left" is enforced by the
   * write itself (`ConnectionsRepo.assignOwnerlessTo`, one transaction with
   * the "new owner group has a member" check). The reads before it only
   * choose which refusal is named first; a member who joins the owner group,
   * or the last one who leaves the new group, while this method awaits is
   * seen by the write and the reassignment is refused.
   */
  async reassign(
    operatorId: string,
    connectionId: string,
    newOwner: NewOwner,
  ): Promise<ConnectionRecord> {
    const { connections } = this.deps.store;
    const seen = await connections.getById(connectionId);
    if (!seen) throw new ConnectError('not-found');
    if (!(await this.looksOwnerless(seen))) throw new ConnectError('not-ownerless');
    const owner = await this.resolveNewOwner(newOwner);
    const watch = await this.deps.grounds.watchConnection(seen.id);
    const result = await connections.assignOwnerlessTo(seen.id, owner);
    // Refused at the write: nothing changed, so there is nothing to settle.
    if (result.outcome !== 'assigned') throw new ConnectError(result.outcome);
    const { previous, connection: reassigned } = result;
    try {
      await this.audit(operatorId, 'connection-reassigned', reassigned, {
        owner: previous.owner,
        status: previous.status,
      });
    } finally {
      await watch.settle(operatorId);
    }
    this.deps.logger.info('connection reassigned by the operator', {
      connection_id: reassigned.id,
      owner_kind: owner.kind,
      owner_id: owner.id,
    });
    return reassigned;
  }

  /**
   * Operator: the groups `reassign` would accept as the new owner — the ones that
   * have a member (an empty group would leave the connection ownerless again).
   * A reading for the form; the write checks again in its own transaction.
   */
  async reassignTargets(): Promise<GroupRecord[]> {
    const groups = await this.deps.store.groups.list();
    const accepted = await Promise.all(groups.map((group) => this.canOwn(group)));
    return groups.filter((_, index) => accepted[index]);
  }

  /** A group can be named owner while it has a member. */
  private async canOwn(group: GroupRecord): Promise<boolean> {
    return (await this.deps.store.groups.memberCount(group.id)) > 0;
  }

  /**
   * The repository's ownerless predicate, read outside any transaction: good
   * enough to name the refusal, never to authorize the write.
   */
  private async looksOwnerless(connection: ConnectionRecord): Promise<boolean> {
    if (connection.status === 'unowned') return true;
    if (connection.status === 'revoked') return false;
    if (connection.owner.kind === 'user') {
      // An owner the operator deactivated holds nothing: the connection is ownerless.
      const owner = await this.deps.store.users.getById(connection.owner.id);
      return owner?.status !== 'active';
    }
    return (await this.deps.store.groups.memberCount(connection.owner.id)) === 0;
  }

  private async resolveNewOwner(newOwner: NewOwner): Promise<Principal> {
    if (newOwner.kind === 'user') {
      const lookup = await findActiveUserByEmail(this.deps.store.users, newOwner.email);
      if (!lookup.found) throw new ConnectError('owner-unknown');
      return { kind: 'user', id: lookup.user.id };
    }
    const group = await this.deps.store.groups.getById(newOwner.groupId);
    if (!group || !(await this.canOwn(group))) {
      throw new ConnectError('owner-group-empty');
    }
    return { kind: 'group', id: group.id };
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private async limit(actor: Actor): Promise<void> {
    const decision = await this.deps.rateLimiter.take(
      `connect:${actor.user.id}`,
      CONNECT_RATE_LIMIT,
      CONNECT_RATE_WINDOW_MS,
    );
    if (!decision.allowed) throw new ConnectError('rate-limited', null, decision.retryAfterMs);
  }

  private requirePlugin(providerId: string): ProviderPlugin {
    const registered = this.deps.registry.get(providerId);
    if (!registered) throw new ConnectError('provider-unknown');
    return registered.plugin;
  }

  private returnToOf(raw: string | null | undefined): string | null {
    if (!raw) return null;
    const path = resolveReturnTo(raw, this.deps.publicUrl);
    if (path === null) throw new ConnectError('return-url-refused');
    return path;
  }

  private owns(actor: Actor, connection: ConnectionRecord): boolean {
    return connection.owner.kind === 'user'
      ? connection.owner.id === actor.user.id
      : actor.groups.some((g) => g.id === connection.owner.id);
  }

  /** A connection of another owner is reported exactly like a missing one. */
  private async requireOwned(actor: Actor, connectionId: string): Promise<ConnectionRecord> {
    const connection = await this.deps.store.connections.getById(connectionId);
    if (!connection || !this.owns(actor, connection)) throw new ConnectError('not-found');
    return connection;
  }

  private async requireReconnectable(
    actor: Actor,
    connectionId: string,
    providerId: string,
  ): Promise<ConnectionRecord> {
    const connection = await this.requireOwned(actor, connectionId);
    if (connection.provider !== providerId) throw new ConnectError('provider-mismatch');
    // Spec §2.3: nobody reconnects an unowned connection until an owner is reassigned.
    const refusal = ownerActRefusal(connection);
    if (refusal) throw new ConnectError(refusal);
    return connection;
  }

  /**
   * The OAuth client of a flow, or the `ConnectError` the page shows: a
   * registration the service refused (`client-registration-failed`) or could not take
   * (`provider-unreachable`), a registered client gone between the start and
   * the callback (`state-invalid`: start again).
   */
  private async clientOrThrow(
    plugin: ProviderPlugin,
    get: () => Promise<OAuth2Client>,
  ): Promise<OAuth2Client> {
    try {
      return await get();
    } catch (err) {
      if (err instanceof OAuth2ClientMissing) throw new ConnectError('state-invalid');
      if (err instanceof OAuth2RegistrationError) {
        this.deps.logger.warn('OAuth client registration failed', {
          provider: plugin.id,
          failure: providerFailureReason(err),
        });
        throw new ConnectError(
          err.rejected ? 'client-registration-failed' : 'provider-unreachable',
          `${plugin.displayName}: ${providerFailureReason(err)}`,
        );
      }
      throw err;
    }
  }

  /** A discovery's context: the stored credential, under the discovery's deadline. */
  private discoveryContextOf(resolved: ResolvedCredential): ConnectionContext {
    return this.deps.broker.contextOf(resolved, AbortSignal.timeout(DISCOVERY_TIMEOUT_MS));
  }

  private async discoverWith(
    plugin: ProviderPlugin,
    ctx: ConnectionContext,
  ): Promise<readonly Resource[]> {
    return plugin.discoverResources(ctx);
  }

  private async storeDiscovery(
    connection: ConnectionRecord,
    plugin: ProviderPlugin,
    resources: readonly Resource[],
    sinks: DiscoverySinks,
    afterCall: DiscoveryAfterCallCause | null = null,
  ): Promise<DiscoveryRecord> {
    const { usable, unusable } = usableResourcesOf(plugin.id, resources);
    for (const r of usable) sinks.returned?.add(r.ref);
    for (let i = 0; i < unusable; i += 1) {
      this.deps.logger.warn('plugin returned an unusable resource; ignored', {
        provider: plugin.id,
        connection_id: connection.id,
      });
    }
    const before = await this.deps.futureResources?.snapshot(connection.id);
    await this.deps.store.connections.syncDiscoveredResources(connection.id, usable);
    const record = await this.recordDiscovery(connection.id, usable.length, null, afterCall);
    // Recorded first: a mission page reads "last checked" with what joined.
    if (before) {
      const moves = await this.deps.futureResources?.settle(connection.id, before, sinks.actorId);
      sinks.moves?.push(...(moves ?? []));
    }
    return record;
  }

  private async recordDiscovery(
    connectionId: string,
    count: number,
    error: string | null,
    afterCall: DiscoveryAfterCallCause | null = null,
  ): Promise<DiscoveryRecord> {
    const record: DiscoveryRecord = {
      at: this.nowIso(),
      ok: error === null,
      count,
      error,
      afterCall,
    };
    const current = await this.deps.store.connections.getById(connectionId);
    if (current) {
      await this.deps.store.connections.setMetadata(connectionId, {
        ...(current.metadata ?? {}),
        discovery: record,
      });
    }
    return record;
  }

  /**
   * What the plugin of a connection says about withdrawing its grant, with the
   * provider's label. Read from the registry alone: it answers for a revoked
   * connection too, and for a provider whose plugin is gone (nothing is known,
   * so the person removes the access by hand).
   */
  providerGrantOf(
    connection: Pick<ConnectionRecord, 'provider'> & Partial<Pick<ConnectionRecord, 'metadata'>>,
  ): {
    readonly providerLabel: string;
    readonly grant: ProviderGrantView;
  } {
    const plugin = this.deps.registry.get(connection.provider)?.plugin;
    if (!plugin) {
      return {
        providerLabel: connection.provider,
        grant: { withdrawnByGateway: false, byHand: null },
      };
    }
    const kind =
      connectionCredentialKind(connection, plugin.credential.kind) ?? plugin.credential.kind;
    return {
      providerLabel: plugin.displayName,
      grant: {
        withdrawnByGateway: canWithdraw(plugin, kind),
        byHand: plugin.manualRevocation ?? null,
      },
    };
  }

  /** The refusal sentence of an account made a way its plugin no longer declares, or `null`. */
  private retiredWayOf(connection: ConnectionRecord): string | null {
    const registered = this.deps.registry.get(connection.provider);
    if (!registered) return null;
    const { plugin } = registered;
    const kind = connectionCredentialKind(connection, plugin.credential.kind);
    return kind !== null && isRetiredWay(kind, plugin.credential.kind)
      ? retiredWayReason(plugin.displayName, kind)
      : null;
  }

  private async view(connection: ConnectionRecord): Promise<ConnectionView> {
    const registered = this.deps.registry.get(connection.provider);
    const metadata = connection.metadata ?? {};
    const kind = connectionCredentialKind(connection, registered?.plugin.credential.kind ?? null);
    const pasted = kind === 'api-key';
    // What the service said the account is: the pasted token's `verify`, or the broker's redeem.
    const accountSaid = pasted || kind === 'oauth2';
    return {
      connection,
      provider_label: registered?.plugin.displayName ?? connection.provider,
      resource_noun: resourceNounOf(registered?.plugin ?? null),
      provider_icon: registered ? serviceIconOf(registered.plugin) : null,
      provider_grant: this.providerGrantOf(connection).grant,
      credential_kind: kind,
      way_retired: registered ? isRetiredWay(kind, registered.plugin.credential.kind) : false,
      token_account: accountSaid && typeof metadata.account === 'string' ? metadata.account : null,
      oauth_broker: this.oauthBrokerOf(metadata),
      token_expires_at: pasted ? connection.credentialExpiresAt : null,
      token_lacks:
        pasted && registered ? tokenLacks(registered.plugin.credential, metadata.granted) : null,
      owner_label: await this.ownerLabel(connection),
      public_key: typeof metadata.public_key === 'string' ? metadata.public_key : null,
      fields: connectionPublicFields(connection),
      discovery: discoveryOf(metadata.discovery),
    };
  }

  /** The broker named at connect time (`metadata.oauth_broker`), as configured now. */
  private oauthBrokerOf(metadata: Record<string, unknown>): ConnectionView['oauth_broker'] {
    const name = metadata.oauth_broker;
    if (typeof name !== 'string') return null;
    return { name, attested: this.deps.brokers.byName(name)?.attested ?? null };
  }

  private async ownerLabel(connection: ConnectionRecord): Promise<string> {
    const owner = await connectionOwnerOf(this.deps.store, connection);
    if (owner.kind === 'user') return owner.name ?? 'unknown user';
    return owner.name === null ? 'unknown group' : `group ${owner.name}`;
  }

  private async audit(
    actorId: string,
    act:
      | 'connection-created'
      | 'connection-reconnected'
      | 'connection-revoked'
      | 'connection-transferred'
      | 'connection-reassigned',
    connection: ConnectionRecord,
    before: unknown,
    extra: Readonly<Record<string, string>> = {},
  ): Promise<void> {
    await this.deps.audit.write({
      kind: 'admin',
      ts: this.nowIso(),
      user_id: actorId,
      act,
      object: { type: 'connection', id: connection.id },
      before,
      after: {
        provider: connection.provider,
        display_name: connection.displayName,
        status: connection.status,
        owner: connection.owner,
        ...extra,
      },
      delegated_client_id: null,
    });
  }

  /**
   * A discovery after the first: the outcome, never the resource list. `cause`
   * says who ran it — the owner's "Refresh" (`by-owner`, the actor is the
   * owner), or the gateway after a creating call (`after-a-call`, the actor is
   * the human behind the call's key).
   */
  private async auditDiscovery(
    userId: string,
    connection: ConnectionRecord,
    record: DiscoveryRecord,
    afterCall: {
      readonly mission_id: string;
      readonly tool: string;
      readonly added: number;
      readonly attempts: number;
    } | null,
    /** A discovery asked from a mission card ("check now"). */
    checkNow?: { readonly cause: 'check-now'; readonly mission_id: string },
  ): Promise<void> {
    await this.deps.audit.write({
      kind: 'admin',
      ts: this.nowIso(),
      user_id: userId,
      act: 'resources-discovered',
      object: { type: 'connection', id: connection.id },
      before: null,
      after: {
        ok: record.ok,
        count: record.count,
        error: record.error,
        ...(afterCall
          ? { cause: 'after-a-call', ...afterCall }
          : (checkNow ?? { cause: 'by-owner' })),
      },
      delegated_client_id: null,
    });
  }

  /** One entry per save that changed something; a save that changed nothing writes none. */
  private async auditResourceEdit(
    actor: Actor,
    connection: ConnectionRecord,
    before: ResourceAuditView,
    after: ResourceAuditView,
  ): Promise<void> {
    if (JSON.stringify(before) === JSON.stringify(after)) return;
    await this.deps.audit.write({
      kind: 'admin',
      ts: this.nowIso(),
      user_id: actor.user.id,
      act: 'resource-edited',
      object: { type: 'connection', id: connection.id },
      before,
      after,
      delegated_client_id: null,
    });
  }

  private nowIso(): string {
    return toIso(this.deps.clock.now());
  }
}

/** What a `resource-edited` audit entry says of a resource: the fields its owner can edit. */
interface ResourceAuditView {
  readonly resource_id: string;
  readonly ref: string;
  readonly display_name: string;
  readonly env: string | null;
  readonly hidden: boolean;
  readonly owner_metadata: Record<string, unknown> | null;
}

function resourceAuditView(resource: ConnectionResourceRecord): ResourceAuditView {
  return {
    resource_id: resource.id,
    ref: resource.ref,
    display_name: resource.displayName,
    // The resource's own label, the one edited here; the connection's default is audited apart.
    env: ownResourceEnv(resource),
    hidden: resource.hidden,
    owner_metadata: resource.ownerMetadata,
  };
}

/** The plugin-facing `Resource` of a stored row (what `classify` and `execute` receive). */
/** Where a discovery reports beyond its record. */
interface DiscoverySinks {
  /** The audit's actor of the joins and leaves it causes. */
  readonly actorId: string;
  /** Filled with the refs the discovery returned. */
  readonly returned?: Set<string>;
  /** Filled with the joins and leaves it caused. */
  readonly moves?: ResourceMove[];
}

/** Moves grouped by set and reason, refs in the order they were written. */
function movesBySet(moves: readonly ResourceMove[]): MissionResourceMoves[] {
  const groups = new Map<string, MissionResourceMoves>();
  for (const move of moves) {
    const key = `${move.resourceSetId}\n${move.reason}`;
    const group = groups.get(key);
    groups.set(key, {
      resource_set_id: move.resourceSetId,
      reason: move.reason,
      refs: [...(group?.refs ?? []), move.ref],
    });
  }
  return [...groups.values()];
}

export function toPluginResource(provider: string, record: ConnectionResourceRecord): Resource {
  return {
    provider,
    ref: record.ref,
    env: record.env,
    displayName: record.displayName,
    ...(record.metadata ? { metadata: record.metadata } : {}),
  };
}

function toolLabel(plugin: ProviderPlugin, name: string): ToolLabel {
  return { name, title: plugin.toolTitles?.[name] ?? name };
}

function isTransportFailure(err: unknown): boolean {
  return (
    err instanceof TypeError ||
    (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError'))
  );
}

function sameList(list: readonly string[], current: unknown): boolean {
  return (
    Array.isArray(current) &&
    current.length === list.length &&
    current.every((value, index) => value === list[index])
  );
}

function discoveryOf(value: unknown): DiscoveryRecord | null {
  if (typeof value !== 'object' || value === null) return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.at !== 'string' || typeof raw.ok !== 'boolean') return null;
  return {
    at: raw.at,
    ok: raw.ok,
    count: typeof raw.count === 'number' ? raw.count : 0,
    error: typeof raw.error === 'string' ? raw.error : null,
    afterCall: afterCallOf(raw.afterCall),
  };
}

function afterCallOf(value: unknown): DiscoveryAfterCallCause | null {
  if (typeof value !== 'object' || value === null) return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.missionId !== 'string' || typeof raw.tool !== 'string') return null;
  return { missionId: raw.missionId, tool: raw.tool };
}
