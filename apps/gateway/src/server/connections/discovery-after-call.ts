/**
 * Discovery after a creating call (ADR discovery-runs-after-a-creating-call).
 *
 * A call that succeeded through the execution door, of a tool its plugin lists
 * in `resourceCreatingTools` (`fly__create_app`), created a resource the
 * connection does not know yet. The door hands the call to `afterCall` once it
 * has its answer; the connection's discovery then runs again — the owner's
 * "Refresh", same merge (`ConnectionService.discoverAfterCall`) — so the new
 * resource is listed, labelled by the connection's default environment, and
 * reached by a mission issued on the whole connection, from the next call on.
 *
 *   off the request path   `afterCall` returns at once; the discovery starts on
 *                          a later turn of the event loop (`defer`), so the
 *                          agent's answer never waits for it
 *   coalesced              per connection, one discovery in flight and at most
 *                          one queued: a burst of creations is two discoveries,
 *                          not one per call
 *   bounded retry          a discovery that failed, or that found nothing new
 *                          (a provider that lists a resource a moment after
 *                          creating it), is run again after each delay of
 *                          `retryDelaysMs`, then given up
 *   audited once           one `resources-discovered` entry per scheduled
 *                          discovery, `after.cause = 'after-a-call'`, with the
 *                          mission, the tool, the attempts and how many refs it
 *                          added; the actor is the human behind the call's key
 *   never fails a call     an error is logged with the connection id, the tool
 *                          and the mission — never the call's arguments
 *
 * Single process: the in-flight map is local (`// single-process only`), like
 * the broker's refresh lock; a hosted deployment with several processes would
 * run at most one discovery per process and connection.
 */
import type { MissionContext } from '@vaubaan/gateway-core';
import type { PluginRegistry } from '@vaubaan/plugin-sdk';

import type { Logger } from '../logging';
import type { AfterCallDiscovery, ConnectionService, DiscoveryAfterCallCause } from './service';

/** Delays before looking again when a discovery failed or found nothing new. */
export const DISCOVERY_AFTER_CALL_RETRY_DELAYS_MS: readonly number[] = [2_000, 10_000];

/** What the door knows of a call it answered. */
export interface AnsweredCall {
  readonly tool: string;
  /** The connection the call was resolved to (`CallAuditEntry.connection_id`). */
  readonly connectionId: string | null;
  /** What the plugin returned: an `isError` result is a call the plugin declined. */
  readonly result: unknown;
}

/** A scheduled discovery: why, and who is behind it. */
export interface ScheduledCause extends DiscoveryAfterCallCause {
  /** The audit's actor: the member holding the key, or the creator for a named key. */
  readonly userId: string;
}

export interface DiscoveryAfterCallDeps {
  readonly registry: Pick<PluginRegistry, 'providerForTool'>;
  readonly service: Pick<ConnectionService, 'discoverAfterCall' | 'auditDiscoveryAfterCall'>;
  readonly logger: Logger;
  readonly retryDelaysMs?: readonly number[];
  /** Runs `fn` after the current request is answered; default `setTimeout(fn, 0)`. */
  readonly defer?: (fn: () => void) => void;
  /** Waits `ms` before looking again; default a timer that `stop()` cuts short. */
  readonly sleep?: (ms: number) => Promise<void>;
}

interface InFlight {
  readonly done: Promise<void>;
  queued: ScheduledCause | null;
}

export class DiscoveryAfterCall {
  private readonly inFlight = new Map<string, InFlight>(); // single-process only
  private readonly retryDelaysMs: readonly number[];
  private readonly defer: (fn: () => void) => void;
  private readonly sleep: (ms: number) => Promise<void>;
  private stopped = false;
  /** Wakes the retries waiting on the default timer, so `stop()` does not wait for them. */
  private readonly sleepers = new Set<() => void>();

  constructor(private readonly deps: DiscoveryAfterCallDeps) {
    this.retryDelaysMs = deps.retryDelaysMs ?? DISCOVERY_AFTER_CALL_RETRY_DELAYS_MS;
    this.defer = deps.defer ?? ((fn) => void setTimeout(fn, 0));
    this.sleep = deps.sleep ?? ((ms) => this.timer(ms));
  }

