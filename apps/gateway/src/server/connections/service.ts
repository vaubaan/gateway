/**
 * Connections (spec §0 "Connection", "Resource"; §2.3 states; §7.2).
 *
 * One generic driver over the four `CredentialSpec` kinds — the plugin
 * declares, the host runs the flow:
 *
 *   oauth2       start(): authorization redirect with a single-use `state` and PKCE
 *                complete(): code exchange with the company's OAuth client
 *   app-install  start(): redirect to the app's installation page with a `state`
 *                complete(): the installation id of the callback, accepted only once
 *                the provider confirms the authorizing user can reach it
 *                (`install-verification.ts`); a spec that cannot prove it is
 *                refused unless the operator accepted unverified installations
 *   api-key      start(): the form values, checked by a first discovery
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
import { isCredentialKind, UpstreamAuthError, type CredentialKind } from '@vaubaan/shared';
import {
  appCredentialSpecOf,
  credentialSpecFor,
  credentialSpecsOf,
  isAppCredentialSpec,
  type ApiKeyCredentialSpec,
  type AppInstallCredentialSpec,
  type ConnectionContext,
  type CredentialCheck,
  type CredentialField,
  type CredentialSecret,
  type CredentialSpec,
  type OAuth2CredentialSpec,
  type PluginRegistry,
  type ProviderPlugin,
  type Resource,
  type SshKeyCredentialSpec,
  type TokenPermissionAccess,
} from '@vaubaan/plugin-sdk';
import type { AuditWriter } from '@vaubaan/gateway-core';

import { findActiveUserByEmail, type MissionGrounds } from '../authority';
import type { RateLimiter } from '../compose/ports';
import type { Logger } from '../logging';
import {
  CLIENT_ID_FIELD,
  CLIENT_SECRET_FIELD,
  needsProviderApp,
  ProviderAppNotConfigured,
  type ProviderAppsService,
} from '../provider-apps';
import type { Store } from '../store';
import { toIso, type Clock } from '../store/clock';
import type {
  ConnectionRecord,
  ConnectionResourceRecord,
  DiscoveredResource,
  GroupRecord,
  Principal,
  UserRecord,
} from '../store/types';
import { serializeSecret } from './credential-codec';
import type { CredentialBroker } from './credentials';
import { canWithdraw } from './credentials';
import { ConnectError, errorMessage, oneLine } from './errors';
import {
  cleanName,
  editableMetadataKeys,
  parseEnvLabel,
  parseListValue,
  readCredentialFields,
  resolveReturnTo,
  type FieldValues,
} from './input';
import {
  InstallationRefused,
  InstallationVerificationUnavailable,
  verifyInstallation,
  type InstallationRefusalReason,
} from './install-verification';
import {
  buildAuthorizationUrl,
  exchangeCode,
  newCodeVerifier,
  OAuth2TokenError,
  type OAuth2Client,
} from './oauth2';
import { connectionCredentialKind, connectionOwnerOf } from './mapping';
import type { PendingConnect, PendingConnectStore, PendingFlowKind } from './pending';
import { generateEd25519KeyPair } from './ssh-keypair';

/** Connect attempts (starts, callbacks, form posts) one user may make per window. */
export const CONNECT_RATE_LIMIT = 10;
export const CONNECT_RATE_WINDOW_MS = 60_000;
/** A discovery that does not finish within this delay is reported as failed. */
export const DISCOVERY_TIMEOUT_MS = 30_000;
/** The pages of the accounts a person can use ("connections" in the spec and the store). */
export const CONNECTIONS_PATH = '/accounts';
/**
 * Where a provider sends the browser back after an authorization. This path is
 * registered at the provider (the callback URL of the company's GitHub App, the
 * redirect URI of its OAuth apps): it is part of the protocol, so it kept its name
 * when the pages moved to `/accounts`.
 */
export const CONNECT_CALLBACK_PATH = '/connections/callback';
const INSTALLATION_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const SSH_KEY_COMMENT = 'vaubaan-gateway';

/** Why a connect attempt was refused before anything was stored (audit `after.reason`). */
export type ConnectRefusalReason =
  | InstallationRefusalReason
  /** The callback carried no authorization code. */
  | 'no-authorization-code'
  /** The plugin declares no verification and the operator did not accept that. */
  | 'verification-not-supported';

