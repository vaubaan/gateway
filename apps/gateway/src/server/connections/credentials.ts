/**
 * Credential broker — the one place a connection's stored credential becomes
 * the decrypted `CredentialSecret` a plugin receives, and the one place it is
 * refreshed (spec §2.3 "expired: the provider rejected the credential and
 * refresh failed"; §2.4).
 *
 * Callers (resource discovery here, the execution door in P1.6) use it as
 * the refresh persistence hook:
 *
 *   const resolved = await broker.resolve(connectionId);   // refreshes when about to expire
 *   try { await plugin.execute({ ...resolved, … }) }
 *   catch (err) {
 *     if (!(err instanceof UpstreamAuthError)) throw err;
 *     const again = await broker.refresh(connectionId);    // forced; marks `expired` on failure
 *     await plugin.execute({ ...again, … });
 *   }
 *
 * Refresh is generic for `oauth2` (ADR plugin-contract-and-credential-spec D2,
 * amended): the host performs the standard `refresh_token` grant from the spec
 * with the company's client credentials, rotates the refresh token and seals
 * the result. A plugin's own `refresh()` is called instead only when it
 * declares one (non-standard flow). The OAuth client secret never reaches a
 * plugin: `appConfig` is `ProviderAppsService.pluginAppConfig()`.
 */
import { isUnavailableConnectionStatus } from '@vaubaan/gateway-core';
import { UpstreamAuthError } from '@vaubaan/shared';
import type {
  ConnectionContext,
  CredentialSecret,
  OAuth2CredentialSpec,
  PluginRegistry,
  ProviderAppConfig,
  ProviderPlugin,
} from '@vaubaan/plugin-sdk';

import type { Logger } from '../logging';
import { CLIENT_ID_FIELD, CLIENT_SECRET_FIELD, type ProviderAppsService } from '../provider-apps';
import type { ConnectionsRepo } from '../store';
import type { Clock } from '../store/clock';
import type { ConnectionRecord, ProviderGrantOutcome } from '../store/types';
import { parseSecret, serializeSecret } from './credential-codec';
import { ConnectionUnavailableError, errorMessage, ProviderUnreachableError } from './errors';
import {
  OAuth2TokenError,
  refreshGrant,
  REVOCATION_REQUEST_TIMEOUT_MS,
  revokeGrant,
  type OAuth2Client,
  type RevocationAttempt,
} from './oauth2';

/** An access token that expires within this delay is refreshed before use. */
export const REFRESH_SKEW_MS = 60_000;
const HTTP_UNAUTHORIZED = 401;

export interface ResolvedCredential {
  readonly connection: ConnectionRecord;
  readonly plugin: ProviderPlugin;
  /** Decrypted, in memory only; the caller drops it after the upstream call. */
  readonly credential: CredentialSecret;
  /** The company's app for this provider as a plugin may see it (no OAuth client secret). */
  readonly appConfig: ProviderAppConfig;
}

export interface CredentialBrokerDeps {
  readonly connections: ConnectionsRepo;
  readonly registry: PluginRegistry;
  readonly providerApps: ProviderAppsService;
  readonly fetch: typeof fetch;
  readonly clock: Clock;
  readonly logger: Logger;
}

/**
 * Can the gateway withdraw the provider-side grant of a connection to this
 * plugin? The one rule, for the broker and for the page that says beforehand
 * what a revocation will do.
 */
export function canWithdraw(plugin: Pick<ProviderPlugin, 'revoke' | 'credential'>): boolean {
  if (plugin.revoke) return true;
  return plugin.credential.kind === 'oauth2' && plugin.credential.revocation !== undefined;
}

/** A withdrawal that takes longer than the delay did not confirm anything. */
async function withinRevocationDelay<T>(attempt: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const tooSlow = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new RevocationTimeout()),
      REVOCATION_REQUEST_TIMEOUT_MS + REVOCATION_GRACE_MS,
    );
  });
  try {
    return await Promise.race([attempt, tooSlow]);
  } finally {
    clearTimeout(timer);
  }
}

