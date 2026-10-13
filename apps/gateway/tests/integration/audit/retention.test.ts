/**
 * Audit retention (spec §6 "immutable audit — purge by operator-configured
 * retention", §8): the sweeper removes the entries older than N days and
 * nothing else, the triggers still forbid every other update and delete, and
 * the composition root starts it from the configuration.
 */
import type { AdminAuditEntry, CallAuditEntry } from '@vaubaan/gateway-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AuditRetentionSweeper, RETENTION_SWEEP_INTERVAL_MS } from '../../../src/server/audit';
import { silentLogger, type Logger } from '../../../src/server/logging';
import { openTestStore, type TestStore } from '../../../src/server/store/testing';
import { buildTestRoot } from '../missions/support';

const NOW = '2026-10-13T09:00:00.000Z';
const DAY_MS = 86_400_000;
const READ = 'github.code-read';
const WRITE = 'github.write-feature-branch';

const daysAgo = (days: number, extraMs = 0): string =>
  new Date(Date.parse(NOW) - days * DAY_MS + extraMs).toISOString();

function call(ts: string, missionId: string): CallAuditEntry {
  return {
    kind: 'call',
    ts,
    mission_id: missionId,
    token_id: null,
    token_kind: null,
    token_holder: null,
    session_id: null,
    connection_id: null,
    resource_ref: null,
    tool: 'github__get_file',
    arguments_hash: '0123456789abcdef',
    slices_executed: [],
    risks_touched: [READ],
    accepted_risks_snapshot: [READ, WRITE],
    decision: 'allowed',
    refusal_code: null,
    refusal_reason: null,
    approval_id: null,
    remaining_budget: { [READ]: 3 },
    agent_label: null,
    upstream_latency_ms: 10,
    upstream_error: null,
    client_ip: null,
    client_user_agent: null,
  };
}

function act(ts: string, userId: string): AdminAuditEntry {
  return {
    kind: 'admin',
    ts,
    user_id: userId,
    act: 'config-changed',
    object: { type: 'instance-config', id: 'idp' },
    before: null,
    after: { issuer: 'https://idp.example.com/' },
    delegated_client_id: null,
  };
}

/** A fake timer the test fires by hand. */
function manualTimers() {
  const ticks = new Map<number, { fn: () => void; ms: number }>();
  let next = 1;
  return {
    ticks,
    setInterval(fn: () => void, ms: number): unknown {
      ticks.set(next, { fn, ms });
      return next++;
    },
    clearInterval(handle: unknown): void {
      ticks.delete(handle as number);
    },
    fire(): void {
      for (const { fn } of ticks.values()) fn();
    },
  };
}