/** How the installation behind a connection was bound to its owner (`metadata.installation_verification`). */
export type InstallationBinding = 'user-authorization' | 'none';

/** The human behind a request, with their *current* groups (never a snapshot). */
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
  readonly steps: readonly string[];
  readonly permissions: readonly TokenPermissionView[];
  readonly recommendedExpiryDays: number | null;
  readonly docsUrl: string | null;
}

/** A tool a way of connecting cannot run, and why. */
export interface UnavailableToolView extends ToolLabel {
  readonly reason: string;
}

/**
 * One way an account of a service can be connected (ADR
 * token-connections-beside-the-integration-app): through the company's app,
 * or with a token pasted by hand, each with what the form asks and what it
 * cannot do.
 */
export interface ConnectMethod {
  readonly kind: CredentialKind;
  /** Goes through an app the company registers at the service. */
  readonly usesApp: boolean;
  /** Usable now: its app is registered (and verifiable), or it needs none. */
  readonly configured: boolean;
  /** The fields of the connect form (`api-key`, `ssh-key`); empty for redirect flows. */
  readonly fields: readonly CredentialField[];
  /** Where the user creates the key (`api-key`). */
  readonly createUrl: string | null;
  /** What the person creates, in the service's words (`api-key`): "fine-grained personal access token". */
  readonly label: string | null;
  readonly guide: TokenGuideView | null;
  readonly unavailableTools: readonly UnavailableToolView[];
}

export interface ConnectableProvider {
  readonly id: string;
  readonly displayName: string;
  readonly description: string | null;
  readonly experimental: boolean;
  /** The way offered first (`defaultMethod`); the four fields below are its own. */
  readonly kind: CredentialKind;
  /** At least one way can be used now: users may connect. */
  readonly configured: boolean;
  /** The fields of the connect form (`api-key`, `ssh-key`); empty for redirect flows. */
  readonly fields: readonly CredentialField[];
  /** Where the user creates the key (`api-key`). */
  readonly createUrl: string | null;
  /**
   * Every way the plugin declares, primary first. The offered one is the
   * first that is `configured` (the company's app when it is registered),
   * else the primary.
   */
  readonly methods: readonly ConnectMethod[];
}

/** The way a page offers first: the first one usable now, else the primary. */
export function defaultMethod(provider: Pick<ConnectableProvider, 'methods'>): ConnectMethod {
  const first = provider.methods[0];
  if (!first) throw new Error('a provider declares at least one way of connecting');
  return provider.methods.find((m) => m.configured) ?? first;
}

/** The way of this kind, or `null` when the service does not connect that way. */
export function methodOf(
  provider: Pick<ConnectableProvider, 'methods'>,
  kind: string | null | undefined,
): ConnectMethod | null {
  return provider.methods.find((m) => m.kind === kind) ?? null;
}

export interface DiscoveryRecord {
  readonly at: string;
  readonly ok: boolean;
  readonly count: number;
  /** The provider's (or the plugin's) own message when the discovery failed. */
  readonly error: string | null;
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
  readonly providerLabel: string;
  readonly providerGrant: ProviderGrantView;
  readonly experimental: boolean;
  /** How this account was made (`connectionCredentialKind`); `null` when unknown and the plugin is gone. */
  readonly credentialKind: CredentialKind | null;
  /** What the service said the pasted token acts as, at connect time (`octocat`); `null` when not said. */
  readonly tokenAccount: string | null;
  /** When the pasted token stops working, as the service said at connect time; `null` when it did not. */
  readonly tokenExpiresAt: string | null;
  /** Tools of the service an account made this way cannot run, and why. */
  readonly unavailableTools: readonly UnavailableToolView[];
  readonly ownerLabel: string;
  /** `ssh-key`: the line to append to `authorized_keys`. */
  readonly publicKey: string | null;
  /** Non-secret values the user entered (team id, host, user…). */
  readonly fields: Readonly<Record<string, string>>;
  readonly discovery: DiscoveryRecord | null;
}

export interface ConnectionDetail extends ConnectionView {
  readonly resources: readonly ConnectionResourceRecord[];
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
   * The way to connect, a credential kind the plugin declares. Absent: the
   * kind of the account being reconnected, else the way offered first.
   */
  readonly method?: string | null;
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
  /** The three repositories the service reads and writes; never the raw handle. */
  readonly store: Pick<Store, 'connections' | 'users' | 'groups'>;
  readonly registry: PluginRegistry;
  readonly providerApps: ProviderAppsService;
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
}

