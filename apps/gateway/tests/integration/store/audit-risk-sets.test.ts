/**
 * Audit — the accepted-risk snapshot stored once per distinct set, the touched risks
 * only in `audit_risks` (migration 0022; spec §8, gateway-risk-model §12; ADR
 * audit-risk-snapshot-stored-once).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CallAuditEntry } from '@vaubaan/gateway-core';
import type { Store } from '../../../src/server/store/index.ts';
import { acceptedSetOf } from '../../../src/server/store/repositories/audit.ts';
import { openTestStore, type TestStore } from '../../support/store/testing.ts';

const READ = 'github.code-read';
const WRITE = 'github.write-feature-branch';
const MERGE = 'github.merge-protected';

/** A mission holding "everything": 100 accepted risks. */
const HUNDRED = Array.from({ length: 100 }, (_, i) => `github.risk-${String(i).padStart(3, '0')}`);

function call(ts: string, over: Partial<CallAuditEntry> = {}): CallAuditEntry {
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
    slices_executed: [],
    risks_touched: [WRITE],
    accepted_risks_snapshot: [READ, WRITE],
    decision: 'allowed',
    refusal_code: null,
    refusal_reason: null,
    approval_id: null,
    remaining_budget: { [WRITE]: 4 },
    agent_label: null,
    upstream_latency_ms: 10,
    upstream_error: null,
    client_ip: null,
    client_user_agent: null,
    ...over,
  };
}

