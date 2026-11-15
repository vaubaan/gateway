/**
 * The body of `GET /ops/stats` (spec §4.3 bis): counts only, for the operator's
 * monitoring. Never a name, an e-mail, an identifier of an item, a resource or a
 * configuration value: the service ids, the key versions and the ceilings are the
 * only words, and they are the gateway's own.
 */
import type { LimitsConfig } from '../config/types';
import type { CallDecisionCounts, SealedVersionCount, StoreKind } from '../store';
import type { InstanceCounts } from './counts';

export interface OpsStats {
  readonly generated_at: string;
  readonly users: number;
  readonly accounts: {
    readonly total: number;
    readonly by_service: Readonly<Record<string, number>>;
  };
  readonly active_missions: number;
  readonly calls_today: {
    /** Midnight UTC of the current day. */
    readonly since: string;
    readonly allowed: number;
    readonly refused: number;
  };
  readonly store: { readonly kind: StoreKind; readonly bytes: number };
  readonly keys: {
    readonly current_version: number;
    /** Sealed values still held per key version, every sealed column together. */
    readonly sealed_by_version: Readonly<Record<string, number>>;
  };
  readonly limits: {
    readonly users: number | null;
    readonly accounts: number | null;
    readonly active_missions: number | null;
  };
}

export interface OpsStatsSources {
  readonly counts: InstanceCounts;
  readonly limits: LimitsConfig;
  readonly calls: { countCallsSince(since: string): Promise<CallDecisionCounts> };
  readonly store: { readonly kind: StoreKind; sizeOnDisk(): number };
  readonly sealed: { versions(): Promise<SealedVersionCount[]> };
  /** `config.encryption.keyVersion`. */
  readonly currentKeyVersion: number;
  readonly now: Date;
}

/** Midnight UTC of the day `now` falls in. */
export function utcMidnight(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

export async function collectOpsStats(sources: OpsStatsSources): Promise<OpsStats> {
  const since = utcMidnight(sources.now).toISOString();
  const [users, accounts, activeMissions, calls, sealed] = await Promise.all([
    sources.counts.users(),
    sources.counts.accounts(),
    sources.counts.activeMissions(sources.now),
    sources.calls.countCallsSince(since),
    sources.sealed.versions(),
  ]);
  const sealedByVersion: Record<string, number> = {};
  for (const { keyVersion, count } of sealed) {
    const key = String(keyVersion);
    sealedByVersion[key] = (sealedByVersion[key] ?? 0) + count;
  }
  return {
    generated_at: sources.now.toISOString(),
    users,
    accounts: { total: accounts.total, by_service: { ...accounts.byService } },
    active_missions: activeMissions,
    calls_today: { since, allowed: calls.allowed, refused: calls.refused },
    store: { kind: sources.store.kind, bytes: sources.store.sizeOnDisk() },
    keys: { current_version: sources.currentKeyVersion, sealed_by_version: sealedByVersion },
    limits: {
      users: sources.limits.users,
      accounts: sources.limits.accounts,
      active_missions: sources.limits.activeMissions,
    },
  };
}
