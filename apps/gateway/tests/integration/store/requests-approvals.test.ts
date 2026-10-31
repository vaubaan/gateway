/**
 * Requests (claims and approval requests with encrypted arguments) and approvals
 * (single-use, short-lived, bound to the exact fingerprint). Spec §3.4, §3.5, plan §3.6.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  InvariantError,
  NotFoundError,
  type ApprovalRecord,
  type ApprovedCall,
  type Store,
} from '../../../src/server/store/index.ts';
import {
  grantApprovalRequest,
  openTestStore,
  heldArguments,
  refuseRequest,
  type TestStore,
} from '../../../src/server/store/testing.ts';

const MERGE = 'github.merge-protected';

describe('requests repository', () => {
  let t: TestStore;
  let store: Store;
  let creator: string;
  let other: string;
  let missionId: string;

  beforeEach(async () => {
    t = openTestStore();
    store = t.store;
    creator = (
      await store.users.upsertFromIdp({
        issuer: 'http://idp.test',
        subject: 'c',
        email: 'c@x',
      })
    ).id;
    other = (
      await store.users.upsertFromIdp({
        issuer: 'http://idp.test',
        subject: 'o',
        email: 'o@x',
      })
    ).id;
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
        periodSeconds: null,
        connections: [{ connectionId: connection.id, resourceScope: 'all', resourceIds: [] }],
        policy: [
          { riskId: MERGE, quota: 1, rateLimit: 1, rateWindowSeconds: 60, gate: 'approval' },
        ],
      })
    ).id;
  });
  afterEach(() => store.close());

  it('stores approval-request arguments encrypted with the request id as associated data', async () => {
    const request = await store.requests.create({
      missionId,
      kind: 'approval',
      riskId: MERGE,
      tool: 'github__merge_pull_request',
      fingerprint: 'fp',
      arguments: { owner: 'acme', repo: 'a', pull_number: 7 },
      expiresAt: '2026-10-13T10:00:00.000Z',
    });
    expect(request).toMatchObject({ kind: 'approval', state: 'open', hasArguments: true });
    expect(t.encryptor.sealCalls).toEqual([{ associatedData: `request:${request.id}` }]);
    expect(await heldArguments(store, request.id)).toEqual({
      owner: 'acme',
      repo: 'a',
      pull_number: 7,
    });
    // Read with another mission, the request is not there: its arguments are never opened.
    await expect(
      store.requests.getArguments({ missionId: 'another-mission', requestId: request.id }),
    ).rejects.toThrow(NotFoundError);
    const raw = store.db
      .prepare<[string], { args_blob: Buffer; key_version: number }>(
        'SELECT args_blob, key_version FROM requests WHERE id = ?',
      )
      .get(request.id);
    expect(raw?.key_version).toBe(1);
    expect(raw?.args_blob.toString('utf8')).not.toBe(
      JSON.stringify({ owner: 'acme', repo: 'a', pull_number: 7 }),
    );
  });

  it('an approval request requires a tool and a fingerprint', async () => {
    await expect(
      store.requests.create({
        missionId,
        kind: 'approval',
        riskId: MERGE,
        expiresAt: '2026-10-13T10:00:00.000Z',
      }),
    ).rejects.toThrow(InvariantError);
  });

  it('erases the arguments on decision and refuses a second decision', async () => {
    const request = await store.requests.create({
      missionId,
      kind: 'approval',
      riskId: MERGE,
      tool: 't',
      fingerprint: 'fp',
      arguments: { a: 1 },
      expiresAt: '2026-10-13T10:00:00.000Z',
    });
    const approval = await grantApprovalRequest(
      store,
      request.id,
      creator,
      '2026-10-13T09:05:00.000Z',
    );
    expect(await store.requests.getById(request.id)).toMatchObject({
      state: 'granted',
      hasArguments: false,
      decidedByUserId: creator,
      decidedAt: t.clock.now().toISOString(),
      decision: { resolution: 'grant', approval_id: approval.id },
    });
    expect(await heldArguments(store, request.id)).toBeNull();
    // A second decision changes nothing and its rules do not run.
    let ran = false;
    const second = await store.requests.decideApproval(request.id, creator, () => {
      ran = true;
      return { state: 'refused' as const, decision: { resolution: 'refuse' } };
    });
    expect(second).toMatchObject({ status: 'not-open', request: { state: 'granted' } });
    expect(ran).toBe(false);
  });

  it('the sweeper expires open requests past their expiry and erases their blobs', async () => {
    const stale = await store.requests.create({
      missionId,
      kind: 'approval',
      riskId: MERGE,
      tool: 't',
      fingerprint: 'fp',
      arguments: { a: 1 },
      expiresAt: '2026-10-13T09:30:00.000Z',
    });
    const fresh = await store.requests.create({
      missionId,
      kind: 'claim',
      riskId: MERGE,
      expiresAt: '2026-10-14T09:00:00.000Z',
    });
    t.clock.set('2026-10-13T09:30:00.000Z');
    expect((await store.requests.sweepExpired()).map((r) => r.id)).toEqual([stale.id]);
    expect(await store.requests.sweepExpired()).toEqual([]);
    expect(await store.requests.getById(stale.id)).toMatchObject({
      state: 'expired',
      hasArguments: false,
    });
    expect(await store.requests.getById(fresh.id)).toMatchObject({ state: 'open' });
    expect((await store.requests.listForMission(missionId)).map((r) => r.id)).toEqual([
      stale.id,
      fresh.id,
    ]);
  });

  it('the inbox lists only the creator’s open requests', async () => {
    const r = await store.requests.create({
      missionId,
      kind: 'claim',
      riskId: MERGE,
      expiresAt: '2026-10-14T09:00:00.000Z',
    });
    expect((await store.requests.listOpenForCreator(creator)).map((x) => x.id)).toEqual([r.id]);
    expect(await store.requests.listOpenForCreator(other)).toEqual([]);
    await refuseRequest(store, r.id, creator);
    expect(await store.requests.listOpenForCreator(creator)).toEqual([]);
    await expect(store.requests.getArguments({ missionId, requestId: 'missing' })).rejects.toThrow(
      /not found/,
    );
  });
});

describe('approvals repository', () => {
  let t: TestStore;
  let store: Store;
  let missionId: string;
  let requestId: string;
  let creator: string;
  let connectionId: string;

  beforeEach(async () => {
    t = openTestStore();
    store = t.store;
    creator = (
      await store.users.upsertFromIdp({
        issuer: 'http://idp.test',
        subject: 'c',
        email: 'c@x',
      })
    ).id;
    const connection = await store.connections.create({
      provider: 'github',
      owner: { kind: 'user', id: creator },
      displayName: 'gh',
      credential: null,
    });
    connectionId = connection.id;
    missionId = (
      await store.missions.create({
        name: 'm',
        creatorUserId: creator,
        periodSeconds: null,
        connections: [{ connectionId: connection.id, resourceScope: 'all', resourceIds: [] }],
        policy: [
          { riskId: MERGE, quota: 5, rateLimit: 1, rateWindowSeconds: 60, gate: 'approval' },
        ],
      })
    ).id;
    requestId = (
      await store.requests.create({
        missionId,
        kind: 'approval',
        riskId: MERGE,
        tool: 't',
        fingerprint: 'fp',
        expiresAt: '2026-10-13T10:00:00.000Z',
      })
    ).id;
  });
  afterEach(() => store.close());

  const CALL: ApprovedCall = { tool: 't', fingerprint: 'fp' };
  const PERIOD = '2026-10-13T00:00:00.000Z';
  const READ = 'github.code-read';
  const grant = (riskIds: readonly string[] = [MERGE]) =>
    store.approvals.create({
      missionId,
      requestId,
      ...CALL,
      riskIds,
      expiresAt: '2026-10-13T09:10:00.000Z',
    });
  /**
   * Consumption as production does it: `DecideContext.findApprovals`, then
   * `consumeApproval` of the one that covers the risk, inside the transaction of a
   * call's decision. The call is allowed only when an approval was consumed.
   */
  const consume = async (
    call: ApprovedCall = CALL,
    riskId: string = MERGE,
  ): Promise<ApprovalRecord | null> => {
    const result = await store.sessions.decideAndDecrement(
      { missionId, riskIds: [MERGE], periodStart: PERIOD },
      (ctx) => {
        const found = ctx.findApprovals(call).find((a) => a.riskIds.includes(riskId));
        const consumed = found ? ctx.consumeApproval(found.id) : null;
        return { allow: consumed !== null, consumed };
      },
    );
    return result.outcome.consumed;
  };

  it('is single-use and bound to the exact tool and fingerprint, and covers the risks it lists', async () => {
    const approval = await grant();
    expect(approval).toMatchObject({
      ...CALL,
      riskId: MERGE,
      riskIds: [MERGE],
      missionId,
      requestId,
      consumedAt: null,
    });
    expect((await store.approvals.listActive(missionId)).map((a) => a.id)).toEqual([approval.id]);
    expect(await store.approvals.getByRequest(requestId)).toEqual(approval);
    expect(await consume({ ...CALL, fingerprint: 'fp-different' })).toBe(null);
    expect(await consume(CALL, READ)).toBe(null);
    const consumed = await consume();
    expect(consumed?.id).toBe(approval.id);
    expect(consumed?.consumedAt).toBe(t.clock.now().toISOString());
    expect(await consume()).toBeNull();
    expect(await store.approvals.listActive(missionId)).toEqual([]);
  });

  it('one approval covers every gated risk of the call it lists, and is consumed once', async () => {
    const approval = await grant([MERGE, READ]);
    expect(approval).toMatchObject({ riskId: MERGE, riskIds: [MERGE, READ] });
    expect(
      store.db
        .prepare('SELECT risk_id, risk_ids_json FROM approvals WHERE id = ?')
        .get(approval.id),
    ).toEqual({ risk_id: MERGE, risk_ids_json: JSON.stringify([MERGE, READ]) });
    // Found for either risk of the call...
    expect((await consume(CALL, READ))?.id).toBe(approval.id);
    // ...and gone for both once used.
    expect(await consume(CALL, MERGE)).toBeNull();
    expect(await consume(CALL, READ)).toBeNull();
  });

  it('an approval lists at least one risk, each once', async () => {
    await expect(grant([])).rejects.toBeInstanceOf(InvariantError);
    const approval = await grant([MERGE, MERGE, READ]);
    expect(approval.riskIds).toEqual([MERGE, READ]);
  });

  it('cannot be consumed through another mission, nor by an id that is not an approval', async () => {
    const approval = await grant();
    const elsewhere = await store.missions.create({
      name: 'other',
      creatorUserId: creator,
      periodSeconds: null,
      connections: [{ connectionId, resourceScope: 'all', resourceIds: [] }],
      policy: [{ riskId: MERGE, quota: 5, rateLimit: 1, rateWindowSeconds: 60, gate: 'approval' }],
    });
    const stolen = await store.sessions.decideAndDecrement(
      { missionId: elsewhere.id, riskIds: [MERGE], periodStart: PERIOD },
      (ctx) => ({
        allow: false,
        found: ctx.findApprovals(CALL).length,
        consumed: ctx.consumeApproval(approval.id),
        unknown: ctx.consumeApproval('not-an-approval'),
      }),
    );
    expect(stolen.outcome).toMatchObject({ found: 0, consumed: null, unknown: null });
    expect((await store.approvals.getByRequest(requestId))?.consumedAt).toBeNull();
    expect((await consume())?.id).toBe(approval.id);
  });

  it('a row written before a request covered the call covers the one risk it named', async () => {
    // What migration 0013 leaves: `risk_ids_json` backfilled from `risk_id`, or NULL on a
    // row an older image wrote meanwhile. Unreadable JSON reads the same narrow way.
    for (const [id, json] of [
      ['backfilled', JSON.stringify([MERGE])],
      ['null-list', null],
      ['broken', '{not json'],
      ['empty', '[]'],
    ] as const) {
      store.db.prepare('DELETE FROM approvals').run();
      store.db
        .prepare(
          `INSERT INTO approvals (id, mission_id, request_id, risk_id, risk_ids_json, tool, fingerprint, created_at, expires_at)
           VALUES (?, ?, ?, ?, ?, 't', 'fp', '2026-10-13T09:00:00.000Z', '2026-10-13T09:10:00.000Z')`,
        )
        .run(id, missionId, requestId, MERGE, json);
      expect((await store.approvals.getByRequest(requestId))?.riskIds, id).toEqual([MERGE]);
      expect(await consume(CALL, READ), id).toBeNull();
      expect((await consume(CALL, MERGE))?.id, id).toBe(id);
    }
  });

  it('the same arguments on another tool touching the same risk do not consume it', async () => {
    // The defect migration 0005 closed: the key had no tool.
    const approval = await grant();
    expect(await consume({ ...CALL, tool: 'other_tool' })).toBeNull();
    expect((await store.approvals.getByRequest(requestId))?.consumedAt).toBeNull();
    expect((await consume())?.id).toBe(approval.id);
  });

  it('an approval without a tool is never written, and never matched', async () => {
    await expect(
      store.approvals.create({
        ...CALL,
        riskIds: [MERGE],
        missionId,
        requestId,
        tool: '',
        expiresAt: '2026-10-13T09:10:00.000Z',
      }),
    ).rejects.toBeInstanceOf(InvariantError);
    // A row older than migration 0005 carries the column default: no call consumes it.
    t.store.db
      .prepare(
        `INSERT INTO approvals (id, mission_id, request_id, risk_id, fingerprint, created_at, expires_at)
         VALUES ('legacy', ?, ?, ?, 'fp', '2026-10-13T09:00:00.000Z', '2026-10-13T09:10:00.000Z')`,
      )
      .run(missionId, requestId, MERGE);
    expect(await store.approvals.getByRequest(requestId)).toMatchObject({ id: 'legacy', tool: '' });
    expect(await consume({ ...CALL, tool: '' })).toBeNull();
    expect(await consume()).toBeNull();
  });

  it('expires', async () => {
    await grant();
    t.clock.set('2026-10-13T09:10:00.000Z');
    expect(await consume()).toBeNull();
    expect(await store.approvals.listActive(missionId)).toEqual([]);
  });

  it('one approval per request', async () => {
    await grant();
    await expect(grant()).rejects.toThrow(/UNIQUE/);
  });
});
