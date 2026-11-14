/**
 * Credential broker — the one place an account's stored credential becomes
 * the decrypted `CredentialSecret` a plugin receives, and the one place it is
 * refreshed (spec §2.3 "expired: the provider rejected the credential and
 * refresh failed"; §2.4).
 *
 * Callers (resource discovery here, the execution door) use it as
 * the refresh persistence hook:
 *
 *   const resolved = await broker.resolve(accountId);   // refreshes when about to expire
 *   try { await plugin.execute({ ...resolved, … }) }
 *   catch (err) {
 *     if (!isUpstreamAuthError(err)) throw err;
 *     const again = await broker.refresh(accountId);    // forced; marks `expired` on failure
 *     await plugin.execute({ ...again, … });
 *   }
 *
 * Refresh is generic for `oauth2` (ADR plugin-contract-and-credential-spec D2,
 * amended): the host performs the standard `refresh_token` grant from the spec
 * with the OAuth client the gateway registered at the service
 * (`OAuth2Clients`), rotates the refresh token and
 * seals the result. A registered client the provider rejects (`invalid_client`)
 * is forgotten, so the reconnect registers a new one. A plugin's own `refresh()` is called instead only when it
 * declares one (non-standard flow). The OAuth client secret never reaches a
 * plugin.
 *
 * A brokered `oauth2` account (ADRs google-calendar-through-an-oauth-broker,
 * oauth-broker-stateless-in-an-attested-enclave D1) is refreshed through the
 * OAuth broker it was made with (`POST /token` with the refresh token) and
 * withdrawn through it (`POST /revoke`). The refresh token sits in the sealed
 * credential beside the secret (`BrokerGrant`) and never reaches the plugin;
 * the broker keeps none. A broker that is down, not attested or refuses the
 * call is a `OAuthBrokerUnavailableError`, which leaves the account as it
 * is; only `invalid_grant` (the provider refused the refresh token) turns it
 * `expired`.
 */
import { isUnavailableAccountStatus } from '@vaubaan/gateway-core';
import { isUpstreamAuthError, UpstreamAuthError } from '@vaubaan/shared';
import {
  isBrokeredSpec,
  type AccountContext,
  type CredentialSecret,
  type OAuth2Secret,
  type PluginRegistry,
  type ProviderPlugin,
} from '@vaubaan/plugin-sdk';

import type { Logger } from '../logging';
import type { AccountsRepo } from '../store';
import type { Clock } from '../store/clock';
import type { AccountRecord, ProviderGrantOutcome } from '../store/types';
import { parseStoredCredential, serializeSecret, type BrokerGrant } from './credential-codec';
import {
  AccountUnavailableError,
  errorMessage,
  OAuthBrokerUnavailableError,
  ProviderUnreachableError,
} from './errors';
import { providerFailureReason } from './failure-reason';
import {
  OAuth2TokenError,
  refreshGrant,
  REVOCATION_REQUEST_TIMEOUT_MS,
  TOKEN_REQUEST_TIMEOUT_MS,
  revokeGrant,
  type OAuth2Client,
  type RevocationAttempt,
} from './oauth2';
import { OAuth2ClientMissing, type OAuth2Clients } from './oauth2-clients';
import { ATTESTED_CALL_BUDGET_MS, OAuthBrokerError, type OAuthBrokers } from './oauth-broker';
import type { NotificationEvents } from '../notifications/events';

/** An access token that expires within this delay is refreshed before use. */
export const REFRESH_SKEW_MS = 60_000;
const HTTP_UNAUTHORIZED = 401;

export interface ResolvedCredential {
  readonly account: AccountRecord;
  readonly plugin: ProviderPlugin;
  /** Decrypted, in memory only; the caller drops it after the upstream call. */
  readonly credential: CredentialSecret;
  /**
   * The OAuth broker's grant of a brokered account, `null` otherwise. Host
   * only: never part of what a plugin receives (`contextOf`).
   */
  readonly brokerGrant: BrokerGrant | null;
}

