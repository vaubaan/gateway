/**
 * The discovery of an account's resources: the first one at connect, a person's "Refresh",
 * "check now" for a mission, the automatic refresh and the one after a call that created a
 * resource (spec §4.2). The account service delegates these acts here and lends ownership and
 * the clock (`AccountDiscoveryHost`).
 */
import { isUpstreamAuthError, UpstreamAuthError } from '@vaubaan/shared';
import {
  type AccountContext,
  type CredentialCheck,
  type CredentialSecret,
  type ServicePlugin,
  type Resource,
} from '@vaubaan/plugin-sdk';
import { DISCOVERY_ACTOR_ID } from '@vaubaan/gateway-core';
import type { ResourceMove } from '../store';
import type { AccountRecord } from '../store/types';
import type { ResolvedCredential } from './credentials';
import { ConnectError } from './errors';
import { serviceFailureReason } from './failure-reason';
import { usableResourcesOf } from './input';
import { accountCredentialKind, isRetiredWay, retiredWayReason } from './mapping';
import type {
  Actor,
  DiscoveryRecord,
  DiscoveryAfterCallCause,
  AfterCallDiscovery,
  AutomaticRefreshCause,
  AutomaticRefresh,
  MissionResourceCheck,
} from './account-views';
import type { MissionResourceMoves } from './account-views';
import { cleanName } from './input';
import { grantedNames } from './token-permissions';
import { isHostAccount } from './host-account';
import type { AccountService, AccountServiceDeps, DiscoveryPolicy } from './service';

/** The outcome of the discovery attempted before the account is written. */
export interface FirstDiscovery {
  /** `null` when the discovery was deferred or failed. */
  readonly resources: readonly Resource[] | null;
  /** The failure a `best-effort` policy tolerated, recorded on the account. */
  readonly error: string | null;
}

/** "Check now" on mission cards: this many discoveries per user per window. */
export const CHECK_NOW_RATE_LIMIT = 10;

export const CHECK_NOW_RATE_WINDOW_MS = 60_000;

