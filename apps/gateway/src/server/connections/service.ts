/**
 * Connections (spec §0 "Connection", "Resource"; §2.3 states; §7.2).
 *
 * One generic driver over the four `CredentialSpec` kinds — the plugin
 * declares, the host runs the flow:
 *
 *   oauth2       start(): authorization redirect with a single-use `state` and PKCE
 *                complete(): code exchange with the company's OAuth client
 *   app-install  start(): redirect to the app's installation page with a `state`
 *                complete(): the installation id of the callback
 *   api-key      start(): the form values, checked by a first discovery
 *   ssh-key      start(): an ed25519 key pair generated here, public key shown
 *
 * A connection is created under the name of the user who connected it
 * (owner = user; groups arrive with P2.2 behind the same `Principal`). Its
 * credential is the serialized `CredentialSecret`, sealed by the store with
 * the connection id as associated data. Resources are discovered by the
 * plugin at connect time and merged by `syncDiscoveredResources`, which
 * never overwrites an owner edit and never deletes a row.
 */
import { UpstreamAuthError, type CredentialKind } from '@vaubaan/shared';
import type {
  ConnectionContext,
  CredentialField,
  CredentialSecret,
  PluginRegistry,
  ProviderPlugin,
  Resource,
} from '@vaubaan/plugin-sdk';
import type { AuditWriter } from '@vaubaan/gateway-core';

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
  UserRecord,
} from '../store/types';
import { serializeSecret } from './credential-codec';
import type { CredentialBroker } from './credentials';
import { ConnectError, errorMessage, oneLine } from './errors';
import {
  cleanName,
  editableMetadataKeys,
  parseEnvLabel,
  parseListValue,
  readCredentialFields,
  resolveReturnTo,
} from './input';
import {
  buildAuthorizationUrl,
  exchangeCode,
  newCodeVerifier,
  OAuth2TokenError,
  type OAuth2Client,
} from './oauth2';
import type { PendingConnect, PendingConnectStore } from './pending';
import { generateEd25519KeyPair } from './ssh-keypair';

/** Connect attempts (starts, callbacks, form posts) one user may make per window. */
export const CONNECT_RATE_LIMIT = 10;
export const CONNECT_RATE_WINDOW_MS = 60_000;
/** A discovery that does not finish within this delay is reported as failed. */
export const DISCOVERY_TIMEOUT_MS = 30_000;
export const CONNECTIONS_PATH = '/connections';
const INSTALLATION_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const SSH_KEY_COMMENT = 'vaubaan-gateway';

/** The human behind a request, with their *current* groups (never a snapshot). */
export interface Actor {
  readonly user: UserRecord;
  readonly groups: readonly GroupRecord[];
}

export interface ConnectableProvider {
  readonly id: string;
  readonly displayName: string;
  readonly description: string | null;
  readonly experimental: boolean;
  readonly kind: CredentialKind;
  /** The company app is registered (or none is needed): users may connect. */
  readonly configured: boolean;
  /** The fields of the connect form (`api-key`, `ssh-key`); empty for redirect flows. */
  readonly fields: readonly CredentialField[];
  /** Where the user creates the key (`api-key`). */
  readonly createUrl: string | null;
}

export interface DiscoveryRecord {
  readonly at: string;
  readonly ok: boolean;
  readonly count: number;
  /** The provider's (or the plugin's) own message when the discovery failed. */
  readonly error: string | null;
}

export interface ConnectionView {
  readonly connection: ConnectionRecord;
  readonly providerLabel: string;
  readonly experimental: boolean;
  /** `null` when the plugin is no longer registered. */
  readonly credentialKind: CredentialKind | null;
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

export interface ConnectionServiceDeps {
  readonly store: Store;
  readonly registry: PluginRegistry;
  readonly providerApps: ProviderAppsService;
  readonly broker: CredentialBroker;
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

export class ConnectionService {
  constructor(private readonly deps: ConnectionServiceDeps) {}