export interface CredentialBrokerDeps {
  readonly accounts: AccountsRepo;
  readonly registry: PluginRegistry;
  /** The OAuth client of an `oauth2` service, registered by the gateway. */
  readonly clients: Pick<OAuth2Clients, 'forTokenRequest' | 'rejected'>;
  /** The OAuth brokers the instance is enrolled with: refresh and revocation of a brokered account. */
  readonly brokers: Pick<OAuthBrokers, 'byName'>;
  readonly fetch: typeof fetch;
  readonly clock: Clock;
  readonly logger: Logger;
  /** Told when a rejected credential turns an account `expired` (spec §4.2 bis). */
  readonly notifications?: Pick<NotificationEvents, 'accountNeedsReconnecting'>;
}

/**
 * Can the gateway withdraw the provider-side grant of an account to this
 * plugin made with this kind of credential (the primary kind when omitted)?
 * The one rule, for the broker and for the page that says beforehand what a
 * revocation will do: the plugin's own `revoke` hook, or the declarative
 * `revocation` of its `oauth2` spec. An account made with another kind than
 * the plugin now declares (a kind that left the contract) withdraws nothing.
 */
export function canWithdraw(
  plugin: Pick<ProviderPlugin, 'revoke' | 'credential'>,
  kind: string = plugin.credential.kind,
): boolean {
  if (kind !== plugin.credential.kind) return false;
  if (plugin.revoke) return true;
  const spec = plugin.credential;
  if (spec.kind !== 'oauth2') return false;
  return isBrokeredSpec(spec) || spec.revocation !== undefined;
}

/** The plugin's `refresh` override serves its primary way of connecting only. */
function ownRefreshApplies(plugin: ProviderPlugin, credential: CredentialSecret): boolean {
  return plugin.refresh !== undefined && credential.kind === plugin.credential.kind;
}

/**
 * How long a withdrawal may take: the provider's revocation request, or —
 * through an attested OAuth broker — an attestation and the call
 * (`ATTESTED_CALL_BUDGET_MS`), so that a broker that must be attested first
 * is not cut short and recorded `failed` while it is still answering.
 */
function revocationDelayMs(plugin: ProviderPlugin): number {
  const spec = plugin.credential;
  const brokered = spec.kind === 'oauth2' && isBrokeredSpec(spec) && !plugin.revoke;
  return brokered ? ATTESTED_CALL_BUDGET_MS : REVOCATION_REQUEST_TIMEOUT_MS;
}