describe('audit retention sweeper', () => {
  let t: TestStore;
  let missionId: string;
  let userId: string;

  beforeEach(async () => {
    t = openTestStore();
    t.clock.set(NOW);
    userId = (
      await t.store.users.upsertFromIdp({
        issuer: 'http://idp.test',
        subject: 'u',
        email: 'u@example.com',
      })
    ).id;
    const connection = await t.store.connections.create({
      provider: 'github',
      owner: { kind: 'user', id: userId },
      displayName: 'gh',
      credential: null,
    });
    missionId = (
      await t.store.missions.create({
        name: 'm',
        creatorUserId: userId,
        periodSeconds: 86_400,
        expiresAt: null,
        connections: [{ connectionId: connection.id, resourceScope: 'all', resourceIds: [] }],
        policy: [{ riskId: READ, quota: 10, rateLimit: 5, rateWindowSeconds: 60, gate: 'auto' }],
      })
    ).id;
  });
  afterEach(() => t.store.close());

  const sweeper = (retentionDays: number, extra: { logger?: Logger } = {}) =>
    new AuditRetentionSweeper({
      audit: t.store.audit,
      retentionDays,
      logger: extra.logger ?? silentLogger,
    });

  const count = (table: string): number =>
    t.store.db.prepare<[], { n: number }>(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n ?? 0;

  it('removes the entries older than N days, with their risk rows, and no other', async () => {
    const tooOldCall = await t.store.audit.append(call(daysAgo(31), missionId));
    const tooOldAct = await t.store.audit.append(act(daysAgo(30, -1), userId));
    const onTheLine = await t.store.audit.append(call(daysAgo(30), missionId));
    const recentCall = await t.store.audit.append(call(daysAgo(29), missionId));
    const recentAct = await t.store.audit.append(act(daysAgo(1), userId));

    expect(await sweeper(30).sweep()).toBe(2);

    expect(await t.store.audit.getById(tooOldCall.id)).toBeNull();
    expect(await t.store.audit.getById(tooOldAct.id)).toBeNull();
    // Exactly N days old is not "older than N days".
    expect(await t.store.audit.getById(onTheLine.id)).toEqual(onTheLine);
    expect(await t.store.audit.getById(recentCall.id)).toEqual(recentCall);
    expect(await t.store.audit.getById(recentAct.id)).toEqual(recentAct);
    expect(count('audit')).toBe(3);
    // Two risk rows per call entry (accepted snapshot of two risks): only the kept calls' remain.
    expect(count('audit_risks')).toBe(4);
    expect(
      t.store.db
        .prepare<
          [string],
          { n: number }
        >('SELECT COUNT(*) AS n FROM audit_risks WHERE audit_id = ?')
        .get(tooOldCall.id)?.n,
    ).toBe(0);
  });

  it('touches nothing outside the audit', async () => {
    const session = await t.store.sessions.getOrCreate(missionId);
    await t.store.sessions.recordEvent(session.id, { kind: 'call-allowed', riskId: READ });
    await t.store.requests.create({
      missionId,
      sessionId: session.id,
      kind: 'claim',
      riskId: READ,
      expiresAt: daysAgo(-1),
    });
    await t.store.audit.append(call(daysAgo(400), missionId));
    const tables = [
      'users',
      'connections',
      'missions',
      'mission_policy',
      'sessions',
      'events',
      'requests',
    ];
    const before = tables.map(count);

    expect(await sweeper(30).sweep()).toBe(1);

    expect(tables.map(count)).toEqual(before);
    expect(before.every((n) => n > 0)).toBe(true);
  });

  it('leaves the audit append-only: the triggers still forbid update and delete', async () => {
    await t.store.audit.append(call(daysAgo(100), missionId));
    const kept = await t.store.audit.append(call(daysAgo(2), missionId));
    const keptAct = await t.store.audit.append(act(daysAgo(2), userId));
    await sweeper(30).sweep();
    const { db } = t.store;

    // The purge window is closed again.
    expect(count('audit_purge_guard')).toBe(0);
    expect(() => db.prepare('DELETE FROM audit WHERE id = ?').run(kept.id)).toThrow(
      /retention purge/,
    );
    expect(() => db.prepare('DELETE FROM audit WHERE id = ?').run(keptAct.id)).toThrow(
      /retention purge/,
    );
    expect(() => db.prepare('DELETE FROM audit').run()).toThrow(/retention purge/);
    expect(() => db.prepare('DELETE FROM audit_risks WHERE audit_id = ?').run(kept.id)).toThrow(
      /retention purge/,
    );
    expect(() =>
      db.prepare("UPDATE audit SET decision = 'refused' WHERE id = ?").run(kept.id),
    ).toThrow(/append-only/);
    expect(() =>
      db.prepare('UPDATE audit_risks SET remaining = 99 WHERE audit_id = ?').run(kept.id),
    ).toThrow(/append-only/);
    expect(await t.store.audit.getById(kept.id)).toEqual(kept);
  });

  it('is idempotent, and purges later what ages past the retention', async () => {
    await t.store.audit.append(call(daysAgo(10), missionId));
    const s = sweeper(30);
    expect(await s.sweep()).toBe(0);
    expect(await s.sweep()).toBe(0);
    t.clock.advance(21 * DAY_MS);
    expect(await s.sweep()).toBe(1);
    expect(await s.sweep()).toBe(0);
  });

  it('honours the configured number of days', async () => {
    await t.store.audit.append(call(daysAgo(8), missionId));
    await t.store.audit.append(call(daysAgo(6), missionId));
    expect(await sweeper(90).sweep()).toBe(0);
    expect(await sweeper(7).sweep()).toBe(1);
    expect(await sweeper(1).sweep()).toBe(1);
  });
});

describe('audit retention sweeper — scheduling', () => {
  function fakeAudit(outcomes: (number | Error)[]) {
    const calls: number[] = [];
    return {
      calls,
      async purgeByRetention(days?: number): Promise<number> {
        calls.push(days ?? -1);
        const outcome = outcomes.shift() ?? 0;
        if (outcome instanceof Error) throw outcome;
        return outcome;
      },
    };
  }

  it('sweeps once on start, then on every interval, until stopped', async () => {
    const audit = fakeAudit([]);
    const timers = manualTimers();
    const s = new AuditRetentionSweeper({ audit, retentionDays: 45, logger: silentLogger, timers });
    expect(s.started).toBe(false);

    await s.start();
    expect(s.started).toBe(true);
    expect(audit.calls).toEqual([45]);
    expect([...timers.ticks.values()].map((tick) => tick.ms)).toEqual([
      RETENTION_SWEEP_INTERVAL_MS,
    ]);

    await s.start(); // idempotent: no second timer, no second boot sweep
    expect(timers.ticks.size).toBe(1);
    expect(audit.calls).toEqual([45]);

    timers.fire();
    await s.sweep(); // joins the sweep the tick started
    timers.fire();
    await s.stop();
    expect(audit.calls).toEqual([45, 45, 45]);
    expect(s.started).toBe(false);
    expect(timers.ticks.size).toBe(0);
  });

  it('a failed purge is logged and retried at the next interval; it never throws', async () => {
    const audit = fakeAudit([new Error('database is locked'), 3]);
    const timers = manualTimers();
    const lines: { level: string; message: string; fields: unknown }[] = [];
    const logger: Logger = {
      debug: () => undefined,
      info: (message, fields) => lines.push({ level: 'info', message, fields }),
      warn: () => undefined,
      error: (message, fields) => lines.push({ level: 'error', message, fields }),
      child: () => logger,
    };
    const s = new AuditRetentionSweeper({ audit, retentionDays: 90, logger, timers });

    await expect(s.start()).resolves.toBeUndefined();
    expect(await s.sweep()).toBe(3);
    await s.stop();
    expect(lines).toEqual([
      {
        level: 'error',
        message: 'audit retention: purge failed',
        fields: { retention_days: 90, detail: 'database is locked' },
      },
      {
        level: 'info',
        message: 'audit retention: entries purged',
        fields: { removed: 3, retention_days: 90 },
      },
    ]);
  });

  it('concurrent sweeps share one purge', async () => {
    const audit = fakeAudit([2]);
    const s = new AuditRetentionSweeper({ audit, retentionDays: 90, logger: silentLogger });
    expect(await Promise.all([s.sweep(), s.sweep(), s.sweep()])).toEqual([2, 2, 2]);
    expect(audit.calls).toEqual([90]);
  });
});

describe('audit retention sweeper — composition root', () => {
  it('is started with `retention_days` and stopped by close()', async () => {
    const root = await buildTestRoot({ env: { VAUBAAN_RETENTION_DAYS: '7' } });
    try {
      expect(root.config.retentionDays).toBe(7);
      expect(root.audit.retention.started).toBe(true);
      const user = await root.store.users.upsertFromIdp({
        issuer: 'http://idp.test',
        subject: 'u',
        email: 'u@example.com',
      });
      const old = await root.store.audit.append(
        act(new Date(Date.now() - 8 * DAY_MS).toISOString(), user.id),
      );
      const recent = await root.store.audit.append(
        act(new Date(Date.now() - 6 * DAY_MS).toISOString(), user.id),
      );
      expect(await root.audit.retention.sweep()).toBe(1);
      expect(await root.store.audit.getById(old.id)).toBeNull();
      expect(await root.store.audit.getById(recent.id)).not.toBeNull();
    } finally {
      await root.close();
    }
    expect(root.audit.retention.started).toBe(false);
  });

  it('defaults to 90 days', async () => {
    const root = await buildTestRoot();
    try {
      const user = await root.store.users.upsertFromIdp({
        issuer: 'http://idp.test',
        subject: 'u',
        email: 'u@example.com',
      });
      await root.store.audit.append(act(new Date(Date.now() - 89 * DAY_MS).toISOString(), user.id));
      await root.store.audit.append(act(new Date(Date.now() - 91 * DAY_MS).toISOString(), user.id));
      expect(await root.audit.retention.sweep()).toBe(1);
    } finally {
      await root.close();
    }
  });
});
