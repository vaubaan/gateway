/**
 * `ActivityOverviewService` — what the Overview of Activity reads (spec §4.2
 * "Activity"): per mission the reader may see, over a span (today, 7 days, 30
 * days), the calls allowed and refused, the requests that wait, the bytes sent
 * up to the services and received down, the calls per account and per key
 * holder, the use of each permission in the mission's current period; and,
 * across those missions, what expires soon.
 *
 * Scope: the Timeline's (`eventScopeOf`) — the missions the reader created or
 * is a current member of, every mission for an operator, none for the
 * bootstrap token. An account's owner reads its calls in the Record, not the
 * missions that carry it (handbook audit.md). The scope is applied in SQL by
 * each read, never by filtering rows here.
 *
 * Reads, and where each number comes from:
 *
 *   - the missions shown — `MissionsRepo.listInScope`: running ones, and any
 *     with a call in the span;
 *   - calls, bytes, accounts, holders — ONE statement over the audit for every
 *     mission (`AuditRepo.callTotals`, index `audit_calls_overview`), summed
 *     here by mission, account and holder (`totalsByMission`). Counts of audit
 *     entries, never a budget;
 *   - waiting — `RequestsRepo.countOpenInScope`, one statement;
 *   - the use of the period — the budget's own derivation
 *     (`MissionService.standing` → `stateOf`), the same remaining counts the
 *     mission page and its mission log page read: `used = quota - remaining`;
 *   - the accounts' names, states and expiries — one read per distinct account.
 *
 * Nothing here is a sentence: the page words it (`vocabulary.ts`).
 */
import {
  policyLineKey,
  type CredentialKind,
  type Gate,
  type MissionStatus,
  type MissionTokenKind,
  type RiskId,
} from '@vaubaan/shared';
import { MS_PER_DAY } from '@vaubaan/shared/time';

import { accountCredentialKind } from '../accounts/mapping';
import type { MissionState } from '../budget';
import type { MissionService } from '../missions';
import type { AccountRecord, CallTotalsRow, MissionRecord, Store } from '../store';
import type { Clock } from '../store/clock';
import type { AuditViewer } from './query-service';
import { HolderNames, type MissionLogHolderView } from './mission-log-view';
import { eventScopeOf } from './timeline';

/** What "expires soon" means, in days, for a mission's end and an account's key. */
export const EXPIRING_SOON_DAYS = 7;

export const OVERVIEW_PERIODS = ['today', '7d', '30d'] as const;
export type OverviewPeriod = (typeof OVERVIEW_PERIODS)[number];
export const DEFAULT_OVERVIEW_PERIOD: OverviewPeriod = '7d';
export const OVERVIEW_PARAMS = { period: 'period' } as const;

/** The period an address names; the default for anything else. */
export function parseOverviewPeriod(
  query: Readonly<Record<string, string | readonly string[] | undefined>>,
): OverviewPeriod {
  const value = query[OVERVIEW_PARAMS.period];
  const text = Array.isArray(value) ? (value as readonly string[])[0] : value;
  return OVERVIEW_PERIODS.find((p) => p === text) ?? DEFAULT_OVERVIEW_PERIOD;
}

/** Where a span starts: midnight UTC today, or 7 or 30 days back from now. */
export function sinceOf(period: OverviewPeriod, now: Date): Date {
  if (period === 'today') {
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  }
  return new Date(now.getTime() - (period === '7d' ? 7 : 30) * MS_PER_DAY);
}

/** Calls counted and bytes summed, for a mission, an account or a holder. */
export interface OverviewCounts {
  readonly allowed: number;
  readonly refused: number;
  readonly request_bytes: number;
  readonly response_bytes: number;
}

/** One line of the policy with its use in the mission's current period. */
export interface OverviewLine {
  readonly risk_id: RiskId;
  readonly resource_set_id: string;
  readonly quota: number;
  /** Counted this period; `null` when the mission is not active (no current period). */
  readonly used: number | null;
  readonly gate: Gate;
}

