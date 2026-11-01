/**
 * A mission edited after issuance by its creator, without limit on what moves but
 * its period (spec §3.2 "Editing a mission"; ADR mission-editable-after-issuance).
 * Over the real composition root: the mission service, its HTTP handler, the store,
 * the budget and the execution door.
 *
 * What is proven here:
 *
 *   - every section moves in one edit: name, expiry, accounts added and removed,
 *     resources added and removed, permissions added and removed, quota, rate (calls
 *     and window) and gate — written in one transaction, traced by one
 *     `mission-changed` audit entry with each section before and after, and by session
 *     events per risk plus one summary the activity words;
 *   - a refusal carries, word for word, the issue a creation asking for the same thing
 *     gets; a fact unrelated to what moves (a resource gone stale) refuses nothing;
 *   - the period never moves; a stale revision is a conflict and writes nothing;
 *   - the creator only; a revoked mission is not edited; an expired one is, and an end
 *     moved into the future brings it back;
 *   - a removed permission closes the claims and approval requests about it;
 *   - same token, same session, same counters: a removed resource is refused from the
 *     next call, an added one is reached, a removed permission fails closed even for a
 *     call whose mission was loaded before the edit.
 */
import type { MissionPolicyEntry } from '@vaubaan/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { budgetMissionOf } from '../../../src/server/budget';
import {
  executionInstance,
  line,
  type ExecutionInstance,
} from '../../../src/server/execution/testing';
import type { MissionDraft } from '../../../src/server/missions';
import { agePastStaleGrace } from '../../../src/server/store/testing';
import type { MissionRecord } from '../../../src/server/store/types';
import {
  githubDraft,
  issueMission,
  MERGE,
  openAuditRig,
  PR,
  READ,
  seedCall,
  type OperatorRig,
} from '../audit/support';

import { sessionHeaders } from './support';

const SUPABASE_READ = 'supabase.read-data';

