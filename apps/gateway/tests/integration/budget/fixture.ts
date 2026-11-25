/**
 * Shared fixture of the budget integration suites: an ephemeral `:memory:` store, one
 * creator, one account, one mission with a three-risk policy, and a `MissionLogService`
 * over an in-memory sliding window.
 */
// The store's camelCase policy line, inside its set: not the shared domain type.
import type { MissionPolicyLineInput as MissionPolicyEntryRecord } from '../../../src/server/store/types.ts';
import {
  budgetMissionOf,
  MissionLogService,
  type BudgetMission,
} from '../../../src/server/budget/index.ts';
import { SlidingWindowRateLimiter } from '../../../src/server/rate-limit/index.ts';
import type { Store } from '../../../src/server/store/index.ts';
import { openTestStore, type TestStore } from '../../support/store/testing.ts';

export const READ = 'github.code-read';
export const WRITE = 'github.write-feature-branch';
export const MERGE = 'github.merge-protected';

export const ANCHOR = '2026-10-13T00:00:00.000Z';
export const DAY_SECONDS = 86_400;
export const REQUEST_EXPIRY_SECONDS = 24 * 3600;
/** The default of `approvals.expiry`: a granted approval is usable for ten minutes. */
export const APPROVAL_VALIDITY_SECONDS = 600;

export const DEFAULT_POLICY: readonly MissionPolicyEntryRecord[] = [
  { riskId: READ, quota: 10, rateLimit: 5, rateWindowSeconds: 60, gate: 'auto' },
  { riskId: WRITE, quota: 1, rateLimit: 5, rateWindowSeconds: 60, gate: 'auto' },
  { riskId: MERGE, quota: 2, rateLimit: 1, rateWindowSeconds: 60, gate: 'approval' },
];

export interface BudgetFixture extends TestStore {
  readonly store: Store;
  readonly creatorId: string;
  readonly accountId: string;
  readonly mission: BudgetMission;
  /** The one resource set of the mission's account. */
  readonly setId: string;
  readonly service: MissionLogService;
  readonly rateWindows: SlidingWindowRateLimiter;
  requestUrl(requestId: string): string;
  /** Another mission for the same creator and account. */
  createMission(input: {
    periodSeconds: number | null;
    policy?: readonly MissionPolicyEntryRecord[];
    expiresAt?: string | null;
  }): Promise<BudgetMission>;
}

export async function openBudgetFixture(
  options: { periodSeconds?: number | null; policy?: readonly MissionPolicyEntryRecord[] } = {},
): Promise<BudgetFixture> {
  const t = openTestStore();
  const { store } = t;
  const creatorId = (
    await store.users.upsertFromIdp({
      issuer: 'http://idp.test',
      subject: 'creator',
      email: 'c@x',
    })
  ).id;
  const accountId = (
    await store.accounts.create({
      service: 'github',
      owner: { kind: 'user', id: creatorId },
      displayName: 'gh',
      credential: null,
    })
  ).id;
  const requestUrl = (requestId: string) => `https://gateway.example.com/r/${requestId}`;
  const rateWindows = new SlidingWindowRateLimiter();
  const service = new MissionLogService({
    missionLogs: store.missionLogs,
    requests: store.requests,
    rateWindows,
    requestUrl,
    requestExpirySeconds: REQUEST_EXPIRY_SECONDS,
    approvalValiditySeconds: APPROVAL_VALIDITY_SECONDS,
  });

  async function createMission(input: {
    periodSeconds: number | null;
    policy?: readonly MissionPolicyEntryRecord[];
    expiresAt?: string | null;
  }): Promise<BudgetMission> {
    const record = await store.missions.create({
      name: 'm',
      creatorUserId: creatorId,
      periodAnchor: ANCHOR,
      periodSeconds: input.periodSeconds,
      expiresAt: input.expiresAt ?? null,
      accounts: [{ accountId, resourceIds: [] }],
      policy: input.policy ?? DEFAULT_POLICY,
    });
    return budgetMissionOf(record);
  }

  const mission = await createMission({
    periodSeconds: options.periodSeconds === undefined ? DAY_SECONDS : options.periodSeconds,
    policy: options.policy,
  });

  return {
    ...t,
    store,
    creatorId,
    accountId,
    mission,
    setId: mission.policy[0]?.resource_set_id ?? '',
    service,
    rateWindows,
    requestUrl,
    createMission,
  };
}

export const at = (iso: string): Date => new Date(iso);

/**
 * A map keyed by line (`<set>::<risk>`, a mission with one set per account) read by
 * risk: what a test about something else than sets compares.
 */
export function byRisk<V>(
  byLine: Iterable<readonly [string, V]> | Readonly<Record<string, V>>,
): Record<string, V> {
  const entries: Iterable<readonly [string, V]> =
    Symbol.iterator in Object(byLine)
      ? (byLine as Iterable<readonly [string, V]>)
      : Object.entries(byLine as Readonly<Record<string, V>>);
  const out: Record<string, V> = {};
  for (const [key, value] of entries) out[key.slice(key.indexOf('::') + 2)] = value;
  return out;
}
