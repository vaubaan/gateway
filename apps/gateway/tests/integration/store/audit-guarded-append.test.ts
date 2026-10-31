/**
 * Audit — the guarded append (`appendUnlessLatest`: one change two writers both saw
 * is recorded once) and the per-label activity over a bounded and an open span (two
 * statements, portable SQL). Spec §6 "immutable audit", §3.3 (agent label).
 */

import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AdminAuditEntry, CallAuditEntry } from '@vaubaan/gateway-core';
import type { Store } from '../../../src/server/store/index.ts';
import { openTestStore, type TestStore } from '../../support/store/testing.ts';

const GROUNDS = ['mission-orphaned', 'mission-restored'] as const;
const T0 = '2026-10-13T09:00:00.000Z';
const T1 = '2026-10-13T09:00:01.000Z';
const T2 = '2026-10-13T09:00:02.000Z';

function grounds(
  act: (typeof GROUNDS)[number],
  ts: string,
  userId = 'u1',
  missionId = 'm1',
): AdminAuditEntry {
  return {
    kind: 'admin',
    ts,
    user_id: userId,
    act,
    object: { type: 'mission', id: missionId },
    before: { status: act === 'mission-orphaned' ? 'active' : 'orphaned' },
    after: { status: act === 'mission-orphaned' ? 'orphaned' : 'active' },
    delegated_client_id: null,
  };
}

function call(ts: string, label: string | null, decision: 'allowed' | 'refused'): CallAuditEntry {
  return {
    kind: 'call',
    ts,
    mission_id: 'm1',
    token_id: null,
    token_kind: null,
    token_holder: null,
    session_id: 's1',
    connection_id: 'c1',
    resource_ref: null,
    tool: 'github__get_file',
    arguments_hash: 'abc123def4567890',
    slices_executed: [],
    risks_touched: [],
    accepted_risks_snapshot: [],
    decision,
    refusal_code: decision === 'refused' ? 'budget-exhausted' : null,
    refusal_reason: decision === 'refused' ? 'quota is 0' : null,
    approval_id: null,
    remaining_budget: null,
    agent_label: label,
    upstream_latency_ms: null,
    upstream_error: null,
    client_ip: null,
    client_user_agent: null,
  };
}

