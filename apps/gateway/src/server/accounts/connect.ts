/**
 * Connecting an account (spec §0 "Account"; ADR one-place-to-authorize-services-token-first):
 * the one generic driver over the `CredentialSpec` kinds, from `start` to the stored,
 * sealed and audited account.
 *
 *   api-key      start(): the form values, checked at paste and by a first discovery
 *   oauth2       start(): authorization redirect with a single-use `state` and PKCE
 *                complete(): code exchange with the OAuth client the gateway
 *                registered at the service itself (`OAuth2Clients`) — or, for a
 *                brokered spec, `POST /flows` at the OAuth broker, then the
 *                one-time grant redeemed there (`OAuthBrokers`; ADR
 *                google-calendar-through-an-oauth-broker)
 *   ssh-key      start(): an ed25519 key pair generated here, public key shown
 *   host         start(): one button, the person's own account (`connectHost`)
 *
 * The import from v4 creates accounts through the same path. The account service
 * delegates these acts here and lends ownership and the callback URL (`AccountConnectHost`).
 */
import { isUpstreamAuthError } from '@vaubaan/shared';
import {
  type ApiKeyCredentialSpec,
  type CredentialCheck,
  type CredentialSecret,
  isBrokeredSpec,
  type OAuth2BrokeredSpec,
  type OAuth2RegisteredClientSpec,
  type ServicePlugin,
  type SshKeyCredentialSpec,
} from '@vaubaan/plugin-sdk';

import { HostAccountTakenError } from '../store/errors';
import { toIso } from '../store/clock';
import type { AccountRecord } from '../store/types';
import { auditAccountAct } from './account-audit';
import type {
  AccountServiceDeps,
  Actor,
  Connected,
  DiscoveryPolicy,
  DiscoveryRecord,
  ImportPastedInput,
  ImportSshInput,
  StartInput,
  StartResult,
} from './account-views';
import { serializeSecret, type BrokerGrant } from './credential-codec';
import { DISCOVERY_TIMEOUT_MS, isTransportFailure, type AccountDiscovery } from './discovery';
import { ConnectError } from './errors';
import { serviceFailureReason } from './failure-reason';
import {
  cleanName,
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
import { brokerNotConfiguredReason, OAuthBrokerError, type BrokerSource } from './oauth-broker';
import { ownerActRefusal } from './ownership';
import type { PendingConnect, PendingFlowKind } from './pending';
import { generateEd25519KeyPair } from './ssh-keypair';
import { grantedNames } from './token-permissions';

/** An OAuth `error` code is a token of the protocol (RFC 6749 §4.1.2.1), never free text. */
const PROTOCOL_ERROR_CODE = /^[a-z_]{1,40}$/;

/** Connect attempts (starts, callbacks, form posts) one user may make per window. */
export const CONNECT_RATE_LIMIT = 10;
export const CONNECT_RATE_WINDOW_MS = 60_000;
const SSH_KEY_COMMENT = 'vaubaan-gateway';

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

/** What the connect flows read of the account service. */
export interface AccountConnectHost {
  requireOwned(actor: Actor, accountId: string): Promise<AccountRecord>;
  /** The URL the service sends the browser back to. */
  callbackUrl(serviceId: string): URL;
}

export class AccountConnect {
  constructor(
    private readonly deps: AccountServiceDeps,
    private readonly host: AccountConnectHost,
    private readonly discovery: AccountDiscovery,
  ) {}

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
        userId: flow.actor.user.id,
      });
      return { kind: 'redirect', url: url.href };
    } catch (err) {
      throw this.brokerFailure(flow.plugin, err);
    }
  }

  /** The broker that serves a brokered plugin, or `broker-not-configured`. */
  private brokerOrThrow(plugin: ServicePlugin, spec: OAuth2BrokeredSpec): BrokerSource {
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
      redirectUri: this.host.callbackUrl(flow.plugin.id).href,
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
    const first = await this.discovery.firstDiscovery(plugin, secret, options.discovery);
    const account = await this.persist(actor, plugin, secret, options);

    let discovery: DiscoveryRecord | null = null;
    if (first.resources) {
      discovery = await this.discovery.storeDiscovery(account, plugin, first.resources, {
        actorId: actor.user.id,
      });
    } else if (first.error) {
      discovery = await this.discovery.recordDiscovery(account.id, 0, first.error);
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
      await auditAccountAct(this.deps, actor.user.id, 'account-created', created, null);
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
    await auditAccountAct(this.deps, actor.user.id, 'account-reconnected', reconnected, null);
    return reconnected;
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

  private nowIso(): string {
    return toIso(this.deps.clock.now());
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

  private async requireReconnectable(
    actor: Actor,
    accountId: string,
    serviceId: string,
  ): Promise<AccountRecord> {
    const account = await this.host.requireOwned(actor, accountId);
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
}