export interface OverviewAccount extends OverviewCounts {
  readonly id: string;
  /** The service the account is at (the plugin id). */
  readonly service: string;
  /** `null` when the account row no longer exists. */
  readonly display_name: string | null;
  readonly lines: readonly OverviewLine[];
}

export interface OverviewHolder extends OverviewCounts {
  /** `null`: calls written before keys had a holder. */
  readonly holder: MissionLogHolderView | null;
  /** This holder's part of the mission's calls in the span, from 0 to 1. */
  readonly share: number;
}

export interface OverviewMission {
  readonly id: string;
  readonly name: string;
  /** The derived status (`orphaned` while its authority is missing). */
  readonly status: MissionStatus;
  readonly state: MissionState['kind'];
  /** The reader created it: the only one who edits it and answers its requests. */
  readonly created_by_viewer: boolean;
  readonly expires_at: string | null;
  /** The mission's current budget period; `null` when it is not active. */
  readonly period: { readonly start: string; readonly end: string | null } | null;
  /** Period length in seconds; `null` for a one-off mission. */
  readonly period_seconds: number | null;
  readonly totals: OverviewCounts & { readonly waiting: number };
  /** The mission's accounts, busiest first; an account with no call in the span included. */
  readonly accounts: readonly OverviewAccount[];
  /** Busiest first. */
  readonly holders: readonly OverviewHolder[];
}

/** Something that stops working soon, and where it is fixed. */
export type OverviewExpiry =
  | {
      readonly kind: 'mission';
      readonly mission_id: string;
      readonly mission_name: string;
      readonly expires_at: string;
      /** The reader can extend it (its creator). */
      readonly fixable: boolean;
    }
  | {
      readonly kind: 'account';
      readonly account_id: string;
      readonly service: string;
      readonly display_name: string;
      /** `null` with `expired`: the service already refused the key. */
      readonly expires_at: string | null;
      readonly expired: boolean;
      /** One mission of the reader it serves, for who cannot fix the account. */
      readonly mission_id: string;
      readonly mission_name: string;
      /** The reader owns it (alone or through a team): the account page fixes it. */
      readonly fixable: boolean;
    };

export interface ActivityOverview {
  readonly period: OverviewPeriod;
  readonly since: string;
  readonly now: string;
  /** Busiest first, then running before stopped, then by name. */
  readonly missions: readonly OverviewMission[];
  /** Soonest first; the expired accounts first of all. */
  readonly expiring: readonly OverviewExpiry[];
}

export interface ActivityOverviewDeps {
  readonly store: Pick<Store, 'audit' | 'missions' | 'requests' | 'accounts' | 'users'>;
  readonly missions: Pick<MissionService, 'standing'>;
  /** The kind of credential a service's plugin takes first (`api-key`, `oauth2`…); `null` when unknown. */
  readonly credentialKindOf: (service: string) => CredentialKind | null;
  readonly clock: Clock;
}

const NO_COUNTS: OverviewCounts = {
  allowed: 0,
  refused: 0,
  request_bytes: 0,
  response_bytes: 0,
};

function add(a: OverviewCounts, row: CallTotalsRow): OverviewCounts {
  return {
    allowed: a.allowed + row.allowed,
    refused: a.refused + row.refused,
    request_bytes: a.request_bytes + row.requestBytes,
    response_bytes: a.response_bytes + row.responseBytes,
  };
}

/** The key holder of a row, as a map key; `''` for the calls before keys had a holder. */
function holderKey(kind: MissionTokenKind | null, holder: string | null): string {
  return kind === null || holder === null ? '' : `${kind}:${holder}`;
}

/** The sums of one mission: in total, per account, per holder. */
export interface MissionTotals {
  readonly total: OverviewCounts;
  readonly byAccount: ReadonlyMap<string, OverviewCounts>;
  readonly byHolder: ReadonlyMap<
    string,
    { readonly kind: MissionTokenKind | null; readonly holder: string | null } & OverviewCounts
  >;
}

/**
 * The rows of `AuditRepo.callTotals` summed by mission, then per account and per holder.
 * A call refused before its account was resolved counts in the total, under no account.
 */