/** A withdrawal that takes longer than the delay did not confirm anything. */
async function withinRevocationDelay<T>(attempt: Promise<T>, delayMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const tooSlow = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new RevocationTimeout()), delayMs + REVOCATION_GRACE_MS);
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
  // single-process only — one refresh at a time per account inside this process.
  // Rotating refresh tokens are single use, so a hosted deployment needs a lock
  // shared by the replicas (a row lock on the account, or a Redis lock).
  private readonly refreshing = new Map<string, Promise<ResolvedCredential>>();

  constructor(private readonly deps: CredentialBrokerDeps) {}

  /**
   * The credential of an account that serves calls, refreshed first when it
   * is an `oauth2` token about to expire. An account serves while it is
   * `active` or `unowned` (spec §2.3: an unowned account's missions keep
   * running); `isUnavailableAccountStatus` of gateway-core is the one rule.
   * Throws `AccountUnavailableError` for an `expired`, `revoked` or missing
   * account, `UpstreamAuthError` when the refresh is rejected (an `active`
   * account is then `expired`).
   */
  async resolve(accountId: string): Promise<ResolvedCredential> {
    const current = await this.load(accountId);
    if (this.expiresSoon(current.credential) && this.canRefresh(current)) {
      return this.refresh(accountId);
    }
    return current;
  }

  /**
   * Forces a refresh — what a caller does after the provider answered 401/403.
   * A credential that cannot be refreshed (api key, ssh key, oauth2 without a
   * refresh token) or whose refresh is rejected turns the account
   * `expired` and throws `UpstreamAuthError`. A provider that is merely
   * unreachable throws `ProviderUnreachableError` and changes nothing.
   */
  refresh(accountId: string): Promise<ResolvedCredential> {
    const inFlight = this.refreshing.get(accountId);
    if (inFlight) return inFlight;
    const pending = this.refreshNow(accountId).finally(() => {
      this.refreshing.delete(accountId);
    });
    this.refreshing.set(accountId, pending);
    return pending;
  }

  /**
   * The stored credential of an account that is about to be revoked, exactly
   * as it is: no refresh, and whatever the status (an `expired` account
   * still holds the refresh token the provider's revocation endpoint wants).
   * `null` when there is nothing to present: no such account, a plugin that
   * is no longer registered, no stored credential, or one that cannot be read.
   * Never throws: the local revocation must not depend on it.
   */
  async forRevocation(accountId: string): Promise<ResolvedCredential | null> {
    try {
      const account = await this.deps.accounts.getById(accountId);
      if (!account) return null;
      const registered = this.deps.registry.get(account.provider);
      if (!registered) return null;
      const sealed = await this.deps.accounts.getCredential(accountId);
      if (sealed === null) return null;
      const { secret, brokerGrant } = parseStoredCredential(sealed);
      return { account, plugin: registered.plugin, credential: secret, brokerGrant };
    } catch (err) {
      this.deps.logger.warn('credential not readable for the provider-side revocation', {
        account_id: accountId,
        error_class: err instanceof Error ? err.name : typeof err,
      });
      return null;
    }
  }

  /**
   * Asks the provider to withdraw the grant of an account that was just
   * revoked here (spec §2.3), with the credential `forRevocation` read before
   * the store erased it. Never throws and never takes longer than
   * `REVOCATION_REQUEST_TIMEOUT_MS` — `ATTESTED_CALL_BUDGET_MS` through an
   * OAuth broker (an attestation, then the call): the answer is one of three
   * facts.
   *
   *   `revoked`  the provider confirmed (the plugin's `revoke` resolved, or
   *              the endpoint of `credential.revocation` answered 2xx);
   *   `manual`   nothing to ask: the plugin declares no way to withdraw, or
   *              the stored credential holds no token the endpoint accepts;
   *   `failed`   there is a way and it did not confirm: refused, unreachable,
   *              too slow, or the credential could not be read.
   */
  async withdrawAtProvider(
    account: Pick<AccountRecord, 'id' | 'provider'>,
    held: ResolvedCredential | null,
  ): Promise<ProviderGrantOutcome> {
    const plugin = held?.plugin ?? this.deps.registry.get(account.provider)?.plugin;
    const kind = held?.credential.kind ?? plugin?.credential.kind;
    if (!plugin || !kind || !canWithdraw(plugin, kind)) return 'manual';
    const log = { account_id: account.id, provider: plugin.id };
    if (held === null) {
      this.deps.logger.warn('provider grant not withdrawn: no readable credential', log);
      return 'failed';
    }
    try {
      const outcome = await withinRevocationDelay(
        this.withdraw(plugin, held),
        revocationDelayMs(plugin),
      );
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
    if (plugin.revoke && held.credential.kind === plugin.credential.kind) {
      await plugin.revoke(this.contextOf(held, AbortSignal.timeout(REVOCATION_REQUEST_TIMEOUT_MS)));
      return { outcome: 'revoked' };
    }
    const spec = plugin.credential;
    if (spec.kind !== 'oauth2' || held.credential.kind !== 'oauth2') return { outcome: 'no-token' };
    if (isBrokeredSpec(spec)) return this.withdrawAtBroker(spec.broker.provider, held.brokerGrant);
    if (!spec.revocation) return { outcome: 'no-token' };
    return revokeGrant(
      spec.revocation,
      await this.deps.clients.forTokenRequest(plugin, spec),
      held.credential,
      { fetch: this.deps.fetch },
    );
  }

  /** `POST /revoke` with the refresh token, through the broker the account was made with. */
  private async withdrawAtBroker(
    provider: string,
    grant: BrokerGrant | null,
  ): Promise<RevocationAttempt> {
    if (grant === null) return { outcome: 'no-token' };
    const broker = this.deps.brokers.byName(grant.broker);
    if (!broker) {
      return {
        outcome: 'failed',
        status: 0,
        detail: `OAuth broker '${grant.broker}' is no longer configured`,
      };
    }
    try {
      await broker.revoke(provider, grant.refreshToken);
      return { outcome: 'revoked' };
    } catch (err) {
      if (!(err instanceof OAuthBrokerError)) throw err;
      return { outcome: 'failed', status: err.status, detail: err.message };
    }
  }

  /**
   * The `AccountContext` a plugin receives. The signal is required: every plugin
   * call runs under a deadline (a tool call: `execution.call_timeout_seconds`, joined
   * with its caller's signal; discovery, refresh, revocation: their own bounds).
   */
  contextOf(resolved: ResolvedCredential, signal: AbortSignal): AccountContext {
    return {
      credential: resolved.credential,
      fetch: this.deps.fetch,
      signal,
      logger: pluginLogger(this.deps.logger, resolved.plugin.id),
    };
  }

  private async load(accountId: string): Promise<ResolvedCredential> {
    const account = await this.deps.accounts.getById(accountId);
    if (!account) throw new AccountUnavailableError(accountId, 'missing');
    if (isUnavailableAccountStatus(account.status)) {
      throw new AccountUnavailableError(accountId, account.status);
    }
    const registered = this.deps.registry.get(account.provider);
    if (!registered) throw new AccountUnavailableError(accountId, 'missing');
    const sealed = await this.deps.accounts.getCredential(accountId);
    if (sealed === null) throw new AccountUnavailableError(accountId, account.status);
    const { secret, brokerGrant } = parseStoredCredential(sealed);
    return { account, plugin: registered.plugin, credential: secret, brokerGrant };
  }

  private expiresSoon(credential: CredentialSecret): boolean {
    if (credential.kind !== 'oauth2' || credential.expiresAt === null) return false;
    const expiresAt = Date.parse(credential.expiresAt);
    return (
      Number.isFinite(expiresAt) && expiresAt - this.deps.clock.now().getTime() <= REFRESH_SKEW_MS
    );
  }

  private canRefresh(resolved: ResolvedCredential): boolean {
    if (ownRefreshApplies(resolved.plugin, resolved.credential)) return true;
    const spec = resolved.plugin.credential;
    if (spec.kind === 'oauth2' && isBrokeredSpec(spec)) {
      return resolved.credential.kind === 'oauth2' && resolved.brokerGrant !== null;
    }
    return (
      spec.kind === 'oauth2' &&
      spec.refreshable &&
      resolved.credential.kind === 'oauth2' &&
      resolved.credential.refreshToken !== null
    );
  }

  private async refreshNow(accountId: string): Promise<ResolvedCredential> {
    // Re-read inside the single flight: a previous refresh may just have rotated the token.
    const current = await this.load(accountId);
    const { plugin } = current;
    let next: CredentialSecret;
    try {
      next = await this.obtain(current);
    } catch (err) {
      // Only a rejection by the provider ends the account; an unreachable provider,
      // a missing app configuration or a bug leaves its status alone for the next attempt.
      if (!isUpstreamAuthError(err)) {
        if (err instanceof ProviderUnreachableError) {
          if (err instanceof OAuthBrokerUnavailableError) {
            this.deps.logger.warn('credential not refreshed: the OAuth broker failed', {
              account_id: accountId,
              provider: plugin.id,
              broker: err.broker,
              failure: err.message,
            });
          }
          throw err;
        }
        throw new ProviderUnreachableError(
          `${plugin.displayName}: the credential could not be refreshed (${providerFailureReason(err)})`,
        );
      }
      const status = err.upstreamStatus;
      const expired = await this.deps.accounts.markExpired(accountId);
      this.deps.logger.warn('credential refresh rejected', {
        account_id: accountId,
        provider: plugin.id,
        marked_expired: expired,
        failure: providerFailureReason(err),
      });
      // Only the call that made the transition tells the owners: once, after the write.
      if (expired) this.deps.notifications?.accountNeedsReconnecting(accountId);
      throw new UpstreamAuthError(
        `${plugin.displayName} rejected the credential of this account and it could not be refreshed: ${errorMessage(err)}`,
        status,
      );
    }
    const expiresAt = next.kind === 'oauth2' ? next.expiresAt : null;
    const written = await this.deps.accounts.refreshCredential(
      accountId,
      serializeSecret(next, current.brokerGrant),
      expiresAt,
    );
    if (!written) {
      // Revoked (or expired by another path) while the provider was answering.
      const now = await this.deps.accounts.getById(accountId);
      throw new AccountUnavailableError(accountId, now?.status ?? 'missing');
    }
    this.deps.logger.info('credential refreshed', {
      account_id: accountId,
      provider: plugin.id,
      expires_at: expiresAt,
    });
    return this.load(accountId);
  }

  private obtainFromBroker(
    plugin: ProviderPlugin,
    credential: OAuth2Secret,
    grant: BrokerGrant | null,
  ): Promise<OAuth2Secret> {
    return refreshAtBroker(this.deps.brokers, plugin, credential, grant);
  }

  /** A fresh secret, or `UpstreamAuthError` (rejected) / `ProviderUnreachableError` (transient). */
  private async obtain(current: ResolvedCredential): Promise<CredentialSecret> {
    const { plugin, credential } = current;
    if (plugin.refresh && ownRefreshApplies(plugin, credential)) {
      const refreshed = await plugin.refresh(
        this.contextOf(current, AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS)),
      );
      if (refreshed.kind !== credential.kind) {
        throw new Error(`plugin '${plugin.id}' refreshed into a '${refreshed.kind}' credential`);
      }
      return refreshed;
    }
    const spec = plugin.credential;
    if (spec.kind === 'oauth2' && isBrokeredSpec(spec) && credential.kind === 'oauth2') {
      return this.obtainFromBroker(plugin, credential, current.brokerGrant);
    }
    if (
      spec.kind !== 'oauth2' ||
      isBrokeredSpec(spec) ||
      !spec.refreshable ||
      credential.kind !== 'oauth2'
    ) {
      throw new UpstreamAuthError(
        `a '${credential.kind}' credential cannot be refreshed; reconnect the provider`,
        HTTP_UNAUTHORIZED,
      );
    }
    let client: OAuth2Client;
    try {
      client = await this.deps.clients.forTokenRequest(plugin, spec);
    } catch (err) {
      // The registered client was forgotten after the provider rejected it: the grant
      // of this account belonged to it and can never be refreshed again.
      if (err instanceof OAuth2ClientMissing) {
        throw new UpstreamAuthError(
          `${plugin.displayName} no longer accepts the client this account was made with; reconnect it`,
          HTTP_UNAUTHORIZED,
        );
      }
      throw err;
    }
    try {
      return await refreshGrant(spec, client, credential, {
        fetch: this.deps.fetch,
        now: () => this.deps.clock.now(),
      });
    } catch (err) {
      if (err instanceof OAuth2TokenError) {
        if (err.oauthError === 'invalid_client') {
          await this.deps.clients.rejected(plugin, spec, client.clientId);
        }
        if (!err.rejected) throw new ProviderUnreachableError(err.message);
        throw new UpstreamAuthError(err.message, err.status || HTTP_UNAUTHORIZED);
      }
      throw err;
    }
  }
}