describe('store.audit — guarded append and label activity', () => {
  let t: TestStore;
  let store: Store;

  beforeEach(() => {
    t = openTestStore();
    store = t.store;
  });
  afterEach(async () => {
    await store.close();
  });

  const acts = async (): Promise<string[]> =>
    (await store.audit.list({ kind: 'admin' })).map((e) =>
      e.kind === 'admin' ? `${e.act}:${e.user_id}:${e.object.id}` : 'call',
    );

  describe('appendUnlessLatest', () => {
    it('writes when the object has no earlier entry of the guarded acts', async () => {
      const written = await store.audit.appendUnlessLatest(grounds('mission-orphaned', T1), {
        among: GROUNDS,
        since: T0,
      });
      expect(written).toMatchObject({ kind: 'admin', act: 'mission-orphaned', user_id: 'u1' });
      expect(await acts()).toEqual(['mission-orphaned:u1:m1']);
    });

    it('holds back the same act recorded since the guard instant: two writers, one entry', async () => {
      const guard = { among: GROUNDS, since: T0 };
      await store.audit.appendUnlessLatest(grounds('mission-orphaned', T1, 'ada'), guard);
      const second = await store.audit.appendUnlessLatest(
        grounds('mission-orphaned', T2, 'bob'),
        guard,
      );
      expect(second).toBeNull();
      expect(await acts()).toEqual(['mission-orphaned:ada:m1']);
    });

    it('holds back an entry written at the guard instant itself', async () => {
      await store.audit.append(grounds('mission-restored', T1, 'ada'));
      expect(
        await store.audit.appendUnlessLatest(grounds('mission-restored', T1, 'bob'), {
          among: GROUNDS,
          since: T1,
        }),
      ).toBeNull();
    });

    it('writes the other act, and the same act again once the other one came between', async () => {
      const guard = { among: GROUNDS, since: T0 };
      await store.audit.appendUnlessLatest(grounds('mission-orphaned', T1), guard);
      expect(
        await store.audit.appendUnlessLatest(grounds('mission-restored', T1), guard),
      ).not.toBeNull();
      // Same timestamp three times: the id breaks the tie in insertion order.
      expect(
        await store.audit.appendUnlessLatest(grounds('mission-orphaned', T1), guard),
      ).not.toBeNull();
      expect((await acts()).map((a) => a.split(':')[0])).toEqual([
        'mission-orphaned',
        'mission-restored',
        'mission-orphaned',
      ]);
    });

    it('does not hold back for an equal entry older than the guard instant', async () => {
      await store.audit.append(grounds('mission-orphaned', T0));
      expect(
        await store.audit.appendUnlessLatest(grounds('mission-orphaned', T2), {
          among: GROUNDS,
          since: T1,
        }),
      ).not.toBeNull();
      expect(await acts()).toHaveLength(2);
    });

    it('compares per object and only within the guarded acts', async () => {
      const guard = { among: GROUNDS, since: T0 };
      await store.audit.appendUnlessLatest(grounds('mission-orphaned', T1), guard);
      // Another mission is another object.
      expect(
        await store.audit.appendUnlessLatest(grounds('mission-orphaned', T1, 'u1', 'm2'), guard),
      ).not.toBeNull();
      // An unrelated act on the same mission in between changes nothing.
      await store.audit.append({ ...grounds('mission-orphaned', T2), act: 'mission-rotated' });
      expect(
        await store.audit.appendUnlessLatest(grounds('mission-orphaned', T2), guard),
      ).toBeNull();
    });

    it('refuses a guard that does not name the act being written', async () => {
      await expect(
        store.audit.appendUnlessLatest(grounds('mission-orphaned', T1), {
          among: ['mission-restored'],
          since: T0,
        }),
      ).rejects.toThrow(/guarded acts/);
      expect(await acts()).toEqual([]);
    });
  });

  describe('agentLabelActivity', () => {
    beforeEach(async () => {
      await store.audit.append(call('2026-10-13T08:00:00.000Z', 'early', 'allowed'));
      await store.audit.append(call('2026-10-13T09:00:00.000Z', 'coder', 'allowed'));
      await store.audit.append(call('2026-10-13T10:00:00.000Z', 'coder', 'refused'));
      await store.audit.append(call('2026-10-13T11:00:00.000Z', null, 'allowed'));
      await store.audit.append(call('2026-10-13T12:00:00.000Z', 'late', 'allowed'));
    });

    it('a bounded span counts `[since, until)`', async () => {
      expect(
        await store.audit.agentLabelActivity('m1', {
          since: '2026-10-13T09:00:00.000Z',
          until: '2026-10-13T12:00:00.000Z',
        }),
      ).toEqual([
        { label: 'coder', allowed: 1, refused: 1, lastSeenAt: '2026-10-13T10:00:00.000Z' },
        { label: null, allowed: 1, refused: 0, lastSeenAt: '2026-10-13T11:00:00.000Z' },
      ]);
    });

    it('an open span (`until: null`) has no upper bound', async () => {
      const open = await store.audit.agentLabelActivity('m1', {
        since: '2026-10-13T09:00:00.000Z',
        until: null,
      });
      expect(open.map((a) => [a.label, a.allowed + a.refused])).toEqual([
        ['coder', 2],
        [null, 1],
        ['late', 1],
      ]);
    });

    it('binds no parameter that is only compared to NULL (Postgres cannot type it)', () => {
      const source = readFileSync(
        new URL('../../../src/server/store/repositories/audit.ts', import.meta.url),
        'utf8',
      );
      const statements = source.replace(/^\s*(\/\/|\*).*$/gm, '');
      expect(statements).not.toMatch(/\?\s+IS\s+NULL/i);
    });
  });
});