export function totalsByMission(rows: readonly CallTotalsRow[]): Map<string, MissionTotals> {
  const out = new Map<
    string,
    {
      total: OverviewCounts;
      byAccount: Map<string, OverviewCounts>;
      byHolder: Map<
        string,
        { kind: MissionTokenKind | null; holder: string | null } & OverviewCounts
      >;
    }
  >();
  for (const row of rows) {
    let mission = out.get(row.missionId);
    if (!mission) {
      mission = { total: NO_COUNTS, byAccount: new Map(), byHolder: new Map() };
      out.set(row.missionId, mission);
    }
    mission.total = add(mission.total, row);
    if (row.accountId !== null) {
      mission.byAccount.set(
        row.accountId,
        add(mission.byAccount.get(row.accountId) ?? NO_COUNTS, row),
      );
    }
    const key = holderKey(row.kind, row.holder);
    const before = mission.byHolder.get(key) ?? {
      kind: row.kind,
      holder: row.holder,
      ...NO_COUNTS,
    };
    mission.byHolder.set(key, { kind: before.kind, holder: before.holder, ...add(before, row) });
  }
  return out;
}

function callsOf(counts: OverviewCounts): number {
  return counts.allowed + counts.refused;
}

/** The lines of one account of the mission, with the use of the current period. */
function linesOf(mission: MissionRecord, accountId: string, state: MissionState): OverviewLine[] {
  const sets = new Set(
    mission.accounts.find((a) => a.accountId === accountId)?.resourceSets.map((s) => s.id) ?? [],
  );
  const remaining = state.kind === 'active' ? state.remaining : null;
  return mission.policy
    .filter((entry) => sets.has(entry.resourceSetId))
    .map((entry) => {
      const left = remaining
        ? remaining[policyLineKey(entry.resourceSetId, entry.riskId)]
        : undefined;
      return {
        risk_id: entry.riskId,
        resource_set_id: entry.resourceSetId,
        quota: entry.quota,
        used: remaining === null ? null : left === undefined ? 0 : Math.max(0, entry.quota - left),
        gate: entry.gate,
      };
    });
}

function isOwnedBy(account: AccountRecord, viewer: AuditViewer): boolean {
  if (viewer.kind !== 'user') return false;
  const { owner } = account;
  return owner.kind === 'user'
    ? owner.id === viewer.user.id
    : viewer.groups.some((group) => group.id === owner.id);
}

/** Busiest first; then running missions; then by name. */
function byActivity(a: OverviewMission, b: OverviewMission): number {
  return (
    callsOf(b.totals) - callsOf(a.totals) ||
    Number(b.state === 'active') - Number(a.state === 'active') ||
    a.name.localeCompare(b.name)
  );
}

export class ActivityOverviewService {
  constructor(private readonly deps: ActivityOverviewDeps) {}

