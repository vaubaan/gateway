/**
 * The approval gate, end to end over the embedded store with a manual clock (spec §3.5,
 * §7.7, §10 "approval": binding to the exact argument fingerprint, single use, expiry,
 * whole refusal of a multi-risk call, gate opening bounded to the period, erasure of
 * arguments after decision; "integration: approval and replay").
 *
 * The executor's side is the budget's `SessionService.recordCall` (what the execution
 * door runs for every call), the creator's side is the `RequestService`. The store's
 * clock and the calls' `now` are the same manual clock.
 */
import { parseSlice } from '@vaubaan/policy-engine';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  fingerprintArguments,
  type BudgetMission,
  type RecordCallAllowed,
  type RecordCallRefused,
  type RecordCallResult,
} from '../../../src/server/budget/index.ts';
import { alwaysGrounded } from '../../../src/server/authority/testing.ts';
import { createLogger } from '../../../src/server/logging/index.ts';
import {
  RequestService,
  type ApprovalView,
  type DecideResult,
} from '../../../src/server/requests/index.ts';
import type { MissionPolicyEntry as PolicyRecord } from '../../../src/server/store/types.ts';
import {
  APPROVAL_VALIDITY_SECONDS,
  DAY_SECONDS,
  MERGE,
  openBudgetFixture,
  READ,
  REQUEST_EXPIRY_SECONDS,
  WRITE,
  type BudgetFixture,
} from '../budget/fixture.ts';

const PUBLIC_URL = new URL('https://gateway.example.com');
const DAY1 = '2026-10-14T00:00:00.000Z';
const TOOL = 'github__merge_pull_request';
/** Values no page, event, audit entry or log line may carry once the request is closed. */
const SECRET_TITLE = 'ARGUMENT-IN-CLEAR-91c4';
const ARGS = { owner: 'acme', repo: 'app', pull_number: 42, commit_title: SECRET_TITLE };

/** One gated risk with room for several actions, one more gated risk, one ungated. */
const POLICY: readonly PolicyRecord[] = [
  { riskId: READ, quota: 10, rateLimit: 50, rateWindowSeconds: 60, gate: 'auto' },
  { riskId: MERGE, quota: 3, rateLimit: 2, rateWindowSeconds: 60, gate: 'approval' },
  { riskId: WRITE, quota: 5, rateLimit: 50, rateWindowSeconds: 60, gate: 'approval' },
];

interface StoredRequest {
  args_blob: Buffer | null;
  key_version: number | null;
  state: string;
  decision_json: string | null;
}