describe('audit: accepted-risk sets', () => {
  let t: TestStore;
  let store: Store;

  const count = (table: string): number =>
    store.db.prepare<[], { n: number }>(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n ?? -1;

  beforeEach(() => {
    t = openTestStore();
    store = t.store;
  });

  afterEach(() => store.close());

  it('addresses a set by its content: order and duplicates do not change it', () => {
    const a = acceptedSetOf([WRITE, READ, WRITE]);
    const b = acceptedSetOf([READ, WRITE]);
    expect(a).toEqual(b);
    expect(a.riskIds).toEqual([READ, WRITE]);
    expect(a.id).toMatch(/^[0-9a-f]{64}$/);
    expect(acceptedSetOf([READ]).id).not.toBe(a.id);
  });

  it('writes a 100-risk snapshot once; each further call costs its touched rows only', async () => {
    const entry = (ts: string) =>
      call(ts, {
        accepted_risks_snapshot: HUNDRED,
        risks_touched: [HUNDRED[3] ?? '', HUNDRED[7] ?? ''],
        remaining_budget: { [HUNDRED[3] ?? '']: 9, [HUNDRED[7] ?? '']: 2 },
      });
    const first = await store.audit.append(entry('2026-10-23T09:00:00.000Z'));
    expect(count('audit_risk_sets')).toBe(1);
    expect(count('audit_risk_set_members')).toBe(100);
    expect(count('audit_risks')).toBe(2);

    const before =
      count('audit_risks') + count('audit_risk_sets') + count('audit_risk_set_members');
    const second = await store.audit.append(entry('2026-10-23T09:01:00.000Z'));
    const after = count('audit_risks') + count('audit_risk_sets') + count('audit_risk_set_members');
    // Rows per call: the touched risks, and no set row (already stored).
    expect(after - before).toBe(2);

    for (const record of [first, second]) {
      if (record.kind !== 'call') throw new Error('expected a call record');
      expect(record.accepted_risks_snapshot).toEqual(HUNDRED);
      expect(record.risks_touched).toEqual([HUNDRED[3], HUNDRED[7]]);
      expect(record.remaining_budget).toEqual({ [HUNDRED[3] ?? '']: 9, [HUNDRED[7] ?? '']: 2 });
    }
  });

  it('shares one set between missions that accept the same risks, and tells others apart', async () => {
    await store.audit.append(call('2026-10-23T09:00:00.000Z', { mission_id: 'm1' }));
    await store.audit.append(
      call('2026-10-23T09:01:00.000Z', {
        mission_id: 'm2',
        accepted_risks_snapshot: [WRITE, READ],
      }),
    );
    expect(count('audit_risk_sets')).toBe(1);
    const other = await store.audit.append(
      call('2026-10-23T09:02:00.000Z', { mission_id: 'm3', accepted_risks_snapshot: [WRITE] }),
    );
    expect(count('audit_risk_sets')).toBe(2);
    expect(count('audit_risk_set_members')).toBe(3);
    if (other.kind !== 'call') throw new Error('expected a call record');
    expect(other.accepted_risks_snapshot).toEqual([WRITE]);
  });

  it('records no remaining budget for an untouched risk', async () => {
    const record = await store.audit.append(
      call('2026-10-23T09:00:00.000Z', { remaining_budget: { [READ]: 9, [WRITE]: 4 } }),
    );
    if (record.kind !== 'call') throw new Error('expected a call record');
    expect(record.remaining_budget).toEqual({ [WRITE]: 4 });
    expect(record.risks).toEqual([{ riskId: WRITE, accepted: true, touched: true, remaining: 4 }]);
  });

  it('keeps the refused risk of a refused call, and an empty snapshot as an empty set', async () => {
    const refused = await store.audit.append(
      call('2026-10-23T09:00:00.000Z', {
        decision: 'refused',
        refusal_code: 'risk-not-accepted',
        refusal_reason: 'not accepted',
        risks_touched: [MERGE],
        accepted_risks_snapshot: [],
        remaining_budget: null,
      }),
    );
    if (refused.kind !== 'call') throw new Error('expected a call record');
    expect(refused.accepted_risks_snapshot).toEqual([]);
    expect(refused.risks).toEqual([
      { riskId: MERGE, accepted: false, touched: true, remaining: null },
    ]);
    expect(count('audit_risk_sets')).toBe(1);
    expect(count('audit_risk_set_members')).toBe(0);
  });

  it('the purge removes the sets no remaining entry references, inside its window', async () => {
    await store.audit.append(
      call('2026-07-01T00:00:00.000Z', { accepted_risks_snapshot: [READ, WRITE, MERGE] }),
    );
    await store.audit.append(call('2026-07-01T00:00:01.000Z'));
    const recent = await store.audit.append(call('2026-10-12T00:00:00.000Z'));
    expect(count('audit_risk_sets')).toBe(2);

    expect(await store.audit.purgeOlderThan('2026-10-01T00:00:00.000Z')).toBe(2);
    // The set of the old-only snapshot is gone; the one the recent entry uses stays.
    expect(count('audit_risk_sets')).toBe(1);
    expect(count('audit_risk_set_members')).toBe(2);
    expect(count('audit_purge_guard')).toBe(0);
    const kept = await store.audit.getById(recent.id);
    if (kept?.kind !== 'call') throw new Error('expected a call record');
    expect(kept.accepted_risks_snapshot).toEqual([READ, WRITE]);
  });

  it('refuses to delete a set an entry references, even inside a purge window', async () => {
    await store.audit.append(call('2026-10-12T00:00:00.000Z'));
    const setId = acceptedSetOf([READ, WRITE]).id;
    for (const sql of [
      'DELETE FROM audit_risk_set_members WHERE set_id = ?',
      'DELETE FROM audit_risk_sets WHERE id = ?',
    ]) {
      expect(() => {
        store.db.transaction(() => {
          store.db
            .prepare('INSERT INTO audit_purge_guard (id, cutoff) VALUES (1, ?)')
            .run('2026-10-13T00:00:00.000Z');
          store.db.prepare(sql).run(setId);
        })();
      }).toThrow(/retention purge/);
    }
    expect(count('audit_risk_set_members')).toBe(2);
  });

  it('reads an entry written before migration 0022 from its own rows, as before', async () => {
    // What an earlier image wrote: no set id, one row per accepted or touched risk.
    store.db
      .prepare(
        `INSERT INTO audit (id, ts, kind, mission_id, tool, arguments_hash, slices_json, decision)
         VALUES ('old', '2026-10-20T00:00:00.000Z', 'call', 'm1', 'github__create_branch', 'abc', '[]', 'allowed')`,
      )
      .run();
    const row = store.db.prepare(
      'INSERT INTO audit_risks (audit_id, risk_id, accepted, touched, remaining) VALUES (?, ?, ?, ?, ?)',
    );
    row.run('old', READ, 1, 0, 9);
    row.run('old', WRITE, 1, 1, 4);
    row.run('old', MERGE, 0, 1, null);

    const record = await store.audit.getById('old');
    if (record?.kind !== 'call') throw new Error('expected a call record');
    expect(record.accepted_risks_snapshot).toEqual([READ, WRITE]);
    expect(record.risks_touched).toEqual([MERGE, WRITE]);
    expect(record.remaining_budget).toEqual({ [READ]: 9, [WRITE]: 4 });
    expect(
      await store.audit.countAllowedTouches(
        'm1',
        WRITE,
        '2026-10-01T00:00:00.000Z',
        '2026-11-01T00:00:00.000Z',
      ),
    ).toBe(1);

    // It ages out with the retention like any entry; no set was involved.
    expect(await store.audit.purgeOlderThan('2026-10-21T00:00:00.000Z')).toBe(1);
    expect(count('audit_risks')).toBe(0);
  });

  it('refuses a set whose stored members disagree with its count', async () => {
    const record = await store.audit.append(call('2026-10-12T00:00:00.000Z'));
    // Only a raw write with the triggers out of the way can do this; the read says so.
    store.db.exec('DROP TRIGGER audit_risk_set_members_no_delete');
    store.db.prepare('DELETE FROM audit_risk_set_members WHERE risk_id = ?').run(READ);
    await expect(store.audit.getById(record.id)).rejects.toThrow(/1 members stored, 2 expected/);
  });
});
