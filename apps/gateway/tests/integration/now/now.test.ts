/**
 * The read models of the home and of "Waiting for you" over the real root
 * (handbook web-app, "The home — Now"; handbook requests, "Who asked"):
 *
 *   - `RequestService.waiting` / `answered` and the `asker` of a view — who asked,
 *     with what, what is left — for the creator and nobody else;
 *   - `readNow` — what waits, what runs, what stopped, the counts, the first run;
 *   - `readSetup` — the checklist of an administrator.
 *
 * Read-only: nothing here writes, and none of it opens the arguments of a call.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { nowDepsOf, readNow, readSetup, setupDepsOf, type NowView } from '../../../src/server/now';
import type { MissionRecord, UserRecord } from '../../../src/server/store/types';
import {
  ARGUMENT_MARKER,
  githubDraft,
  issueMission,
  MERGE,
  openAuditRig,
  PR,
  seedCall,
  seedDayOfWork,
  type OperatorRig,
} from '../audit/support';

const HOUR_MS = 3_600_000;

describe('the home and the inbox: read models', () => {
  let rig: OperatorRig;
  let ada: UserRecord;
  let bob: UserRecord;

  beforeEach(async () => {
    rig = await openAuditRig();
    ({ ada, bob } = rig.seeded);
  });
  afterEach(async () => {
    await rig.root.close();
  });

  const now = (user: UserRecord): Promise<NowView> =>
    readNow(nowDepsOf(rig.root), { user, groups: [] });

  async function withBobAsMember(mission: MissionRecord): Promise<void> {
    const added = await rig.root.missions.team.addMember(ada, mission.id, { email: bob.email });
    if (!added.ok) throw new Error('could not add Bob');
  }

  describe('RequestService.waiting', () => {
    it('names who asked — the holder of the key, and the label of the agent — and what is left', async () => {
      const mission = await issueMission(rig);
      await withBobAsMember(mission);
      const bobsKey = { token_id: 'bobs-key', token_kind: 'member', holder: bob.id } as const;
      const pr = { tool: 'github__create_pull_request', risks: [PR] } as const;
      await seedCall(rig, mission, pr);
      await seedCall(rig, mission, pr);
      const refused = await seedCall(rig, mission, { ...pr, token: bobsKey, agentLabel: 'codex' });
      // A replay while the request is open is refused again and points to the same request.
      await seedCall(rig, mission, { ...pr, token: bobsKey, agentLabel: 'codex' });
      if (refused.result.outcome !== 'refused') throw new Error('expected a refusal');

      const [item, ...others] = await rig.root.requests.service.waiting(ada);
      expect(others).toEqual([]);
      expect(item?.request).toMatchObject({
        id: refused.result.request_id,
        kind: 'claim',
        state: 'open',
        mission: { id: mission.id, name: mission.name },
      });
      expect(item?.asker).toEqual({
        token_kind: 'member',
        user_id: bob.id,
        // The display name the identity provider gave, not the id the event stores.
        holder: 'Bob',
        agent_label: 'codex',
        tool: 'github__create_pull_request',
        refused_calls: 2,
      });
      expect(item?.budget).toHaveLength(1);
      expect(item?.budget[0]).toMatchObject({ risk_id: PR, quota: 2, consumed: 2, remaining: 0 });
      expect(item?.period_seconds).toBe(86_400);
    });

    it('a machine key is named by its name, and an approval lists every permission it covers', async () => {
      const mission = await issueMission(rig);
      const ci = { token_id: 'ci-key', token_kind: 'named', holder: 'nightly' } as const;
      await seedCall(rig, mission, {
        tool: 'github__merge_pull_request',
        risks: [MERGE],
        args: { pull_number: 12, note: ARGUMENT_MARKER },
        token: ci,
      });
      const [item] = await rig.root.requests.service.waiting(ada);
      expect(item?.request.kind).toBe('approval');
      expect(item?.asker).toMatchObject({
        token_kind: 'named',
        user_id: null,
        holder: 'nightly',
        agent_label: null,
        tool: 'github__merge_pull_request',
      });
      expect(item?.budget.map((line) => [line.risk_id, line.remaining])).toEqual([[MERGE, 2]]);
      // The list never carries the arguments of a call.
      expect(JSON.stringify(item)).not.toContain(ARGUMENT_MARKER);
      // What a page heads the request with: what the tool does, in the plugin's words,
      // and the resource the refused call resolved to — read from its audit entry.
      expect(item?.request.call).toEqual({
        tool: 'github__merge_pull_request',
        title: 'Merge a pull request',
        resource: 'acme/app',
      });
      const view = await rig.root.requests.service.view(ada, item?.request.id ?? '');
      expect(view.outcome === 'ok' && view.view.request.call).toEqual(item?.request.call);
      // The inbox of the mission page reads the same head.
      const [listed] = await rig.root.requests.service.inbox(ada);
      expect(listed?.call).toEqual(item?.request.call);
    });

    it('a limit that was reached is about a permission, not a call: it has no call to head it', async () => {
      const mission = await issueMission(rig);
      const pr = { tool: 'github__create_pull_request', risks: [PR] } as const;
      for (let i = 0; i < 3; i++) await seedCall(rig, mission, pr);
      const [item] = await rig.root.requests.service.waiting(ada);
      expect(item?.request).toMatchObject({ kind: 'claim', call: null });
    });

    it('is the creator’s: a member of the mission and an administrator get nothing', async () => {
      const day = await seedDayOfWork(rig);
      const mission = await rig.root.store.missions.getById(day.mission_id);
      if (!mission) throw new Error('no mission');
      await withBobAsMember(mission);
      expect(await rig.root.requests.service.waiting(ada)).toHaveLength(2);
      expect(await rig.root.requests.service.waiting(bob)).toEqual([]);
      expect(await rig.root.requests.service.waiting(rig.operator)).toEqual([]);
    });

    it('the view of one request names the asker too', async () => {
      const day = await seedDayOfWork(rig);
      const claim = await rig.root.requests.service.view(ada, day.claim_id);
      const approval = await rig.root.requests.service.view(ada, day.approval_id);
      if (claim.outcome !== 'ok' || approval.outcome !== 'ok') throw new Error('expected views');
      expect(claim.view.asker).toMatchObject({
        holder: 'Ada',
        agent_label: 'coder',
        tool: 'github__create_pull_request',
        refused_calls: 1,
      });
      expect(approval.view.asker).toMatchObject({ holder: 'Ada', agent_label: 'coder' });
      expect(claim.view.mission.period_seconds).toBe(86_400);
    });
  });

  describe('RequestService.answered', () => {
    it('lists what the creator answered since an instant, and nothing still open', async () => {
      const day = await seedDayOfWork(rig);
      const { service } = rig.root.requests;
      const since = new Date(Date.now() - HOUR_MS);
      expect(await service.answered(ada, since)).toEqual([]);

      await service.decide(ada, day.claim_id, { resolution: 'refuse' });
      await service.decide(ada, day.approval_id, { resolution: 'grant' });
      const answered = await service.answered(ada, since);
      expect(answered.map((request) => `${request.id} ${request.state}`).sort()).toEqual(
        [`${day.approval_id} granted`, `${day.claim_id} refused`].sort(),
      );
      // Not before the instant asked for, and never someone else's.
      expect(await service.answered(ada, new Date(Date.now() + HOUR_MS))).toEqual([]);
      expect(await service.answered(bob, since)).toEqual([]);
    });
  });

  describe('readNow', () => {
    it('a person who created nothing is on their first run, with what they were given', async () => {
      const view = await now(bob);
      expect(view.first_run).toBe(true);
      expect(view).toMatchObject({ waiting: [], running: [], stopped: [], shared_missions: [] });
      expect(view.totals).toEqual({
        missions: 0,
        stopped: 0,
        calls_last_day: 0,
        refused_last_hour: 0,
        accounts: 0,
        accounts_to_reconnect: 0,
      });

      // Ada owns the four seeded accounts and has no mission yet either.
      const adas = await now(ada);
      expect(adas.first_run).toBe(true);
      expect(adas.totals.accounts).toBe(4);
    });

    it('lists what waits, what runs with its keys and its nearest limit, and counts the calls', async () => {
      const day = await seedDayOfWork(rig);
      const quiet = await issueMission(rig, ada, githubDraft(rig, { name: 'Quiet mission' }));
      const view = await now(ada);

      expect(view.first_run).toBe(false);
      expect(view.waiting.map((item) => item.request.id).sort()).toEqual(
        [day.claim_id, day.approval_id].sort(),
      );
      // The mission that was called comes first; the one nobody called yet after it.
      expect(view.running.map((mission) => mission.name)).toEqual([
        'A day of work',
        'Quiet mission',
      ]);
      const [busy, idle] = view.running;
      expect(busy).toMatchObject({
        id: day.mission_id,
        role: 'creator',
        creator: null,
        services: ['GitHub'],
        holders: [{ kind: 'member', label: 'Ada', you: true }],
        issued_via: null,
        // Two pull requests of two: the permission at its limit is the nearest one.
        nearest: { risk_id: PR, used: 2, limit: 2 },
        limits_reached: 1,
        open_requests: 2,
        calls_last_day: 6,
      });
      expect(busy?.last_activity_at).not.toBeNull();
      expect(idle).toMatchObject({
        id: quiet.id,
        // Nothing used: no permission is near its limit.
        nearest: { used: 0 },
        limits_reached: 0,
        open_requests: 0,
        last_activity_at: null,
        calls_last_day: 0,
      });
      expect(view.totals).toMatchObject({
        missions: 2,
        stopped: 0,
        calls_last_day: 6,
        refused_last_hour: 2,
        accounts: 4,
      });
      // Nothing of a call's arguments reaches the home.
      expect(JSON.stringify(view)).not.toContain(ARGUMENT_MARKER);
    });

    it('a calls count is the last 24 hours and a refusal count the last hour', async () => {
      const mission = await issueMission(rig);
      const at = (hoursAgo: number): Date => new Date(Date.now() - hoursAgo * HOUR_MS);
      const pr = { tool: 'github__create_pull_request', risks: [PR] } as const;
      await seedCall(rig, mission, { now: at(30) });
      await seedCall(rig, mission, { ...pr, now: at(5) });
      await seedCall(rig, mission, { ...pr, now: at(4) });
      // Refused three hours ago: counted in the day, not in the hour.
      const refused = await seedCall(rig, mission, { ...pr, now: at(3) });
      expect(refused.result.outcome).toBe('refused');
      const view = await now(ada);
      expect(view.totals).toMatchObject({ calls_last_day: 3, refused_last_hour: 0 });
    });

    it('a teammate sees the mission shared with them, that it waits, and none of its requests', async () => {
      const day = await seedDayOfWork(rig);
      const mission = await rig.root.store.missions.getById(day.mission_id);
      if (!mission) throw new Error('no mission');
      await withBobAsMember(mission);

      const view = await now(bob);
      // Bob created nothing: his home still starts with the steps.
      expect(view.first_run).toBe(true);
      expect(view.waiting).toEqual([]);
      expect(view.shared_missions).toEqual([
        {
          id: day.mission_id,
          name: 'A day of work',
          creator: 'Ada',
          services: ['GitHub'],
          has_key: false,
          running: true,
        },
      ]);
      expect(view.running).toHaveLength(1);
      expect(view.running[0]).toMatchObject({
        role: 'member',
        creator: 'Ada',
        open_requests: 2,
        holders: [{ kind: 'member', label: 'Ada', you: false }],
      });

      const generated = await rig.root.missions.team.generateToken(bob, day.mission_id);
      expect(generated.ok).toBe(true);
      const after = await now(bob);
      expect(after.shared_missions[0]?.has_key).toBe(true);
      // His own key first.
      expect(after.running[0]?.holders.map((holder) => [holder.label, holder.you])).toEqual([
        ['Bob', true],
        ['Ada', false],
      ]);
    });

    it('a mission that does not run any more is named apart, with its state', async () => {
      const stopped = await issueMission(rig, ada, githubDraft(rig, { name: 'Stopped' }));
      await issueMission(rig, ada, githubDraft(rig, { name: 'Running' }));
      const revoked = await rig.root.missions.service.revoke(ada, stopped.id);
      expect(revoked.ok).toBe(true);

      const view = await now(ada);
      expect(view.running.map((mission) => mission.name)).toEqual(['Running']);
      expect(view.stopped).toMatchObject([{ id: stopped.id, name: 'Stopped', state: 'revoked' }]);
      expect(view.totals).toMatchObject({ missions: 2, stopped: 1 });
    });
  });

  describe('readSetup', () => {
    it('says what is configured: the sign-in, the company apps, telemetry', async () => {
      const setup = await readSetup(setupDepsOf(rig.root));
      // Every service that needs an app of the company is in one list or another; one that
      // also connects with a token is optional, never missing.
      const apps = await rig.root.providerApps.list();
      const needing = apps.filter((app) => app.needsApp);
      expect(
        [
          ...setup.company_apps.registered,
          ...setup.company_apps.missing,
          ...setup.company_apps.optional,
        ].sort(),
      ).toEqual(needing.map((app) => app.displayName).sort());
      const withToken = apps.filter((app) => app.token !== null).map((app) => app.displayName);
      expect(withToken.length).toBeGreaterThan(0);
      expect(setup.company_apps.optional).toEqual(expect.arrayContaining(withToken));
      for (const name of withToken) expect(setup.company_apps.missing).not.toContain(name);
      expect(setup.telemetry).toEqual({ enabled: false, decided: false });
    });
  });
});
