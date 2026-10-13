/**
 * Shared fixture of the budget integration suites: an ephemeral `:memory:` store, one
 * creator, one connection, one mission with a three-risk policy, and a `SessionService`
 * over an in-memory sliding window.
 */
import type { MissionPolicyEntry } from '../../../src/server/store/types.ts';
import {
  budgetMissionOf,
  SessionService,
  type BudgetMission,
} from '../../../src/server/budget/index.ts';
import { SlidingWindowRateLimiter } from '../../../src/server/rate-limit/index.ts';
import type { Store } from '../../../src/server/store/index.ts';
import { openTestStore, type TestStore } from '../../../src/server/store/testing.ts';

export const READ = 'github.code-read';
export const WRITE = 'github.write-feature-branch';
export const MERGE = 'github.merge-protected';

export const ANCHOR = '2026-10-13T00:00:00.000Z';
export const DAY_SECONDS = 86_400;
export const REQUEST_EXPIRY_SECONDS = 24 * 3600;

export const DEFAULT_POLICY: readonly MissionPolicyEntry[] = [
  { riskId: READ, quota: 10, rateLimit: 5, rateWindowSeconds: 60, gate: 'auto' },
  { riskId: WRITE, quota: 1, rateLimit: 5, rateWindowSeconds: 60, gate: 'auto' },
  { riskId: MERGE, quota: 2, rateLimit: 1, rateWindowSeconds: 60, gate: 'approval' },
];

export interface BudgetFixture extends TestStore {
  readonly store: Store;
  readonly creatorId: string;
  readonly connectionId: string;
  readonly mission: BudgetMission;
  readonly service: SessionService;
  readonly rateWindows: SlidingWindowRateLimiter;
  requestUrl(requestId: string): string;
  /** Another mission for the same creator and connection. */
  createMission(input: {
    periodSeconds: number | null;
    policy?: readonly MissionPolicyEntry[];
    expiresAt?: string | null;
  }): Promise<BudgetMission>;
}

export async function openBudgetFixture(
  options: { periodSeconds?: number | null; policy?: readonly MissionPolicyEntry[] } = {},
): Promise<BudgetFixture> {
  const t = openTestStore();
  const { store } = t;
  const creatorId = (await store.users.upsertFromIdp({ subject: 'creator', email: 'c@x' })).id;
  const connectionId = (
    await store.connections.create({
      provider: 'github',
      owner: { kind: 'user', id: creatorId },
      displayName: 'gh',
      credential: null,
    })
  ).id;
  const requestUrl = (requestId: string) => `https://gateway.example.com/r/${requestId}`;
  const rateWindows = new SlidingWindowRateLimiter();
  const service = new SessionService({
    sessions: store.sessions,
    requests: store.requests,
    rateWindows,
    requestUrl,
    requestExpirySeconds: REQUEST_EXPIRY_SECONDS,
  });

  async function createMission(input: {
    periodSeconds: number | null;
    policy?: readonly MissionPolicyEntry[];
    expiresAt?: string | null;
  }): Promise<BudgetMission> {
    const record = await store.missions.create({
      name: 'm',
      creatorUserId: creatorId,
      periodAnchor: ANCHOR,
      periodSeconds: input.periodSeconds,
      expiresAt: input.expiresAt ?? null,
      connections: [{ connectionId, resourceScope: 'all', resourceIds: [] }],
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
    connectionId,
    mission,
    service,
    rateWindows,
    requestUrl,
    createMission,
  };
}

export const at = (iso: string): Date => new Date(iso);
