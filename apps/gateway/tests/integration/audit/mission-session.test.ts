/**
 * `MissionSessionService` on an ephemeral instance (spec §4.2 "Mission
 * session", §3.3): counters per risk and per period with what is left, gate
 * per risk, open requests by link only, agent labels seen, the timeline.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  eventView,
  MissionSessionService,
  SESSION_EVENTS_PAGE_SIZE,
} from '../../../src/server/audit';
import { systemClock } from '../../../src/server/store/clock';
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

  describe('agent labels: who said they made the calls', () => {
    // After the issuance (the period starts with it), one millisecond apart.
    let started = 0;
    beforeEach(() => {
      started = Date.now();
    });
    const t = (step: number) => new Date(started + step);

    it('counts the calls of the current period per label, allowed and refused, unlabelled apart', async () => {
      await seedCall(rig, mission, { now: t(0), agentLabel: 'planner' });
      await seedCall(rig, mission, { now: t(1), agentLabel: 'coder' });
      await seedCall(rig, mission, { now: t(2) }); // no label
      const pr = { tool: 'github__create_pull_request', risks: [PR], agentLabel: 'coder' } as const;
      await seedCall(rig, mission, { ...pr, now: t(3) });
      await seedCall(rig, mission, { ...pr, now: t(4) });
      // The quota of pull requests is two: the third is refused.
      await seedCall(rig, mission, { ...pr, now: t(5) });

      const v = await view();
      expect(v.label_activity).toEqual([
        { label: 'coder', allowed: 3, refused: 1, last_seen_at: t(5).toISOString() },
        { label: null, allowed: 1, refused: 0, last_seen_at: t(2).toISOString() },
        { label: 'planner', allowed: 1, refused: 0, last_seen_at: t(0).toISOString() },
      ]);
      // Counts of calls, beside the budget and never instead of it: the counters are per
      // risk, one per mission, whoever called.
      expect(v.risks.find((r) => r.risk_id === READ)).toMatchObject({ consumed: 3, remaining: 2 });
      expect(v.risks.find((r) => r.risk_id === PR)).toMatchObject({ consumed: 2, exhausted: true });
      expect(v.periods[0]?.consumed).toEqual({ [READ]: 3, [PR]: 2 });
    });

    it('leaves out the calls of past periods, and has nothing for a mission that is not active', async () => {
      const now = new Date();
      const yesterday = new Date(now.getTime() - DAY_SECONDS * 1000);
      const old = await rig.root.store.missions.create({
        name: 'Three days in',
        creatorUserId: rig.seeded.ada.id,
        periodAnchor: new Date(now.getTime() - 3 * DAY_SECONDS * 1000).toISOString(),
        periodSeconds: DAY_SECONDS,
        expiresAt: null,
        connections: [
          { connectionId: rig.seeded.github.connection.id, resourceScope: 'all', resourceIds: [] },
        ],
        policy: [{ riskId: READ, quota: 50, rateLimit: 50, rateWindowSeconds: 60, gate: 'auto' }],
      });
      await seedCall(rig, old, { now: yesterday, agentLabel: 'night-shift' });
      await seedCall(rig, old, { now: yesterday, agentLabel: 'coder' });
      await seedCall(rig, old, { now, agentLabel: 'coder' });

      const active = await view(rig.seeded.ada, old.id);
      expect(active.label_activity.map((a) => [a.label, a.allowed])).toEqual([['coder', 1]]);
      // "Labels seen" keeps the whole history the audit still holds.
      expect(active.agent_labels.map((a) => a.label).sort()).toEqual(['coder', 'night-shift']);

      await rig.root.missions.service.revoke(rig.seeded.ada, old.id);
      const revoked = await view(rig.seeded.ada, old.id);
      expect(revoked.state.kind).toBe('revoked');
      expect(revoked.label_activity).toEqual([]);
    });

    it('filters the timeline to the calls of one label, or to the unlabelled ones', async () => {
      await seedCall(rig, mission, { now: t(0), agentLabel: 'planner' });
      await seedCall(rig, mission, { now: t(1), agentLabel: 'coder' });
      await seedCall(rig, mission, { now: t(2) });
      const pr = { tool: 'github__create_pull_request', risks: [PR], agentLabel: 'coder' } as const;
      await seedCall(rig, mission, { ...pr, now: t(3) });
      await seedCall(rig, mission, { ...pr, now: t(4) });
      await seedCall(rig, mission, { ...pr, now: t(5) }); // refused, opens a claim
      await rig.root.missions.service.rotate(rig.seeded.ada, mission.id);

      const filtered = async (timeline: Parameters<typeof rig.root.audit.sessions.get>[2]) =>
        (await rig.root.audit.sessions.get(rig.seeded.ada, mission.id, timeline))!;

      const all = await view();
      expect(all.timeline_filter).toEqual({ kind: 'all' });
      expect(all.events.map((e) => e.kind)).toContain('rotation');
      expect(all.events.map((e) => e.kind)).toContain('request');

      const coder = await filtered({ timeline: { kind: 'label', label: 'coder' } });
      expect(coder.timeline_filter).toEqual({ kind: 'label', label: 'coder' });
      expect(coder.events.map((e) => [e.kind, e.tool, e.agent_label])).toEqual([
        ['call-refused', 'github__create_pull_request', 'coder'],
        ['call-allowed', 'github__create_pull_request', 'coder'],
        ['call-allowed', 'github__create_pull_request', 'coder'],
        ['call-allowed', 'github__get_file', 'coder'],
      ]);
      expect(coder.next_events).toBeNull();
      expect(coder.events_scan_limited).toBe(false);

      const unlabelled = await filtered({ timeline: { kind: 'unlabelled' } });
      // The request and the rotation carry no label either, but they are not calls.
      expect(unlabelled.events.map((e) => [e.kind, e.agent_label])).toEqual([
        ['call-allowed', null],
      ]);

      const nobody = await filtered({ timeline: { kind: 'label', label: 'reviewer' } });
      expect(nobody.events).toEqual([]);
      // Whatever the filter, the budget and the per-label counts are the mission's.
      expect(nobody.label_activity).toEqual(all.label_activity);
      expect(nobody.risks).toEqual(all.risks);
    });

    it('pages a filtered timeline, and says when it stopped looking before the end', async () => {
      const policy = [{ risk_id: READ, quota: 500, rate_limit: { max: 500, window_seconds: 60 } }];
      const busy = await issueMission(
        rig,
        rig.seeded.ada,
        githubDraft(rig, {
          name: 'Busy',
          connections: [{ connection_id: rig.seeded.github.connection.id, policy }],
        }),
      );
      const base = Date.now() - 60_000;
      // Oldest first: 3 calls of `scout`, then 40 unlabelled ones, then 2 of `scout`.
      const labels = [
        ...Array<string | null>(3).fill('scout'),
        ...Array<string | null>(40).fill(null),
        ...Array<string | null>(2).fill('scout'),
      ];
      for (const [i, agentLabel] of labels.entries()) {
        await seedCall(rig, busy, { now: new Date(base + i * 100), agentLabel });
      }
      // Looks through 10 events at a time, 20 per page read.
      const sessions = new MissionSessionService({
        store: rig.root.store,
        missions: rig.root.missions.service,
        clock: systemClock,
        timelineScan: { batch: 10, limit: 20 },
      });
      const scout = { kind: 'label', label: 'scout' } as const;

      const first = (await sessions.get(rig.seeded.ada, busy.id, { timeline: scout }))!;
      expect(first.events).toHaveLength(2);
      expect(first.events_scan_limited).toBe(true);
      expect(first.next_events).not.toBeNull();

      // Following "Older" resumes where the scan stopped, until the timeline ends.
      const seen = [...first.events];
      let cursor = first.next_events;
      let reads = 1;
      while (cursor) {
        const page = (await sessions.get(rig.seeded.ada, busy.id, {
          timeline: scout,
          eventsBefore: cursor,
        }))!;
        seen.push(...page.events);
        cursor = page.next_events;
        reads += 1;
      }
      expect(seen).toHaveLength(5);
      expect(new Set(seen.map((e) => e.id)).size).toBe(5);
      expect(seen.every((e) => e.agent_label === 'scout')).toBe(true);
      expect(reads).toBe(3);

      // With the default bounds the same timeline is one page.
      const whole = (await rig.root.audit.sessions.get(rig.seeded.ada, busy.id, {
        timeline: scout,
      }))!;
      expect(whole.events).toHaveLength(5);
      expect(whole.events_scan_limited).toBe(false);
      expect(whole.next_events).toBeNull();
    });
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
        kind: 'call-allowed',
        riskId: MERGE,
        actorUserId: 'u-1',
        details: {
          tool: 'github__merge_pull_request',
          fingerprint: 'sha256:abc',
          risk_ids: [MERGE],
          agent_label: null,
          remaining: { [MERGE]: 1 },
          approval_ids: ['a-1'],
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
      kind: 'call-allowed',
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

  it('shows an event with malformed details without detail, and does not throw', () => {
    const shown = eventView(
      {
        id: 'e-3',
        sessionId: 's-1',
        ts: '2026-10-13T09:00:00.000Z',
        kind: 'call-allowed',
        riskId: MERGE,
        actorUserId: 'u-1',
        // A list with a non-text entry, a count that is not a number, missing keys.
        details: {
          tool: 'github__merge_pull_request',
          risk_ids: [MERGE, 7],
          remaining: { [MERGE]: 1, bogus: 'x' },
          args: ARGUMENT_MARKER,
        },
      },
      'ada@example.com',
    );
    expect(shown).toEqual({
      id: 'e-3',
      ts: '2026-10-13T09:00:00.000Z',
      kind: 'call-allowed',
      risk_ids: [MERGE],
      actor_email: 'ada@example.com',
      tool: null,
      refusal_code: null,
      agent_label: null,
      remaining: null,
      request_id: null,
      request_kind: null,
      token_prefix: null,
      credits: null,
      dimension: null,
      expires_at: null,
    });
  });
});