  /**
   * The door's hook, called with every allowed call it answered. Schedules a
   * discovery of the call's connection when the call succeeded (not an
   * `isError` result) and its tool is one the plugin declares as creating a
   * resource. Returns whether it scheduled one. Never throws, never waits.
   */
  afterCall(ctx: MissionContext, call: AnsweredCall): boolean {
    if (this.stopped || call.connectionId === null || isErrorResult(call.result)) return false;
    const registered = this.deps.registry.providerForTool(call.tool);
    if (!registered?.plugin.resourceCreatingTools?.includes(call.tool)) return false;
    const connection = ctx.connections.find((c) => c.id === call.connectionId);
    if (!connection || connection.provider !== registered.plugin.id) return false;
    this.schedule(call.connectionId, {
      missionId: ctx.mission.id,
      tool: call.tool,
      userId:
        ctx.token.holder.kind === 'member' ? ctx.token.holder.user_id : ctx.mission.creator_id,
    });
    return true;
  }

  /** One discovery of the connection, coalesced with the one in flight. */
  schedule(connectionId: string, cause: ScheduledCause): void {
    if (this.stopped) return;
    const current = this.inFlight.get(connectionId);
    if (current) {
      // The latest call names the cause: one queued discovery covers them all.
      current.queued = cause;
      return;
    }
    let started!: () => void;
    const go = new Promise<void>((resolve) => (started = resolve));
    const entry: InFlight = {
      queued: null,
      done: go
        .then(() => this.drainConnection(connectionId, cause, entry))
        .finally(() => this.inFlight.delete(connectionId)),
    };
    this.inFlight.set(connectionId, entry);
    this.defer(started);
  }

  /** Resolves when no discovery is in flight or queued (tests, shutdown). */
  async idle(): Promise<void> {
    while (this.inFlight.size > 0) {
      await Promise.all([...this.inFlight.values()].map((e) => e.done));
    }
  }

  /** Schedules nothing more; waits for the discoveries in flight (`root.close()`). */
  async stop(): Promise<void> {
    this.stopped = true;
    for (const entry of this.inFlight.values()) entry.queued = null;
    for (const wake of [...this.sleepers]) wake();
    await this.idle();
  }

  private timer(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const wake = (): void => {
        clearTimeout(handle);
        this.sleepers.delete(wake);
        resolve();
      };
      const handle = setTimeout(wake, ms);
      this.sleepers.add(wake);
    });
  }

  private async drainConnection(
    connectionId: string,
    first: ScheduledCause,
    entry: InFlight,
  ): Promise<void> {
    let cause: ScheduledCause | null = first;
    while (cause !== null) {
      await this.runOnce(connectionId, cause);
      cause = this.stopped ? null : entry.queued;
      entry.queued = null;
    }
  }

  /** One scheduled discovery: its attempts, then its audit entry. Never throws. */
  private async runOnce(connectionId: string, cause: ScheduledCause): Promise<void> {
    const context = { connection_id: connectionId, tool: cause.tool, mission_id: cause.missionId };
    try {
      let outcome: AfterCallDiscovery | null = null;
      let attempts = 0;
      for (;;) {
        outcome = await this.deps.service.discoverAfterCall(connectionId, cause);
        attempts += 1;
        if (outcome === null) return; // the connection no longer serves: nothing to look for
        const lookAgain = !outcome.record.ok || outcome.added === 0;
        const delay = this.retryDelaysMs[attempts - 1];
        if (!lookAgain || delay === undefined || this.stopped) break;
        await this.sleep(delay);
        if (this.stopped) break;
      }
      await this.deps.service.auditDiscoveryAfterCall(connectionId, cause, {
        ...outcome,
        attempts,
      });
      this.deps.logger.info('resource discovery after a creating call', {
        ...context,
        ok: outcome.record.ok,
        added: outcome.added,
        attempts,
      });
    } catch (error) {
      this.deps.logger.warn('resource discovery after a creating call failed', {
        ...context,
        error_class: error instanceof Error ? error.name : typeof error,
      });
    }
  }
}

function isErrorResult(result: unknown): boolean {
  return (
    typeof result === 'object' &&
    result !== null &&
    (result as { isError?: unknown }).isError === true
  );
}