describe('approval gate: refusal, decision, replay', () => {
  let f: BudgetFixture;
  let mission: BudgetMission;
  let requests: RequestService;
  let logs: string[];
  const creator = () => ({ id: f.creatorId });

  beforeEach(async () => {
    f = await openBudgetFixture();
    mission = await f.createMission({ periodSeconds: DAY_SECONDS, policy: POLICY });
    logs = [];
    requests = new RequestService({
      store: f.store,
      // No plugin registered: labels fall back to the risk ids.
      registry: { get: () => undefined },
      grounds: alwaysGrounded,
      publicUrl: PUBLIC_URL,
      approvalValiditySeconds: APPROVAL_VALIDITY_SECONDS,
      clock: f.clock,
      logger: createLogger({
        level: 'debug',
        redact: (text) => text,
        write: (_level, text) => logs.push(text),
      }),
    });
  });
  afterEach(() => f.store.close());

  const call = (
    overrides: {
      risks?: readonly string[];
      args?: unknown;
      tool?: string;
      mission?: BudgetMission;
    } = {},
  ) =>
    f.service.recordCall({
      mission: overrides.mission ?? mission,
      tool: overrides.tool ?? TOOL,
      args: overrides.args ?? ARGS,
      risks_touched: overrides.risks ?? [MERGE],
      agent_label: 'builder',
      now: f.clock.now(),
    });

  function refused(result: RecordCallResult): RecordCallRefused & { request_id: string } {
    if (result.outcome !== 'refused') throw new Error('expected a refusal');
    if (!result.request_id) throw new Error(`no request on ${result.refusal.code}`);
    return { ...result, request_id: result.request_id };
  }

  function allowed(result: RecordCallResult): RecordCallAllowed {
    if (result.outcome !== 'allowed') throw new Error(`expected allow, got ${result.refusal.code}`);
    return result;
  }

  function decided(result: DecideResult) {
    if (!result.ok) throw new Error(`expected a decision, got ${JSON.stringify(result)}`);
    return result.request;
  }

  async function approvalView(requestId: string): Promise<ApprovalView> {
    const result = await requests.view(creator(), requestId);
    if (result.outcome !== 'ok' || result.view.kind !== 'approval') {
      throw new Error('expected the view of an approval request');
    }
    return result.view;
  }

  /** The request row as it is stored, blob included: what "erased" is proven on. */
  function stored(requestId: string): StoredRequest {
    const row = f.store.db
      .prepare<
        [string],
        StoredRequest
      >('SELECT args_blob, key_version, state, decision_json FROM requests WHERE id = ?')
      .get(requestId);
    if (!row) throw new Error(`no request ${requestId}`);
    return row;
  }

  const countersOf = async (periodStart?: string, of: BudgetMission = mission) => {
    const session = await f.store.sessions.getByMission(of.id);
    if (!session) return {};
    const period = periodStart ?? f.mission.period.anchor_at;
    return Object.fromEntries(
      (await f.store.sessions.counters(session.id, period)).map((c) => [c.riskId, c.consumed]),
    );
  };

  const events = async (of: BudgetMission = mission) => {
    const session = await f.store.sessions.getByMission(of.id);
    return session ? f.store.sessions.listEvents(session.id) : [];
  };

  const adminEntries = async () =>
    (await f.store.audit.list({ kind: 'admin' })).flatMap((e) => (e.kind === 'admin' ? [e] : []));

  // ───────────────────────────────────────────────────────────────────────────
  // The refusal and the request it drops
  // ───────────────────────────────────────────────────────────────────────────

  describe('the refusal', () => {
    it('carries the URL, the fingerprint, the validity and the replay instruction; nothing ran', async () => {
      const result = refused(await call());
      const request = await f.store.requests.getById(result.request_id);
      expect(result.refusal).toEqual({
        code: 'approval-required',
        risk_id: MERGE,
        fingerprint: fingerprintArguments(ARGS),
        approval_url: `https://gateway.example.com/r/${result.request_id}`,
        expires_at: request?.expiresAt,
        approval_valid_seconds: APPROVAL_VALIDITY_SECONDS,
        hint: expect.stringContaining('exactly the same arguments') as string,
      });
      expect(result.refusal.hint).toContain(`https://gateway.example.com/r/${result.request_id}`);
      expect(result.refusal.hint).toContain(`within ${APPROVAL_VALIDITY_SECONDS}s`);
      // The request lives as long as any request; the approval, once granted, much less.
      expect(request?.expiresAt).toBe(
        new Date(f.clock.now().getTime() + REQUEST_EXPIRY_SECONDS * 1000).toISOString(),
      );
      // Nothing was decremented, nothing is in the rate window.
      expect(await countersOf()).toEqual({});
      // The refusal never repeats the arguments.
      expect(JSON.stringify(result.refusal)).not.toContain(SECRET_TITLE);
    });

    it('seals the arguments with the request id as associated data, inside the refusal', async () => {
      const result = refused(await call());
      expect(f.encryptor.sealCalls).toEqual([{ associatedData: `request:${result.request_id}` }]);
      const row = stored(result.request_id);
      expect(row.state).toBe('open');
      expect(row.args_blob).not.toBeNull();
      expect(row.key_version).toBe(1);
      // Sealed under another request's id, the blob does not open.
      await expect(
        f.encryptor.decrypt('request:another', {
          blob: row.args_blob as Buffer,
          keyVersion: row.key_version as number,
        }),
      ).rejects.toThrow(/associated data/);
      // The session's events name the tool and the fingerprint, never the arguments.
      expect(JSON.stringify(await events())).not.toContain(SECRET_TITLE);
    });

    it('a replay before the decision points to the same request; no second row', async () => {
      const first = refused(await call());
      const again = refused(await call({ args: { ...ARGS } }));
      expect(again.request_id).toBe(first.request_id);
      expect(await f.store.requests.listForMission(mission.id)).toHaveLength(1);
    });

    it('one byte changed in the arguments is another call: a new request, another fingerprint', async () => {
      const first = refused(await call());
      const other = refused(await call({ args: { ...ARGS, pull_number: 43 } }));
      expect(other.request_id).not.toBe(first.request_id);
      expect(other.fingerprint).not.toBe(first.fingerprint);
      const sameButCase = refused(await call({ args: { ...ARGS, repo: 'App' } }));
      expect(sameButCase.request_id).not.toBe(first.request_id);
      expect(await f.store.requests.listForMission(mission.id)).toHaveLength(3);
    });

    it('the same arguments on another tool are another call: a request of their own', async () => {
      const first = refused(await call());
      const other = refused(await call({ tool: 'github__delete_branch' }));
      expect(other.fingerprint).toBe(first.fingerprint);
      expect(other.request_id).not.toBe(first.request_id);
      expect((await f.store.requests.getById(other.request_id))?.tool).toBe(
        'github__delete_branch',
      );
    });

    it('a multi-risk call with one gated risk is refused as a whole', async () => {
      const result = refused(await call({ risks: [READ, MERGE] }));
      expect(result.refusal).toMatchObject({ code: 'approval-required', risk_id: MERGE });
      expect(await countersOf()).toEqual({});
      // The ungated risk was not counted, and its rate window saw nothing.
      for (let i = 0; i < 10; i++) allowed(await call({ risks: [READ], args: { i } }));
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // The creator's view
  // ───────────────────────────────────────────────────────────────────────────

  describe("the creator's view", () => {
    it('shows the tool, the arguments in clear, the slices, the risks touched and what is left', async () => {
      allowed(await call({ risks: [READ], args: { path: 'README.md' }, tool: 'github__get_file' }));
      const result = refused(await call({ risks: [READ, MERGE] }));
      // The pipeline writes the entry of the refused call: slices and touched risks.
      const slice = parseSlice('github.repo[acme/app].branch[main].W');
      await f.store.auditWriter.write({
        kind: 'call',
        ts: f.clock.now().toISOString(),
        mission_id: mission.id,
        token_id: null,
        token_kind: null,
        token_holder: null,
        session_id: result.session_id,
        connection_id: f.connectionId,
        resource_ref: 'acme/app',
        tool: TOOL,
        arguments_hash: result.fingerprint,
        slices_executed: [slice],
        risks_touched: [READ, MERGE],
        accepted_risks_snapshot: [READ, MERGE, WRITE],
        decision: 'refused',
        refusal_code: 'approval-required',
        refusal_reason: result.refusal.hint,
        approval_id: null,
        remaining_budget: null,
        agent_label: 'builder',
        upstream_latency_ms: null,
        upstream_error: null,
        client_ip: null,
        client_user_agent: null,
      });

      const view = await approvalView(result.request_id);
      expect(view.request).toMatchObject({
        id: result.request_id,
        kind: 'approval',
        state: 'open',
        risk_id: MERGE,
        tool: TOOL,
        url: `https://gateway.example.com/r/${result.request_id}`,
        mission: { id: mission.id },
      });
      expect(view.call).toEqual({
        tool: TOOL,
        fingerprint: fingerprintArguments(ARGS),
        arguments: ARGS,
        arguments_erased: false,
        slices: ['github.repo[acme/app].branch[main].W'],
        risks: [
          { risk_id: READ, label: READ, quota: 10, consumed: 1, remaining: 9, gate: 'auto' },
          { risk_id: MERGE, label: MERGE, quota: 3, consumed: 0, remaining: 3, gate: 'approval' },
        ],
      });
      expect(view.gate).toEqual({ policy: 'approval', open_until: null });
      expect(view.approval).toBeNull();
      expect(view.period).toMatchObject({ end: DAY1 });
      expect(view.options.map((o) => [o.resolution, o.unavailable])).toEqual([
        ['grant', null],
        ['open-gate', null],
        ['refuse', null],
      ]);
      expect(view.events.map((e) => e.summary)).toEqual([
        `Refused ${TOOL} (approval-required) by “builder”`,
        `An approval request for ${TOOL} was dropped in the creator’s inbox`,
        'Allowed github__get_file by “builder”',
      ]);
    });

    it('without an audit entry it still shows the gated risk; the slices read "not recorded"', async () => {
      const result = refused(await call());
      const view = await approvalView(result.request_id);
      expect(view.call.slices).toBeNull();
      expect(view.call.risks.map((r) => r.risk_id)).toEqual([MERGE]);
    });

    it('is refused to anyone but the creator, with nothing about the request', async () => {
      const result = refused(await call());
      const other = await f.store.users.upsertFromIdp({ subject: 'o', email: 'o@x' });
      expect(await requests.view({ id: other.id }, result.request_id)).toEqual({
        outcome: 'forbidden',
      });
      expect(await requests.inbox({ id: other.id })).toEqual([]);
      for (const resolution of ['grant', 'open-gate', 'refuse'] as const) {
        expect(
          await requests.decideApproval({ id: other.id }, result.request_id, { resolution }),
        ).toEqual({ ok: false, reason: 'forbidden' });
      }
      expect(stored(result.request_id).state).toBe('open');
      expect(await f.store.approvals.listActive(mission.id)).toEqual([]);
    });

    it('the inbox lists it with its tool, never its arguments', async () => {
      const result = refused(await call());
      const inbox = await requests.inbox(creator());
      expect(inbox).toMatchObject([{ id: result.request_id, kind: 'approval', tool: TOOL }]);
      expect(JSON.stringify(inbox)).not.toContain(SECRET_TITLE);
      expect(await requests.openCount(creator())).toBe(1);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Grant → identical replay → second replay
  // ───────────────────────────────────────────────────────────────────────────

  describe('grant', () => {
    it('refusal → grant → the identical replay passes → the second identical replay is refused', async () => {
      const first = refused(await call());
      const request = decided(
        await requests.decide(creator(), first.request_id, { resolution: 'grant' }),
      );
      expect(request).toMatchObject({ state: 'granted', decision: { resolution: 'grant' } });

      const [approval] = await f.store.approvals.listActive(mission.id);
      expect(approval).toMatchObject({
        missionId: mission.id,
        requestId: first.request_id,
        riskId: MERGE,
        tool: TOOL,
        fingerprint: first.fingerprint,
        consumedAt: null,
        expiresAt: new Date(
          f.clock.now().getTime() + APPROVAL_VALIDITY_SECONDS * 1000,
        ).toISOString(),
      });

      // The executor replays the same arguments, serialized in another key order.
      f.clock.advance(5_000);
      const replay = allowed(
        await call({
          args: { commit_title: SECRET_TITLE, pull_number: 42, repo: 'app', owner: 'acme' },
        }),
      );
      expect(replay.approval_ids).toEqual([approval?.id]);
      expect((await f.store.approvals.getByRequest(first.request_id))?.consumedAt).toBe(
        f.clock.now().toISOString(),
      );

      // Single use: the same call again asks again, with a request of its own.
      const second = refused(await call());
      expect(second.refusal.code).toBe('approval-required');
      expect(second.request_id).not.toBe(first.request_id);
      expect(await f.store.approvals.listActive(mission.id)).toEqual([]);

      const view = await approvalView(first.request_id);
      expect(view.approval).toMatchObject({ id: approval?.id, state: 'consumed' });
      expect(view.options).toEqual([]);
    });

    it('the approved action still decrements the quota and counts in the rate window', async () => {
      const first = refused(await call());
      decided(await requests.decide(creator(), first.request_id, { resolution: 'grant' }));
      const replay = allowed(await call());
      expect(replay.decrements).toEqual([MERGE]);
      expect(replay.remaining).toEqual({ [MERGE]: 2 });
      expect(await countersOf()).toEqual({ [MERGE]: 1 });

      // MERGE's window is 2 per 60 s: one more approved action fills it, and the
      // third is refused on the rate before any approval is asked or consumed.
      const two = refused(await call({ args: { pull_number: 2 } }));
      decided(await requests.decide(creator(), two.request_id, { resolution: 'grant' }));
      allowed(await call({ args: { pull_number: 2 } }));
      const three = await call({ args: { pull_number: 3 } });
      expect(three).toMatchObject({
        outcome: 'refused',
        refusal: { code: 'rate-limited', risk_id: MERGE },
      });
      expect(await countersOf()).toEqual({ [MERGE]: 2 });
    });

    it('the gate does not replace the budget: at zero quota an approval opens nothing', async () => {
      for (const pull_number of [1, 2, 3]) {
        const r = refused(await call({ args: { pull_number } }));
        decided(await requests.decide(creator(), r.request_id, { resolution: 'grant' }));
        allowed(await call({ args: { pull_number } }));
        f.clock.advance(61_000);
      }
      // A fourth call: the claim comes first, the creator is not asked to approve it.
      const fourth = refused(await call({ args: { pull_number: 4 } }));
      expect(fourth.refusal).toMatchObject({ code: 'budget-exhausted', risk_id: MERGE });
      expect((await f.store.requests.getById(fourth.request_id))?.kind).toBe('claim');
    });

    it('one approval covers a multi-risk call: the ungated risks pass with it and are counted', async () => {
      const first = refused(await call({ risks: [READ, MERGE] }));
      decided(await requests.decide(creator(), first.request_id, { resolution: 'grant' }));
      const replay = allowed(await call({ risks: [READ, MERGE] }));
      expect(replay.approval_ids).toHaveLength(1);
      expect(replay.decrements).toEqual([READ, MERGE]);
      expect(await countersOf()).toEqual({ [READ]: 1, [MERGE]: 1 });
      expect(await f.store.requests.listForMission(mission.id)).toHaveLength(1);
    });

    it('is bound to the exact fingerprint: one byte changed does not consume it', async () => {
      const first = refused(await call());
      decided(await requests.decide(creator(), first.request_id, { resolution: 'grant' }));
      const other = refused(await call({ args: { ...ARGS, pull_number: 43 } }));
      expect(other.refusal).toMatchObject({ code: 'approval-required' });
      expect(other.fingerprint).not.toBe(first.fingerprint);
      expect(await f.store.approvals.listActive(mission.id)).toHaveLength(1);
      expect(await countersOf()).toEqual({});
      // The approved call itself still passes afterwards.
      allowed(await call());
    });

    it('is bound to the tool: the same arguments on another tool touching the same risk ask again', async () => {
      const first = refused(await call());
      decided(await requests.decide(creator(), first.request_id, { resolution: 'grant' }));
      const other = refused(await call({ tool: 'github__delete_branch' }));
      expect(other.refusal).toMatchObject({ code: 'approval-required', risk_id: MERGE });
      expect(other.fingerprint).toBe(first.fingerprint);
      expect(await f.store.approvals.listActive(mission.id)).toHaveLength(1);
      expect(await countersOf()).toEqual({});
      allowed(await call());
    });

    it('is bound to the mission: the same call on another mission of the creator asks again', async () => {
      const first = refused(await call());
      decided(await requests.decide(creator(), first.request_id, { resolution: 'grant' }));
      const sibling = await f.createMission({ periodSeconds: DAY_SECONDS, policy: POLICY });
      const other = refused(await call({ mission: sibling }));
      expect(other.refusal.code).toBe('approval-required');
      expect(await f.store.approvals.listActive(mission.id)).toHaveLength(1);
    });

    it('expires after the configured delay: the replay comes too late and asks again', async () => {
      const first = refused(await call());
      decided(await requests.decide(creator(), first.request_id, { resolution: 'grant' }));
      f.clock.advance(APPROVAL_VALIDITY_SECONDS * 1000 - 1);
      expect(await f.store.approvals.listActive(mission.id)).toHaveLength(1);
      f.clock.advance(1);
      const late = refused(await call());
      expect(late.refusal.code).toBe('approval-required');
      expect(late.request_id).not.toBe(first.request_id);
      expect(await countersOf()).toEqual({});
      expect((await approvalView(first.request_id)).approval).toMatchObject({ state: 'expired' });
    });

    it('the delay is the operator-configured one', async () => {
      const short = new RequestService({
        store: f.store,
        registry: { get: () => undefined },
        grounds: alwaysGrounded,
        publicUrl: PUBLIC_URL,
        approvalValiditySeconds: 30,
        clock: f.clock,
        logger: createLogger({ level: 'error', redact: (text) => text, write: () => undefined }),
      });
      const first = refused(await call());
      decided(await short.decide(creator(), first.request_id, { resolution: 'grant' }));
      const [approval] = await f.store.approvals.listActive(mission.id);
      expect(approval?.expiresAt).toBe(new Date(f.clock.now().getTime() + 30_000).toISOString());
      f.clock.advance(30_000);
      expect(refused(await call()).refusal.code).toBe('approval-required');
    });

    it('a second gated risk of the same call asks in its turn; both approvals are consumed together', async () => {
      const first = refused(await call({ risks: [MERGE, WRITE] }));
      expect(first.refusal).toMatchObject({ risk_id: MERGE });
      decided(await requests.decide(creator(), first.request_id, { resolution: 'grant' }));
      // The approval of the first risk is not consumed by the refusal on the second.
      const second = refused(await call({ risks: [MERGE, WRITE] }));
      expect(second.refusal).toMatchObject({ code: 'approval-required', risk_id: WRITE });
      expect(await f.store.approvals.listActive(mission.id)).toHaveLength(1);
      decided(await requests.decide(creator(), second.request_id, { resolution: 'grant' }));
      const replay = allowed(await call({ risks: [MERGE, WRITE] }));
      expect(replay.approval_ids).toHaveLength(2);
      expect(await countersOf()).toEqual({ [MERGE]: 1, [WRITE]: 1 });
      expect(await f.store.approvals.listActive(mission.id)).toEqual([]);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Erasure of the arguments
  // ───────────────────────────────────────────────────────────────────────────

  describe('erasure of the arguments', () => {
    it.each(['grant', 'open-gate', 'refuse'] as const)(
      'on "%s" the sealed blob is NULL in the row; only the fingerprint remains',
      async (resolution) => {
        const first = refused(await call());
        expect(stored(first.request_id).args_blob).not.toBeNull();
        decided(await requests.decide(creator(), first.request_id, { resolution }));

        const row = stored(first.request_id);
        expect(row.args_blob).toBeNull();
        expect(row.key_version).toBeNull();
        expect(row.state).toBe(resolution === 'refuse' ? 'refused' : 'granted');
        // The decision that is kept names no argument.
        expect(row.decision_json).not.toContain(SECRET_TITLE);

        expect(await f.store.requests.getArguments(first.request_id)).toBeNull();
        const record = await f.store.requests.getById(first.request_id);
        expect(record).toMatchObject({ hasArguments: false, fingerprint: first.fingerprint });
        const view = await approvalView(first.request_id);
        expect(view.call).toMatchObject({
          arguments: null,
          arguments_erased: true,
          fingerprint: first.fingerprint,
        });
        expect(JSON.stringify(view)).not.toContain(SECRET_TITLE);
      },
    );

    it('on expiry the sweeper erases the blob; before it runs, nothing opens an overdue request', async () => {
      const first = refused(await call());
      f.clock.advance(REQUEST_EXPIRY_SECONDS * 1000);

      // Overdue, not swept yet: the blob is still in the row, and nobody reads it.
      expect(stored(first.request_id)).toMatchObject({ state: 'open' });
      expect(stored(first.request_id).args_blob).not.toBeNull();
      expect(await f.store.requests.getArguments(first.request_id)).toBeNull();
      const overdue = await approvalView(first.request_id);
      expect(overdue.request.state).toBe('expired');
      expect(overdue.call).toMatchObject({ arguments: null, arguments_erased: true });
      expect(overdue.options).toEqual([]);

      expect(await requests.sweep()).toBe(1);
      const row = stored(first.request_id);
      expect(row.state).toBe('expired');
      expect(row.args_blob).toBeNull();
      expect(row.key_version).toBeNull();
      expect((await events()).at(-1)).toMatchObject({
        kind: 'request',
        details: { request_id: first.request_id, request_kind: 'approval', state: 'expired' },
      });
    });

    it('a decision that arrives after the expiry decides nothing, and erases the blob', async () => {
      const first = refused(await call());
      f.clock.advance(REQUEST_EXPIRY_SECONDS * 1000);
      expect(await requests.decide(creator(), first.request_id, { resolution: 'grant' })).toEqual({
        ok: false,
        reason: 'not-open',
        state: 'expired',
      });
      expect(stored(first.request_id)).toMatchObject({ state: 'expired', args_blob: null });
      expect(await f.store.approvals.listActive(mission.id)).toEqual([]);
      expect(await adminEntries()).toEqual([]);
    });

    it('a decision refused on its rules writes nothing: the request stays open, the blob sealed', async () => {
      const oneOff = await f.createMission({ periodSeconds: null, policy: POLICY });
      const first = refused(await call({ mission: oneOff }));
      const result = await requests.decide(creator(), first.request_id, {
        resolution: 'open-gate',
      });
      expect(result).toMatchObject({
        ok: false,
        reason: 'invalid',
        problem: { code: 'no-period-end' },
      });
      expect(stored(first.request_id).state).toBe('open');
      expect(stored(first.request_id).args_blob).not.toBeNull();
      expect((await events(oneOff)).map((e) => e.kind)).not.toContain('gate-opened');
      expect(await adminEntries()).toEqual([]);
      // The creator still reads the arguments and can grant this one action.
      expect((await approvalView(first.request_id)).call.arguments).toEqual(ARGS);
      decided(await requests.decide(creator(), first.request_id, { resolution: 'grant' }));
      allowed(await call({ mission: oneOff }));
    });

    it('a decided request cannot be decided again', async () => {
      const first = refused(await call());
      decided(await requests.decide(creator(), first.request_id, { resolution: 'refuse' }));
      expect(await requests.decide(creator(), first.request_id, { resolution: 'grant' })).toEqual({
        ok: false,
        reason: 'not-open',
        state: 'refused',
      });
      expect(await f.store.approvals.listActive(mission.id)).toEqual([]);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Refuse
  // ───────────────────────────────────────────────────────────────────────────

  it('a refusal produces no approval: the replay is refused again with a new request', async () => {
    const first = refused(await call());
    const request = decided(
      await requests.decide(creator(), first.request_id, { resolution: 'refuse' }),
    );
    expect(request).toMatchObject({ state: 'refused', decision: { resolution: 'refuse' } });
    expect(await f.store.approvals.getByRequest(first.request_id)).toBeNull();
    const again = refused(await call());
    expect(again.refusal.code).toBe('approval-required');
    expect(again.request_id).not.toBe(first.request_id);
    expect(await countersOf()).toEqual({});
    expect((await events()).map((e) => e.kind)).toContain('request');
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Open the gate for the rest of the period
  // ───────────────────────────────────────────────────────────────────────────

  describe('open the gate for the rest of the period', () => {
    async function openGate(): Promise<string> {
      const first = refused(await call());
      const request = decided(
        await requests.decide(creator(), first.request_id, { resolution: 'open-gate' }),
      );
      expect(request).toMatchObject({
        state: 'granted',
        decision: {
          resolution: 'open-gate',
          period_start: mission.period.anchor_at,
          period_end: DAY1,
        },
      });
      return first.request_id;
    }

    it('is a session event; no approval is produced', async () => {
      const requestId = await openGate();
      expect(await f.store.approvals.getByRequest(requestId)).toBeNull();
      expect((await events()).at(-1)).toMatchObject({
        kind: 'gate-opened',
        riskId: MERGE,
        actorUserId: f.creatorId,
        details: {
          request_id: requestId,
          period_start: mission.period.anchor_at,
          period_end: DAY1,
        },
      });
      const view = await approvalView(requestId);
      expect(view.gate).toEqual({ policy: 'approval', open_until: DAY1 });
      expect(view.call.risks).toMatchObject([{ risk_id: MERGE, gate: 'auto' }]);
    });

    it('decide() reads it: the replay passes, and so does any other call on the risk, within the budget', async () => {
      await openGate();
      const replay = allowed(await call());
      expect(replay.approval_ids).toEqual([]);
      // Other arguments, another tool: the gate is open for the risk, not for one call.
      allowed(await call({ args: { pull_number: 7 }, tool: 'github__delete_branch' }));
      expect(await countersOf()).toEqual({ [MERGE]: 2 });
      // The rate limit and the quota still apply.
      expect(await call({ args: { pull_number: 8 } })).toMatchObject({
        outcome: 'refused',
        refusal: { code: 'rate-limited' },
      });
      f.clock.advance(61_000);
      allowed(await call({ args: { pull_number: 8 } }));
      f.clock.advance(61_000);
      expect(refused(await call({ args: { pull_number: 9 } })).refusal.code).toBe(
        'budget-exhausted',
      );
    });

    it('opens that risk only: another gated risk of the mission still asks', async () => {
      await openGate();
      const other = refused(await call({ risks: [WRITE], tool: 'github__push' }));
      expect(other.refusal).toMatchObject({ code: 'approval-required', risk_id: WRITE });
      // A call touching both: the opened one passes its gate, the other one asks.
      const both = refused(await call({ risks: [MERGE, WRITE], args: { both: true } }));
      expect(both.refusal).toMatchObject({ code: 'approval-required', risk_id: WRITE });
    });

    it('is bounded to the period: after the reload the gate asks again', async () => {
      await openGate();
      allowed(await call());
      // The last instant of the period still passes…
      f.clock.set('2026-10-13T23:59:59.999Z');
      allowed(await call({ args: { pull_number: 2 } }));
      // …the first of the next one does not: counters at zero, gate `approval` again.
      f.clock.set(DAY1);
      const next = refused(await call({ args: { pull_number: 3 } }));
      expect(next.refusal).toMatchObject({ code: 'approval-required', risk_id: MERGE });
      expect(await countersOf(DAY1)).toEqual({});
      const view = await approvalView(next.request_id);
      expect(view.gate).toEqual({ policy: 'approval', open_until: null });
      expect(view.options.find((o) => o.resolution === 'open-gate')?.unavailable).toBeNull();
    });

    it('opened again in the next period, it opens that period only', async () => {
      await openGate();
      f.clock.set('2026-10-14T08:00:00.000Z');
      const next = refused(await call());
      decided(await requests.decide(creator(), next.request_id, { resolution: 'open-gate' }));
      allowed(await call());
      f.clock.set('2026-10-15T00:00:00.000Z');
      expect(refused(await call()).refusal.code).toBe('approval-required');
    });

    it('cannot be opened twice in a period, nor on a gate the mission set to auto', async () => {
      // Two requests open before the first decision.
      const first = refused(await call());
      const second = refused(await call({ args: { pull_number: 2 } }));
      decided(await requests.decide(creator(), first.request_id, { resolution: 'open-gate' }));
      expect(
        await requests.decide(creator(), second.request_id, { resolution: 'open-gate' }),
      ).toMatchObject({ ok: false, reason: 'invalid', problem: { code: 'gate-not-closed' } });
      expect(stored(second.request_id).state).toBe('open');
      const view = await approvalView(second.request_id);
      expect(view.options.find((o) => o.resolution === 'open-gate')?.unavailable?.code).toBe(
        'gate-not-closed',
      );
      // The request can still be granted or refused.
      decided(await requests.decide(creator(), second.request_id, { resolution: 'refuse' }));
    });

    it('an edit of the gate on the mission ends the opening', async () => {
      await openGate();
      allowed(await call());
      f.clock.advance(1_000);
      // The creator sets the gate on the mission itself: the latest act decides.
      const changed = await f.store.missions.setGate(mission.id, MERGE, 'approval', f.creatorId);
      expect(changed).toMatchObject({ previous: 'approval' });
      // Same value: nothing was written, the opening stands.
      allowed(await call({ args: { pull_number: 2 } }));

      // Auto, then approval again: two edits, both after the opening.
      f.clock.advance(61_000);
      await f.store.missions.setGate(mission.id, MERGE, 'auto', f.creatorId);
      await f.store.missions.setGate(mission.id, MERGE, 'approval', f.creatorId);
      expect((await events()).filter((e) => e.kind === 'gate-changed')).toHaveLength(2);
      const after = refused(await call({ args: { pull_number: 3 } }));
      expect(after.refusal).toMatchObject({ code: 'approval-required', risk_id: MERGE });
      expect((await approvalView(after.request_id)).gate).toEqual({
        policy: 'approval',
        open_until: null,
      });
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Mission states
  // ───────────────────────────────────────────────────────────────────────────

  describe('when the mission no longer runs', () => {
    it('a revoked mission takes a refusal only', async () => {
      const first = refused(await call());
      await f.store.missions.setStatus(mission.id, 'revoked');
      const view = await approvalView(first.request_id);
      expect(view.options.map((o) => [o.resolution, o.unavailable?.code ?? null])).toEqual([
        ['grant', 'mission-closed'],
        ['open-gate', 'mission-closed'],
        ['refuse', null],
      ]);
      expect(
        await requests.decide(creator(), first.request_id, { resolution: 'grant' }),
      ).toMatchObject({ ok: false, reason: 'invalid', problem: { code: 'mission-closed' } });
      expect(await f.store.approvals.listActive(mission.id)).toEqual([]);
      decided(await requests.decide(creator(), first.request_id, { resolution: 'refuse' }));
    });

    it('a risk that left the policy takes a refusal only', async () => {
      const first = refused(await call());
      await f.store.missions.replacePolicy(
        mission.id,
        POLICY.filter((entry) => entry.riskId !== MERGE),
      );
      expect(
        await requests.decide(creator(), first.request_id, { resolution: 'grant' }),
      ).toMatchObject({ ok: false, reason: 'invalid', problem: { code: 'risk-not-in-policy' } });
      expect((await approvalView(first.request_id)).gate).toEqual({
        policy: null,
        open_until: null,
      });
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Audit and logs
  // ───────────────────────────────────────────────────────────────────────────

  describe('every decision is an administrative act', () => {
    it.each([
      ['grant', 'approval-granted'],
      ['open-gate', 'gate-opened'],
      ['refuse', 'request-refused'],
    ] as const)(
      '"%s" writes one %s entry naming the creator, the tool and the fingerprint',
      async (resolution, act) => {
        const first = refused(await call());
        expect(await adminEntries()).toEqual([]);
        decided(await requests.decide(creator(), first.request_id, { resolution }));
        const entries = await adminEntries();
        expect(entries).toHaveLength(1);
        expect(entries[0]).toMatchObject({
          act,
          user_id: f.creatorId,
          object: { type: 'request', id: first.request_id },
          after: {
            mission_id: mission.id,
            risk_id: MERGE,
            tool: TOOL,
            fingerprint: first.fingerprint,
            resolution,
          },
          delegated_client_id: null,
        });
      },
    );

    it('a grant names its approval; an opening names the period it is bounded to', async () => {
      const granted = refused(await call());
      decided(await requests.decide(creator(), granted.request_id, { resolution: 'grant' }));
      const [approval] = await f.store.approvals.listActive(mission.id);
      const opened = refused(await call({ args: { pull_number: 2 } }));
      decided(await requests.decide(creator(), opened.request_id, { resolution: 'open-gate' }));
      const [grantEntry, openEntry] = await adminEntries();
      expect(grantEntry?.after).toMatchObject({
        approval_id: approval?.id,
        approval_expires_at: approval?.expiresAt,
      });
      expect(openEntry).toMatchObject({
        before: { gate: 'approval' },
        after: { gate: 'auto', period_start: mission.period.anchor_at, period_end: DAY1 },
      });
    });

    it('neither the audit, nor the session events, nor the logs ever hold the arguments', async () => {
      const first = refused(await call());
      await approvalView(first.request_id);
      decided(await requests.decide(creator(), first.request_id, { resolution: 'grant' }));
      allowed(await call());
      const second = refused(await call());
      decided(await requests.decide(creator(), second.request_id, { resolution: 'refuse' }));

      expect(logs.length).toBeGreaterThan(0);
      for (const kept of [await f.store.audit.list(), await events(), logs]) {
        expect(JSON.stringify(kept)).not.toContain(SECRET_TITLE);
      }
      // Nothing in the store holds them either, once every request is closed.
      const blobs = f.store.db
        .prepare<
          [],
          { n: number }
        >('SELECT COUNT(*) AS n FROM requests WHERE args_blob IS NOT NULL')
        .get();
      expect(blobs?.n).toBe(0);
    });
  });
});