/** Past the request's own timeout: a plugin `revoke` that ignores its signal is cut here. */
const REVOCATION_GRACE_MS = 1_000;

class RevocationTimeout extends Error {
  constructor() {
    super('the provider-side revocation did not complete in time');
    this.name = 'RevocationTimeout';
  }
}

export class CredentialBroker {
  // single-process only — one refresh at a time per connection inside this process.
  // Rotating refresh tokens are single use, so a hosted deployment needs a lock
  // shared by the replicas (a row lock on the connection, or a Redis lock).
  private readonly refreshing = new Map<string, Promise<ResolvedCredential>>();

  constructor(private readonly deps: CredentialBrokerDeps) {}

  /**
   * The credential of a connection that serves calls, refreshed first when it
   * is an `oauth2` token about to expire. A connection serves while it is
   * `active` or `unowned` (spec §2.3: an unowned connection's missions keep
   * running); `isUnavailableConnectionStatus` of gateway-core is the one rule.
   * Throws `ConnectionUnavailableError` for an `expired`, `revoked` or missing
   * connection, `UpstreamAuthError` when the refresh is rejected (an `active`
   * connection is then `expired`).
   */
  async resolve(connectionId: string): Promise<ResolvedCredential> {
    const current = await this.load(connectionId);
    if (this.expiresSoon(current.credential) && this.canRefresh(current)) {
      return this.refresh(connectionId);
    }
    return current;
  }

  /**
   * Forces a refresh — what a caller does after the provider answered 401/403.
   * A credential that cannot be refreshed (api key, ssh key, oauth2 without a
   * refresh token) or whose refresh is rejected turns the connection
   * `expired` and throws `UpstreamAuthError`. A provider that is merely
   * unreachable throws `ProviderUnreachableError` and changes nothing.
   */
  refresh(connectionId: string): Promise<ResolvedCredential> {
    const inFlight = this.refreshing.get(connectionId);
    if (inFlight) return inFlight;
    const pending = this.refreshNow(connectionId).finally(() => {
      this.refreshing.delete(connectionId);
    });
    this.refreshing.set(connectionId, pending);
    return pending;
  }

  /**
   * The stored credential of a connection that is about to be revoked, exactly
   * as it is: no refresh, and whatever the status (an `expired` connection
   * still holds the refresh token the provider's revocation endpoint wants).
   * `null` when there is nothing to present: no such connection, a plugin that
   * is no longer registered, no stored credential, or one that cannot be read.
   * Never throws: the local revocation must not depend on it.
   */
  async forRevocation(connectionId: string): Promise<ResolvedCredential | null> {
    try {
      const connection = await this.deps.connections.getById(connectionId);
      if (!connection) return null;
      const registered = this.deps.registry.get(connection.provider);
      if (!registered) return null;
      const sealed = await this.deps.connections.getCredential(connectionId);
      if (sealed === null) return null;
      return {
        connection,
        plugin: registered.plugin,
        credential: parseSecret(sealed),
        appConfig: await this.deps.providerApps.pluginAppConfig(connection.provider),
      };
    } catch (err) {
      this.deps.logger.warn('credential not readable for the provider-side revocation', {
        connection_id: connectionId,
        error_class: err instanceof Error ? err.name : typeof err,
      });
      return null;
    }
  }