  /** The URL the provider sends the browser back to — always on `public_url`. */
  callbackUrl(providerId: string): URL {
    return new URL(
      `${CONNECTIONS_PATH}/callback/${encodeURIComponent(providerId)}`,
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
    const spec = plugin.credential;
    const configured = needsProviderApp(spec)
      ? (await this.deps.providerApps.status(providerId)).configured
      : true;
    return {
      id: plugin.id,
      displayName: plugin.displayName,
      description: plugin.description ?? null,
      experimental: plugin.experimental === true,
      kind: spec.kind,
      configured,
      fields: spec.kind === 'api-key' || spec.kind === 'ssh-key' ? spec.fields : [],
      createUrl: spec.kind === 'api-key' ? (spec.createUrl ?? null) : null,
    };
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
    const displayName =
      cleanName(input.displayName) ?? reconnect?.displayName ?? plugin.displayName;
    const spec = plugin.credential;

    switch (spec.kind) {
      case 'oauth2': {
        const client = await this.oauthClient(plugin);
        const pending: PendingConnect = {
          kind: 'oauth2',
          providerId,
          userId: actor.user.id,
          displayName,
          codeVerifier: spec.pkce ? newCodeVerifier() : null,
          redirectUri: this.callbackUrl(providerId).href,
          returnTo,
          reconnectId: reconnect?.id ?? null,
          createdAt: this.nowIso(),
        };
        const state = await this.deps.pending.create(pending);
        const url = buildAuthorizationUrl(spec, client, {
          redirectUri: pending.redirectUri,
          state,
          codeVerifier: pending.codeVerifier,
        });
        return { kind: 'redirect', url: url.href };
      }
      case 'app-install': {
        const appConfig = await this.hostAppConfig(providerId);
        const url = new URL(spec.installUrl(appConfig));
        const state = await this.deps.pending.create({
          kind: 'app-install',
          providerId,
          userId: actor.user.id,
          displayName,
          codeVerifier: null,
          redirectUri: this.callbackUrl(providerId).href,
          returnTo,
          reconnectId: reconnect?.id ?? null,
          createdAt: this.nowIso(),
        });
        url.searchParams.set('state', state);
        return { kind: 'redirect', url: url.href };
      }
      case 'api-key': {
        const read = readCredentialFields(spec.fields, input.fields ?? {});
        if (read.problems.length > 0)
          throw new ConnectError('invalid-input', read.problems.join('; '));
        const secret: CredentialSecret = {
          kind: 'api-key',
          fields: read.values,
          metadata: read.visible,
        };
        const connected = await this.finalize(actor, plugin, secret, {
          displayName,
          reconnectId: reconnect?.id ?? null,
          returnTo,
          discovery: 'required',
          metadata: { fields: read.visible },
        });
        return { kind: 'connected', ...connected };
      }
      case 'ssh-key': {
        const read = readCredentialFields(spec.fields, input.fields ?? {});
        if (read.problems.length > 0)
          throw new ConnectError('invalid-input', read.problems.join('; '));
        const pair = generateEd25519KeyPair(SSH_KEY_COMMENT);
        const secret: CredentialSecret = {
          kind: 'ssh-key',
          privateKeyPem: pair.privateKeyPem,
          publicKey: pair.publicKey,
          fields: read.values,
          metadata: read.visible,
        };
        const connected = await this.finalize(actor, plugin, secret, {
          displayName,
          reconnectId: reconnect?.id ?? null,
          returnTo,
          discovery: 'deferred',
          metadata: { fields: read.visible, public_key: pair.publicKey },
        });
        return { kind: 'connected', ...connected };
      }
    }
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
      const denied = query.get('error');
      if (denied) {
        const description = query.get('error_description');
        throw new ConnectError(
          'provider-denied',
          description ? `${denied}: ${description}` : denied,
        );
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

    if (pending.kind === 'app-install' && spec.kind === 'app-install') {
      const installationId = query.get(spec.installationIdParam);
      if (!installationId || !INSTALLATION_ID_PATTERN.test(installationId)) {
        throw new ConnectError(
          'provider-denied',
          'no installation was returned (it may be awaiting approval by an account owner)',
        );
      }
      const secret: CredentialSecret = { kind: 'app-install', installationId, metadata: {} };
      return this.finalize(actor, plugin, secret, {
        displayName: pending.displayName,
        reconnectId: pending.reconnectId,
        returnTo: pending.returnTo,
        discovery: 'reject-auth-failure',
        metadata: { installation_id: installationId },
      });
    }

    throw new ConnectError('state-invalid');
  }

  private async finalize(
    actor: Actor,
    plugin: ProviderPlugin,
    secret: CredentialSecret,
    options: {
      readonly displayName: string;
      readonly reconnectId: string | null;
      readonly returnTo: string | null;
      readonly discovery: DiscoveryPolicy;
      readonly metadata: Record<string, unknown>;
    },
  ): Promise<Connected> {
    let discovered: readonly Resource[] | null = null;
    let discoveryError: string | null = null;
    if (options.discovery !== 'deferred') {
      try {
        discovered = await this.discoverWith(plugin, {
          credential: secret,
          appConfig: await this.deps.providerApps.pluginAppConfig(plugin.id),
          fetch: this.deps.fetch,
        });
      } catch (err) {
        const rejected = err instanceof UpstreamAuthError;
        if (
          options.discovery === 'required' ||
          (options.discovery === 'reject-auth-failure' && rejected)
        ) {
          throw new ConnectError(
            rejected || !isTransportFailure(err) ? 'credential-rejected' : 'provider-unreachable',
            `${plugin.displayName}: ${errorMessage(err)}`,
          );
        }
        discoveryError = oneLine(errorMessage(err));
      }
    }

    const { connections } = this.deps.store;
    const expiresAt = secret.kind === 'oauth2' ? secret.expiresAt : null;
    const sealed = serializeSecret(secret);
    const metadata = { credential_kind: secret.kind, ...options.metadata };
    let connection: ConnectionRecord;
    if (options.reconnectId) {
      // Ownership is checked again: a redirect flow may complete minutes after it started.
      await this.requireReconnectable(actor, options.reconnectId, plugin.id);
      if (!(await connections.reconnect(options.reconnectId, sealed, expiresAt))) {
        throw new ConnectError('connection-revoked');
      }
      const previous = await connections.getById(options.reconnectId);
      connection = await connections.setMetadata(options.reconnectId, {
        ...(previous?.metadata ?? {}),
        ...metadata,
      });
      await this.audit(actor, 'connection-reconnected', connection, null);
    } else {
      connection = await connections.create({
        provider: plugin.id,
        owner: { kind: 'user', id: actor.user.id },
        displayName: options.displayName,
        credential: sealed,
        credentialExpiresAt: expiresAt,
        metadata,
      });
      await this.audit(actor, 'connection-created', connection, null);
    }

    let discovery: DiscoveryRecord | null = null;
    if (discovered) discovery = await this.storeDiscovery(connection, plugin, discovered);
    else if (discoveryError)
      discovery = await this.recordDiscovery(connection.id, 0, discoveryError);

    this.deps.logger.info(options.reconnectId ? 'connection reconnected' : 'connection created', {
      connection_id: connection.id,
      provider: plugin.id,
      user_id: actor.user.id,
      credential_kind: secret.kind,
      resources: discovery?.count ?? 0,
    });
    return {
      connection: (await connections.getById(connection.id)) ?? connection,
      discovery,
      reconnected: options.reconnectId !== null,
      returnTo: options.returnTo,
    };
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
      return await this.storeDiscovery(connection, resolved.plugin, resources);
    } catch (err) {
      this.deps.logger.warn('resource discovery failed', {
        connection_id: connection.id,
        provider: connection.provider,
        detail: errorMessage(err),
      });
      return this.recordDiscovery(connection.id, 0, oneLine(errorMessage(err)));
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
    this.deps.logger.info('resource edited by its owner', {
      connection_id: connection.id,
      resource_id: resource.id,
      user_id: actor.user.id,
    });
    return resource;
  }

  // ── Revoke ────────────────────────────────────────────────────────────────

  /** Terminal. The sealed credential is erased; the provider-side grant is not revoked. */
  async revoke(actor: Actor, connectionId: string): Promise<ConnectionRecord> {
    const connection = await this.requireOwned(actor, connectionId);
    if (connection.status === 'revoked') return connection;
    const revoked = await this.deps.store.connections.revoke(connection.id);
    await this.audit(actor, 'connection-revoked', revoked, { status: connection.status });
    this.deps.logger.info('connection revoked', {
      connection_id: revoked.id,
      provider: revoked.provider,
      user_id: actor.user.id,
    });
    return revoked;
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
    if (connection.status === 'revoked') throw new ConnectError('connection-revoked');
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
    const isPublic =
      plugin.credential.kind === 'oauth2' && plugin.credential.clientAuthMethod === 'none';
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

  private async view(connection: ConnectionRecord): Promise<ConnectionView> {
    const registered = this.deps.registry.get(connection.provider);
    const metadata = connection.metadata ?? {};
    return {
      connection,
      providerLabel: registered?.plugin.displayName ?? connection.provider,
      experimental: registered?.plugin.experimental === true,
      credentialKind: registered?.plugin.credential.kind ?? null,
      ownerLabel: await this.ownerLabel(connection),
      publicKey: typeof metadata.public_key === 'string' ? metadata.public_key : null,
      fields: stringValues(metadata.fields),
      discovery: discoveryOf(metadata.discovery),
    };
  }

  private async ownerLabel(connection: ConnectionRecord): Promise<string> {
    if (connection.owner.kind === 'user') {
      const user = await this.deps.store.users.getById(connection.owner.id);
      return user?.email ?? 'unknown user';
    }
    const group = await this.deps.store.groups.getById(connection.owner.id);
    return group ? `group ${group.name}` : 'unknown group';
  }

  private async audit(
    actor: Actor,
    act: 'connection-created' | 'connection-reconnected' | 'connection-revoked',
    connection: ConnectionRecord,
    before: unknown,
  ): Promise<void> {
    await this.deps.audit.write({
      kind: 'admin',
      ts: this.nowIso(),
      user_id: actor.user.id,
      act,
      object: { type: 'connection', id: connection.id },
      before,
      after: {
        provider: connection.provider,
        display_name: connection.displayName,
        status: connection.status,
        owner: connection.owner,
      },
      delegated_client_id: null,
    });
  }

  private nowIso(): string {
    return toIso(this.deps.clock.now());
  }
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