/** The refresh of a brokered account, for `CredentialBroker.obtain`. */
async function refreshAtBroker(
  brokers: Pick<OAuthBrokers, 'byName'>,
  plugin: ProviderPlugin,
  credential: OAuth2Secret,
  grant: BrokerGrant | null,
): Promise<OAuth2Secret> {
  if (grant === null) {
    throw new UpstreamAuthError(
      `${plugin.displayName}: this account holds no broker grant; reconnect it`,
      HTTP_UNAUTHORIZED,
    );
  }
  const spec = plugin.credential;
  if (spec.kind !== 'oauth2' || !isBrokeredSpec(spec)) {
    throw new Error(`plugin '${plugin.id}' does not take its client from a broker`);
  }
  const broker = brokers.byName(grant.broker);
  if (!broker) {
    throw new OAuthBrokerUnavailableError(
      grant.broker,
      `OAuth broker '${grant.broker}' this account was made through is no longer configured`,
    );
  }
  try {
    const fresh = await broker.token(spec.broker.provider, grant.refreshToken);
    return {
      kind: 'oauth2',
      accessToken: fresh.accessToken,
      refreshToken: null,
      expiresAt: fresh.expiresAt,
      scopes: fresh.scopes ?? credential.scopes,
      metadata: credential.metadata,
    };
  } catch (err) {
    if (!(err instanceof OAuthBrokerError)) throw err;
    // Only the provider's refusal of the refresh token (invalid_grant) ends the account.
    if (err.grantGone) throw new UpstreamAuthError(err.message, err.status || HTTP_UNAUTHORIZED);
    throw new OAuthBrokerUnavailableError(grant.broker, err.message);
  }
}

function pluginLogger(logger: Logger, pluginId: string): AccountContext['logger'] {
  const child = logger.child({ plugin: pluginId });
  return {
    debug: (message, data) => child.debug(message, data),
    info: (message, data) => child.info(message, data),
    warn: (message, data) => child.warn(message, data),
    error: (message, data) => child.error(message, data),
  };
}
