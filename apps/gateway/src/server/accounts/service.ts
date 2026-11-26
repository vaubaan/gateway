/**
 * Accounts (spec §0 "Account", "Resource"; §2.3 states; §7.2).
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
 * An account is created under the name of the user who connected it. An
 * owner may transfer it to a group they belong to (`transfer`); when that
 * group empties the account is `unowned` and the operator hands it to a new
 * owner (`reassign`, the operator's only act on the domain — spec §2.3). Its
 * credential is the serialized `CredentialSecret`, sealed by the store with
 * the account id as associated data. Resources are discovered by the
 * plugin at connect time and merged by `syncDiscoveredResources`, which
 * never overwrites an owner edit and never deletes a row.
 */
import { isUpstreamAuthError } from '@vaubaan/shared';
import {
  type ApiKeyCredentialSpec,
  type CredentialCheck,
  type CredentialSecret,
  type GuideStep,
  isBrokeredSpec,
  type OAuth2BrokeredSpec,
  type OAuth2RegisteredClientSpec,
  type ServicePlugin,
  type Resource,
  screenshotAttribution,
  type SshKeyCredentialSpec,
  type TokenGuide,
  serviceIconOf,
} from '@vaubaan/plugin-sdk';

import { findActiveUserByEmail } from '../authority';
import { connectFileUrl } from '../plugins/connect-files';
import { catalogEnvsOf } from '../../lib/missions/catalog-view';
import { resourceNounOf } from '../../lib/services/resource-noun';
import { HostAccountTakenError } from '../store/errors';
import { ownResourceEnv } from '../store/resource-env';
import { toIso } from '../store/clock';
import type { AccountRecord, AccountResourceRecord, GroupRecord, Principal } from '../store/types';
import { serializeSecret } from './credential-codec';
import { canWithdraw } from './credentials';
import { ConnectError } from './errors';
import { serviceFailureReason } from './failure-reason';
import { grantedNames, tokenLacks } from './token-permissions';
import {
  cleanName,
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
import { OAuth2ClientMissing } from './oauth2-clients';
import {
  brokerNotConfiguredReason,
  OAuthBrokerError,
  type OAuthBrokerClient,
} from './oauth-broker';
import type { BrokerGrant } from './credential-codec';
import {
  accountCredentialKind,
  accountOwnerOf,
  accountPublicFields,
  isRetiredWay,
} from './mapping';
import type { PendingConnect, PendingFlowKind } from './pending';
import { generateEd25519KeyPair } from './ssh-keypair';

import { AccountDiscovery, DISCOVERY_TIMEOUT_MS, isTransportFailure } from './discovery';
import { isHostAccount } from './host-account';

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
  GuideStepView,
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

/** An OAuth `error` code is a token of the protocol (RFC 6749 §4.1.2.1), never free text. */
const PROTOCOL_ERROR_CODE = /^[a-z_]{1,40}$/;

/** Connect attempts (starts, callbacks, form posts) one user may make per window. */
export const CONNECT_RATE_LIMIT = 10;
export const CONNECT_RATE_WINDOW_MS = 60_000;
/** The pages of the accounts a person can use ("accounts" in the spec and the store). */
export const ACCOUNTS_PATH = '/accounts';
/**
 * Where a service sends the browser back after an authorization. This path is
 * registered at the service (the redirect URI of the company's OAuth client):
 * it is part of the protocol, so it kept its name when the pages moved to
 * `/accounts`.
 */
export const CONNECT_CALLBACK_PATH = '/connections/callback';
const SSH_KEY_COMMENT = 'vaubaan-gateway';

/**
 * Why this account takes no owner act (share, transfer, reconnect), or `null` when it
 * does (spec §2.3): revocation is final, and nobody acts on an account without owner
 * until the operator reassigns one. A `host` account (the Vaubaan account) takes none
 * either: it is its person's own, never shared nor transferred, and holds nothing to
 * reconnect (ADR platform-management-is-a-plugin-on-the-execution-door). The one
 * statement of the rule: the service's own refusals, the shares service and the pages
 * (through `transferTargets` and `ShareContext.unshareable`) all read it here.
 */
export function ownerActRefusal(
  account: Pick<AccountRecord, 'status' | 'metadata'>,
): 'account-revoked' | 'account-unowned' | 'account-personal' | null {
  if (account.status === 'revoked') return 'account-revoked';
  if (account.status === 'unowned') return 'account-unowned';
  if (isHostAccount(account)) return 'account-personal';
  return null;
}

/** "Connected" with the host account the person already holds: nothing stored, nothing audited. */
function handBack(flow: Pick<FlowStart, 'returnTo'>, account: AccountRecord): StartResult {
  return {
    kind: 'connected',
    account,
    discovery: null,
    reconnected: false,
    returnTo: flow.returnTo,
  };
}

/** How a failed first discovery is treated when a credential has just been obtained. */
export type DiscoveryPolicy =
  /** Any failure refuses the account: the user can simply retry (api-key form). */
  | 'required'
  /** The credential is kept whatever happens: the authorization code is spent. */
  | 'best-effort'
  /** Not attempted: the public key is not installed yet (ssh-key). */
  | 'deferred';

/** What every credential kind needs to start a flow, resolved once by `start`. */
interface FlowStart {
  readonly actor: Actor;
  readonly plugin: ServicePlugin;
  readonly displayName: string;
  readonly returnTo: string | null;
  /** The account being re-authenticated, already checked as reconnectable. */
  readonly reconnectId: string | null;
}

/** What `finalize` stores once a credential has been obtained. */
interface FinalizeOptions {
  readonly displayName: string;
  readonly reconnectId: string | null;
  readonly returnTo: string | null;
  readonly discovery: DiscoveryPolicy;
  readonly metadata: Record<string, unknown>;
  /** When the credential stops working, as the service said; else an OAuth token's own expiry. */
  readonly expiresAt?: string | null;
  /** The OAuth broker's grant of a brokered account, sealed beside the secret. */
  readonly brokerGrant?: BrokerGrant | null;
}

export class AccountService {
  /** The discovery of resources (`discovery.ts`). */
  readonly #discovery: AccountDiscovery;

  constructor(private readonly deps: AccountServiceDeps) {
    this.#discovery = new AccountDiscovery(deps, this);
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

  // ── Services ─────────────────────────────────────────────────────────────

  /** Every registered plugin, in registry order. */
  async services(): Promise<ConnectableService[]> {
    return Promise.all(this.deps.registry.ids.map((id) => this.describe(id)));
  }

  async service(serviceId: string): Promise<ConnectableService | null> {
    return this.deps.registry.has(serviceId) ? this.describe(serviceId) : null;
  }

  private async describe(serviceId: string): Promise<ConnectableService> {
    const { plugin } = this.deps.registry.require(serviceId);
    const spec = plugin.credential;
    const guide = spec.kind === 'api-key' ? spec.guide : undefined;
    const steps = (list: readonly GuideStep[]): GuideStepView[] =>
      list.map((step) => stepView(plugin, guide?.screenshots, step));
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
      alternatives:
        spec.kind === 'api-key'
          ? (spec.alternatives ?? []).map((alt) => ({ ...alt, steps: steps(alt.steps) }))
          : [],
      createUrl: spec.kind === 'api-key' ? (spec.createUrl ?? null) : null,
      label: spec.kind === 'api-key' ? (spec.label ?? null) : null,
      guide: guide
        ? {
            steps: steps(guide.steps),
            reach: guide.reach,
            permissions: guide.permissions.map((p) => ({ name: p.name, access: p.access })),
            expiry: guide.expiry,
            docsUrl: guide.docsUrl,
          }
        : null,
      unavailable: this.unavailableReason(plugin),
    };
  }

  /** Why a plugin cannot be connected here, or `null`: a broker it needs is not configured. */
  private unavailableReason(plugin: ServicePlugin): string | null {
    const spec = plugin.credential;
    if (spec.kind !== 'oauth2' || !isBrokeredSpec(spec)) return null;
    return this.deps.brokers.forProvider(spec.broker.provider)
      ? null
      : brokerNotConfiguredReason(plugin.displayName, spec.broker.provider);
  }

  // ── Reads ─────────────────────────────────────────────────────────────────

  /** The accounts the actor owns, directly or through a group they belong to now. */
  async listFor(actor: Actor): Promise<AccountView[]> {
    const owned = await this.deps.store.accounts.listOwnedBy([
      { kind: 'user', id: actor.user.id },
      ...actor.groups.map((g) => ({ kind: 'group' as const, id: g.id })),
    ]);
    return Promise.all(owned.map((c) => this.view(c)));
  }

  async get(actor: Actor, accountId: string): Promise<AccountDetail> {
    const account = await this.requireOwned(actor, accountId);
    return {
      ...(await this.view(account)),
      resources: await this.deps.store.accounts.listResources(account.id),
      default_env_choices: this.defaultEnvChoices(account.service),
    };
  }

  /** The environment labels of the service's catalog: what a default may be. */
  defaultEnvChoices(serviceId: string): string[] {
    const registered = this.deps.registry.get(serviceId);
    return registered ? catalogEnvsOf(registered.plugin.catalog) : [];
  }

  // ── Connect ───────────────────────────────────────────────────────────────

  async start(actor: Actor, serviceId: string, input: StartInput = {}): Promise<StartResult> {
    await this.limit(actor);
    const plugin = this.requirePlugin(serviceId);
    const returnTo = this.returnToOf(input.returnTo);
    const reconnect = input.reconnectId
      ? await this.requireReconnectable(actor, input.reconnectId, serviceId)
      : null;
    // Before the service is reached: a refused flow spends no authorization code.
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
      case 'host':
        return this.connectHost(flow);
    }
  }

  /**
   * A `host` account (the `vaubaan` plugin; ADR
   * platform-management-is-a-plugin-on-the-execution-door): one button, no
   * secret, nothing to verify, no resource. It belongs to the person who pressed
   * it and is never shared. A person holds one: connecting again hands back the
   * account they already have. The store holds the rule (migration 0040): of two
   * connects at once, the second insert is refused and reads the first one back.
   */
  private async connectHost(flow: FlowStart): Promise<StartResult> {
    const existing = await this.heldHostAccount(flow);
    if (existing && !flow.reconnectId) return handBack(flow, existing);
    const secret: CredentialSecret = { kind: 'host', metadata: {} };
    try {
      const connected = await this.finalize(flow.actor, flow.plugin, secret, {
        displayName: flow.displayName,
        reconnectId: flow.reconnectId,
        returnTo: flow.returnTo,
        discovery: 'deferred',
        metadata: {},
      });
      return { kind: 'connected', ...connected };
    } catch (err) {
      if (!(err instanceof HostAccountTakenError)) throw err;
      const held = await this.heldHostAccount(flow);
      if (!held) throw err;
      this.deps.logger.info('host account handed back after a concurrent connect', {
        account_id: held.id,
        service: flow.plugin.id,
        user_id: flow.actor.user.id,
      });
      return handBack(flow, held);
    }
  }

  /** The person's own account of a host service, not revoked (the one a flow reconnects aside). */
  private async heldHostAccount(flow: FlowStart): Promise<AccountRecord | undefined> {
    const owned = await this.deps.store.accounts.listOwnedBy([
      { kind: 'user', id: flow.actor.user.id },
    ]);
    return owned.find(
      (c) => c.service === flow.plugin.id && c.status !== 'revoked' && c.id !== flow.reconnectId,
    );
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
   * broker that serves the plugin's service answers `POST /flows` with the
   * service's page; the S256 PKCE verifier and the broker's name stay in the
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
  private brokerOrThrow(plugin: ServicePlugin, spec: OAuth2BrokeredSpec): OAuthBrokerClient {
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
  private brokerFailure(plugin: ServicePlugin, err: unknown): unknown {
    if (!(err instanceof OAuthBrokerError)) return err;
    this.deps.logger.warn('OAuth broker call failed', {
      service: plugin.id,
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
   * into the account's metadata (the importer's marker).
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
   * Creates an account from a key taken from the v4 SaaS, through the same
   * path as a key pasted in the form: the plugin's check, the first
   * discovery (a failure refuses it, nothing is stored), the seal, the
   * `account-created` entry under `actor`. `importedFrom` is kept in the
   * account's metadata so a second run recognises it. No connect rate
   * limit: the operator's command is not a web request.
   */
  async importPastedKey(
    actor: Actor,
    serviceId: string,
    input: ImportPastedInput,
  ): Promise<Connected> {
    const plugin = this.requirePlugin(serviceId);
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
   * Creates an `ssh-key` account with a key pair that already exists
   * (`importEd25519PrivateKey`) instead of a new one: the key is already in
   * the host's `authorized_keys`, so the first discovery runs at once and is
   * the probe — it verifies the pinned host key and the key pair, and a
   * failure refuses the account.
   */
  async importSshKey(actor: Actor, input: ImportSshInput): Promise<Connected> {
    const plugin = this.requirePlugin(input.serviceId);
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

  private importFlow(actor: Actor, plugin: ServicePlugin, displayName: string): FlowStart {
    return {
      actor,
      plugin,
      displayName: cleanName(displayName) ?? plugin.displayName,
      returnTo: null,
      reconnectId: null,
    };
  }

  /**
   * Asks the service about pasted values before anything is stored (the
   * spec's `verify`): who they act as and when they stop working. A
   * rejection, an answer that is not understood or a credential already
   * expired refuses the account; an unreachable service says so. `null`
   * when the spec declares no check (the first discovery is then the check).
   */
  private async verifyPasted(
    plugin: ServicePlugin,
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
        rejected ? 'credential-rejected' : 'service-unreachable',
        `${plugin.displayName}: ${serviceFailureReason(err, secret)}`,
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
      serviceId: flow.plugin.id,
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
   * The service's callback. `query` is the query string the browser came
   * back with; its `state` must name a pending flow of this user and this
   * service, and is consumed whatever the outcome.
   */
  async complete(actor: Actor, serviceId: string, query: URLSearchParams): Promise<Connected> {
    await this.limit(actor);
    const pending = await this.deps.pending.take(query.get('state'), actor.user.id);
    if (!pending || pending.serviceId !== serviceId) throw new ConnectError('state-invalid');
    const plugin = this.requirePlugin(serviceId);
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
    plugin: ServicePlugin,
    pending: PendingConnect,
    query: URLSearchParams,
  ): Promise<Connected> {
    const denied = query.get('error');
    if (denied) {
      throw new ConnectError(
        'service-denied',
        PROTOCOL_ERROR_CODE.test(denied) ? `${plugin.displayName}: ${denied}` : null,
      );
    }
    const grant = query.get('grant');
    if (!grant) throw new ConnectError('service-denied', 'no grant was returned');
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
    plugin: ServicePlugin,
    spec: OAuth2RegisteredClientSpec,
    pending: PendingConnect,
    query: URLSearchParams,
  ): Promise<Connected> {
    const denied = query.get('error');
    if (denied) {
      // The protocol code only (RFC 6749 §4.1.2.1): `error_description` is the service's text.
      throw new ConnectError(
        'service-denied',
        PROTOCOL_ERROR_CODE.test(denied) ? `${plugin.displayName}: ${denied}` : null,
      );
    }
    const code = query.get('code');
    if (!code) throw new ConnectError('service-denied', 'no authorization code was returned');
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
          err.rejected ? 'token-exchange-failed' : 'service-unreachable',
          `${plugin.displayName}: ${serviceFailureReason(err)}`,
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

  /** First discovery, then the write, then the discovery's outcome on the account. */
  private async finalize(
    actor: Actor,
    plugin: ServicePlugin,
    secret: CredentialSecret,
    options: FinalizeOptions,
  ): Promise<Connected> {
    const first = await this.#discovery.firstDiscovery(plugin, secret, options.discovery);
    const account = await this.persist(actor, plugin, secret, options);

    let discovery: DiscoveryRecord | null = null;
    if (first.resources) {
      discovery = await this.#discovery.storeDiscovery(account, plugin, first.resources, {
        actorId: actor.user.id,
      });
    } else if (first.error) {
      discovery = await this.#discovery.recordDiscovery(account.id, 0, first.error);
    }

    this.deps.logger.info(options.reconnectId ? 'account reconnected' : 'account created', {
      account_id: account.id,
      service: plugin.id,
      user_id: actor.user.id,
      credential_kind: secret.kind,
      resources: discovery?.count ?? 0,
    });
    return {
      account: (await this.deps.store.accounts.getById(account.id)) ?? account,
      discovery,
      reconnected: options.reconnectId !== null,
      returnTo: options.returnTo,
    };
  }

  /** Throws the `ConnectError` of the ceiling of accounts when one more does not fit. */
  private async refuseAtCeiling(): Promise<void> {
    const reached = await this.deps.ceilings?.refusal('accounts');
    if (!reached) return;
    this.deps.logger.warn('account refused at the ceiling of accounts', {
      count: reached.count,
      ceiling: reached.limit,
    });
    throw new ConnectError('account-limit-reached', reached.message);
  }

  /** Creates the account, or reconnects the one the flow named; audited either way. */
  private async persist(
    actor: Actor,
    plugin: ServicePlugin,
    secret: CredentialSecret,
    options: FinalizeOptions,
  ): Promise<AccountRecord> {
    const { accounts } = this.deps.store;
    const expiresAt = options.expiresAt ?? (secret.kind === 'oauth2' ? secret.expiresAt : null);
    const sealed = serializeSecret(secret, options.brokerGrant ?? null);
    const metadata = { credential_kind: secret.kind, ...options.metadata };
    if (!options.reconnectId) {
      // Again when the account is stored: a redirect flow may end long after it started.
      await this.refuseAtCeiling();
      const created = await accounts.create({
        service: plugin.id,
        owner: { kind: 'user', id: actor.user.id },
        displayName: options.displayName,
        credential: sealed,
        credentialExpiresAt: expiresAt,
        metadata,
      });
      await this.audit(actor.user.id, 'account-created', created, null);
      return created;
    }
    // Ownership is checked again: a redirect flow may complete minutes after it started.
    await this.requireReconnectable(actor, options.reconnectId, plugin.id);
    if (!(await accounts.reconnect(options.reconnectId, sealed, expiresAt))) {
      // The status changed between the check and the write.
      const now = await accounts.getById(options.reconnectId);
      throw new ConnectError(now?.status === 'unowned' ? 'account-unowned' : 'account-revoked');
    }
    const previous = await accounts.getById(options.reconnectId);
    // Reconnected another way (an app account now on a token, or back): the
    // facts of the old way (installation id, token account) no longer hold.
    const sameWay = previous?.metadata?.credential_kind === secret.kind;
    const before = previous?.metadata ?? {};
    let kept: Record<string, unknown> = before;
    if (!sameWay) kept = 'discovery' in before ? { discovery: before.discovery } : {};
    const reconnected = await accounts.setMetadata(options.reconnectId, {
      ...kept,
      ...metadata,
    });
    await this.audit(actor.user.id, 'account-reconnected', reconnected, null);
    return reconnected;
  }

  // ── Resources ─────────────────────────────────────────────────────────────

  async updateResource(
    actor: Actor,
    accountId: string,
    resourceId: string,
    patch: ResourcePatch,
  ): Promise<AccountResourceRecord> {
    const account = await this.requireOwned(actor, accountId);
    const { accounts } = this.deps.store;
    let resource = await accounts.getResource(resourceId);
    if (!resource || resource.accountId !== account.id) throw new ConnectError('not-found');
    const before = resourceAuditView(resource);

    // Validate everything before the first write.
    let env: string | null | undefined;
    if (patch.env !== undefined) {
      const parsed = parseEnvLabel(patch.env);
      if (!parsed.ok) throw new ConnectError('invalid-input', parsed.problem);
      // Compared with the resource's own label: one inherited from the account's
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
        if (resource.displayNameEdited) await accounts.setResourceDisplayName(resource.id, null);
      } else if (name !== resource.displayName) {
        await accounts.setResourceDisplayName(resource.id, name);
      }
    }
    if (env !== undefined) {
      const before = await this.deps.futureResources?.snapshot(account.id);
      await accounts.setResourceEnv(resource.id, env);
      if (before) await this.deps.futureResources?.settle(account.id, before, actor.user.id);
    }
    if (patch.hidden !== undefined && patch.hidden !== resource.hidden) {
      await accounts.setResourceHidden(resource.id, patch.hidden);
    }
    if (ownerMetadata) await accounts.setResourceOwnerMetadata(resource.id, ownerMetadata);

    resource = (await accounts.getResource(resource.id)) ?? resource;
    await this.auditResourceEdit(actor, account, before, resourceAuditView(resource));
    this.deps.logger.info('resource edited by its owner', {
      account_id: account.id,
      resource_id: resource.id,
      user_id: actor.user.id,
    });
    return resource;
  }

  /**
   * The owner's default environment for the account's unlabelled resources
   * (ADR connect-driver-and-resource-curation). `raw` is one of the catalog's
   * environment labels (`defaultEnvChoices`), or blank for none. A resource's own
   * label, the owner's or the plugin's, always wins over it. Audited
   * (`account-default-env-set`) when it changes; an unchanged value writes nothing.
   */
  async setDefaultEnv(actor: Actor, accountId: string, raw: string): Promise<AccountRecord> {
    const account = await this.requireOwned(actor, accountId);
    if (account.status === 'revoked') throw new ConnectError('account-revoked');
    const parsed = parseEnvLabel(raw);
    if (!parsed.ok) throw new ConnectError('invalid-input', parsed.problem);
    const choices = this.defaultEnvChoices(account.service);
    if (parsed.env !== null && !choices.includes(parsed.env)) {
      throw new ConnectError(
        'invalid-input',
        choices.length === 0
          ? 'no permission of this service depends on an environment'
          : `'${parsed.env}' is not an environment of this service (${choices.join(', ')})`,
      );
    }
    if (parsed.env === account.defaultEnv) return account;
    const before = await this.deps.futureResources?.snapshot(account.id);
    const updated = await this.deps.store.accounts.setDefaultEnv(account.id, parsed.env);
    await this.deps.audit.write({
      kind: 'admin',
      ts: this.nowIso(),
      user_id: actor.user.id,
      act: 'account-default-env-set',
      object: { type: 'account', id: account.id },
      before: { default_env: account.defaultEnv },
      after: { default_env: updated.defaultEnv },
    });
    this.deps.logger.info('account default environment set by its owner', {
      account_id: account.id,
      user_id: actor.user.id,
      default_env: updated.defaultEnv,
    });
    // The resources inheriting the default were relabelled with it.
    if (before) await this.deps.futureResources?.settle(account.id, before, actor.user.id);
    return updated;
  }

  /**
   * The owner's name for the account: how it reads in the lists, the missions and the
   * Record. Any owner, a personal (`host`) account included; never a disconnected one.
   * Blank is refused; an unchanged name writes nothing. Audited (`account-renamed`).
   */
  async rename(actor: Actor, accountId: string, raw: string): Promise<AccountRecord> {
    const account = await this.requireOwned(actor, accountId);
    if (account.status === 'revoked') throw new ConnectError('account-revoked');
    const name = cleanName(raw);
    if (name === null) throw new ConnectError('invalid-input', 'the name cannot be empty');
    if (name === account.displayName) return account;
    const updated = await this.deps.store.accounts.setDisplayName(account.id, name);
    await this.deps.audit.write({
      kind: 'admin',
      ts: this.nowIso(),
      user_id: actor.user.id,
      act: 'account-renamed',
      object: { type: 'account', id: account.id },
      before: { display_name: account.displayName },
      after: { display_name: updated.displayName },
    });
    this.deps.logger.info('account renamed by its owner', {
      account_id: account.id,
      user_id: actor.user.id,
    });
    return updated;
  }

  // ── Revoke ────────────────────────────────────────────────────────────────

  /**
   * Terminal. The sealed credential is erased, and the missions that carry
   * the account lose their part on it for good: they keep serving through
   * their other accounts, and one with no other part left is `orphaned`
   * and stays so — a revoked account never comes back (spec §2.3, §7.8; ADR
   * orphaned-missions-and-ownerless-connections, amendment 2026-10-21).
   *
   * The grant at the service is withdrawn too when the service documents
   * how (`CredentialBroker.withdrawAtService`). In this order, on purpose:
   * the credential is read, the account is revoked here, and only then is
   * the service asked — the local revocation never waits for the service
   * and never depends on its answer. What the service answered is stored on
   * the account (`serviceGrant`) and written in the entry, so that a
   * grant that still stands stays visible until somebody removes it by hand.
   */
  async revoke(actor: Actor, accountId: string): Promise<AccountRecord> {
    const account = await this.requireOwned(actor, accountId);
    if (account.status === 'revoked') return account;
    const watch = await this.deps.grounds.watchAccount(account.id);
    // Read before the erase: the service's endpoint wants the token the store is about to drop.
    const held = await this.deps.broker.forRevocation(account.id);
    let revoked = await this.deps.store.accounts.revoke(account.id);
    const serviceGrant = await this.deps.broker.withdrawAtService(revoked, held);
    try {
      revoked =
        (await this.deps.store.accounts.recordServiceGrant(revoked.id, serviceGrant)) ?? revoked;
    } catch (err) {
      // The revocation stands and the entry below still says what the service answered.
      this.deps.logger.error('service grant outcome not stored', {
        account_id: revoked.id,
        service_grant: serviceGrant,
        error_class: err instanceof Error ? err.name : typeof err,
      });
    }
    // Settled whatever happens to the act's own entry: the revocation is committed, and
    // the entries that say which missions stopped serving must not depend on it.
    try {
      await this.audit(
        actor.user.id,
        'account-revoked',
        revoked,
        { status: account.status },
        { service_grant: serviceGrant },
      );
    } finally {
      await watch.settle(actor.user.id);
    }
    this.deps.logger.info('account revoked', {
      account_id: revoked.id,
      service: revoked.service,
      user_id: actor.user.id,
      service_grant: serviceGrant,
    });
    return revoked;
  }

  // ── Ownership ─────────────────────────────────────────────────────────────

  /**
   * The groups the actor may hand this account to: the ones they belong to
   * now, the current owner group excepted (spec §11.2: never a group one is
   * not a member of). None for an account that takes no owner act, which
   * `transfer` refuses.
   */
  transferTargets(actor: Actor, account: AccountRecord): GroupRecord[] {
    if (ownerActRefusal(account)) return [];
    return actor.groups.filter(
      (g) => !(account.owner.kind === 'group' && account.owner.id === g.id),
    );
  }

  /**
   * Transfers ownership to a group the actor belongs to (spec §7.2): every
   * current and future member of that group is then a full owner. Shares of
   * the account are kept. Members of a previous owner group who are not in
   * the new one lose their authority, members of the new one gain it: the
   * missions of the account are watched across the transfer.
   */
  async transfer(actor: Actor, accountId: string, groupId: string): Promise<AccountRecord> {
    const account = await this.requireOwned(actor, accountId);
    const refusal = ownerActRefusal(account);
    if (refusal) throw new ConnectError(refusal);
    const group = actor.groups.find((g) => g.id === groupId);
    if (!group) throw new ConnectError('transfer-not-member');
    if (account.owner.kind === 'group' && account.owner.id === group.id) return account;

    const watch = await this.deps.grounds.watchAccount(account.id);
    const transferred = await this.deps.store.accounts.transferOwner(account.id, {
      kind: 'group',
      id: group.id,
    });
    try {
      await this.audit(actor.user.id, 'account-transferred', transferred, {
        owner: account.owner,
      });
    } finally {
      await watch.settle(actor.user.id);
    }
    this.deps.logger.info('account transferred', {
      account_id: transferred.id,
      group_id: group.id,
      user_id: actor.user.id,
    });
    return transferred;
  }

  /** Operator: the accounts nobody owns any more (`unowned`, or expired with an empty owner group). */
  async listOwnerless(): Promise<AccountView[]> {
    const ownerless = await this.deps.store.accounts.listOwnerless();
    return Promise.all(ownerless.map((c) => this.view(c)));
  }

  /**
   * Operator only (the caller authorizes; `operatorId` is the audit actor):
   * gives an ownerless account a new owner. An `unowned` account is
   * `active` again; an `expired` one stays `expired` until its new owner
   * reconnects. Nothing else of the account is reachable from here: no
   * credential, no share, no mission. The missions the emptied owner group
   * had left orphaned serve again when their creator is the new owner, or a
   * member of the new owner group.
   *
   * The rule "only an account that has no owner left" is enforced by the
   * write itself (`AccountsRepo.assignOwnerlessTo`, one transaction with
   * the "new owner group has a member" check). The reads before it only
   * choose which refusal is named first; a member who joins the owner group,
   * or the last one who leaves the new group, while this method awaits is
   * seen by the write and the reassignment is refused.
   */
  async reassign(
    operatorId: string,
    accountId: string,
    newOwner: NewOwner,
  ): Promise<AccountRecord> {
    const { accounts } = this.deps.store;
    const seen = await accounts.getById(accountId);
    if (!seen) throw new ConnectError('not-found');
    // A host account is its person's own: it is never handed to anyone else.
    if (isHostAccount(seen)) throw new ConnectError('account-personal');
    if (!(await this.looksOwnerless(seen))) throw new ConnectError('not-ownerless');
    const owner = await this.resolveNewOwner(newOwner);
    const watch = await this.deps.grounds.watchAccount(seen.id);
    const result = await accounts.assignOwnerlessTo(seen.id, owner);
    // Refused at the write: nothing changed, so there is nothing to settle.
    if (result.outcome !== 'assigned') throw new ConnectError(result.outcome);
    const { previous, account: reassigned } = result;
    try {
      await this.audit(operatorId, 'account-reassigned', reassigned, {
        owner: previous.owner,
        status: previous.status,
      });
    } finally {
      await watch.settle(operatorId);
    }
    this.deps.logger.info('account reassigned by the operator', {
      account_id: reassigned.id,
      owner_kind: owner.kind,
      owner_id: owner.id,
    });
    return reassigned;
  }

  /**
   * Operator: the groups `reassign` would accept as the new owner — the ones that
   * have a member (an empty group would leave the account ownerless again).
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
  private async looksOwnerless(account: AccountRecord): Promise<boolean> {
    if (account.status === 'unowned') return true;
    if (account.status === 'revoked') return false;
    if (account.owner.kind === 'user') {
      // An owner the operator deactivated holds nothing: the account is ownerless.
      const owner = await this.deps.store.users.getById(account.owner.id);
      return owner?.status !== 'active';
    }
    return (await this.deps.store.groups.memberCount(account.owner.id)) === 0;
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

  private requirePlugin(serviceId: string): ServicePlugin {
    const registered = this.deps.registry.get(serviceId);
    if (!registered) throw new ConnectError('service-unknown');
    return registered.plugin;
  }

  private returnToOf(raw: string | null | undefined): string | null {
    if (!raw) return null;
    const path = resolveReturnTo(raw, this.deps.publicUrl);
    if (path === null) throw new ConnectError('return-url-refused');
    return path;
  }

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

  private async requireReconnectable(
    actor: Actor,
    accountId: string,
    serviceId: string,
  ): Promise<AccountRecord> {
    const account = await this.requireOwned(actor, accountId);
    if (account.service !== serviceId) throw new ConnectError('service-mismatch');
    // Spec §2.3: nobody reconnects an unowned account until an owner is reassigned.
    const refusal = ownerActRefusal(account);
    if (refusal) throw new ConnectError(refusal);
    return account;
  }

  /**
   * The OAuth client of a flow, or the `ConnectError` the page shows: a
   * registration the service refused (`client-registration-failed`) or could not take
   * (`service-unreachable`), a registered client gone between the start and
   * the callback (`state-invalid`: start again).
   */
  private async clientOrThrow(
    plugin: ServicePlugin,
    get: () => Promise<OAuth2Client>,
  ): Promise<OAuth2Client> {
    try {
      return await get();
    } catch (err) {
      if (err instanceof OAuth2ClientMissing) throw new ConnectError('state-invalid');
      if (err instanceof OAuth2RegistrationError) {
        this.deps.logger.warn('OAuth client registration failed', {
          service: plugin.id,
          failure: serviceFailureReason(err),
        });
        throw new ConnectError(
          err.rejected ? 'client-registration-failed' : 'service-unreachable',
          `${plugin.displayName}: ${serviceFailureReason(err)}`,
        );
      }
      throw err;
    }
  }

  /**
   * What the plugin of an account says about withdrawing its grant, with the
   * service's label. Read from the registry alone: it answers for a revoked
   * account too, and for a service whose plugin is gone (nothing is known,
   * so the person removes the access by hand).
   */
  serviceGrantOf(
    account: Pick<AccountRecord, 'service'> & Partial<Pick<AccountRecord, 'metadata'>>,
  ): {
    readonly serviceLabel: string;
    readonly grant: ServiceGrantView;
  } {
    const plugin = this.deps.registry.get(account.service)?.plugin;
    if (!plugin) {
      return {
        serviceLabel: account.service,
        grant: { withdrawnByGateway: false, byHand: null },
      };
    }
    const kind = accountCredentialKind(account, plugin.credential.kind) ?? plugin.credential.kind;
    return {
      serviceLabel: plugin.displayName,
      grant: {
        withdrawnByGateway: canWithdraw(plugin, kind),
        byHand: plugin.manualRevocation ?? null,
      },
    };
  }

  private async view(account: AccountRecord): Promise<AccountView> {
    const registered = this.deps.registry.get(account.service);
    const metadata = account.metadata ?? {};
    const kind = accountCredentialKind(account, registered?.plugin.credential.kind ?? null);
    const pasted = kind === 'api-key';
    // What the service said the account is: the pasted token's `verify`, or the broker's redeem.
    const accountSaid = pasted || kind === 'oauth2';
    return {
      account,
      service_label: registered?.plugin.displayName ?? account.service,
      resource_noun: resourceNounOf(registered?.plugin ?? null),
      service_icon: registered ? serviceIconOf(registered.plugin) : null,
      service_grant: this.serviceGrantOf(account).grant,
      credential_kind: kind,
      way_retired: registered ? isRetiredWay(kind, registered.plugin.credential.kind) : false,
      token_account: accountSaid && typeof metadata.account === 'string' ? metadata.account : null,
      oauth_broker: this.oauthBrokerOf(metadata),
      token_expires_at: pasted ? account.credentialExpiresAt : null,
      token_lacks:
        pasted && registered ? tokenLacks(registered.plugin.credential, metadata.granted) : null,
      owner_label: await this.ownerLabel(account),
      public_key: typeof metadata.public_key === 'string' ? metadata.public_key : null,
      fields: accountPublicFields(account),
      discovery: discoveryOf(metadata.discovery),
    };
  }

  /** The broker named at connect time (`metadata.oauth_broker`), as configured now. */
  private oauthBrokerOf(metadata: Record<string, unknown>): AccountView['oauth_broker'] {
    const name = metadata.oauth_broker;
    if (typeof name !== 'string') return null;
    return { name, attested: this.deps.brokers.byName(name)?.attested ?? null };
  }

  private async ownerLabel(account: AccountRecord): Promise<string> {
    const owner = await accountOwnerOf(this.deps.store, account);
    if (owner.kind === 'user') return owner.name ?? 'unknown user';
    return owner.name === null ? 'unknown group' : `group ${owner.name}`;
  }

  private async audit(
    actorId: string,
    act:
      | 'account-created'
      | 'account-reconnected'
      | 'account-revoked'
      | 'account-transferred'
      | 'account-reassigned',
    account: AccountRecord,
    before: unknown,
    extra: Readonly<Record<string, string>> = {},
  ): Promise<void> {
    await this.deps.audit.write({
      kind: 'admin',
      ts: this.nowIso(),
      user_id: actorId,
      act,
      object: { type: 'account', id: account.id },
      before,
      after: {
        service: account.service,
        display_name: account.displayName,
        status: account.status,
        owner: account.owner,
        ...extra,
      },
    });
  }

  /** One entry per save that changed something; a save that changed nothing writes none. */
  private async auditResourceEdit(
    actor: Actor,
    account: AccountRecord,
    before: ResourceAuditView,
    after: ResourceAuditView,
  ): Promise<void> {
    if (JSON.stringify(before) === JSON.stringify(after)) return;
    await this.deps.audit.write({
      kind: 'admin',
      ts: this.nowIso(),
      user_id: actor.user.id,
      act: 'resource-edited',
      object: { type: 'account', id: account.id },
      before,
      after,
    });
  }

  nowIso(): string {
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

function resourceAuditView(resource: AccountResourceRecord): ResourceAuditView {
  return {
    resource_id: resource.id,
    ref: resource.ref,
    display_name: resource.displayName,
    // The resource's own label, the one edited here; the account's default is audited apart.
    env: ownResourceEnv(resource),
    hidden: resource.hidden,
    owner_metadata: resource.ownerMetadata,
  };
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

/** A step with its screenshot resolved: served from the plugin's folder, its provenance derived. */
function stepView(
  plugin: ServicePlugin,
  screenshots: TokenGuide['screenshots'],
  step: GuideStep,
): GuideStepView {
  const shot = step.screenshot === undefined ? undefined : screenshots?.[step.screenshot];
  return {
    ...step,
    figure:
      step.screenshot !== undefined && shot !== undefined
        ? {
            url: connectFileUrl(plugin.id, step.screenshot),
            alt: shot.alt,
            attribution: screenshotAttribution(plugin.displayName, shot),
          }
        : null,
  };
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