describe('editing a mission after issuance', () => {
  let rig: OperatorRig;
  let mission: MissionRecord;

  beforeEach(async () => {
    rig = await openAuditRig();
    // GitHub, on acme/app only: reads (5), pull requests (2), merges under approval.
    mission = await issueMission(
      rig,
      rig.seeded.ada,
      githubDraft(rig, {
        connections: [
          {
            ...githubDraft(rig).connections[0],
            resources: { scope: 'selected', resource_refs: ['acme/app'] },
          },
        ],
      }),
    );
  });
  afterEach(async () => {
    await rig.root.close();
  });

  const service = () => rig.root.missions.service;
  const fresh = async (): Promise<MissionRecord> => {
    const record = await rig.root.store.missions.getById(mission.id);
    if (!record) throw new Error('the mission vanished');
    return record;
  };
  const view = async () => {
    const found = await service().editView(rig.seeded.ada, mission.id);
    if (!found) throw new Error('no edit view');
    return found;
  };
  const resourceId = (ref: string) => {
    const found = rig.seeded.github.resources.find((r) => r.ref === ref);
    if (!found) throw new Error(`no ${ref}`);
    return found.id;
  };
  /** The mission's own draft with `change` applied, and its revision. */
  const edited = async (change: (draft: MissionDraft) => MissionDraft) => {
    const current = await view();
    return { draft: change(current.draft), revision: current.revision };
  };
  const githubLine = (draft: MissionDraft) => {
    const [github] = draft.connections;
    if (!github) throw new Error('no GitHub line');
    return github;
  };
  const audits = async () =>
    (await rig.root.store.audit.list({ kind: 'admin' })).flatMap((e) =>
      e.kind === 'admin' && e.act === 'mission-changed' ? [e] : [],
    );
  const events = async () => {
    const session = await rig.root.store.sessions.getByMission(mission.id);
    return session ? rig.root.store.sessions.listEvents(session.id) : [];
  };

  it('moves every section in one edit, with the same token and the same counters', async () => {
    // A session with two reads, so the counters and the events have somewhere to be.
    for (let n = 1; n <= 2; n += 1) {
      expect(
        (await seedCall(rig, await fresh(), { risks: [READ], args: { n } })).result.outcome,
      ).toBe('allowed');
    }
    const tokensBefore = await rig.root.store.missions.listTokens(mission.id);
    const expiry = new Date(Date.now() + 7 * 86_400_000).toISOString();

    const body = await edited((draft) => {
      const github = githubLine(draft);
      return {
        ...draft,
        name: 'Ship the billing page, and the invoices',
        expires_at: expiry,
        connections: [
          {
            ...github,
            resources: { scope: 'selected', resource_ids: [resourceId('acme/web')] },
            policy: [
              {
                risk_id: READ,
                quota: 9,
                rate_limit: { max: 20, window_seconds: 120 },
                gate: 'auto',
              },
              {
                risk_id: PR,
                quota: 2,
                rate_limit: { max: 50, window_seconds: 60 },
                gate: 'approval',
              },
              {
                risk_id: 'github.comment-write',
                quota: 3,
                rate_limit: { max: 5, window_seconds: 60 },
                gate: 'auto',
              },
            ],
          },
          {
            connection_id: rig.seeded.supabase.connection.id,
            resources: { scope: 'all' },
            policy: [
              { risk_id: SUPABASE_READ, quota: 10, rate_limit: { max: 10, window_seconds: 60 } },
            ],
          },
        ],
      };
    });
    const result = await service().edit(rig.seeded.ada, mission.id, body);
    expect(result).toMatchObject({ ok: true, requests_closed: [] });

    const after = await fresh();
    expect(after.name).toBe('Ship the billing page, and the invoices');
    expect(after.expiresAt).toBe(expiry);
    expect(after.periodSeconds).toBe(mission.periodSeconds);
    expect(after.connections.map((c) => c.connectionId).sort()).toEqual(
      [rig.seeded.github.connection.id, rig.seeded.supabase.connection.id].sort(),
    );
    expect(
      after.connections.find((c) => c.connectionId === rig.seeded.github.connection.id),
    ).toEqual({
      connectionId: rig.seeded.github.connection.id,
      resourceScope: 'selected',
      resourceIds: [resourceId('acme/web')],
      // Added by the edit (ADR created-resources-join-the-mission's `source` column).
      resourceSources: { [resourceId('acme/web')]: 'edit' },
    });
    const policy = new Map(budgetMissionOf(after).policy.map((p) => [p.risk_id, p]));
    expect(policy.get(READ)).toEqual({
      risk_id: READ,
      quota: 9,
      rate_limit: { max: 20, window_seconds: 120 },
      gate: 'auto',
    });
    expect(policy.get(PR)?.gate).toBe('approval');
    expect(policy.has(MERGE)).toBe(false);
    expect(policy.get('github.comment-write')?.quota).toBe(3);
    expect(policy.get(SUPABASE_READ)?.quota).toBe(10);

    // Same keys; what was used stays used (2 of the new 9).
    expect(await rig.root.store.missions.listTokens(mission.id)).toEqual(tokensBefore);
    const next = await seedCall(rig, after, { risks: [READ], args: { n: 3 } });
    expect(next.result).toMatchObject({ outcome: 'allowed', remaining: { [READ]: 6 } });

    // One audit entry, each section that moved before and after.
    const [entry, ...others] = await audits();
    expect(others).toEqual([]);
    expect(entry?.before).toMatchObject({
      name: 'Ship the billing page',
      expires_at: null,
      connections: [rig.seeded.github.connection.id],
      resources: [
        {
          connection_id: rig.seeded.github.connection.id,
          resource_scope: 'selected',
          resource_ids: [resourceId('acme/app')],
        },
      ],
    });
    expect(entry?.after).toMatchObject({
      name: 'Ship the billing page, and the invoices',
      expires_at: expiry,
      requests_closed: [],
    });
    const beforeIds = (entry?.before as { permissions: MissionPolicyEntry[] }).permissions.map(
      (p) => p.risk_id,
    );
    const afterIds = (entry?.after as { permissions: MissionPolicyEntry[] }).permissions.map(
      (p) => p.risk_id,
    );
    expect(beforeIds.sort()).toEqual([MERGE, PR, READ].sort());
    expect(afterIds.sort()).toEqual(['github.comment-write', PR, READ, SUPABASE_READ].sort());

    // Session events: one per risk that moved, and the summary the activity words.
    const kinds = (await events()).map((e) => [e.kind, e.riskId]);
    expect(kinds).toEqual(
      expect.arrayContaining([
        ['permission-removed', MERGE],
        ['permission-added', 'github.comment-write'],
        ['permission-added', SUPABASE_READ],
        ['limits-changed', READ],
        ['gate-changed', PR],
        ['mission-changed', null],
      ]),
    );
    const summary = (await events()).find((e) => e.kind === 'mission-changed');
    const activity = await rig.root.audit.sessions.get(rig.seeded.ada, mission.id);
    const worded = activity?.events.find((e) => e.kind === 'mission-changed');
    expect(summary).toBeDefined();
    expect(worded?.mission_change).toEqual(
      expect.arrayContaining([
        'renamed',
        '1 account added',
        // acme/web, and the two projects of the Supabase account added whole.
        '3 resources added',
        '1 resource removed',
        '2 permissions added',
        '1 permission removed',
        `quota of ${READ} 5 → 9`,
        `rate of ${READ} 50/60s → 20/120s`,
        `${PR} now asks first`,
      ]),
    );
  });

  it('refuses with the very issue a creation gets, and judges only what moves', async () => {
    const body = await edited((draft) => {
      const github = githubLine(draft);
      return {
        ...draft,
        connections: [
          {
            ...github,
            policy: (github.policy ?? []).map((p) => (p.risk_id === READ ? { ...p, quota: 0 } : p)),
          },
        ],
      };
    });
    const result = await service().edit(rig.seeded.ada, mission.id, body);
    expect(result.ok).toBe(false);
    if (result.ok || result.reason !== 'refused') throw new Error(JSON.stringify(result));
    const creation = await service().preview(rig.seeded.ada, body.draft);
    expect(result.issues).toEqual(creation.issues.filter((i) => i.code === 'invalid-budget'));
    expect(result.issues.map((i) => i.message)).toEqual([
      `${READ}: quota must be a whole number of at least 1.`,
    ]);
    expect(await audits()).toEqual([]);

    // acme/app goes stale at the provider: a creation would refuse it, a lowered limit is not.
    agePastStaleGrace(rig.root.store, rig.seeded.github.connection.id); // past the grace of a fresh row
    await rig.root.store.connections.syncDiscoveredResources(rig.seeded.github.connection.id, [
      { ref: 'acme/web', displayName: 'acme/web', env: null },
      { ref: 'acme/infra', displayName: 'acme/infra', env: null },
    ]);
    const lower = await edited((draft) => {
      const github = githubLine(draft);
      return {
        ...draft,
        connections: [
          {
            ...github,
            policy: (github.policy ?? []).map((p) => (p.risk_id === READ ? { ...p, quota: 3 } : p)),
          },
        ],
      };
    });
    expect(
      (await service().preview(rig.seeded.ada, lower.draft)).issues.map((i) => i.code),
    ).toContain('resource-stale');
    expect(await service().edit(rig.seeded.ada, mission.id, lower)).toMatchObject({ ok: true });
    const after = await fresh();
    // The stale resource stays where it was: it comes back if discovery returns it.
    expect(after.connections[0]?.resourceIds).toEqual([resourceId('acme/app')]);
    expect(after.policy.find((p) => p.riskId === READ)?.quota).toBe(3);

    // Moved to acme/web; adding the stale acme/app back is judged, with the creation's words.
    const select = (ids: string[]) =>
      edited((draft) => ({
        ...draft,
        connections: [
          { ...githubLine(draft), resources: { scope: 'selected', resource_ids: ids } },
        ],
      }));
    expect(
      await service().edit(rig.seeded.ada, mission.id, await select([resourceId('acme/web')])),
    ).toMatchObject({ ok: true });
    const back = await select([resourceId('acme/web'), resourceId('acme/app')]);
    const staleRefusal = await service().edit(rig.seeded.ada, mission.id, back);
    const staleCreation = await service().preview(rig.seeded.ada, back.draft);
    expect(staleRefusal).toMatchObject({ ok: false, reason: 'refused' });
    expect(
      staleRefusal.ok === false && staleRefusal.reason === 'refused' ? staleRefusal.issues : [],
    ).toEqual(staleCreation.issues.filter((i) => i.code === 'resource-stale'));
  });

  it('never moves the period; a stale revision is a conflict and writes nothing', async () => {
    const period = await edited((draft) => ({
      ...draft,
      period: { kind: 'recurring', length_seconds: 3600 },
    }));
    const refused = await service().edit(rig.seeded.ada, mission.id, period);
    expect(refused).toMatchObject({
      ok: false,
      reason: 'refused',
      issues: [{ code: 'period-not-editable' }],
    });

    const stale = await edited((draft) => ({ ...draft, name: 'First' }));
    expect(await service().edit(rig.seeded.ada, mission.id, stale)).toMatchObject({ ok: true });
    const again = { ...stale, draft: { ...stale.draft, name: 'Second' } };
    expect(await service().edit(rig.seeded.ada, mission.id, again)).toEqual({
      ok: false,
      reason: 'conflict',
    });
    expect((await fresh()).name).toBe('First');
  });

  it('writes nothing when nothing moves', async () => {
    const same = await edited((draft) => draft);
    expect(await service().edit(rig.seeded.ada, mission.id, same)).toMatchObject({ ok: true });
    expect(await audits()).toEqual([]);
    expect((await fresh()).updatedAt).toBe(mission.updatedAt);
  });

  it('keeps the trust levels the form recorded, known macro-actions only, and an edit moves them', async () => {
    const base = githubLine(githubDraft(rig));
    const recorded = await issueMission(
      rig,
      rig.seeded.ada,
      githubDraft(rig, {
        connections: [
          { ...base, trust_levels: { read: 'trusting', 'no-such-action': 'autonomous' } },
        ],
      }),
    );
    const stored = await rig.root.store.missions.getById(recorded.id);
    expect(stored?.connections[0]?.trustLevels).toEqual({ read: 'trusting' });

    const current = await service().editView(rig.seeded.ada, recorded.id);
    if (!current) throw new Error('no edit view');
    expect(githubLine(current.draft).trust_levels).toEqual({ read: 'trusting' });
    const line = githubLine(current.draft);
    const draft: MissionDraft = {
      ...current.draft,
      connections: [
        {
          ...line,
          trust_levels: { read: 'autonomous' },
          policy: (line.policy ?? []).map((p) => (p.risk_id === READ ? { ...p, quota: 6 } : p)),
        },
      ],
    };
    expect(
      await service().edit(rig.seeded.ada, recorded.id, { draft, revision: current.revision }),
    ).toMatchObject({ ok: true });
    const after = await rig.root.store.missions.getById(recorded.id);
    expect(after?.connections[0]?.trustLevels).toEqual({ read: 'autonomous' });
  });

  it('is the creator’s alone; a revoked mission is not edited, an expired one is and comes back', async () => {
    const body = await edited((draft) => ({ ...draft, name: 'Not yours' }));
    expect(await service().edit(rig.seeded.bob, mission.id, body)).toEqual({
      ok: false,
      reason: 'not-found',
    });
    expect(await service().edit(rig.operator, mission.id, body)).toEqual({
      ok: false,
      reason: 'not-found',
    });
    expect(await service().editView(rig.seeded.bob, mission.id)).toBeNull();

    // Expired: edited, and an end moved into the future brings it back.
    await rig.root.store.missions.setExpiresAt(
      mission.id,
      new Date(Date.now() - 1000).toISOString(),
    );
    await rig.root.store.missions.setStatus(mission.id, 'expired');
    const later = new Date(Date.now() + 86_400_000).toISOString();
    const revive = await edited((draft) => ({ ...draft, expires_at: later }));
    expect(await service().edit(rig.seeded.ada, mission.id, revive)).toMatchObject({ ok: true });
    expect(await fresh()).toMatchObject({ status: 'active', expiresAt: later, closedAt: null });

    await service().revoke(rig.seeded.ada, mission.id);
    const revoked = await edited((draft) => ({ ...draft, name: 'Too late' }));
    expect(await service().edit(rig.seeded.ada, mission.id, revoked)).toEqual({
      ok: false,
      reason: 'inactive',
      state: 'revoked',
    });
  });

  it('closes the claims and approval requests about a removed permission, and only those', async () => {
    // A claim on READ (quota 5 spent) and an approval request on MERGE.
    for (let n = 1; n <= 5; n += 1)
      await seedCall(rig, await fresh(), { risks: [READ], args: { n } });
    const claim = await seedCall(rig, await fresh(), { risks: [READ], args: { n: 6 } });
    const approval = await seedCall(rig, await fresh(), { tool: 'github__merge', risks: [MERGE] });
    expect(claim.result.outcome).toBe('refused');
    expect(approval.result.outcome).toBe('refused');
    const claimId = claim.result.outcome === 'refused' ? claim.result.request_id : null;
    const approvalId = approval.result.outcome === 'refused' ? approval.result.request_id : null;

    const body = await edited((draft) => {
      const github = githubLine(draft);
      return {
        ...draft,
        connections: [
          { ...github, policy: (github.policy ?? []).filter((p) => p.risk_id !== MERGE) },
        ],
      };
    });
    const result = await service().edit(rig.seeded.ada, mission.id, body);
    expect(result).toMatchObject({ ok: true, requests_closed: [approvalId] });

    const requests = await rig.root.store.requests.listForMission(mission.id);
    expect(requests.find((r) => r.id === approvalId)).toMatchObject({
      state: 'refused',
      decidedByUserId: rig.seeded.ada.id,
      decision: { resolution: 'mission-changed', removed: [MERGE] },
      hasArguments: false,
    });
    expect(requests.find((r) => r.id === claimId)?.state).toBe('open');
    const [entry] = await audits();
    expect(entry?.after).toMatchObject({ requests_closed: [approvalId] });
    const closed = (await events()).find(
      (e) =>
        e.kind === 'request' &&
        (e.details as { request_id?: string; state?: string } | null)?.request_id === approvalId &&
        (e.details as { state?: string } | null)?.state !== undefined,
    );
    expect(closed?.details).toMatchObject({ state: 'refused', reason: 'mission-changed' });

    // A call loaded before the edit, touching the removed permission, fails closed.
    await expect(
      seedCall(rig, mission, { tool: 'github__merge', risks: [MERGE] }),
    ).rejects.toThrow();
  });

  it('answers over HTTP: 200 with the changes, 409 on a conflict, 422 with the issues', async () => {
    const headers = await sessionHeaders(rig.root, rig.seeded.ada);
    const post = (body: unknown) =>
      rig.root.missions.handlers.edit(
        new Request(`https://gateway.example.com/api/missions/${mission.id}/edit`, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
        }),
        mission.id,
      );
    const body = await edited((draft) => ({ ...draft, name: 'Over HTTP' }));
    const ok = await post(body);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({
      changes: { name: { before: 'Ship the billing page', after: 'Over HTTP' } },
    });
    expect((await post(body)).status).toBe(409);
    const refused = await edited((draft) => ({ ...draft, name: '' }));
    const answer = await post(refused);
    expect(answer.status).toBe(422);
    expect(await answer.json()).toMatchObject({
      error: 'refused',
      issues: [{ code: 'name-missing' }],
    });
    expect((await post({ draft: refused.draft })).status).toBe(400);
  });
});

