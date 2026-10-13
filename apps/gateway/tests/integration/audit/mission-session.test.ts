/**
 * `MissionSessionService` on an ephemeral instance (spec §4.2 "Mission
 * session", §3.3): counters per risk and per period with what is left, gate
 * per risk, open requests by link only, agent labels seen, the timeline.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { eventView, SESSION_EVENTS_PAGE_SIZE } from '../../../src/server/audit';
import type { MissionRecord } from '../../../src/server/store/types';
import {
  ARGUMENT_MARKER,
  DAY_SECONDS,
  githubDraft,
  issueMission,
  MERGE,
  NO_FILTER,
  openAuditRig,
  PR,
  READ,
  seedCall,
  type OperatorRig,
} from './support';

const byRisk = (a: readonly unknown[], b: readonly unknown[]) =>
  String(a[0]).localeCompare(String(b[0]));

describe('mission session view', () => {
  let rig: OperatorRig;
  let mission: MissionRecord;

  beforeEach(async () => {
    rig = await openAuditRig();
    mission = await issueMission(rig);
  });
  afterEach(async () => {
    await rig.root.close();
  });

  const view = async (user = rig.seeded.ada, id = mission.id) => {
    const found = await rig.root.audit.sessions.get(user, id);
    if (!found) throw new Error('expected a session view');
    return found;
  };

  it('is the creator’s only: another user and an unknown mission get the same answer', async () => {
    await seedCall(rig, mission);
    expect(await rig.root.audit.sessions.get(rig.seeded.bob, mission.id)).toBeNull();
    expect(await rig.root.audit.sessions.get(rig.operator, mission.id)).toBeNull();
    expect(await rig.root.audit.sessions.get(rig.seeded.ada, 'no-such-mission')).toBeNull();
  });

  it('before the first call: no session, a full budget, the gate of every risk', async () => {
    const v = await view();
    expect(v.session).toBeNull();
    expect(v.events).toEqual([]);
    expect(v.open_requests).toEqual([]);
    expect(v.agent_labels).toEqual([]);
    expect(v.state.kind).toBe('active');
    expect(
      v.risks.map((r) => [r.risk_id, r.quota, r.consumed, r.remaining, r.gate]).sort(byRisk),
    ).toEqual(
      [
        [READ, 5, 0, 5, 'auto'],
        [PR, 2, 0, 2, 'auto'],
        [MERGE, 2, 0, 2, 'approval'],
      ].sort(byRisk),
    );
    // The catalog's label, not the id.
    expect(v.risks.every((r) => r.label.length > 0 && r.label !== r.risk_id)).toBe(true);
    expect(v.periods).toHaveLength(1);
    expect(v.periods[0]).toMatchObject({ current: true, consumed: {} });
  });

  it('counts per risk for the current period and says what is left and what is exhausted', async () => {
    await seedCall(rig, mission);
    await seedCall(rig, mission, { risks: [READ, PR] });
    await seedCall(rig, mission, { risks: [PR] });
    await seedCall(rig, mission, { risks: [PR] }); // refused: nothing counted

    const v = await view();
    expect(v.session).not.toBeNull();
    expect(
      v.risks.map((r) => [r.risk_id, r.consumed, r.remaining, r.exhausted]).sort(byRisk),
    ).toEqual(
      [
        [READ, 2, 3, false],
        [PR, 2, 0, true],
        [MERGE, 0, 2, false],
      ].sort(byRisk),
    );
    const current = v.periods.find((p) => p.current);
    expect(current?.consumed).toEqual({ [READ]: 2, [PR]: 2 });
    expect(Date.parse(current?.end ?? '') - Date.parse(current?.start ?? '')).toBe(
      DAY_SECONDS * 1000,
    );
  });

  it('keeps the counters of past periods, newest first, apart from the current one', async () => {
    const now = new Date();
    const yesterday = new Date(now.getTime() - DAY_SECONDS * 1000);
    // Issued three days ago: straight through the repository, which takes the anchor.
    const old = await rig.root.store.missions.create({
      name: 'Three days in',
      creatorUserId: rig.seeded.ada.id,
      periodAnchor: new Date(now.getTime() - 3 * DAY_SECONDS * 1000).toISOString(),
      periodSeconds: DAY_SECONDS,
      expiresAt: null,
      connections: [
        { connectionId: rig.seeded.github.connection.id, resourceScope: 'all', resourceIds: [] },
      ],
      policy: [{ riskId: PR, quota: 2, rateLimit: 50, rateWindowSeconds: 60, gate: 'auto' }],
    });
    await seedCall(rig, old, { now: yesterday, risks: [PR] });
    await seedCall(rig, old, { now: yesterday, risks: [PR] });
    await seedCall(rig, old, { now, risks: [PR] });

    const v = await view(rig.seeded.ada, old.id);
    expect(v.periods.map((p) => [p.current, p.consumed[PR]])).toEqual([
      [true, 1],
      [false, 2],
    ]);
    expect(v.periods[1]?.end).toBe(v.periods[0]?.start);
    // Yesterday's exhaustion is gone today.
    expect(v.risks.find((r) => r.risk_id === PR)).toMatchObject({ remaining: 1, exhausted: false });
  });

  it('a one-off mission has one period that never ends', async () => {
    const oneOff = await issueMission(
      rig,
      rig.seeded.ada,
      githubDraft(rig, { name: 'One shot', period: { kind: 'one-off' } }),
    );
    await seedCall(rig, oneOff);
    const v = await view(rig.seeded.ada, oneOff.id);
    expect(v.periods).toEqual([
      { start: oneOff.periodAnchor, end: null, current: true, consumed: { [READ]: 1 } },
    ]);
  });

  it('lists open requests by link only: no tool, no fingerprint, no argument', async () => {
    const approval = await seedCall(rig, mission, {
      tool: 'github__merge_pull_request',
      risks: [MERGE],
      args: { pull_number: 12, note: ARGUMENT_MARKER },
    });
    for (let i = 0; i < 2; i++) await seedCall(rig, mission, { risks: [PR] });
    const claim = await seedCall(rig, mission, { risks: [PR] });
    if (approval.result.outcome !== 'refused' || claim.result.outcome !== 'refused') {
      throw new Error('expected two refusals');
    }

    const v = await view();
    expect(v.open_requests.map((r) => [r.kind, r.risk_id, r.path]).sort()).toEqual(
      [
        ['approval', MERGE, `/requests/${approval.result.request_id}`],
        ['claim', PR, `/requests/${claim.result.request_id}`],
      ].sort(),
    );
    expect(Object.keys(v.open_requests[0] ?? {}).sort()).toEqual([
      'created_at',
      'expires_at',
      'id',
      'kind',
      'path',
      'risk_id',
    ]);
    // The refusal the agent received carries the forwarded URL of the same request.
    expect(approval.result.refusal).toMatchObject({
      approval_url: `${rig.root.config.publicUrl.origin}/r/${approval.result.request_id}`,
    });
    // The sealed arguments exist in the store and reach neither the view nor the audit page.
    expect(await rig.root.store.requests.getArguments(approval.result.request_id ?? '')).toEqual({
      pull_number: 12,
      note: ARGUMENT_MARKER,
    });
    expect(JSON.stringify(v)).not.toContain(ARGUMENT_MARKER);
  });

  it('a decided or expired request is no longer listed', async () => {
    for (let i = 0; i < 2; i++) await seedCall(rig, mission, { risks: [PR] });
    const claim = await seedCall(rig, mission, { risks: [PR] });
    if (claim.result.outcome !== 'refused' || !claim.result.request_id) {
      throw new Error('expected a claim');
    }
    expect((await view()).open_requests).toHaveLength(1);
    await rig.root.store.requests.decide(claim.result.request_id, 'refused', rig.seeded.ada.id);
    expect((await view()).open_requests).toEqual([]);
  });

  it('a granted claim lowers the counters, and the timeline says what was given back', async () => {
    await seedCall(rig, mission);
    for (let i = 0; i < 2; i++) await seedCall(rig, mission, { risks: [PR] });
    const claim = await seedCall(rig, mission, { risks: [PR] });
    if (claim.result.outcome !== 'refused' || !claim.result.request_id) {
      throw new Error('expected a claim');
    }
    const pr = async () => (await view()).risks.find((r) => r.risk_id === PR);
    expect(await pr()).toMatchObject({ consumed: 2, remaining: 0, exhausted: true });

    const granted = await rig.root.requests.service.decideClaim(
      rig.seeded.ada,
      claim.result.request_id,
      { resolution: 'extend-quota', amount: 1 },
    );
    expect(granted.ok).toBe(true);

    const v = await view();
    // The counter went down: "counted" and "left" are read from it, not from the audit.
    expect(v.risks.find((r) => r.risk_id === PR)).toMatchObject({
      consumed: 1,
      remaining: 1,
      exhausted: false,
    });
    expect(v.risks.find((r) => r.risk_id === READ)).toMatchObject({ consumed: 1, remaining: 4 });
    expect(v.periods[0]?.consumed).toMatchObject({ [PR]: 1 });
    expect(v.open_requests).toEqual([]);
    expect(v.events[0]).toMatchObject({
      kind: 'extension',
      actor_email: 'ada@example.com',
      dimension: 'quota',
      credits: { [PR]: 1 },
      request_id: claim.result.request_id,
    });

    // A period reset gives everything back, on every risk.
    await seedCall(rig, mission, { risks: [PR] });
    const second = await seedCall(rig, mission, { risks: [PR] });
    if (second.result.outcome !== 'refused' || !second.result.request_id) {
      throw new Error('expected a second claim');
    }
    await rig.root.requests.service.decideClaim(rig.seeded.ada, second.result.request_id, {
      resolution: 'reset-period',
    });
    const after = await view();
    expect(after.risks.every((r) => r.consumed === 0 && !r.exhausted)).toBe(true);
    expect(after.events[0]).toMatchObject({ kind: 'reset', credits: { [PR]: 2, [READ]: 1 } });
    // The decisions are in the audit of the mission.
    const audit = await rig.root.audit.query.search(
      { kind: 'user', user: rig.seeded.ada, groups: [], isOperator: false },
      { ...NO_FILTER, missionId: mission.id, kind: 'admin' },
    );
    expect(audit.entries.flatMap((e) => (e.kind === 'admin' ? [e.act] : []))).toEqual([
      'period-reset',
      'budget-extended',
      'mission-issued',
    ]);
  });

  it('shows the agent labels seen, most recent first, with their call counts', async () => {
    const t = (minute: number) => new Date(Date.UTC(2026, 9, 13, 9, minute));
    await seedCall(rig, mission, { now: t(0), agentLabel: 'planner' });
    await seedCall(rig, mission, { now: t(1), agentLabel: 'coder' });
    await seedCall(rig, mission, { now: t(2), agentLabel: 'planner' });
    await seedCall(rig, mission, { now: t(3) }); // no label
    expect((await view()).agent_labels).toEqual([
      { label: 'planner', calls: 2, lastSeenAt: t(2).toISOString() },
      { label: 'coder', calls: 1, lastSeenAt: t(1).toISOString() },
    ]);
  });

  it('the timeline is newest first and names tool, risks, what is left, the refusal and the request', async () => {
    await seedCall(rig, mission, { agentLabel: 'coder' });
    for (let i = 0; i < 2; i++) await seedCall(rig, mission, { risks: [PR] });
    const refused = await seedCall(rig, mission, {
      tool: 'github__create_pull_request',
      risks: [PR],
    });
    await rig.root.missions.service.rotate(rig.seeded.ada, mission.id);

    const { events } = await view();
    expect(events.map((e) => e.kind)).toEqual([
      'rotation',
      'call-refused',
      'request',
      'call-allowed',
      'call-allowed',
      'call-allowed',
    ]);
    expect(events[0]).toMatchObject({ actor_email: 'ada@example.com', tool: null });
    expect(events[0]?.token_prefix).toMatch(/^[A-Za-z0-9]{8}$/);
    expect(events[1]).toMatchObject({
      tool: 'github__create_pull_request',
      refusal_code: 'budget-exhausted',
      risk_ids: [PR],
      request_id: refused.result.outcome === 'refused' ? refused.result.request_id : null,
      remaining: null,
    });
    expect(events[2]).toMatchObject({ request_kind: 'claim', risk_ids: [PR] });
    expect(events.at(-1)).toMatchObject({
      tool: 'github__get_file',
      agent_label: 'coder',
      risk_ids: [READ],
      remaining: { [READ]: 4 },
    });
    expect(JSON.stringify(events)).not.toContain(ARGUMENT_MARKER);
  });

  it('pages the timeline by keyset', async () => {
    const policy = [{ risk_id: READ, quota: 500, rate_limit: { max: 500, window_seconds: 60 } }];
    const busy = await issueMission(
      rig,
      rig.seeded.ada,
      githubDraft(rig, {
        name: 'Busy',
        connections: [{ connection_id: rig.seeded.github.connection.id, policy }],
      }),
    );
    const total = SESSION_EVENTS_PAGE_SIZE + 5;
    for (let i = 0; i < total; i++) await seedCall(rig, busy);

    const first = await view(rig.seeded.ada, busy.id);
    expect(first.events).toHaveLength(SESSION_EVENTS_PAGE_SIZE);
    expect(first.next_events).not.toBeNull();
    const second = await rig.root.audit.sessions.get(rig.seeded.ada, busy.id, {
      eventsBefore: first.next_events,
    });
    expect(second?.events).toHaveLength(5);
    expect(second?.next_events).toBeNull();
    const ids = [...first.events, ...(second?.events ?? [])].map((e) => e.id);
    expect(new Set(ids).size).toBe(total);
  });

  it('a revoked mission keeps its history and shows no current budget', async () => {
    await seedCall(rig, mission);
    await rig.root.missions.service.revoke(rig.seeded.ada, mission.id);
    const v = await view();
    expect(v.state.kind).toBe('revoked');
    expect(v.risks.every((r) => r.consumed === null && r.remaining === null)).toBe(true);
    expect(v.periods).toHaveLength(1);
    expect(v.periods[0]).toMatchObject({ current: false, consumed: { [READ]: 1 } });
    expect(v.events[0]).toMatchObject({ kind: 'revocation', actor_email: 'ada@example.com' });
  });
});

describe('eventView', () => {
  it('surfaces the named fields of an event and nothing else of its details', () => {
    const shown = eventView(
      {
        id: 'e-1',
        sessionId: 's-1',
        ts: '2026-10-13T09:00:00.000Z',
        kind: 'approval',
        riskId: MERGE,
        actorUserId: 'u-1',
        details: {
          tool: 'github__merge_pull_request',
          risk_ids: [MERGE, 7],
          remaining: { [MERGE]: 1, bogus: 'x' },
          arguments: { secret: ARGUMENT_MARKER },
          args: ARGUMENT_MARKER,
          anything_else: ARGUMENT_MARKER,
        },
      },
      'ada@example.com',
    );
    expect(shown).toEqual({
      id: 'e-1',
      ts: '2026-10-13T09:00:00.000Z',
      kind: 'approval',
      risk_ids: [MERGE],
      actor_email: 'ada@example.com',
      tool: 'github__merge_pull_request',
      refusal_code: null,
      agent_label: null,
      remaining: { [MERGE]: 1 },
      request_id: null,
      request_kind: null,
      token_prefix: null,
      credits: null,
      dimension: null,
      expires_at: null,
    });
    expect(JSON.stringify(shown)).not.toContain(ARGUMENT_MARKER);
  });

  it('reads an event with no details', () => {
    expect(
      eventView(
        {
          id: 'e-2',
          sessionId: 's-1',
          ts: '2026-10-13T09:00:00.000Z',
          kind: 'reset',
          riskId: null,
          actorUserId: null,
          details: null,
        },
        null,
      ),
    ).toMatchObject({ risk_ids: [], tool: null, remaining: null });
  });
});