  async overview(viewer: AuditViewer, period: OverviewPeriod): Promise<ActivityOverview> {
    const { store } = this.deps;
    const now = this.deps.clock.now();
    const since = sinceOf(period, now).toISOString();
    const scope = eventScopeOf(viewer);
    const [stored, rows, waiting] = await Promise.all([
      store.missions.listInScope(scope, since),
      store.audit.callTotals({ scope, since }),
      store.requests.countOpenInScope(scope, now.toISOString()),
    ]);
    const totals = totalsByMission(rows);
    const names = new HolderNames(store.users);
    const accounts = new Map<string, Promise<AccountRecord | null>>();
    const accountOf = (id: string): Promise<AccountRecord | null> => {
      let read = accounts.get(id);
      if (!read) {
        read = store.accounts.getById(id);
        accounts.set(id, read);
      }
      return read;
    };

    const missions: OverviewMission[] = [];
    for (const record of stored) {
      const { mission, state } = await this.deps.missions.standing(record);
      const sums = totals.get(mission.id);
      const accountViews: OverviewAccount[] = [];
      for (const { accountId } of mission.accounts) {
        const account = await accountOf(accountId);
        accountViews.push({
          id: accountId,
          service: account?.service ?? '',
          display_name: account?.displayName ?? null,
          ...(sums?.byAccount.get(accountId) ?? NO_COUNTS),
          lines: linesOf(mission, accountId, state),
        });
      }
      accountViews.sort((a, b) => callsOf(b) - callsOf(a));
      const calls = sums ? callsOf(sums.total) : 0;
      const holders: OverviewHolder[] = [];
      for (const h of sums?.byHolder.values() ?? []) {
        holders.push({
          holder:
            h.kind !== null && h.holder !== null
              ? await names.view({ kind: h.kind, key: h.holder })
              : null,
          allowed: h.allowed,
          refused: h.refused,
          request_bytes: h.request_bytes,
          response_bytes: h.response_bytes,
          share: calls === 0 ? 0 : callsOf(h) / calls,
        });
      }
      holders.sort(
        (a, b) =>
          callsOf(b) - callsOf(a) || (a.holder?.label ?? '').localeCompare(b.holder?.label ?? ''),
      );
      missions.push({
        id: mission.id,
        name: mission.name,
        status: mission.status,
        state: state.kind,
        created_by_viewer: viewer.kind === 'user' && viewer.user.id === mission.creatorUserId,
        expires_at: mission.expiresAt,
        period:
          state.kind === 'active' ? { start: state.period.start, end: state.period.end } : null,
        period_seconds: mission.periodSeconds,
        totals: { ...(sums?.total ?? NO_COUNTS), waiting: waiting.get(mission.id) ?? 0 },
        accounts: accountViews,
        holders,
      });
    }
    missions.sort(byActivity);

    return {
      period,
      since,
      now: now.toISOString(),
      missions,
      expiring: await this.expiring(viewer, missions, accountOf, now),
    };
  }

  /**
   * The running missions that end within `EXPIRING_SOON_DAYS`, and their accounts whose
   * pasted key ends within it or that the service already refused (`expired`). An
   * account carried by several missions is listed once, under the first of them.
   */
  private async expiring(
    viewer: AuditViewer,
    missions: readonly OverviewMission[],
    accountOf: (id: string) => Promise<AccountRecord | null>,
    now: Date,
  ): Promise<OverviewExpiry[]> {
    const horizon = now.getTime() + EXPIRING_SOON_DAYS * MS_PER_DAY;
    const soon = (iso: string | null): boolean => {
      if (iso === null) return false;
      const at = Date.parse(iso);
      return at > now.getTime() && at <= horizon;
    };
    const out: OverviewExpiry[] = [];
    const seen = new Set<string>();
    for (const mission of missions) {
      if (mission.state !== 'active') continue;
      if (mission.expires_at !== null && soon(mission.expires_at)) {
        out.push({
          kind: 'mission',
          mission_id: mission.id,
          mission_name: mission.name,
          expires_at: mission.expires_at,
          fixable: mission.created_by_viewer,
        });
      }
      for (const { id } of mission.accounts) {
        if (seen.has(id)) continue;
        const account = await accountOf(id);
        if (!account) continue;
        const expired = account.status === 'expired';
        const keyEnds =
          this.pastedKey(account) &&
          account.status === 'active' &&
          soon(account.credentialExpiresAt);
        if (!expired && !keyEnds) continue;
        seen.add(id);
        out.push({
          kind: 'account',
          account_id: id,
          service: account.service,
          display_name: account.displayName,
          expires_at: expired ? null : account.credentialExpiresAt,
          expired,
          mission_id: mission.id,
          mission_name: mission.name,
          fixable: isOwnedBy(account, viewer),
        });
      }
    }
    return out.sort((a, b) => {
      const at = (e: OverviewExpiry) =>
        e.kind === 'account' && e.expired ? -Infinity : Date.parse(e.expires_at ?? '');
      return at(a) - at(b);
    });
  }

  /**
   * Whether the account's stored expiry is a pasted key's (what its owner must replace):
   * an OAuth access token's expiry is refreshed by the gateway and says nothing to fix.
   */
  private pastedKey(account: AccountRecord): boolean {
    return (
      accountCredentialKind(account, this.deps.credentialKindOf(account.service)) === 'api-key'
    );
  }
}
