/**
 * What the store gained for the approval gate (spec §3.5; plan §3.6): the decision of an
 * approval request in one transaction, approvals keyed by the tool (migration 0005),
 * the events a gate opening is read from, the gate of a mission's risk, and the audit
 * lookup the creator's view reads the slices from.
 */
import type { CallAuditEntry } from '@vaubaan/gateway-core';
import { parseSlice } from '@vaubaan/policy-engine';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  InvariantError,
  NotFoundError,
  type DecideContext,
  type RequestRecord,
  type Store,
} from '../../../src/server/store/index.ts';
import { openTestStore, refuseRequest, type TestStore } from '../../../src/server/store/testing.ts';

const READ = 'github.code-read';
const WRITE = 'github.write-feature-branch';
const MERGE = 'github.merge-protected';
const PERIOD = '2026-10-13T00:00:00.000Z';
const TOOL = 'github__merge_pull_request';
const ARGS = { pull_number: 7, note: 'in clear for the creator only' };

describe('store: the approval gate', () => {
  let t: TestStore;
  let store: Store;
  let creator: string;
  let missionId: string;

  beforeEach(async () => {
    t = openTestStore();
    store = t.store;
    creator = (await store.users.upsertFromIdp({ subject: 'c', email: 'c@x' })).id;
    const connection = await store.connections.create({
      provider: 'github',
      owner: { kind: 'user', id: creator },
      displayName: 'gh',
      credential: null,
    });
    missionId = (
      await store.missions.create({
        name: 'm',
        creatorUserId: creator,
        periodAnchor: PERIOD,
        periodSeconds: 86_400,
        connections: [{ connectionId: connection.id, resourceScope: 'all', resourceIds: [] }],
        policy: [
          { riskId: READ, quota: 10, rateLimit: 5, rateWindowSeconds: 60, gate: 'auto' },
          { riskId: MERGE, quota: 5, rateLimit: 5, rateWindowSeconds: 60, gate: 'approval' },
        ],
      })
    ).id;
  });
  afterEach(() => store.close());

  async function approvalRequest(
    overrides: { tool?: string; fingerprint?: string; expiresAt?: string } = {},
  ): Promise<RequestRecord> {
    const session = await store.sessions.getOrCreate(missionId);
    return store.requests.create({
      missionId,
      sessionId: session.id,
      kind: 'approval',
      riskId: MERGE,
      tool: overrides.tool ?? TOOL,
      fingerprint: overrides.fingerprint ?? 'fp-1',
      arguments: ARGS,
      expiresAt: overrides.expiresAt ?? '2026-10-14T09:00:00.000Z',
    });
  }

  const blobOf = (id: string) =>
    store.db
      .prepare<
        [string],
        { args_blob: Buffer | null; key_version: number | null }
      >('SELECT args_blob, key_version FROM requests WHERE id = ?')
      .get(id);

  const eventsOf = async () => {
    const session = await store.sessions.getByMission(missionId);
    return session ? store.sessions.listEvents(session.id) : [];
  };

  /** Runs `read` inside a decision transaction that allows nothing. */
  async function inDecision<T>(read: (ctx: DecideContext) => T): Promise<T> {
    let value: T | undefined;
    await store.sessions.decideAndDecrement(
      { missionId, riskIds: [MERGE], periodStart: PERIOD },
      (ctx) => {
        value = read(ctx);
        return { allow: false };
      },
    );
    return value as T;
  }

  // ───────────────────────────────────────────────────────────────────────────

  describe('migration 0005', () => {
    it('adds the tool to the approvals table and to its lookup index', () => {
      const columns = store.db
        .prepare<
          [],
          { name: string; notnull: number; dflt_value: string | null }
        >('SELECT name, "notnull", dflt_value FROM pragma_table_info(\'approvals\')')
        .all();
      expect(columns.find((c) => c.name === 'tool')).toEqual({
        name: 'tool',
        notnull: 1,
        dflt_value: "''",
      });
      const index = store.db
        .prepare<
          [],
          { sql: string }
        >("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'approvals_lookup'")
        .get();
      expect(index?.sql).toContain('(mission_id, risk_id, tool, fingerprint)');
      expect(index?.sql).toContain('consumed_at IS NULL');
    });
  });

  describe('requests.decideApproval', () => {
    it('decides, erases the sealed arguments and writes the approval in one transaction', async () => {
      const request = await approvalRequest();
      expect(blobOf(request.id)?.args_blob).not.toBeNull();

      const result = await store.requests.decideApproval(request.id, creator, (ctx) => {
        expect(ctx.request).toMatchObject({ id: request.id, state: 'open', tool: TOOL });
        expect(ctx.session?.missionId).toBe(missionId);
        expect(ctx.now).toBe(t.clock.now().toISOString());
        const approval = ctx.createApproval('2026-10-13T09:10:00.000Z');
        ctx.recordEvent({
          kind: 'approval',
          riskId: MERGE,
          actorUserId: creator,
          details: {
            request_id: request.id,
            approval_id: approval.id,
            tool: TOOL,
            fingerprint: 'fp-1',
            expires_at: approval.expiresAt,
          },
        });
        return { state: 'granted' as const, decision: { resolution: 'grant' }, approval };
      });

      if (result.status !== 'decided') throw new Error('expected a decision');
      expect(result.request).toMatchObject({
        state: 'granted',
        hasArguments: false,
        decidedByUserId: creator,
        decidedAt: t.clock.now().toISOString(),
        decision: { resolution: 'grant' },
        // What stays: the tool and the fingerprint.
        tool: TOOL,
        fingerprint: 'fp-1',
      });
      expect(blobOf(request.id)).toEqual({ args_blob: null, key_version: null });
      // The approval is bound to the request's own mission, risk, tool and fingerprint.
      expect(result.outcome.approval).toMatchObject({
        missionId,
        requestId: request.id,
        riskId: MERGE,
        tool: TOOL,
        fingerprint: 'fp-1',
        expiresAt: '2026-10-13T09:10:00.000Z',
        consumedAt: null,
      });
      expect(await store.approvals.getByRequest(request.id)).toEqual(result.outcome.approval);
      expect((await eventsOf()).map((e) => e.kind)).toEqual(['approval']);
    });

    it('a thrown apply writes nothing: no approval, no event, the arguments stay sealed', async () => {
      const request = await approvalRequest();
      await expect(
        store.requests.decideApproval(request.id, creator, (ctx) => {
          ctx.createApproval('2026-10-13T09:10:00.000Z');
          ctx.recordEvent({
            kind: 'request',
            riskId: MERGE,
            details: { request_id: request.id, request_kind: 'approval', state: 'refused' },
          });
          throw new Error('the rules said no');
        }),
      ).rejects.toThrow('the rules said no');
      expect(await store.requests.getById(request.id)).toMatchObject({
        state: 'open',
        hasArguments: true,
        decidedAt: null,
      });
      expect(await store.requests.getArguments(request.id)).toEqual(ARGS);
      expect(await store.approvals.getByRequest(request.id)).toBeNull();
      expect(await eventsOf()).toEqual([]);
    });

    it('a request already decided is not decided again, and apply does not run', async () => {
      const request = await approvalRequest();
      await refuseRequest(store, request.id, creator);
      let ran = false;
      const result = await store.requests.decideApproval(request.id, creator, () => {
        ran = true;
        return { state: 'granted' as const, decision: {} };
      });
      expect(result).toMatchObject({ status: 'not-open', request: { state: 'refused' } });
      expect(ran).toBe(false);
    });

    it('an overdue request is expired right there: blob erased, event recorded, apply not run', async () => {
      const request = await approvalRequest({ expiresAt: '2026-10-13T09:30:00.000Z' });
      t.clock.set('2026-10-13T09:30:00.000Z');
      let ran = false;
      const result = await store.requests.decideApproval(request.id, creator, () => {
        ran = true;
        return { state: 'granted' as const, decision: {} };
      });
      expect(result).toMatchObject({ status: 'not-open', request: { state: 'expired' } });
      expect(ran).toBe(false);
      expect(blobOf(request.id)).toEqual({ args_blob: null, key_version: null });
      expect((await eventsOf()).at(-1)).toMatchObject({
        kind: 'request',
        details: { request_id: request.id, request_kind: 'approval', state: 'expired' },
      });
    });

    it('refuses a claim, and an unknown request', async () => {
      const claim = await store.requests.create({
        missionId,
        kind: 'claim',
        riskId: READ,
        expiresAt: '2026-10-14T09:00:00.000Z',
      });
      const grant = () => ({ state: 'granted' as const, decision: {} });
      await expect(store.requests.decideApproval(claim.id, creator, grant)).rejects.toBeInstanceOf(
        InvariantError,
      );
      await expect(store.requests.decideApproval('missing', creator, grant)).rejects.toBeInstanceOf(
        NotFoundError,
      );
      expect((await store.requests.getById(claim.id))?.state).toBe('open');
    });
  });

  describe('requests.getArguments', () => {
    it('opens the arguments of an open request only, even before the sweeper ran', async () => {
      const request = await approvalRequest({ expiresAt: '2026-10-13T09:30:00.000Z' });
      expect(await store.requests.getArguments(request.id)).toEqual(ARGS);
      t.clock.set('2026-10-13T09:29:59.999Z');
      expect(await store.requests.getArguments(request.id)).toEqual(ARGS);
      // Overdue: the blob is still in the row, and it is not opened.
      t.clock.set('2026-10-13T09:30:00.000Z');
      expect(blobOf(request.id)?.args_blob).not.toBeNull();
      expect(await store.requests.getArguments(request.id)).toBeNull();
      expect(await store.requests.sweepExpired()).toHaveLength(1);
      expect(blobOf(request.id)).toEqual({ args_blob: null, key_version: null });
      expect(await store.requests.getArguments(request.id)).toBeNull();
    });
  });

  describe('the open request of a call', () => {
    it('an approval request is found by its risk, tool and fingerprint', async () => {
      const request = await approvalRequest();
      const found = await inDecision((ctx) => ({
        same: ctx.findOpenRequest({
          kind: 'approval',
          riskId: MERGE,
          tool: TOOL,
          fingerprint: 'fp-1',
        }),
        otherTool: ctx.findOpenRequest({
          kind: 'approval',
          riskId: MERGE,
          tool: 'github__delete_branch',
          fingerprint: 'fp-1',
        }),
        otherArguments: ctx.findOpenRequest({
          kind: 'approval',
          riskId: MERGE,
          tool: TOOL,
          fingerprint: 'fp-2',
        }),
        otherRisk: ctx.findOpenRequest({
          kind: 'approval',
          riskId: READ,
          tool: TOOL,
          fingerprint: 'fp-1',
        }),
        // A claim lookup never returns an approval request.
        claim: ctx.findOpenRequest({ kind: 'claim', riskId: MERGE }),
      }));
      expect(found.same?.id).toBe(request.id);
      expect(found.otherTool).toBeNull();
      expect(found.otherArguments).toBeNull();
      expect(found.otherRisk).toBeNull();
      expect(found.claim).toBeNull();
    });

    it('an approval lookup without a tool or a fingerprint is a bug, not a broad match', async () => {
      await approvalRequest();
      await expect(
        inDecision((ctx) =>
          ctx.findOpenRequest({ kind: 'approval', riskId: MERGE, fingerprint: 'fp-1' }),
        ),
      ).rejects.toBeInstanceOf(InvariantError);
      await expect(
        inDecision((ctx) => ctx.findOpenRequest({ kind: 'approval', riskId: MERGE, tool: TOOL })),
      ).rejects.toBeInstanceOf(InvariantError);
    });
  });

  describe('riskEvents', () => {
    it('returns the events of the asked kinds and risks since an instant, oldest first', async () => {
      const session = await store.sessions.getOrCreate(missionId);
      const record = async (ts: string, kind: string, riskId: string | null) => {
        t.clock.set(ts);
        return (await store.sessions.recordEvent(session.id, { kind, riskId, details: { ts } })).id;
      };
      await record('2026-10-12T23:59:59.999Z', 'gate-opened', MERGE); // before `since`
      const opened = await record('2026-10-13T00:00:00.000Z', 'gate-opened', MERGE);
      await record('2026-10-13T08:00:00.000Z', 'gate-opened', READ); // another risk
      await record('2026-10-13T08:30:00.000Z', 'call-allowed', MERGE); // another kind
      await record('2026-10-13T08:45:00.000Z', 'gate-opened', null); // no risk
      const changed = await record('2026-10-13T09:00:00.000Z', 'gate-changed', MERGE);

      const query = { kinds: ['gate-opened', 'gate-changed'], riskIds: [MERGE], since: PERIOD };
      const inTransaction = await inDecision((ctx) => ctx.riskEvents(query));
      expect(inTransaction.map((e) => e.id)).toEqual([opened, changed]);
      expect(inTransaction.map((e) => e.kind)).toEqual(['gate-opened', 'gate-changed']);

      // Nothing asked, nothing returned.
      expect(await inDecision((ctx) => ctx.riskEvents({ ...query, kinds: [] }))).toEqual([]);
      expect(await inDecision((ctx) => ctx.riskEvents({ ...query, riskIds: [] }))).toEqual([]);
      // Several risks at once.
      const both = await inDecision((ctx) => ctx.riskEvents({ ...query, riskIds: [MERGE, READ] }));
      expect(both).toHaveLength(3);
    });
  });

  describe('missions.setGate', () => {
    const gateOf = async (riskId: string) =>
      (await store.missions.getById(missionId))?.policy.find((p) => p.riskId === riskId)?.gate;

    it('sets the gate of one risk and leaves the rest of the row alone', async () => {
      const before = await store.missions.getById(missionId);
      t.clock.advance(1_000);
      const changed = await store.missions.setGate(missionId, READ, 'approval', creator);
      expect(changed?.previous).toBe('auto');
      expect(changed?.mission.updatedAt).toBe(t.clock.now().toISOString());
      expect(changed?.mission.policy).toEqual(
        before?.policy.map((p) => (p.riskId === READ ? { ...p, gate: 'approval' } : p)),
      );
      expect(await gateOf(MERGE)).toBe('approval');
      // No session yet: nothing to record on.
      expect(await eventsOf()).toEqual([]);
    });

    it('records gate-changed on the session, in the same transaction', async () => {
      await store.sessions.getOrCreate(missionId);
      await store.missions.setGate(missionId, MERGE, 'auto', creator);
      expect(await eventsOf()).toMatchObject([
        {
          kind: 'gate-changed',
          riskId: MERGE,
          actorUserId: creator,
          details: { gate: 'auto', gate_before: 'approval' },
        },
      ]);
    });

    it('the gate a risk already has: nothing written, nothing recorded', async () => {
      await store.sessions.getOrCreate(missionId);
      const before = await store.missions.getById(missionId);
      t.clock.advance(1_000);
      const same = await store.missions.setGate(missionId, MERGE, 'approval', creator);
      expect(same).toEqual({ mission: before, previous: 'approval', openingClosed: false });
      expect(await eventsOf()).toEqual([]);
    });

    it('`closeOpening` on a gate already `approval`: the event that ends an opening, and nothing else', async () => {
      await store.sessions.getOrCreate(missionId);
      t.clock.advance(1_000);
      const closed = await store.missions.setGate(missionId, MERGE, 'approval', creator, {
        closeOpening: true,
      });
      expect(closed).toMatchObject({ previous: 'approval', openingClosed: true });
      expect((await store.missions.getById(missionId))?.policy).toEqual(
        expect.arrayContaining([expect.objectContaining({ riskId: MERGE, gate: 'approval' })]),
      );
      expect(await eventsOf()).toMatchObject([
        { kind: 'gate-changed', riskId: MERGE, actorUserId: creator },
      ]);
      // It only ever closes: it does nothing to a gate that is `auto`, or being set to `auto`.
      const auto = await store.missions.setGate(missionId, READ, 'auto', creator, {
        closeOpening: true,
      });
      expect(auto).toMatchObject({ previous: 'auto', openingClosed: false });
      expect(await eventsOf()).toHaveLength(1);
    });

    it('a risk outside the policy is null; an unknown mission is a NotFoundError', async () => {
      expect(await store.missions.setGate(missionId, WRITE, 'approval', creator)).toBeNull();
      expect((await store.missions.getById(missionId))?.policy.map((p) => p.riskId)).toEqual([
        READ,
        MERGE,
      ]);
      await expect(
        store.missions.setGate('missing', MERGE, 'auto', creator),
      ).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  describe('audit.latestCall', () => {
    const entry = (ts: string, overrides: Partial<CallAuditEntry> = {}): CallAuditEntry => ({
      kind: 'call',
      ts,
      mission_id: missionId,
      token_id: null,
      token_kind: null,
      token_holder: null,
      session_id: null,
      connection_id: null,
      resource_ref: 'acme/app',
      tool: TOOL,
      arguments_hash: 'fp-1',
      slices_executed: [parseSlice('github.repo[acme/app].branch[main].W')],
      risks_touched: [MERGE, READ],
      accepted_risks_snapshot: [READ, MERGE],
      decision: 'refused',
      refusal_code: 'approval-required',
      refusal_reason: 'asks the creator',
      approval_id: null,
      remaining_budget: null,
      agent_label: null,
      upstream_latency_ms: null,
      upstream_error: null,
      client_ip: null,
      client_user_agent: null,
      ...overrides,
    });
    const lookup = { missionId: '', tool: TOOL, argumentsHash: 'fp-1' };

    it('finds the latest entry of the mission for the tool and the fingerprint', async () => {
      const first = await store.audit.append(entry('2026-10-13T09:00:00.000Z'));
      const replay = await store.audit.append(entry('2026-10-13T09:05:00.000Z'));
      await store.audit.append(entry('2026-10-13T09:06:00.000Z', { arguments_hash: 'fp-2' }));
      await store.audit.append(
        entry('2026-10-13T09:07:00.000Z', { tool: 'github__delete_branch' }),
      );
      const allowed = await store.audit.append(
        entry('2026-10-13T09:08:00.000Z', {
          decision: 'allowed',
          refusal_code: null,
          refusal_reason: null,
          remaining_budget: { [MERGE]: 4, [READ]: 9 },
        }),
      );

      const query = { ...lookup, missionId };
      expect((await store.audit.latestCall(query))?.id).toBe(allowed.id);
      const refused = await store.audit.latestCall({ ...query, refusalCode: 'approval-required' });
      expect(refused?.id).toBe(replay.id);
      expect(refused?.id).not.toBe(first.id);
      expect(refused).toMatchObject({
        kind: 'call',
        risks_touched: [READ, MERGE],
        slices_executed: [parseSlice('github.repo[acme/app].branch[main].W')],
      });
    });

    it('answers null for another mission, another tool, another fingerprint or another refusal', async () => {
      await store.audit.append(entry('2026-10-13T09:00:00.000Z'));
      const query = { ...lookup, missionId };
      expect(await store.audit.latestCall({ ...query, missionId: 'another' })).toBeNull();
      expect(await store.audit.latestCall({ ...query, tool: 'github__get_file' })).toBeNull();
      expect(await store.audit.latestCall({ ...query, argumentsHash: 'fp-9' })).toBeNull();
      expect(
        await store.audit.latestCall({ ...query, refusalCode: 'budget-exhausted' }),
      ).toBeNull();
    });
  });
});