  /**
   * Asks the provider to withdraw the grant of a connection that was just
   * revoked here (spec §2.3), with the credential `forRevocation` read before
   * the store erased it. Never throws and never takes longer than
   * `REVOCATION_REQUEST_TIMEOUT_MS`: the answer is one of three facts.
   *
   *   `revoked`  the provider confirmed (the plugin's `revoke` resolved, or
   *              the endpoint of `credential.revocation` answered 2xx);
   *   `manual`   nothing to ask: the plugin declares no way to withdraw, or
   *              the stored credential holds no token the endpoint accepts;
   *   `failed`   there is a way and it did not confirm: refused, unreachable,
   *              too slow, or the credential could not be read.
   */
  async withdrawAtProvider(
    connection: Pick<ConnectionRecord, 'id' | 'provider'>,
    held: ResolvedCredential | null,
  ): Promise<ProviderGrantOutcome> {
    const plugin = held?.plugin ?? this.deps.registry.get(connection.provider)?.plugin;
    if (!plugin || !canWithdraw(plugin)) return 'manual';
    const log = { connection_id: connection.id, provider: plugin.id };
    if (held === null) {
      this.deps.logger.warn('provider grant not withdrawn: no readable credential', log);
      return 'failed';
    }
    try {
      const outcome = await withinRevocationDelay(this.withdraw(plugin, held));
      if (outcome.outcome === 'revoked') {
        this.deps.logger.info('provider grant withdrawn', log);
        return 'revoked';
      }
      if (outcome.outcome === 'no-token') {
        this.deps.logger.info('provider grant not withdrawn: no token the provider accepts', log);
        return 'manual';
      }
      this.deps.logger.warn('provider grant not withdrawn', {
        ...log,
        upstream_status: outcome.status,
        detail: outcome.detail,
      });
      return 'failed';
    } catch (err) {
      this.deps.logger.warn('provider grant not withdrawn', {
        ...log,
        error_class: err instanceof Error ? err.name : typeof err,
      });
      return 'failed';
    }
  }

  /** The plugin's own `revoke`, else the declared OAuth revocation request. */
  private async withdraw(
    plugin: ProviderPlugin,
    held: ResolvedCredential,
  ): Promise<RevocationAttempt> {
    if (plugin.revoke) {
      await plugin.revoke(this.contextOf(held, AbortSignal.timeout(REVOCATION_REQUEST_TIMEOUT_MS)));
      return { outcome: 'revoked' };
    }
    const spec = plugin.credential;
    if (spec.kind !== 'oauth2' || !spec.revocation || held.credential.kind !== 'oauth2') {
      return { outcome: 'no-token' };
    }
    return revokeGrant(spec.revocation, await this.oauthClient(plugin.id, spec), held.credential, {
      fetch: this.deps.fetch,
    });
  }

  /** The `ConnectionContext` a plugin receives for a connection-level call (discovery). */
  contextOf(resolved: ResolvedCredential, signal?: AbortSignal): ConnectionContext {
    return {
      credential: resolved.credential,
      appConfig: resolved.appConfig,
      fetch: this.deps.fetch,
      ...(signal ? { signal } : {}),
      logger: pluginLogger(this.deps.logger, resolved.plugin.id),
    };
  }

  private async load(connectionId: string): Promise<ResolvedCredential> {
    const connection = await this.deps.connections.getById(connectionId);
    if (!connection) throw new ConnectionUnavailableError(connectionId, 'missing');
    if (isUnavailableConnectionStatus(connection.status)) {
      throw new ConnectionUnavailableError(connectionId, connection.status);
    }
    const registered = this.deps.registry.get(connection.provider);
    if (!registered) throw new ConnectionUnavailableError(connectionId, 'missing');
    const sealed = await this.deps.connections.getCredential(connectionId);
    if (sealed === null) throw new ConnectionUnavailableError(connectionId, connection.status);
    return {
      connection,
      plugin: registered.plugin,
      credential: parseSecret(sealed),
      appConfig: await this.deps.providerApps.pluginAppConfig(connection.provider),
    };
  }

  private expiresSoon(credential: CredentialSecret): boolean {
    if (credential.kind !== 'oauth2' || credential.expiresAt === null) return false;
    const expiresAt = Date.parse(credential.expiresAt);
    return (
      Number.isFinite(expiresAt) && expiresAt - this.deps.clock.now().getTime() <= REFRESH_SKEW_MS
    );
  }

  private canRefresh(resolved: ResolvedCredential): boolean {
    if (resolved.plugin.refresh) return true;
    const spec = resolved.plugin.credential;
    return (
      spec.kind === 'oauth2' &&
      spec.refreshable &&
      resolved.credential.kind === 'oauth2' &&
      resolved.credential.refreshToken !== null
    );
  }

