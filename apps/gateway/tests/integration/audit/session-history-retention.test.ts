/**
 * `retention_days` also purges the session history (spec §6, §8; product owner's
 * decision of 2026-10-13): the timeline events older than N days and the counters of
 * periods that ended more than N days ago leave with the audit entries of the same
 * age. What the budget still reads never leaves: the counters of the current period,
 * and the gate and credit events written since it started.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AuditRetentionSweeper } from '../../../src/server/audit';
import {
  currentPeriod,
  GATE_EVENT_KINDS,
  openedGatesOf,
  PERIOD_STATE_EVENT_KINDS,
  SessionHistoryRetention,
} from '../../../src/server/budget';
import { silentLogger, type Logger } from '../../../src/server/logging';
import { openTestStore, type TestStore } from '../../../src/server/store/testing';
import { buildTestRoot } from '../missions/support';

const NOW = '2026-10-13T09:00:00.000Z';
const DAY_MS = 86_400_000;
const DAY_S = 86_400;
const READ = 'github.code-read';
const MERGE = 'github.merge-protected';
/** A risk of a catalog the image ships: the composition root checks a policy against it. */
const SHIPPED_RISK = 'github.read-code';

const daysAgo = (days: number, extraMs = 0): string =>
  new Date(Date.parse(NOW) - days * DAY_MS + extraMs).toISOString();