describe('an edited mission at the execution door', () => {
  let rig: ExecutionInstance;
  beforeEach(async () => {
    rig = await executionInstance();
  });
  afterEach(async () => {
    await rig.close();
  });

  it('reaches an added resource and refuses a removed one from the next call, same token', async () => {
    const issued = await rig.issue({ policy: [line('depot.read', 10)], spaces: ['app-staging'] });
    expect(
      (await rig.call(issued, 'depot__read_item', { space: 'app-staging' })).error,
    ).toBeUndefined();
    expect((await rig.call(issued, 'depot__read_item', { space: 'scratch' })).error).toBeDefined();

    const service = rig.root.missions.service;
    const view = await service.editView(rig.ada, issued.mission.id);
    if (!view) throw new Error('no edit view');
    const scratch = rig.resources.find((r) => r.ref === 'scratch');
    const [depot] = view.draft.connections;
    if (!scratch || !depot) throw new Error('fixture');
    const result = await service.edit(rig.ada, issued.mission.id, {
      revision: view.revision,
      draft: {
        ...view.draft,
        connections: [{ ...depot, resources: { scope: 'selected', resource_ids: [scratch.id] } }],
      },
    });
    expect(result).toMatchObject({ ok: true });

    expect(
      (await rig.call(issued, 'depot__read_item', { space: 'scratch' })).error,
    ).toBeUndefined();
    const refused = await rig.call(issued, 'depot__read_item', { space: 'app-staging' });
    expect(refused.error).toBeDefined();
    // The counter carried on: two reads allowed in all, on one session.
    const stored = await rig.root.store.missions.getById(issued.mission.id);
    const session = await rig.root.store.sessions.getByMission(issued.mission.id);
    if (!stored || !session) throw new Error('fixture');
    const counters = await rig.root.store.sessions.counters(session.id);
    expect(counters.reduce((n, c) => n + c.consumed, 0)).toBe(2);
  });
});