  private async refreshNow(connectionId: string): Promise<ResolvedCredential> {
    // Re-read inside the single flight: a previous refresh may just have rotated the token.
    const current = await this.load(connectionId);
    const { plugin } = current;
    let next: CredentialSecret;
    try {
      next = await this.obtain(current);
    } catch (err) {
      // Only a rejection by the provider ends the connection; an unreachable provider,
      // a missing app configuration or a bug leaves its status alone for the next attempt.
      if (!(err instanceof UpstreamAuthError)) {
        if (err instanceof ProviderUnreachableError) throw err;
        throw new ProviderUnreachableError(
          `${plugin.displayName}: the credential could not be refreshed (${errorMessage(err)})`,
        );
      }
      const status = err.upstreamStatus;
      const expired = await this.deps.connections.markExpired(connectionId);
      this.deps.logger.warn('credential refresh rejected', {
        connection_id: connectionId,
        provider: plugin.id,
        marked_expired: expired,
        detail: errorMessage(err),
      });
      throw new UpstreamAuthError(
        `${plugin.displayName} rejected the credential of this connection and it could not be refreshed: ${errorMessage(err)}`,
        status,
      );
    }
    const expiresAt = next.kind === 'oauth2' ? next.expiresAt : null;
    const written = await this.deps.connections.refreshCredential(
      connectionId,
      serializeSecret(next),
      expiresAt,
    );
    if (!written) {
      // Revoked (or expired by another path) while the provider was answering.
      const now = await this.deps.connections.getById(connectionId);
      throw new ConnectionUnavailableError(connectionId, now?.status ?? 'missing');
    }
    this.deps.logger.info('credential refreshed', {
      connection_id: connectionId,
      provider: plugin.id,
      expires_at: expiresAt,
    });
    return this.load(connectionId);
  }

  /** A fresh secret, or `UpstreamAuthError` (rejected) / `ProviderUnreachableError` (transient). */
  private async obtain(current: ResolvedCredential): Promise<CredentialSecret> {
    const { plugin, credential } = current;
    if (plugin.refresh) {
      const refreshed = await plugin.refresh(this.contextOf(current));
      if (refreshed.kind !== plugin.credential.kind) {
        throw new Error(`plugin '${plugin.id}' refreshed into a '${refreshed.kind}' credential`);
      }
      return refreshed;
    }
    const spec = plugin.credential;
    if (spec.kind !== 'oauth2' || !spec.refreshable || credential.kind !== 'oauth2') {
      throw new UpstreamAuthError(
        `a '${spec.kind}' credential cannot be refreshed; reconnect the provider`,
        HTTP_UNAUTHORIZED,
      );
    }
    try {
      return await refreshGrant(spec, await this.oauthClient(plugin.id, spec), credential, {
        fetch: this.deps.fetch,
        now: () => this.deps.clock.now(),
      });
    } catch (err) {
      if (err instanceof OAuth2TokenError) {
        if (!err.rejected) throw new ProviderUnreachableError(err.message);
        throw new UpstreamAuthError(err.message, err.status || HTTP_UNAUTHORIZED);
      }
      throw err;
    }
  }

  /** The company's OAuth client, secret included — host use only. */
  async oauthClient(providerId: string, spec: OAuth2CredentialSpec): Promise<OAuth2Client> {
    const app = await this.deps.providerApps.hostAppConfig(providerId);
    const clientId = app[CLIENT_ID_FIELD];
    if (!clientId) throw new Error(`provider '${providerId}': client_id is not configured`);
    return {
      clientId,
      clientSecret: spec.clientAuthMethod === 'none' ? null : (app[CLIENT_SECRET_FIELD] ?? null),
    };
  }
}

function pluginLogger(logger: Logger, pluginId: string): ConnectionContext['logger'] {
  const child = logger.child({ plugin: pluginId });
  return {
    debug: (message, data) => child.debug(message, data),
    info: (message, data) => child.info(message, data),
    warn: (message, data) => child.warn(message, data),
    error: (message, data) => child.error(message, data),
  };
}