describe('retention of the session history', () => {
  let t: TestStore;
  let userId: string;
  let connectionId: string;

  beforeEach(async () => {
    t = openTestStore();
    t.clock.set(daysAgo(100));
    userId = (
      await t.store.users.upsertFromIdp({
        issuer: 'http://idp.test',
        subject: 'u',
        email: 'u@example.com',
      })
    ).id;
    connectionId = (
      await t.store.connections.create({
        provider: 'github',
        owner: { kind: 'user', id: userId },
        displayName: 'gh',
        credential: null,
      })
    ).id;
  });
  afterEach(() => t.store.close());

  /** A mission issued 100 days ago; `periodSeconds: null` is a one-off mission. */
  async function mission(periodSeconds: number | null) {
    t.clock.set(daysAgo(100));
    const record = await t.store.missions.create({
      name: `m-${periodSeconds ?? 'one-off'}`,
      creatorUserId: userId,
      periodSeconds,
      expiresAt: null,
      connections: [{ connectionId, resourceScope: 'all', resourceIds: [] }],
      policy: [
        { riskId: READ, quota: 100, rateLimit: 50, rateWindowSeconds: 60, gate: 'auto' },
        { riskId: MERGE, quota: 100, rateLimit: 50, rateWindowSeconds: 60, gate: 'approval' },
      ],
    });
    const session = await t.store.sessions.getOrCreate(record.id);
    return { record, sessionId: session.id };
  }

  /** One event written `days` ago. */
  async function event(
    sessionId: string,
    days: number,
    kind: string,
    riskId: string = READ,
    details?: Record<string, unknown>,
  ) {
    t.clock.set(daysAgo(days));
    return t.store.sessions.recordEvent(sessionId, { kind, riskId, details });
  }

  /** One allowed call `days` ago: the counter of the period that day falls in. */
  async function consume(m: Awaited<ReturnType<typeof mission>>, days: number) {
    t.clock.set(daysAgo(days));
    const period = currentPeriod(
      { anchor_at: m.record.periodAnchor, length_seconds: m.record.periodSeconds },
      t.clock.now(),
    );
    await t.store.sessions.decideAndDecrement(
      { missionId: m.record.id, riskIds: [READ], periodStart: period.start },
      () => ({ allow: true }),
    );
    return period.start;
  }

  function purge(retentionDays: number) {
    t.clock.set(NOW);
    return new SessionHistoryRetention({
      sessions: t.store.sessions,
      missions: t.store.missions,
      clock: t.clock,
    }).purge(retentionDays);
  }

  const eventIds = async (sessionId: string) =>
    (await t.store.sessions.listEvents(sessionId, { limit: 1000 })).map((e) => e.id);
  const periodStarts = async (sessionId: string) =>
    (await t.store.sessions.counters(sessionId)).map((c) => c.periodStart);

  it('removes the events older than N days and no other', async () => {
    const m = await mission(DAY_S);
    const tooOld = await event(m.sessionId, 31, 'call-allowed');
    const justTooOld = await event(m.sessionId, 30, 'call-refused');
    t.clock.set(daysAgo(30, -1));
    const oneMsTooOld = await t.store.sessions.recordEvent(m.sessionId, {
      kind: 'request',
      riskId: READ,
    });
    const recent = await event(m.sessionId, 29, 'call-allowed');
    const today = await event(m.sessionId, 0, 'call-allowed');

    expect(await purge(30)).toEqual({ events: 2, counters: 0 });

    const left = await eventIds(m.sessionId);
    expect(left).not.toContain(tooOld.id);
    expect(left).not.toContain(oneMsTooOld.id);
    // Exactly N days old is not "older than N days".
    expect(left).toEqual([justTooOld.id, recent.id, today.id]);
  });

  it('removes the counters of the periods that ended more than N days ago, never the current one', async () => {
    const m = await mission(DAY_S);
    const longGone = await consume(m, 60);
    const gone = await consume(m, 32);
    const endedOnTheLine = await consume(m, 31);
    const recent = await consume(m, 5);
    const current = await consume(m, 0);

    expect(await purge(30)).toEqual({ events: 0, counters: 2 });

    const left = await periodStarts(m.sessionId);
    expect(left).not.toContain(longGone);
    expect(left).not.toContain(gone);
    // A period that ended exactly N days ago did not end "more than N days ago".
    expect(left).toEqual([endedOnTheLine, recent, current]);
  });

  it('keeps what the budget still reads in a period longer than the retention', async () => {
    // One period of a year, started 100 days ago: everything below is "this period".
    const m = await mission(365 * DAY_S);
    const call = await event(m.sessionId, 90, 'call-allowed');
    const yearStart = m.record.periodAnchor;
    const gate = await event(m.sessionId, 90, 'gate-opened', MERGE, {
      request_id: 'r',
      period_start: yearStart,
      period_end: new Date(Date.parse(yearStart) + 365 * DAY_MS).toISOString(),
    });
    const extension = await event(m.sessionId, 80, 'extension', READ, {
      credits: { [READ]: 3 },
    });
    const reset = await event(m.sessionId, 70, 'reset', READ, { credits: { [READ]: 1 } });
    const start = await consume(m, 95);

    expect(await purge(30)).toEqual({ events: 1, counters: 0 });

    const left = await eventIds(m.sessionId);
    expect(left).not.toContain(call.id);
    expect(left).toEqual([gate.id, extension.id, reset.id]);
    // The counters of the current period are the budget: untouched, whatever their age.
    expect(await t.store.sessions.counters(m.sessionId, start)).toMatchObject([
      { riskId: READ, consumed: 1 },
    ]);
    // The gate opened 90 days ago "until the period ends" is still read as open.
    const period = currentPeriod(
      { anchor_at: m.record.periodAnchor, length_seconds: m.record.periodSeconds },
      new Date(NOW),
    );
    const gateEvents = await t.store.sessions.listEvents(m.sessionId, {
      kinds: GATE_EVENT_KINDS,
      since: period.start,
    });
    expect(openedGatesOf(gateEvents, period).has(MERGE)).toBe(true);
  });

  it('removes a gate or a credit event once its period is over', async () => {
    const m = await mission(DAY_S);
    const oldGate = await event(m.sessionId, 40, 'gate-opened', MERGE, { request_id: 'r' });
    const oldCredit = await event(m.sessionId, 40, 'reset', READ, { credits: { [READ]: 1 } });
    // Over, but younger than the retention: history that is still kept.
    const lastWeek = await event(m.sessionId, 7, 'gate-opened', MERGE, { request_id: 'r' });

    expect(await purge(30)).toEqual({ events: 2, counters: 0 });
    const left = await eventIds(m.sessionId);
    expect(left).not.toContain(oldGate.id);
    expect(left).not.toContain(oldCredit.id);
    expect(left).toEqual([lastWeek.id]);
  });

  it('on a one-off mission: the old calls leave, the counters and the credits of its only period stay', async () => {
    const m = await mission(null);
    const call = await event(m.sessionId, 90, 'call-allowed');
    const credit = await event(m.sessionId, 90, 'extension', READ, { credits: { [READ]: 2 } });
    const recent = await event(m.sessionId, 2, 'call-allowed');
    const only = await consume(m, 95);

    expect(await purge(30)).toEqual({ events: 1, counters: 0 });
    const left = await eventIds(m.sessionId);
    expect(left).not.toContain(call.id);
    expect(left).toEqual([credit.id, recent.id]);
    expect(await periodStarts(m.sessionId)).toEqual([only]);
  });

  it('purges each session by its own mission period, and is idempotent', async () => {
    const daily = await mission(DAY_S);
    const yearly = await mission(365 * DAY_S);
    await event(daily.sessionId, 50, 'gate-opened', MERGE);
    const kept = await event(yearly.sessionId, 50, 'gate-opened', MERGE);
    await consume(daily, 50);
    await consume(yearly, 50);

    expect(await purge(30)).toEqual({ events: 1, counters: 1 });
    expect(await purge(30)).toEqual({ events: 0, counters: 0 });
    expect(await eventIds(daily.sessionId)).toEqual([]);
    expect(await eventIds(yearly.sessionId)).toEqual([kept.id]);
    expect((await periodStarts(yearly.sessionId)).length).toBe(1);
    // Later, what aged past the retention leaves in its turn.
    await event(daily.sessionId, 20, 'call-allowed');
    expect(await purge(30)).toEqual({ events: 0, counters: 0 });
    expect(await purge(15)).toEqual({ events: 1, counters: 0 });
  });

  it('touches nothing but events and counters, and refuses a retention that is not a number of days', async () => {
    const m = await mission(DAY_S);
    await event(m.sessionId, 60, 'call-allowed');
    await consume(m, 60);
    t.clock.set(daysAgo(60));
    await t.store.requests.create({
      missionId: m.record.id,
      sessionId: m.sessionId,
      kind: 'claim',
      riskId: READ,
      expiresAt: daysAgo(59),
    });
    const count = (table: string): number =>
      t.store.db.prepare<[], { n: number }>(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n ?? 0;
    const tables = ['users', 'connections', 'missions', 'mission_policy', 'sessions', 'requests'];
    const before = tables.map(count);

    expect(await purge(30)).toEqual({ events: 1, counters: 1 });
    expect(tables.map(count)).toEqual(before);
    expect(before.every((n) => n > 0)).toBe(true);
    await expect(purge(0)).rejects.toThrow(/positive number of days/);
    await expect(purge(1.5)).rejects.toThrow(/positive number of days/);
  });

  it('keeps exactly the kinds a period reads back: the gate events and the credit events', () => {
    expect([...PERIOD_STATE_EVENT_KINDS].sort()).toEqual(
      ['extension', 'gate-changed', 'gate-opened', 'permission-removed', 'reset'].sort(),
    );
  });
});

describe('the retention sweeper purges the session history with the audit', () => {
  function recordingLogger() {
    const lines: { level: string; message: string; fields: unknown }[] = [];
    const logger: Logger = {
      debug: () => undefined,
      info: (message, fields) => lines.push({ level: 'info', message, fields }),
      warn: () => undefined,
      error: (message, fields) => lines.push({ level: 'error', message, fields }),
      child: () => logger,
    };
    return { lines, logger };
  }

  it('logs what it removed, with the same number of days', async () => {
    const asked: number[] = [];
    const { lines, logger } = recordingLogger();
    const s = new AuditRetentionSweeper({
      audit: { purgeByRetention: async () => 0 },
      sessionHistory: {
        purge: async (days) => {
          asked.push(days);
          return { events: 4, counters: 2 };
        },
      },
      retentionDays: 45,
      logger,
    });
    expect(await s.sweep()).toBe(0);
    expect(asked).toEqual([45]);
    expect(lines).toEqual([
      {
        level: 'info',
        message: 'audit retention: session history purged',
        fields: { events: 4, counters: 2, retention_days: 45 },
      },
    ]);
  });

  it('the two purges fail apart: neither holds the other back, neither throws', async () => {
    const { lines, logger } = recordingLogger();
    let historyRuns = 0;
    const failingAudit = new AuditRetentionSweeper({
      audit: {
        purgeByRetention: async () => {
          throw new Error('audit locked');
        },
      },
      sessionHistory: {
        purge: async () => {
          historyRuns += 1;
          return { events: 0, counters: 0 };
        },
      },
      retentionDays: 90,
      logger,
    });
    expect(await failingAudit.sweep()).toBeNull();
    expect(historyRuns).toBe(1);

    const failingHistory = new AuditRetentionSweeper({
      audit: { purgeByRetention: async () => 5 },
      sessionHistory: {
        purge: async () => {
          throw new Error('events locked');
        },
      },
      retentionDays: 90,
      logger: silentLogger,
    });
    expect(await failingHistory.sweep()).toBe(5);
    expect(lines.map((line) => line.message)).toEqual(['audit retention: purge failed']);
  });

  it('is wired by the composition root: one `retention_days` for the audit and the sessions', async () => {
    const root = await buildTestRoot({ env: { VAUBAAN_RETENTION_DAYS: '7' } });
    try {
      const user = await root.store.users.upsertFromIdp({
        issuer: 'http://idp.test',
        subject: 'u',
        email: 'u@example.com',
      });
      const connection = await root.store.connections.create({
        provider: 'github',
        owner: { kind: 'user', id: user.id },
        displayName: 'gh',
        credential: null,
      });
      const created = await root.store.missions.create({
        name: 'm',
        creatorUserId: user.id,
        periodSeconds: null,
        expiresAt: null,
        connections: [{ connectionId: connection.id, resourceScope: 'all', resourceIds: [] }],
        policy: [
          { riskId: SHIPPED_RISK, quota: 5, rateLimit: 5, rateWindowSeconds: 60, gate: 'auto' },
        ],
      });
      const session = await root.store.sessions.getOrCreate(created.id);
      const recent = await root.store.sessions.recordEvent(session.id, {
        kind: 'call-allowed',
        riskId: SHIPPED_RISK,
      });
      const old = await root.store.sessions.recordEvent(session.id, {
        kind: 'call-allowed',
        riskId: SHIPPED_RISK,
      });
      // The store stamps events with its own clock: age one of them by hand.
      root.store.db
        .prepare('UPDATE events SET ts = ? WHERE id = ?')
        .run(new Date(Date.now() - 8 * DAY_MS).toISOString(), old.id);

      await root.audit.retention.sweep();

      const left = await root.store.sessions.listEvents(session.id);
      expect(left.map((e) => e.id)).toEqual([recent.id]);
    } finally {
      await root.close();
    }
  });
});
