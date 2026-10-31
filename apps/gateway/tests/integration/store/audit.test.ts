/**
 * Audit — append-only by triggers, purge only through the retention path, and the
 * store's implementation of gateway-core's `AuditWriter`. Spec §6 "immutable audit", §8.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AdminAuditEntry, CallAuditEntry } from '@vaubaan/gateway-core';
import { SqliteAuditWriter, type Store } from '../../../src/server/store/index.ts';
import { openTestStore, type TestStore } from '../../support/store/testing.ts';

const READ = 'github.code-read';
const WRITE = 'github.write-feature-branch';

function callEntry(ts: string, decision: 'allowed' | 'refused' = 'allowed'): CallAuditEntry {
  return {
    kind: 'call',
    ts,
    mission_id: 'm1',
    token_id: null,
    token_kind: null,
    token_holder: null,
    session_id: 's1',
    connection_id: 'c1',
    resource_ref: 'acme/repo',
    tool: 'github__create_branch',
    arguments_hash: 'abc123def4567890',
    slices_executed: [
      {
        provider: 'github',
        path: [
          { kind: 'name', value: 'repo' },
          { kind: 'ident', value: 'acme/repo' },
          { kind: 'name', value: 'branch' },
          { kind: 'ident', value: 'feat' },
        ],
        action: 'W',
      },
    ],
    risks_touched: [WRITE],
    accepted_risks_snapshot: [READ, WRITE],
    decision,
    refusal_code: decision === 'refused' ? 'budget-exhausted' : null,
    refusal_reason: decision === 'refused' ? 'quota for github.write-feature-branch is 0' : null,
    approval_id: null,
    // What the budget stage writes: the remaining budget of the touched risks.
    remaining_budget: { [WRITE]: 4 },
    agent_label: 'orchestrator',
    upstream_latency_ms: 120,
    upstream_error: null,
    client_ip: '10.0.0.1',
    client_user_agent: 'mcp-client/1.0',
  };
}

const adminEntry: AdminAuditEntry = {
  kind: 'admin',
  ts: '2026-10-13T09:00:00.000Z',
  user_id: 'u1',
  act: 'share-created',
  object: { type: 'share', id: 'sh1' },
  before: null,
  after: { restriction: [READ] },
  delegated_client_id: null,
};

describe('audit repository', () => {
  let t: TestStore;
  let store: Store;

  beforeEach(() => {
    t = openTestStore();
    store = t.store;
  });

  afterEach(() => store.close());

  it('appends a call entry and reads it back unchanged, with a row per touched risk', async () => {
    const entry = callEntry('2026-10-13T09:00:00.000Z');
    const record = await store.audit.append(entry);
    expect(record.kind).toBe('call');
    if (record.kind !== 'call') throw new Error('expected a call record');
    const { id, risks, ...roundTrip } = record;
    expect(roundTrip).toEqual(entry);
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(risks).toEqual([{ riskId: WRITE, accepted: true, touched: true, remaining: 4 }]);
    expect(await store.audit.getById(id)).toEqual(record);
  });

  it('keeps a touched risk that was not accepted (risk-not-accepted refusal)', async () => {
    const record = await store.audit.append({
      ...callEntry('2026-10-13T09:00:00.000Z', 'refused'),
      risks_touched: ['github.merge-protected'],
      accepted_risks_snapshot: [READ],
      refusal_code: 'risk-not-accepted',
      remaining_budget: null,
    });
    if (record.kind !== 'call') throw new Error('expected a call record');
    expect(record.risks).toEqual([
      { riskId: 'github.merge-protected', accepted: false, touched: true, remaining: null },
    ]);
    expect(record.accepted_risks_snapshot).toEqual([READ]);
    expect(record.remaining_budget).toBeNull();
  });

  it('appends an administrative entry and reads it back unchanged', async () => {
    const record = await store.audit.append(adminEntry);
    expect(record.kind).toBe('admin');
    if (record.kind !== 'admin') throw new Error('expected an admin record');
    const { id: _id, ...roundTrip } = record;
    expect(roundTrip).toEqual(adminEntry);
  });

  it('rejects an UPDATE on audit rows', async () => {
    const record = await store.audit.append(callEntry('2026-10-13T09:00:00.000Z'));
    expect(() =>
      store.db.prepare('UPDATE audit SET decision = ? WHERE id = ?').run('refused', record.id),
    ).toThrow(/append-only/);
    expect(() =>
      store.db.prepare('UPDATE audit SET upstream_latency_ms = ? WHERE id = ?').run(1, record.id),
    ).toThrow(/append-only/);
    expect(() =>
      store.db.prepare('UPDATE audit_risks SET remaining = 0 WHERE audit_id = ?').run(record.id),
    ).toThrow(/append-only/);
    expect(() => store.db.prepare('UPDATE audit_risk_sets SET risk_count = 0').run()).toThrow(
      /append-only/,
    );
    expect(() =>
      store.db.prepare("UPDATE audit_risk_set_members SET risk_id = 'github.other'").run(),
    ).toThrow(/append-only/);
  });

  it('rejects a DELETE outside the retention purge', async () => {
    const record = await store.audit.append(callEntry('2026-10-13T09:00:00.000Z'));
    expect(() => store.db.prepare('DELETE FROM audit WHERE id = ?').run(record.id)).toThrow(
      /retention purge/,
    );
    expect(() => store.db.prepare('DELETE FROM audit').run()).toThrow(/retention purge/);
    expect(() =>
      store.db.prepare('DELETE FROM audit_risks WHERE audit_id = ?').run(record.id),
    ).toThrow(/retention purge/);
    expect(() => store.db.prepare('DELETE FROM audit_risk_set_members').run()).toThrow(
      /retention purge/,
    );
    expect(() => store.db.prepare('DELETE FROM audit_risk_sets').run()).toThrow(/retention purge/);
    expect((await store.audit.list()).map((r) => r.id)).toEqual([record.id]);
  });

  it('purges only entries older than the cutoff, through the dedicated path', async () => {
    const old = await store.audit.append(callEntry('2026-07-01T00:00:00.000Z'));
    const recent = await store.audit.append(callEntry('2026-10-12T00:00:00.000Z'));
    expect(await store.audit.purgeOlderThan('2026-10-01T00:00:00.000Z')).toBe(1);
    expect((await store.audit.list()).map((r) => r.id)).toEqual([recent.id]);
    expect(await store.audit.getById(old.id)).toBeNull();
    // The purge window is closed again: a plain delete is still refused.
    expect(() => store.db.prepare('DELETE FROM audit WHERE id = ?').run(recent.id)).toThrow();
    expect(
      store.db.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM audit_purge_guard').get()?.n,
    ).toBe(0);
    expect(
      store.db
        .prepare<[string], { n: number }>(
          'SELECT COUNT(*) AS n FROM audit_risks WHERE audit_id = ?',
        )
        .get(old.id)?.n,
    ).toBe(0);
  });

  it('cannot delete rows newer than the cutoff even inside a purge window', async () => {
    const recent = await store.audit.append(callEntry('2026-10-12T00:00:00.000Z'));
    expect(() => {
      store.db.transaction(() => {
        store.db
          .prepare('INSERT INTO audit_purge_guard (id, cutoff) VALUES (1, ?)')
          .run('2026-10-01T00:00:00.000Z');
        store.db.prepare('DELETE FROM audit WHERE id = ?').run(recent.id);
      })();
    }).toThrow(/retention purge/);
  });

  it('cannot delete the risk rows of a recent entry inside a purge window either (0002)', async () => {
    const recent = await store.audit.append(callEntry('2026-10-12T00:00:00.000Z'));
    expect(() => {
      store.db.transaction(() => {
        store.db
          .prepare('INSERT INTO audit_purge_guard (id, cutoff) VALUES (1, ?)')
          .run('2026-10-01T00:00:00.000Z');
        store.db.prepare('DELETE FROM audit_risks WHERE audit_id = ?').run(recent.id);
      })();
    }).toThrow(/retention purge/);
    expect(
      store.db
        .prepare<[string], { n: number }>(
          'SELECT COUNT(*) AS n FROM audit_risks WHERE audit_id = ?',
        )
        .get(recent.id)?.n,
    ).toBe(1);
  });

  it('computes the retention cutoff from the clock, default 90 days', async () => {
    t.clock.set('2026-10-13T00:00:00.000Z');
    await store.audit.append(callEntry('2026-07-14T00:00:00.000Z')); // 91 days old
    await store.audit.append(callEntry('2026-07-16T00:00:00.000Z')); // 89 days old
    expect(await store.audit.purgeByRetention()).toBe(1);
    expect(await store.audit.list()).toHaveLength(1);
    await expect(store.audit.purgeByRetention(0)).rejects.toThrow(/positive/);
  });

  it('filters by mission, kind and time range', async () => {
    await store.audit.append(callEntry('2026-10-13T09:00:00.000Z'));
    await store.audit.append(callEntry('2026-10-13T10:00:00.000Z', 'refused'));
    await store.audit.append(adminEntry);
    expect(await store.audit.list({ kind: 'admin' })).toHaveLength(1);
    expect(await store.audit.list({ missionId: 'm1' })).toHaveLength(2);
    expect(
      await store.audit.list({
        since: '2026-10-13T09:30:00.000Z',
        until: '2026-10-13T11:00:00.000Z',
      }),
    ).toHaveLength(1);
    expect(await store.audit.list({ limit: 1 })).toHaveLength(1);
  });

  it('counts allowed touches per risk for the counters-vs-audit structural check', async () => {
    await store.audit.append(callEntry('2026-10-13T09:00:00.000Z'));
    await store.audit.append(callEntry('2026-10-13T09:01:00.000Z'));
    await store.audit.append(callEntry('2026-10-13T09:02:00.000Z', 'refused'));
    const day = ['2026-10-13T00:00:00.000Z', '2026-10-14T00:00:00.000Z'] as const;
    expect(await store.audit.countAllowedTouches('m1', WRITE, ...day)).toBe(2);
    expect(await store.audit.countAllowedTouches('m1', READ, ...day)).toBe(0);
  });

  it('counts a mission’s calls per agent label over a span, the unlabelled ones apart', async () => {
    const at = (hour: string, label: string | null, decision: 'allowed' | 'refused' = 'allowed') =>
      store.audit.append({
        ...callEntry(`2026-10-13T${hour}:00:00.000Z`, decision),
        agent_label: label,
      });
    await at('08', 'early'); // before the span
    await at('09', 'coder');
    await at('10', 'coder', 'refused');
    await at('11', null);
    await at('12', 'planner');
    await at('13', 'coder');
    await at('14', 'late'); // `until` is exclusive
    await store.audit.append({ ...callEntry('2026-10-13T10:30:00.000Z'), mission_id: 'm2' });
    await store.audit.append(adminEntry);

    const span = { since: '2026-10-13T09:00:00.000Z', until: '2026-10-13T14:00:00.000Z' };
    expect(await store.audit.agentLabelActivity('m1', span)).toEqual([
      { label: 'coder', allowed: 2, refused: 1, lastSeenAt: '2026-10-13T13:00:00.000Z' },
      { label: null, allowed: 1, refused: 0, lastSeenAt: '2026-10-13T11:00:00.000Z' },
      { label: 'planner', allowed: 1, refused: 0, lastSeenAt: '2026-10-13T12:00:00.000Z' },
    ]);
    // An open span (a one-off mission's single period) has no upper bound.
    const open = await store.audit.agentLabelActivity('m1', { since: span.since, until: null });
    expect(open.map((a) => a.label)).toEqual(['coder', null, 'late', 'planner']);
    expect(await store.audit.agentLabelActivity('none', span)).toEqual([]);
  });

  it('searches call entries by exact agent label', async () => {
    const scope = {
      missionCreatorUserId: null,
      missionMemberUserId: null,
      connectionOwners: [],
      allAdmin: true,
      allCalls: false,
    };
    await store.audit.append(adminEntry);
    // Nothing in scope but administrative entries: a label filter matches none of them.
    expect(await store.audit.search({ scope, limit: 10, agentLabel: 'orchestrator' })).toEqual([]);
    expect(await store.audit.search({ scope, limit: 10 })).toHaveLength(1);
  });

  it('the schema refuses an incomplete entry atomically', () => {
    expect(() =>
      store.db
        .prepare(
          `INSERT INTO audit (id, ts, kind, mission_id, tool, decision)
           VALUES ('x', '2026-10-13T00:00:00.000Z', 'call', 'm1', 't', 'allowed')`,
        )
        .run(),
    ).toThrow(/CHECK/);
    expect(() =>
      store.db
        .prepare(
          `INSERT INTO audit (id, ts, kind, act, object_type)
           VALUES ('y', '2026-10-13T00:00:00.000Z', 'admin', 'share-created', 'share')`,
        )
        .run(),
    ).toThrow(/CHECK/);
  });

  it('implements gateway-core’s AuditWriter and propagates failures', async () => {
    const writer = new SqliteAuditWriter(store.audit);
    await writer.write(adminEntry);
    expect(await store.audit.list({ kind: 'admin' })).toHaveLength(1);
    expect(store.auditWriter).toBeInstanceOf(SqliteAuditWriter);
    await store.close();
    await expect(store.auditWriter.write(adminEntry)).rejects.toThrow();
    t = openTestStore();
    store = t.store;
  });
});
