/**
 * Sweeper of the temporary refs a push left at the provider (spec §4.1 ter;
 * ADR gateway-as-git-remote D5; migration 0015): those whose deadline passed
 * — the request of a pending approval expired, or a push never finished (a
 * crash, a client gone, a provider that did not answer or kept the ref).
 *
 *   per ref    a row goes only once the provider confirmed its ref gone
 *              (`deleteTemporaryRefs`); a ref the provider kept keeps its row
 *   passes     one run takes batches until nothing is left to try, at most
 *              `PENDING_REF_SWEEP_PASSES` batches
 *   no blocking a group the provider refused this run is postponed by one
 *              interval: it goes to the back of the queue instead of heading
 *              every batch
 *   giving up  a row older than `PENDING_REF_GIVE_UP_MS` is dropped (logged)
 *   gone       an account that is gone (revoked, expired, deleted) cannot
 *              delete anything: its rows are dropped
 *
 * Several replicas may each run a sweeper: a second delete of a deleted ref
 * is reported gone and changes nothing. The timer is per process.
 */
import type { PluginRegistry } from '@vaubaan/plugin-sdk';

import { AccountUnavailableError, type CredentialBroker } from '../accounts';
import type { AccountCredentialCache } from '../execution';
import { errorFields, type Logger } from '../logging';
import type { PendingRefRecord, PendingRefsRepo } from '../store';
import type { Clock } from '../store/clock';
import { CLEANUP_TIMEOUT_MS } from './constants';
import { deleteTemporaryRefs, errorName } from './temporary-refs';

export const PENDING_REF_SWEEP_INTERVAL_MS = 5 * 60_000;
/** Rows handled per batch. */
export const PENDING_REF_SWEEP_BATCH = 100;
/** Batches per run, at most. */
export const PENDING_REF_SWEEP_PASSES = 20;
/** Rows a provider never let us delete are dropped once this old. */
export const PENDING_REF_GIVE_UP_MS = 48 * 60 * 60_000;

export interface PendingRefSweeperDeps {
  readonly pendingRefs: PendingRefsRepo;
  readonly registry: PluginRegistry;
  readonly credentials: Pick<CredentialBroker, 'resolve' | 'contextOf'>;
  readonly credentialCache: AccountCredentialCache;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly intervalMs?: number;
}

export interface PendingRefSweeper {
  /** One run now; resolves with the number of rows dropped. Never rejects. */
  runOnce(): Promise<number>;
  stop(): void;
}

function groupKey(row: PendingRefRecord): string {
  return `${row.accountId}\n${row.repository}`;
}

export function startPendingRefSweeper(deps: PendingRefSweeperDeps): PendingRefSweeper {
  const intervalMs = deps.intervalMs ?? PENDING_REF_SWEEP_INTERVAL_MS;
  let running = false;

  /** The refs of `rows` the provider confirmed gone (all of them for an account that is gone). */
  async function sweepGroup(rows: readonly PendingRefRecord[]): Promise<Set<string>> {
    const [first] = rows;
    if (!first) return new Set();
    try {
      const resolved = await deps.credentials.resolve(first.accountId);
      const remote = resolved.plugin.gitRemote;
      if (!remote) return new Set(rows.map((r) => r.ref));
      const ctx = {
        ...deps.credentials.contextOf(resolved, AbortSignal.timeout(CLEANUP_TIMEOUT_MS)),
        resources: [],
        credentialCache: deps.credentialCache.scopeFor(resolved.account),
      };
      const upstream = await remote.upstream(ctx, first.repository, 'write');
      return await deleteTemporaryRefs(
        ctx,
        upstream,
        rows.map((r) => ({ temporary: r.ref, objectId: r.objectId })),
      );
    } catch (err) {
      if (err instanceof AccountUnavailableError) return new Set(rows.map((r) => r.ref));
      deps.logger.warn('temporary refs not deleted at the provider', {
        account_id: first.accountId,
        refs: rows.length,
        error: errorName(err),
      });
      return new Set();
    }
  }

  async function oneBatch(): Promise<{ readonly seen: number; readonly dropped: number }> {
    const now = deps.clock.now();
    const rows = await deps.pendingRefs.listExpired(now.toISOString(), PENDING_REF_SWEEP_BATCH);
    const groups = new Map<string, PendingRefRecord[]>();
    for (const row of rows) groups.set(groupKey(row), [...(groups.get(groupKey(row)) ?? []), row]);
    let dropped = 0;
    for (const group of groups.values()) {
      const gone = await sweepGroup(group);
      const tooOld = group.filter(
        (r) => !gone.has(r.ref) && now.getTime() - Date.parse(r.createdAt) > PENDING_REF_GIVE_UP_MS,
      );
      if (tooOld.length > 0) {
        deps.logger.warn('temporary refs given up: the provider kept them', {
          account_id: group[0]?.accountId,
          refs: tooOld.length,
        });
      }
      dropped += await deps.pendingRefs.remove([...gone, ...tooOld.map((r) => r.ref)]);
      const kept = group.filter((r) => !gone.has(r.ref) && !tooOld.includes(r)).map((r) => r.ref);
      // To the back of the queue: the next run tries them again, after the others.
      await deps.pendingRefs.extend(kept, new Date(now.getTime() + intervalMs).toISOString());
    }
    return { seen: rows.length, dropped };
  }

  async function runOnce(): Promise<number> {
    // A run slower than the interval is not stacked on.
    if (running) return 0;
    running = true;
    try {
      let dropped = 0;
      for (let pass = 0; pass < PENDING_REF_SWEEP_PASSES; pass += 1) {
        const batch = await oneBatch();
        dropped += batch.dropped;
        if (batch.seen < PENDING_REF_SWEEP_BATCH) break;
      }
      return dropped;
    } catch (err) {
      deps.logger.error('temporary ref sweep failed', errorFields(err));
      return 0;
    } finally {
      running = false;
    }
  }

  const timer = setInterval(() => void runOnce(), intervalMs);
  // The sweeper never keeps the process alive on its own.
  timer.unref();

  return {
    runOnce,
    stop() {
      clearInterval(timer);
    },
  };
}
