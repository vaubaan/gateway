/**
 * Who reads the arguments of an approval request (spec §3.5 "the request shows the
 * creator … the arguments in clear", §3.4 "any other identity is refused", §6): the
 * mission's creator and nobody else — not an operator, not a co-owner of the
 * connection through its owner group, not the bootstrap operator, not the executor
 * holding the mission token. Over the real composition root and its HTTP handlers.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SESSION_COOKIE } from '../../../src/server/auth';
import { seedConnection } from '../../../src/server/missions/testing';
import { ADDRESSED_TO_CREATOR, type ApprovalView } from '../../../src/server/requests';
import type { MissionRecord, UserRecord } from '../../../src/server/store/types';
import {
  ARGUMENT_MARKER,
  DAY_SECONDS,
  MERGE,
  openAuditRig,
  READ,
  seedCall,
  type OperatorRig,
} from '../audit/support';
import { PUBLIC_URL, sessionHeaders } from '../missions/support';

const TOOL = 'github__merge_pull_request';
const MISSION_NAME = 'Ship the team repository';
const ARGS = { pull_number: 12, commit_title: ARGUMENT_MARKER };
const FORM = 'application/x-www-form-urlencoded';

describe('the arguments of an approval request are for the creator only', () => {
  let rig: OperatorRig;
  let carol: UserRecord;
  let mission: MissionRecord;
  let token: string;
  let requestId: string;

  beforeEach(async () => {
    rig = await openAuditRig();
    const { root, seeded } = rig;
    // A connection owned by a group: Ada and Carol both own it.
    carol = await root.store.users.upsertFromIdp({
      issuer: 'http://idp.test',
      subject: 'idp|carol',
      email: 'carol@example.com',
    });
    const team = await root.store.groups.getOrCreate('platform', 'local', null);
    await root.store.groups.setMembers(team.id, [seeded.ada.id, carol.id]);
    const connection = await seedConnection(root.store, {
      provider: 'github',
      owner: { kind: 'group', id: team.id },
      displayName: 'team-org',
      resources: [{ ref: 'team/app', displayName: 'team/app' }],
    });
    const issued = await root.missions.service.issue(seeded.ada, {
      name: MISSION_NAME,
      connections: [
        {
          connection_id: connection.connection.id,
          policy: [
            { risk_id: READ, quota: 5, rate_limit: { max: 50, window_seconds: 60 } },
            {
              risk_id: MERGE,
              quota: 2,
              rate_limit: { max: 50, window_seconds: 60 },
              gate: 'approval',
            },
          ],
        },
      ],
      period: { kind: 'recurring', length_seconds: DAY_SECONDS },
      expires_at: null,
    });
    if (!issued.ok) throw new Error(`issue refused: ${JSON.stringify(issued)}`);
    mission = issued.mission;
    token = issued.token.secret;
    requestId = await gatedCall();
  });
  afterEach(async () => {
    await rig.root.close();
  });

  /** A call on the gated risk, as the door records it; the id of the request it drops. */
  async function gatedCall(args: Record<string, unknown> = ARGS): Promise<string> {
    const seededCall = await seedCall(rig, mission, { tool: TOOL, risks: [MERGE], args });
    const { result } = seededCall;
    if (result.outcome !== 'refused' || !result.request_id) {
      throw new Error('expected an approval request');
    }
    return result.request_id;
  }

  const url = (id = requestId) => `${PUBLIC_URL}/r/${id}`;
  const get = (target: string, headers: Headers): Request =>
    new Request(target, { method: 'GET', headers });

  function decideRequest(headers: Headers, body: unknown, id = requestId): Request {
    const form = headers.get('content-type') === FORM;
    return new Request(`${PUBLIC_URL}/api/requests/${id}/decide`, {
      method: 'POST',
      headers,
      body: form
        ? new URLSearchParams(body as Record<string, string>).toString()
        : JSON.stringify(body),
    });
  }

  async function creatorView(id = requestId): Promise<ApprovalView> {
    const result = await rig.root.requests.service.view(rig.seeded.ada, id);
    if (result.outcome !== 'ok' || result.view.kind !== 'approval') {
      throw new Error('expected the creator to read the approval request');
    }
    return result.view;
  }

  /** What must never reach anyone but the creator. */
  const SECRETS = [ARGUMENT_MARKER, TOOL, MISSION_NAME, MERGE, 'ada@example.com'];

  async function stillSealed(): Promise<void> {
    expect(await rig.root.store.requests.getById(requestId)).toMatchObject({
      state: 'open',
      hasArguments: true,
    });
    expect(await rig.root.store.approvals.listActive(mission.id)).toEqual([]);
  }

  it('the creator reads the tool, the arguments in clear, and the budget of the risk', async () => {
    const view = await creatorView();
    expect(view.call).toMatchObject({
      tool: TOOL,
      arguments: ARGS,
      arguments_erased: false,
      // The audit rig records calls with no slice.
      slices: [],
      risks: [{ risk_id: MERGE, quota: 2, consumed: 0, remaining: 2, gate: 'approval' }],
    });
    // The catalog's label of the risk, from the plugin the image ships.
    expect(view.request.risk_label).not.toBe(MERGE);
    expect(view.request.risk_label.length).toBeGreaterThan(0);

    // The forwarded URL lets the creator through to the inbox entry.
    const opened = await rig.root.requests.handlers.open(
      get(url(), await sessionHeaders(rig.root, rig.seeded.ada)),
      requestId,
    );
    expect(opened.status).toBe(303);
    expect(opened.headers.get('location')).toBe(`/waiting/${requestId}`);
  });

  describe.each([
    ['an operator', () => rig.operator],
    ['a co-owner of the connection through its owner group', () => carol],
    ['another user', () => rig.seeded.bob],
  ] as const)('%s', (_who, userOf) => {
    it('gets no view from the service', async () => {
      expect(await rig.root.requests.service.view(userOf(), requestId)).toEqual({
        outcome: 'forbidden',
      });
      expect(await rig.root.requests.service.inbox(userOf())).toEqual([]);
      expect(await rig.root.requests.service.openCount(userOf())).toBe(0);
    });

    it('gets one sentence at the forwarded URL, and nothing about the request', async () => {
      const response = await rig.root.requests.handlers.open(
        get(url(), await sessionHeaders(rig.root, userOf())),
        requestId,
      );
      expect(response.status).toBe(403);
      const page = await response.text();
      expect(page).toContain(ADDRESSED_TO_CREATOR);
      for (const secret of SECRETS) expect(page).not.toContain(secret);
    });

    it('has an empty inbox over HTTP', async () => {
      const response = await rig.root.requests.handlers.inbox(
        get(`${PUBLIC_URL}/api/requests`, await sessionHeaders(rig.root, userOf())),
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ requests: [] });
    });

    it.each(['grant', 'open-gate', 'refuse'] as const)('cannot record "%s"', async (resolution) => {
      const response = await rig.root.requests.handlers.decide(
        decideRequest(await sessionHeaders(rig.root, userOf()), { resolution }),
        requestId,
      );
      expect(response.status).toBe(403);
      const body = await response.text();
      expect(JSON.parse(body)).toEqual({ error: 'forbidden', message: ADDRESSED_TO_CREATOR });
      for (const secret of SECRETS) expect(body).not.toContain(secret);
      await stillSealed();
    });

    it('reads nothing of it on the mission’s pages either', async () => {
      expect(await rig.root.missions.service.get(userOf(), mission.id)).toBeNull();
      expect(await rig.root.audit.sessions.get(userOf(), mission.id)).toBeNull();
    });
  });

  it('the bootstrap operator is nobody’s creator: 403 on the three routes', async () => {
    const session = await rig.root.auth.sessions.create({ kind: 'bootstrap' });
    const headers = new Headers({
      cookie: `${SESSION_COOKIE}=${session.id}`,
      origin: PUBLIC_URL,
      'content-type': 'application/json',
    });
    const opened = await rig.root.requests.handlers.open(get(url(), headers), requestId);
    expect(opened.status).toBe(403);
    const page = await opened.text();
    expect(page).toContain(ADDRESSED_TO_CREATOR);
    for (const secret of SECRETS) expect(page).not.toContain(secret);

    const inbox = await rig.root.requests.handlers.inbox(
      get(`${PUBLIC_URL}/api/requests`, headers),
    );
    expect(inbox.status).toBe(403);
    expect(await inbox.text()).not.toContain(ARGUMENT_MARKER);

    const decided = await rig.root.requests.handlers.decide(
      decideRequest(headers, { resolution: 'grant' }),
      requestId,
    );
    expect(decided.status).toBe(403);
    await stillSealed();
  });

  it('the executor cannot approve its own action: a mission token is refused by kind', async () => {
    for (const headers of [
      new Headers({ authorization: `Bearer ${token}`, 'content-type': 'application/json' }),
      // Even next to the creator's own session cookie.
      await sessionHeaders(rig.root, rig.seeded.ada, { authorization: `Bearer ${token}` }),
    ]) {
      const decided = await rig.root.requests.handlers.decide(
        decideRequest(headers, { resolution: 'grant' }),
        requestId,
      );
      expect(decided.status).toBe(403);
      expect(await decided.json()).toMatchObject({
        error: 'wrong-credential-kind',
        presented: 'mission-token',
        expected: 'human-session',
      });
      const opened = await rig.root.requests.handlers.open(get(url(), headers), requestId);
      expect(opened.status).toBe(403);
      expect(await opened.text()).not.toContain(ARGUMENT_MARKER);
    }
    await stillSealed();
  });

  it('a decision from another origin is refused before anything is read', async () => {
    const headers = await sessionHeaders(rig.root, rig.seeded.ada, {
      origin: 'https://evil.example',
    });
    const decided = await rig.root.requests.handlers.decide(
      decideRequest(headers, { resolution: 'grant' }),
      requestId,
    );
    expect(decided.status).toBe(403);
    expect(await decided.json()).toMatchObject({ error: 'origin-mismatch' });
    await stillSealed();
  });

  describe('the creator decides over HTTP', () => {
    it('JSON: the answer is the summary — the tool, never the arguments', async () => {
      const headers = await sessionHeaders(rig.root, rig.seeded.ada);
      const inbox = await rig.root.requests.handlers.inbox(
        get(`${PUBLIC_URL}/api/requests`, headers),
      );
      const listed = await inbox.text();
      expect(JSON.parse(listed)).toMatchObject({
        requests: [{ id: requestId, kind: 'approval', tool: TOOL, risk_id: MERGE }],
      });
      expect(listed).not.toContain(ARGUMENT_MARKER);

      const decided = await rig.root.requests.handlers.decide(
        decideRequest(headers, { resolution: 'grant' }),
        requestId,
      );
      expect(decided.status).toBe(200);
      const body = await decided.text();
      expect(JSON.parse(body)).toMatchObject({
        request: { id: requestId, state: 'granted', tool: TOOL, decision: { resolution: 'grant' } },
      });
      expect(body).not.toContain(ARGUMENT_MARKER);

      // Decided: the creator's own view no longer holds them either.
      expect((await creatorView()).call).toMatchObject({ arguments: null, arguments_erased: true });
      expect(await rig.root.store.approvals.listActive(mission.id)).toMatchObject([
        { requestId, riskId: MERGE, tool: TOOL },
      ]);
    });

    it('the page’s form: 303 back to the request, with the outcome in the query', async () => {
      const headers = await sessionHeaders(rig.root, rig.seeded.ada, { 'content-type': FORM });
      const decided = await rig.root.requests.handlers.decide(
        decideRequest(headers, { resolution: 'open-gate' }),
        requestId,
      );
      expect(decided.status).toBe(303);
      expect(decided.headers.get('location')).toBe(`/waiting/${requestId}?decided=1`);
      const view = await creatorView();
      expect(view.request.state).toBe('granted');
      expect(view.gate.open_until).toBe(view.period.end);

      // A second request on the same risk: the gate is open, opening it again is refused.
      const again = await gatedCallWhileOpen();
      expect(again).toBe('allowed');
    });

    async function gatedCallWhileOpen(): Promise<string> {
      const { result } = await seedCall(rig, mission, {
        tool: TOOL,
        risks: [MERGE],
        args: { pull_number: 13 },
      });
      return result.outcome;
    }

    it('a decision the rules refuse comes back as ?problem=<code>; an unknown one as invalid-decision', async () => {
      const headers = await sessionHeaders(rig.root, rig.seeded.ada, { 'content-type': FORM });
      await rig.root.missions.service.revoke(rig.seeded.ada, mission.id);
      const refusedByRules = await rig.root.requests.handlers.decide(
        decideRequest(headers, { resolution: 'grant' }),
        requestId,
      );
      expect(refusedByRules.headers.get('location')).toBe(
        `/waiting/${requestId}?problem=mission-closed`,
      );
      const unknown = await rig.root.requests.handlers.decide(
        decideRequest(headers, { resolution: 'reset-period' }),
        requestId,
      );
      expect(unknown.headers.get('location')).toBe(
        `/waiting/${requestId}?problem=invalid-decision`,
      );
      const json = await rig.root.requests.handlers.decide(
        decideRequest(await sessionHeaders(rig.root, rig.seeded.ada), {
          resolution: 'grant',
          widen: true,
        }),
        requestId,
      );
      expect(json.status).toBe(422);
      expect(await json.json()).toMatchObject({ error: 'invalid-decision' });
      await stillSealed();
    });
  });

  it('after the decision, an operator searching the whole audit finds the act and no argument', async () => {
    await rig.root.requests.service.decide(rig.seeded.ada, requestId, { resolution: 'grant' });
    const everything = await rig.root.store.audit.list();
    expect(everything.some((e) => e.kind === 'admin' && e.act === 'approval-granted')).toBe(true);
    expect(JSON.stringify(everything)).not.toContain(ARGUMENT_MARKER);
    const session = await rig.root.store.sessions.getByMission(mission.id);
    expect(
      JSON.stringify(await rig.root.store.sessions.listEvents(session?.id ?? '')),
    ).not.toContain(ARGUMENT_MARKER);
  });
});
