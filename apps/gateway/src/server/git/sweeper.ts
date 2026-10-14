/**
 * Sweeper of the temporary refs a push left at the provider while it waited
 * for an approval (spec §4.1 bis; ADR gateway-as-git-remote D5; migration
 * 0015). Once the request has expired, nobody will read the diff any more:
 * the refs are deleted at the provider (compare-and-swap on what they point
 * at) and their rows dropped.
 *
 * A connection that is gone (revoked, expired, deleted) cannot delete
 * anything: its rows are dropped, and the refs stay at the provider, where
 * the person who removes the grant sees them under `refs/vaubaan/`. A
 * provider that does not answer keeps the rows for the next pass, for at
 * most `PENDING_REF_GIVE_UP_MS` after the expiry.
 *
 * Several replicas may each run a sweeper: a second delete of a deleted ref
 * is refused by the provider and changes nothing. The timer is per process.
 */
import type { PluginRegistry } from '@vaubaan/plugin-sdk';

import { ConnectionUnavailableError, type CredentialBroker } from '../connections';
import type { ConnectionCredentialCache } from '../execution';
import type { Logger } from '../logging';
import type { PendingRefRecord, PendingRefsRepo } from '../store';
import type { Clock } from '../store/clock';
import { deleteTemporaryRefs } from './push';

export const PENDING_REF_SWEEP_INTERVAL_MS = 5 * 60_000;
/** Rows handled per pass. */
export const PENDING_REF_SWEEP_BATCH = 100;
/** After this long past their expiry, rows a provider never let us delete are dropped. */
export const PENDING_REF_GIVE_UP_MS = 24 * 60 * 60_000;

export interface PendingRefSweeperDeps {
  readonly pendingRefs: PendingRefsRepo;
  readonly registry: PluginRegistry;
  readonly credentials: Pick<CredentialBroker, 'resolve' | 'contextOf'>;
  readonly credentialCache: ConnectionCredentialCache;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly intervalMs?: number;
}

export interface PendingRefSweeper {
  /** One pass now; resolves with the number of rows dropped. Never rejects. */
  runOnce(): Promise<number>;
  stop(): void;
}

function groupKey(row: PendingRefRecord): string {
  return `${row.connectionId}\n${row.repository}`;
}

export function startPendingRefSweeper(deps: PendingRefSweeperDeps): PendingRefSweeper {
  let running = false;

  async function sweepGroup(rows: readonly PendingRefRecord[]): Promise<boolean> {
    const [first] = rows;
    if (!first) return true;
    try {
      const resolved = await deps.credentials.resolve(first.connectionId);
      const remote = resolved.plugin.gitRemote;
      if (!remote) return true;
      const ctx = {
        ...deps.credentials.contextOf(resolved),
        resources: [],
        credentialCache: deps.credentialCache.scopeFor(resolved.connection),
      };
      const upstream = await remote.upstream(ctx, first.repository, 'write');
      await deleteTemporaryRefs(
        ctx,
        upstream,
        rows.map((r) => ({ temporary: r.ref, objectId: r.objectId })),
      );
      return true;
    } catch (err) {
      if (err instanceof ConnectionUnavailableError) return true;
      const overdue =
        deps.clock.now().getTime() - Date.parse(first.expiresAt) > PENDING_REF_GIVE_UP_MS;
      deps.logger.warn('temporary refs not deleted at the provider', {
        connection_id: first.connectionId,
        refs: rows.length,
        error: err instanceof Error ? err.name : 'Error',
        giving_up: overdue,
      });
      return overdue;
    }
  }

  async function runOnce(): Promise<number> {
    // A pass slower than the interval is not stacked on.
    if (running) return 0;
    running = true;
    try {
      const rows = await deps.pendingRefs.listExpired(
        deps.clock.now().toISOString(),
        PENDING_REF_SWEEP_BATCH,
      );
      const groups = new Map<string, PendingRefRecord[]>();
      for (const row of rows) {
        const key = groupKey(row);
        groups.set(key, [...(groups.get(key) ?? []), row]);
      }
      let dropped = 0;
      for (const group of groups.values()) {
        if (await sweepGroup(group)) {
          dropped += await deps.pendingRefs.remove(group.map((r) => r.ref));
        }
      }
      return dropped;
    } catch (err) {
      deps.logger.error('temporary ref sweep failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return 0;
    } finally {
      running = false;
    }
  }

  const timer = setInterval(() => void runOnce(), deps.intervalMs ?? PENDING_REF_SWEEP_INTERVAL_MS);
  // The sweeper never keeps the process alive on its own.
  timer.unref();

  return {
    runOnce,
    stop() {
      clearInterval(timer);
    },
  };
}