/** How a failed first discovery is treated when a credential has just been obtained. */
type DiscoveryPolicy =
  /** Any failure refuses the connection: the user can simply retry (api-key form). */
  | 'required'
  /** Only a rejection by the provider refuses it (a forged installation id). */
  | 'reject-auth-failure'
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

  /** Every registered plugin, in registry order; the picker shows the `configured` ones. */
  async providers(): Promise<ConnectableProvider[]> {
    return Promise.all(this.deps.registry.ids.map((id) => this.describe(id)));
  }

  async provider(providerId: string): Promise<ConnectableProvider | null> {
    return this.deps.registry.has(providerId) ? this.describe(providerId) : null;
  }

  private async describe(providerId: string): Promise<ConnectableProvider> {
    const { plugin } = this.deps.registry.require(providerId);
    const app = appCredentialSpecOf(plugin);
    // An installation nobody can verify is not connectable until the operator says so.
    const status =
      app && needsProviderApp(app) ? await this.deps.providerApps.status(providerId) : null;
    const appConfigured =
      status === null || (status.configured && status.installVerification !== 'unverified-refused');
    const methods = credentialSpecsOf(plugin).map((spec) =>
      methodView(plugin, spec, isAppCredentialSpec(spec) ? appConfigured : true),
    );
    const offered = defaultMethod({ methods });
    return {
      id: plugin.id,
      displayName: plugin.displayName,
      description: plugin.description ?? null,
      experimental: plugin.experimental === true,
      kind: offered.kind,
      configured: methods.some((m) => m.configured),
      fields: offered.fields,
      createUrl: offered.createUrl,
      methods,
    };
  }

  /**
   * The spec a connect flow runs: the way the form chose, else the way of the
   * account being reconnected, else the way offered first. A way the plugin
   * does not declare is refused.
   */
  private async chooseSpec(
    plugin: ProviderPlugin,
    method: string | null | undefined,
    reconnect: ConnectionRecord | null,
  ): Promise<CredentialSpec> {
    if (method) {
      const chosen = isCredentialKind(method) ? credentialSpecFor(plugin, method) : null;
      if (!chosen) {
        throw new ConnectError(
          'invalid-input',
          `${plugin.displayName} cannot be connected that way (${method.slice(0, 40)})`,
        );
      }
      return chosen;
    }
    if (reconnect) {
      const kind = connectionCredentialKind(reconnect, plugin.credential.kind);
      const same = kind ? credentialSpecFor(plugin, kind) : null;
      if (same) return same;
    }
    const offered = defaultMethod(await this.describe(plugin.id));
    return credentialSpecFor(plugin, offered.kind) ?? plugin.credential;
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
    };
  }

  // ── Connect ───────────────────────────────────────────────────────────────

  async start(actor: Actor, providerId: string, input: StartInput = {}): Promise<StartResult> {
    await this.limit(actor);
    const plugin = this.requirePlugin(providerId);
    const returnTo = this.returnToOf(input.returnTo);
    const reconnect = input.reconnectId
      ? await this.requireReconnectable(actor, input.reconnectId, providerId)
      : null;
    const flow: FlowStart = {
      actor,
      plugin,
      displayName: cleanName(input.displayName) ?? reconnect?.displayName ?? plugin.displayName,
      returnTo,
      reconnectId: reconnect?.id ?? null,
    };
    const spec = await this.chooseSpec(plugin, input.method, reconnect);

    switch (spec.kind) {
      case 'oauth2':
        return this.startOAuth2(flow, spec);
      case 'app-install':
        return this.startAppInstall(flow, spec);
      case 'api-key':
        return this.connectWithApiKey(flow, spec, input);
      case 'ssh-key':
        return this.connectWithSshKey(flow, spec, input);
    }
  }

  private async startOAuth2(flow: FlowStart, spec: OAuth2CredentialSpec): Promise<StartResult> {
    const client = await this.oauthClient(flow.plugin);
    const pending = this.newPending('oauth2', flow, spec.pkce ? newCodeVerifier() : null);
    const state = await this.deps.pending.create(pending);
    const url = buildAuthorizationUrl(spec, client, {
      redirectUri: pending.redirectUri,
      state,
      codeVerifier: pending.codeVerifier,
    });
    return { kind: 'redirect', url: url.href };
  }

  private async startAppInstall(
    flow: FlowStart,
    spec: AppInstallCredentialSpec,
  ): Promise<StartResult> {
    const providerId = flow.plugin.id;
    const appConfig = await this.hostAppConfig(providerId);
    // Refused before the user is sent anywhere; checked again on the callback.
    if (
      !spec.userVerification &&
      (await this.deps.providerApps.installVerification(providerId)) !== 'unverified-accepted'
    ) {
      throw new ConnectError('installation-unverifiable');
    }
    const url = new URL(spec.installUrl(appConfig));
    const state = await this.deps.pending.create(this.newPending('app-install', flow, null));
    url.searchParams.set('state', state);
    return { kind: 'redirect', url: url.href };
  }

  private async connectWithApiKey(
    flow: FlowStart,
    spec: ApiKeyCredentialSpec,
    input: StartInput,
  ): Promise<StartResult> {
    const read = this.readFormOrThrow(spec.fields, input);
    const secret: CredentialSecret = {
      kind: 'api-key',
      fields: read.values,
      metadata: read.visible,
    };
    const check = await this.verifyPasted(flow.plugin, spec, secret);
    const connected = await this.finalize(flow.actor, flow.plugin, secret, {
      displayName: flow.displayName,
      reconnectId: flow.reconnectId,
      returnTo: flow.returnTo,
      discovery: 'required',
      metadata: {
        fields: read.visible,
        ...(check ? { account: check.account, expires_at: check.expiresAt } : {}),
      },
      expiresAt: check?.expiresAt ?? null,
    });
    return { kind: 'connected', ...connected };
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
        appConfig: await this.deps.providerApps.pluginAppConfig(plugin.id),
        fetch: this.deps.fetch,
        signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
      });
    } catch (err) {
      const rejected = err instanceof UpstreamAuthError || !isTransportFailure(err);
      throw new ConnectError(
        rejected ? 'credential-rejected' : 'provider-unreachable',
        `${plugin.displayName}: ${errorMessage(err)}`,
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
    };
  }

  private async connectWithSshKey(
    flow: FlowStart,
    spec: SshKeyCredentialSpec,
    input: StartInput,
  ): Promise<StartResult> {
    const read = this.readFormOrThrow(spec.fields, input);
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
      createdAt: this.nowIso(),
    };
  }

  /** The form values of an `api-key` / `ssh-key` connect, or `invalid-input` naming each problem. */
  private readFormOrThrow(fields: readonly CredentialField[], input: StartInput): FieldValues {
    const read = readCredentialFields(fields, input.fields ?? {});
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

    if (pending.kind === 'oauth2') {
      const spec = credentialSpecFor(plugin, 'oauth2');
      if (spec) return this.completeOAuth2(actor, plugin, spec, pending, query);
    }
    if (pending.kind === 'app-install') {
      const spec = credentialSpecFor(plugin, 'app-install');
      if (spec) return this.completeAppInstall(actor, plugin, spec, pending, query);
    }
    throw new ConnectError('state-invalid');
  }

  private async completeOAuth2(
    actor: Actor,
    plugin: ProviderPlugin,
    spec: OAuth2CredentialSpec,
    pending: PendingConnect,
    query: URLSearchParams,
  ): Promise<Connected> {
    const denied = query.get('error');
    if (denied) {
      const description = query.get('error_description');
      throw new ConnectError('provider-denied', description ? `${denied}: ${description}` : denied);
    }
    const code = query.get('code');
    if (!code) throw new ConnectError('provider-denied', 'no authorization code was returned');
    let secret: CredentialSecret;
    try {
      secret = await exchangeCode(
        spec,
        await this.oauthClient(plugin),
        { code, redirectUri: pending.redirectUri, codeVerifier: pending.codeVerifier },
        { fetch: this.deps.fetch, now: () => this.deps.clock.now() },
      );
    } catch (err) {
      if (err instanceof OAuth2TokenError) {
        throw new ConnectError(
          err.rejected ? 'token-exchange-failed' : 'provider-unreachable',
          err.message,
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

  private async completeAppInstall(
    actor: Actor,
    plugin: ProviderPlugin,
    spec: AppInstallCredentialSpec,
    pending: PendingConnect,
    query: URLSearchParams,
  ): Promise<Connected> {
    const installationId = query.get(spec.installationIdParam);
    if (!installationId || !INSTALLATION_ID_PATTERN.test(installationId)) {
      throw new ConnectError(
        'provider-denied',
        'no installation was returned (it may be awaiting approval by an account owner)',
      );
    }
    const binding = await this.bindInstallation(actor, plugin, spec, pending, query, {
      installationId,
    });
    const secret: CredentialSecret = { kind: 'app-install', installationId, metadata: {} };
    return this.finalize(actor, plugin, secret, {
      displayName: pending.displayName,
      reconnectId: pending.reconnectId,
      returnTo: pending.returnTo,
      discovery: 'reject-auth-failure',
      metadata: { installation_id: installationId, installation_verification: binding },
    });
  }

  /**
   * Proves that the human behind the callback can reach the installation it
   * names, or refuses. A refusal stores nothing and leaves an audit entry; an
   * unreachable provider is not a refusal (the user retries).
   */
  private async bindInstallation(
    actor: Actor,
    plugin: ProviderPlugin,
    spec: AppInstallCredentialSpec,
    pending: PendingConnect,
    query: URLSearchParams,
    claim: { readonly installationId: string },
  ): Promise<InstallationBinding> {
    const refuse = async (
      reason: ConnectRefusalReason,
      error: ConnectError,
    ): Promise<ConnectError> => {
      await this.auditRefusal(actor, plugin, pending, claim.installationId, reason);
      this.deps.logger.warn('connection refused: installation not bound to the user', {
        provider: plugin.id,
        user_id: actor.user.id,
        installation_id: claim.installationId,
        reason,
      });
      return error;
    };

    const verification = spec.userVerification;
    if (!verification) {
      const accepted =
        (await this.deps.providerApps.installVerification(plugin.id)) === 'unverified-accepted';
      if (!accepted) {
        throw await refuse(
          'verification-not-supported',
          new ConnectError('installation-unverifiable'),
        );
      }
      this.deps.logger.warn('installation accepted without verification (operator setting)', {
        provider: plugin.id,
        user_id: actor.user.id,
        installation_id: claim.installationId,
      });
      return 'none';
    }

    const code = query.get(verification.codeParam);
    if (!code) {
      const denied = query.get('error');
      throw await refuse(
        'no-authorization-code',
        new ConnectError(
          'installation-not-verified',
          denied
            ? `the authorization was not granted (${denied})`
            : 'the provider returned no user authorization; the app must request user authorization during installation',
        ),
      );
    }
    const app = await this.hostAppConfig(plugin.id);
    const clientId = app[CLIENT_ID_FIELD];
    const clientSecret = app[CLIENT_SECRET_FIELD];
    if (!clientId || !clientSecret) throw new ConnectError('app-not-configured');
    try {
      await verifyInstallation(
        verification,
        { clientId, clientSecret },
        { installationId: claim.installationId, code },
        { fetch: this.deps.fetch, now: () => this.deps.clock.now() },
      );
    } catch (err) {
      if (err instanceof InstallationVerificationUnavailable) {
        throw new ConnectError('provider-unreachable', err.message);
      }
      if (err instanceof InstallationRefused) {
        throw await refuse(
          err.reason,
          new ConnectError(
            err.reason === 'authorization-code-rejected'
              ? 'token-exchange-failed'
              : 'installation-not-verified',
            err.message,
          ),
        );
      }
      throw err;
    }
    return 'user-authorization';
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
      discovery = await this.storeDiscovery(connection, plugin, first.resources);
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
        appConfig: await this.deps.providerApps.pluginAppConfig(plugin.id),
        fetch: this.deps.fetch,
      });
      return { resources, error: null };
    } catch (err) {
      const rejected = err instanceof UpstreamAuthError;
      if (policy === 'required' || (policy === 'reject-auth-failure' && rejected)) {
        throw new ConnectError(
          rejected || !isTransportFailure(err) ? 'credential-rejected' : 'provider-unreachable',
          `${plugin.displayName}: ${errorMessage(err)}`,
        );
      }
      return { resources: null, error: oneLine(errorMessage(err)) };
    }
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
    const sealed = serializeSecret(secret);
    const metadata = { credential_kind: secret.kind, ...options.metadata };
    if (!options.reconnectId) {
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
    try {
      let resolved = await this.deps.broker.resolve(connection.id);
      let resources: readonly Resource[];
      try {
        resources = await this.discoverWith(resolved.plugin, this.deps.broker.contextOf(resolved));
      } catch (err) {
        if (!(err instanceof UpstreamAuthError)) throw err;
        try {
          resolved = await this.deps.broker.refresh(connection.id);
        } catch (refreshErr) {
          if (!(refreshErr instanceof UpstreamAuthError)) throw refreshErr;
          // Keep the provider's own words: they say what is wrong with the credential.
          throw new UpstreamAuthError(
            `${err.message} — the credential could not be refreshed, the connection is now expired; reconnect it`,
            err.upstreamStatus,
          );
        }
        resources = await this.discoverWith(resolved.plugin, this.deps.broker.contextOf(resolved));
      }
      const record = await this.storeDiscovery(connection, resolved.plugin, resources);
      await this.auditDiscovery(actor, connection, record);
      return record;
    } catch (err) {
      this.deps.logger.warn('resource discovery failed', {
        connection_id: connection.id,
        provider: connection.provider,
        detail: errorMessage(err),
      });
      const record = await this.recordDiscovery(connection.id, 0, oneLine(errorMessage(err)));
      await this.auditDiscovery(actor, connection, record);
      return record;
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
      if (parsed.env !== resource.env) {
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
    if (env !== undefined) await connections.setResourceEnv(resource.id, env);
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

  // ── Revoke ────────────────────────────────────────────────────────────────

  /**
   * Terminal. The sealed credential is erased, and the missions that carry
   * the connection are `orphaned` from then on, and stay so: a revoked
   * connection never comes back (spec §2.3, §7.8).
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

  private async hostAppConfig(providerId: string): Promise<Readonly<Record<string, string>>> {
    try {
      return await this.deps.providerApps.hostAppConfig(providerId);
    } catch (err) {
      if (err instanceof ProviderAppNotConfigured) throw new ConnectError('app-not-configured');
      throw err;
    }
  }

  private async oauthClient(plugin: ProviderPlugin): Promise<OAuth2Client> {
    const app = await this.hostAppConfig(plugin.id);
    const clientId = app[CLIENT_ID_FIELD];
    if (!clientId) throw new ConnectError('app-not-configured');
    const spec = credentialSpecFor(plugin, 'oauth2');
    const isPublic = spec !== null && spec.clientAuthMethod === 'none';
    return { clientId, clientSecret: isPublic ? null : (app[CLIENT_SECRET_FIELD] ?? null) };
  }

  private async discoverWith(
    plugin: ProviderPlugin,
    ctx: ConnectionContext,
  ): Promise<readonly Resource[]> {
    return plugin.discoverResources({
      ...ctx,
      signal: ctx.signal ?? AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
    });
  }

  private async storeDiscovery(
    connection: ConnectionRecord,
    plugin: ProviderPlugin,
    resources: readonly Resource[],
  ): Promise<DiscoveryRecord> {
    const usable: DiscoveredResource[] = [];
    for (const r of resources) {
      if (r.provider !== plugin.id || typeof r.ref !== 'string' || r.ref.length === 0) {
        this.deps.logger.warn('plugin returned an unusable resource; ignored', {
          provider: plugin.id,
          connection_id: connection.id,
        });
        continue;
      }
      // A label the plugin sets must be a valid environment label; otherwise the
      // resource is kept unlabelled and the owner decides.
      const label = typeof r.env === 'string' ? parseEnvLabel(r.env) : null;
      usable.push({
        ref: r.ref,
        displayName: cleanName(r.displayName) ?? r.ref,
        env: label?.ok ? label.env : null,
        metadata: r.metadata ?? null,
      });
    }
    await this.deps.store.connections.syncDiscoveredResources(connection.id, usable);
    return this.recordDiscovery(connection.id, usable.length, null);
  }

  private async recordDiscovery(
    connectionId: string,
    count: number,
    error: string | null,
  ): Promise<DiscoveryRecord> {
    const record: DiscoveryRecord = { at: this.nowIso(), ok: error === null, count, error };
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
    // The way the account was made says where its grant lives: a pasted token
    // is deleted on the token page, an app is uninstalled elsewhere.
    const kind =
      connectionCredentialKind(connection, plugin.credential.kind) ?? plugin.credential.kind;
    const spec = credentialSpecFor(plugin, kind);
    return {
      providerLabel: plugin.displayName,
      grant: {
        withdrawnByGateway: canWithdraw(plugin, kind),
        byHand: spec?.manualRevocation ?? plugin.manualRevocation ?? null,
      },
    };
  }

  private async view(connection: ConnectionRecord): Promise<ConnectionView> {
    const registered = this.deps.registry.get(connection.provider);
    const metadata = connection.metadata ?? {};
    const kind = connectionCredentialKind(connection, registered?.plugin.credential.kind ?? null);
    const spec = registered && kind ? credentialSpecFor(registered.plugin, kind) : null;
    const pasted = kind === 'api-key';
    return {
      connection,
      providerLabel: registered?.plugin.displayName ?? connection.provider,
      providerGrant: this.providerGrantOf(connection).grant,
      experimental: registered?.plugin.experimental === true,
      credentialKind: kind,
      tokenAccount: pasted && typeof metadata.account === 'string' ? metadata.account : null,
      tokenExpiresAt: pasted ? connection.credentialExpiresAt : null,
      unavailableTools: registered && spec ? unavailableToolsOf(registered.plugin, spec) : [],
      ownerLabel: await this.ownerLabel(connection),
      publicKey: typeof metadata.public_key === 'string' ? metadata.public_key : null,
      fields: stringValues(metadata.fields),
      discovery: discoveryOf(metadata.discovery),
    };
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

  /** The owner's "refresh discovery": the outcome, never the resource list. */
  private async auditDiscovery(
    actor: Actor,
    connection: ConnectionRecord,
    record: DiscoveryRecord,
  ): Promise<void> {
    await this.deps.audit.write({
      kind: 'admin',
      ts: this.nowIso(),
      user_id: actor.user.id,
      act: 'resources-discovered',
      object: { type: 'connection', id: connection.id },
      before: null,
      after: { ok: record.ok, count: record.count, error: record.error },
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

  /** Nothing was created: the entry names the provider and the claim that was refused. */
  private async auditRefusal(
    actor: Actor,
    plugin: ProviderPlugin,
    pending: PendingConnect,
    installationId: string,
    reason: ConnectRefusalReason,
  ): Promise<void> {
    await this.deps.audit.write({
      kind: 'admin',
      ts: this.nowIso(),
      user_id: actor.user.id,
      act: 'connection-refused',
      object: { type: 'connection', id: pending.reconnectId ?? `not-created:${plugin.id}` },
      before: null,
      after: {
        provider: plugin.id,
        reason,
        installation_id: installationId,
        reconnect: pending.reconnectId !== null,
      },
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
    env: resource.env,
    hidden: resource.hidden,
    owner_metadata: resource.ownerMetadata,
  };
}

/** The plugin-facing `Resource` of a stored row (what `classify` and `execute` receive). */
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

function unavailableToolsOf(plugin: ProviderPlugin, spec: CredentialSpec): UnavailableToolView[] {
  return Object.entries(spec.unavailableTools ?? {}).map(([name, reason]) => ({
    ...toolLabel(plugin, name),
    reason,
  }));
}

/** One way of connecting as the connect page shows it, read from the plugin's declaration. */
function methodView(
  plugin: ProviderPlugin,
  spec: CredentialSpec,
  configured: boolean,
): ConnectMethod {
  const guide = spec.kind === 'api-key' ? spec.guide : undefined;
  return {
    kind: spec.kind,
    usesApp: isAppCredentialSpec(spec),
    configured,
    fields: spec.kind === 'api-key' || spec.kind === 'ssh-key' ? spec.fields : [],
    createUrl: spec.kind === 'api-key' ? (spec.createUrl ?? null) : null,
    label: spec.kind === 'api-key' ? (spec.label ?? null) : null,
    guide: guide
      ? {
          steps: guide.steps,
          permissions: guide.permissions.map((p) => ({
            name: p.name,
            access: p.access,
            tools: p.tools.map((tool) => toolLabel(plugin, tool)),
          })),
          recommendedExpiryDays: guide.recommendedExpiryDays,
          docsUrl: guide.docsUrl ?? null,
        }
      : null,
    unavailableTools: unavailableToolsOf(plugin, spec),
  };
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

function stringValues(value: unknown): Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, v] of Object.entries(value)) if (typeof v === 'string') out[key] = v;
  return out;
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
  };
}