/** Moves grouped by set and reason, refs in the order they were written. */
export function movesBySet(moves: readonly ResourceMove[]): MissionResourceMoves[] {
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

/** What a key's check says, as the account's metadata keeps it; an unreadable expiry is none. */
export function keyFactsOf(check: CredentialCheck): {
  readonly account: string | null;
  readonly expires_at: string | null;
  readonly granted?: string[];
} {
  const expiresMs = check.expiresAt === null ? null : Date.parse(check.expiresAt);
  return {
    account: cleanName(check.account),
    expires_at:
      expiresMs === null || !Number.isFinite(expiresMs) ? null : new Date(expiresMs).toISOString(),
    ...(check.granted === undefined ? {} : { granted: grantedNames(check.granted) }),
  };
}

/** Where a discovery reports beyond its record. */
export interface DiscoverySinks {
  /** The audit's actor of the joins and leaves it causes. */
  readonly actorId: string;
  /** Filled with the refs the discovery returned. */
  readonly returned?: Set<string>;
  /** Filled with the joins and leaves it caused. */
  readonly moves?: ResourceMove[];
}

export function isTransportFailure(err: unknown): boolean {
  return (
    err instanceof TypeError ||
    (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError'))
  );
}

/** A discovery that does not finish within this delay is reported as failed. */
export const DISCOVERY_TIMEOUT_MS = 30_000;

/** What the discovery reads of the account service: ownership and the clock. */
export type AccountDiscoveryHost = Pick<AccountService, 'requireOwned' | 'owns' | 'nowIso'>;

export class AccountDiscovery {
  constructor(
    private readonly deps: AccountServiceDeps,
    private readonly host: AccountDiscoveryHost,
  ) {}

  /**
   * Tries the credential that was just obtained, before anything is stored.
   * Throws the `ConnectError` of a failure the policy does not tolerate.
   */
  async firstDiscovery(
    plugin: ServicePlugin,
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
          rejected || !isTransportFailure(err) ? 'credential-rejected' : 'service-unreachable',
          `${plugin.displayName}: ${serviceFailureReason(err, secret)}`,
        );
      }
      // Recorded on the account, which other owners read: the status only.
      return { resources: null, error: serviceFailureReason(err) };
    }
  }

  /**
   * The owner's "refresh discovery". On a rejected credential the broker
   * refreshes once; a second rejection leaves the account `expired`. The
   * outcome is recorded on the account and returned, never thrown: a
   * failed discovery leaves the known resources as they were.
   */
  async discover(actor: Actor, accountId: string): Promise<DiscoveryRecord> {
    const account = await this.host.requireOwned(actor, accountId);
    if (account.status === 'revoked') throw new ConnectError('account-revoked');
    const record = await this.rediscover(account, null, { actorId: actor.user.id });
    // After a key's scope changed at the service: what it may do now.
    if (record.ok) await this.reverify(account.id);
    await this.auditDiscovery(actor.user.id, account, record, null);
    return record;
  }

  /**
   * "Check now" on a mission card (ADR
   * resource-set-is-one-environment-with-optional-future-resources): runs the discovery
   * of one account of the mission and says what joined or left that mission. The
   * mission's creator, or an owner of the account, may ask; anyone else, a mission
   * without that account, or a missing one reads `not-found`. Rate-limited per user
   * (`CHECK_NOW_RATE_LIMIT`); audited as a `resources-discovered` entry, cause `check-now`.
   */
  async checkForMission(
    actor: Actor,
    missionId: string,
    accountId: string,
  ): Promise<MissionResourceCheck> {
    const mission = await this.deps.store.missions.getById(missionId);
    const account = await this.deps.store.accounts.getById(accountId);
    if (
      !mission ||
      !account ||
      !mission.accounts.some((c) => c.accountId === accountId) ||
      (mission.creatorUserId !== actor.user.id && !this.host.owns(actor, account))
    ) {
      throw new ConnectError('not-found');
    }
    if (account.status === 'revoked') throw new ConnectError('account-revoked');
    const decision = await this.deps.rateLimiter.take(
      `check-resources:${actor.user.id}`,
      CHECK_NOW_RATE_LIMIT,
      CHECK_NOW_RATE_WINDOW_MS,
    );
    if (!decision.allowed) throw new ConnectError('rate-limited', null, decision.retryAfterMs);
    const moves: ResourceMove[] = [];
    const record = await this.rediscover(account, null, { actorId: actor.user.id, moves });
    await this.auditDiscovery(actor.user.id, account, record, null, {
      cause: 'check-now',
      mission_id: missionId,
    });
    const own = moves.filter((m) => m.missionId === missionId);
    return {
      account_id: accountId,
      discovery: record,
      last_checked_at: record.at,
      joined: movesBySet(own.filter((m) => m.change === 'joined')),
      left: movesBySet(own.filter((m) => m.change === 'left')),
    };
  }

  /**
   * A refresh the gateway runs on its own (`AccountRefresher`): hourly, or because a page
   * showed the account stale. The same discovery as "Refresh" — a rejected key turns the
   * account `expired` and tells its owners, new resources follow the plugin's hidden
   * marks and join the future sets, missing ones go stale — then the key's check again.
   * Audited (`resources-discovered`, actor `DISCOVERY_ACTOR_ID`, `cause` scheduled or
   * on-open) only when something changed: a no-op refresh leaves no entry. `null` when
   * the account does not serve (gone, revoked, expired) or is a host account.
   */
  async refreshOnItsOwn(
    accountId: string,
    cause: AutomaticRefreshCause,
  ): Promise<AutomaticRefresh | null> {
    const account = await this.deps.store.accounts.getById(accountId);
    if (
      !account ||
      account.status === 'revoked' ||
      account.status === 'expired' ||
      isHostAccount(account)
    ) {
      return null;
    }
    const before = await this.liveRefsOf(account.id);
    const record = await this.rediscover(account, null, { actorId: DISCOVERY_ACTOR_ID });
    const rightsChanged = record.ok ? await this.reverify(account.id) : false;
    const after = await this.liveRefsOf(account.id);
    const added = [...after].filter((ref) => !before.has(ref)).length;
    const removed = [...before].filter((ref) => !after.has(ref)).length;
    const expired = (await this.deps.store.accounts.getById(account.id))?.status === 'expired';
    const changed = added > 0 || removed > 0 || rightsChanged || expired;
    if (changed) {
      await this.deps.audit.write({
        kind: 'admin',
        ts: this.host.nowIso(),
        user_id: DISCOVERY_ACTOR_ID,
        act: 'resources-discovered',
        object: { type: 'account', id: account.id },
        before: null,
        after: {
          ok: record.ok,
          count: record.count,
          error: record.error,
          cause,
          added,
          removed,
          rights_changed: rightsChanged,
          ...(expired ? { expired: true } : {}),
        },
      });
    }
    return { record, added, removed, rightsChanged, expired, changed };
  }

  /** The refs of the account's resources that are not stale. */
  private async liveRefsOf(accountId: string): Promise<Set<string>> {
    return new Set(
      (await this.deps.store.accounts.listResources(accountId))
        .filter((r) => r.staleSince === null)
        .map((r) => r.ref),
    );
  }

  /**
   * A pasted key's check (`verify`) asked again, after a discovery that worked: who it
   * acts as, until when, what it holds. Written when the service says something else
   * than what is stored; true then. A check that fails changes nothing (the discovery
   * just proved the key works) and is logged by account only.
   */
  private async reverify(accountId: string): Promise<boolean> {
    const account = await this.deps.store.accounts.getById(accountId);
    const plugin = account ? this.deps.registry.get(account.service)?.plugin : undefined;
    if (!account || !plugin) return false;
    const spec = plugin.credential;
    if (spec.kind !== 'api-key' || !spec.verify) return false;
    if (accountCredentialKind(account, spec.kind) !== 'api-key') return false;
    let check: CredentialCheck;
    try {
      const resolved = await this.deps.broker.resolve(accountId);
      if (resolved.credential.kind !== 'api-key') return false;
      check = await spec.verify({
        credential: resolved.credential,
        fetch: this.deps.fetch,
        signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
      });
    } catch (err) {
      this.deps.logger.warn('key check failed on refresh', {
        account_id: accountId,
        service: account.service,
        failure: serviceFailureReason(err),
      });
      return false;
    }
    const said = keyFactsOf(check);
    const metadata = account.metadata ?? {};
    const factsDiffer =
      (metadata.account ?? null) !== said.account ||
      (metadata.expires_at ?? null) !== said.expires_at ||
      (said.granted !== undefined &&
        JSON.stringify(metadata.granted ?? null) !== JSON.stringify(said.granted));
    const expiryDiffers = account.credentialExpiresAt !== said.expires_at;
    if (!factsDiffer && !expiryDiffers) return false;
    if (factsDiffer) {
      await this.deps.store.accounts.setMetadata(accountId, {
        ...metadata,
        account: said.account,
        expires_at: said.expires_at,
        ...(said.granted === undefined ? {} : { granted: said.granted }),
      });
    }
    if (expiryDiffers) {
      await this.deps.store.accounts.setCredentialExpiresAt(accountId, said.expires_at);
    }
    return true;
  }

  /**
   * The gateway's own discovery after a call that created a resource of the
   * account (ADR created-resources-join-the-mission): the same merge as
   * the owner's "Refresh", run by `DiscoveryAfterCall` off the request path.
   * Nothing is audited here: the scheduler may look again (a service that
   * lists a new resource a moment late) and audits the outcome once, through
   * `auditDiscoveryAfterCall`. `null` when the account no longer serves
   * (gone, revoked, expired): there is nothing to look for with it.
   * `createdRefs`: the refs the call created, read from its answer and already
   * recorded (ADR created-resources-join-the-mission); the outcome says how many
   * of them this discovery did not return yet.
   */
  async discoverAfterCall(
    accountId: string,
    cause: DiscoveryAfterCallCause,
    createdRefs: readonly string[] = [],
  ): Promise<AfterCallDiscovery | null> {
    const account = await this.deps.store.accounts.getById(accountId);
    if (!account || account.status === 'revoked' || account.status === 'expired') {
      return null;
    }
    const liveRefs = async (): Promise<Set<string>> =>
      new Set(
        (await this.deps.store.accounts.listResources(account.id))
          .filter((r) => r.staleSince === null)
          .map((r) => r.ref),
      );
    const before = await liveRefs();
    const returned = new Set<string>();
    const record = await this.rediscover(account, cause, {
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
    accountId: string,
    cause: DiscoveryAfterCallCause & { readonly userId: string },
    outcome: AfterCallDiscovery & { readonly attempts: number },
  ): Promise<void> {
    const account = await this.deps.store.accounts.getById(accountId);
    if (!account) return;
    await this.auditDiscovery(cause.userId, account, outcome.record, {
      mission_id: cause.missionId,
      tool: cause.tool,
      added: outcome.added,
      attempts: outcome.attempts,
    });
  }

  /**
   * One discovery of an account that is not revoked, merged into its
   * resources, its outcome recorded on the account and returned — never
   * thrown. On a rejected credential the broker refreshes once.
   */
  private async rediscover(
    account: AccountRecord,
    afterCall: DiscoveryAfterCallCause | null,
    sinks: DiscoverySinks,
  ): Promise<DiscoveryRecord> {
    // An account made a way the plugin no longer declares: its stored secret is not
    // what the plugin reads, so the plugin is not called; the owner reconnects it.
    const retired = this.retiredWayOf(account);
    if (retired !== null) return this.recordDiscovery(account.id, 0, retired, afterCall);
    try {
      let resolved = await this.deps.broker.resolve(account.id);
      let resources: readonly Resource[];
      try {
        resources = await this.discoverWith(resolved.plugin, this.discoveryContextOf(resolved));
      } catch (err) {
        if (!isUpstreamAuthError(err)) throw err;
        try {
          resolved = await this.deps.broker.refresh(account.id);
        } catch (refreshErr) {
          if (!isUpstreamAuthError(refreshErr)) throw refreshErr;
          // Keep the service's own words: they say what is wrong with the credential.
          throw new UpstreamAuthError(
            `${err.message} — the credential could not be refreshed, the account is now expired; reconnect it`,
            err.upstreamStatus,
          );
        }
        resources = await this.discoverWith(resolved.plugin, this.discoveryContextOf(resolved));
      }
      return await this.storeDiscovery(account, resolved.plugin, resources, sinks, afterCall);
    } catch (err) {
      this.deps.logger.warn('resource discovery failed', {
        account_id: account.id,
        service: account.service,
        failure: serviceFailureReason(err),
        ...(afterCall ? { after_call_of: afterCall.tool, mission_id: afterCall.missionId } : {}),
      });
      return this.recordDiscovery(account.id, 0, serviceFailureReason(err), afterCall);
    }
  }

  /** A discovery's context: the stored credential, under the discovery's deadline. */
  private discoveryContextOf(resolved: ResolvedCredential): AccountContext {
    return this.deps.broker.contextOf(resolved, AbortSignal.timeout(DISCOVERY_TIMEOUT_MS));
  }

  private async discoverWith(
    plugin: ServicePlugin,
    ctx: AccountContext,
  ): Promise<readonly Resource[]> {
    return plugin.discoverResources(ctx);
  }

  async storeDiscovery(
    account: AccountRecord,
    plugin: ServicePlugin,
    resources: readonly Resource[],
    sinks: DiscoverySinks,
    afterCall: DiscoveryAfterCallCause | null = null,
  ): Promise<DiscoveryRecord> {
    const { usable, unusable } = usableResourcesOf(plugin.id, resources);
    for (const r of usable) sinks.returned?.add(r.ref);
    for (let i = 0; i < unusable; i += 1) {
      this.deps.logger.warn('plugin returned an unusable resource; ignored', {
        service: plugin.id,
        account_id: account.id,
      });
    }
    const before = await this.deps.futureResources?.snapshot(account.id);
    await this.deps.store.accounts.syncDiscoveredResources(account.id, usable);
    const record = await this.recordDiscovery(account.id, usable.length, null, afterCall);
    // Recorded first: a mission page reads "last checked" with what joined.
    if (before) {
      const moves = await this.deps.futureResources?.settle(account.id, before, sinks.actorId);
      sinks.moves?.push(...(moves ?? []));
    }
    return record;
  }

  async recordDiscovery(
    accountId: string,
    count: number,
    error: string | null,
    afterCall: DiscoveryAfterCallCause | null = null,
  ): Promise<DiscoveryRecord> {
    const record: DiscoveryRecord = {
      at: this.host.nowIso(),
      ok: error === null,
      count,
      error,
      afterCall,
    };
    const current = await this.deps.store.accounts.getById(accountId);
    if (current) {
      await this.deps.store.accounts.setMetadata(accountId, {
        ...(current.metadata ?? {}),
        discovery: record,
      });
    }
    return record;
  }

  /** The refusal sentence of an account made a way its plugin no longer declares, or `null`. */
  private retiredWayOf(account: AccountRecord): string | null {
    const registered = this.deps.registry.get(account.service);
    if (!registered) return null;
    const { plugin } = registered;
    const kind = accountCredentialKind(account, plugin.credential.kind);
    return kind !== null && isRetiredWay(kind, plugin.credential.kind)
      ? retiredWayReason(plugin.displayName, kind)
      : null;
  }

  /**
   * A discovery after the first: the outcome, never the resource list. `cause`
   * says who ran it — the owner's "Refresh" (`by-owner`, the actor is the
   * owner), or the gateway after a creating call (`after-a-call`, the actor is
   * the human behind the call's key).
   */
  private async auditDiscovery(
    userId: string,
    account: AccountRecord,
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
      ts: this.host.nowIso(),
      user_id: userId,
      act: 'resources-discovered',
      object: { type: 'account', id: account.id },
      before: null,
      after: {
        ok: record.ok,
        count: record.count,
        error: record.error,
        ...(afterCall
          ? { cause: 'after-a-call', ...afterCall }
          : (checkNow ?? { cause: 'by-owner' })),
      },
    });
  }
}
