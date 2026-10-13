/**
 * Call pipeline skeleton: order of checks, refusal per stage, audit entry on
 * every path, decision core wired through the risk stage.
 */
import { describe, expect, test } from 'vitest';
import type { RiskCatalog, Slice } from '@vaubaan/shared';
import { indexCatalog } from '@vaubaan/policy-engine';

import {
  CallPipeline,
  MemoryAuditWriter,
  acceptedRisksOf,
  checkConnectionAvailable,
  checkMissionActive,
  evaluateCallForToken,
  fingerprintArguments,
  refuse,
  UpstreamRefusalError,
  type AuditWriter,
  type BudgetStage,
  type CallPipelineDeps,
  type CallRequest,
  type Classifier,
  type MissionConnection,
  type MissionContext,
  type MissionResource,
  type ResourceStage,
  type RiskStage,
  type UpstreamStage,
} from '../../src/index.ts';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const NOW = new Date('2026-10-13T10:00:00.000Z');

const catalog: RiskCatalog = {
  provider: 'supabase',
  risks: [
    {
      id: 'supabase.read-data',
      label: 'Read',
      reason: 'reads',
      matches: 'supabase.**.R',
      vector: {
        reversibility: 'reversible',
        blast: 'single',
        data: 'data',
        cost: 'free',
        visibility: 'internal',
        persistence: 'stateless',
      },
    },
    {
      id: 'supabase.bulk-row-write',
      label: 'Bulk',
      reason: 'bulk',
      matches: 'supabase.**.W',
      vector: {
        reversibility: 'costly',
        blast: 'bulk',
        data: 'data',
        cost: 'moderate',
        visibility: 'internal',
        persistence: 'session',
      },
    },
  ],
};
const indexed = indexCatalog(catalog);

const connection: MissionConnection = {
  id: 'con_1',
  provider: 'supabase',
  display_name: 'Supabase (acme)',
  status: 'active',
  owner: { kind: 'user', id: 'usr_1', display: 'ana@example.test' },
};

const resource: MissionResource = {
  id: 'res_1',
  connection_id: 'con_1',
  provider: 'supabase',
  ref: 'prj_x',
  env: 'staging',
  displayName: 'API staging',
  discovered_at: '2026-10-01T00:00:00.000Z',
};

const ctx: MissionContext = {
  mission: {
    id: 'mis_1',
    name: 'Explore',
    status: 'active',
    creator_id: 'usr_1',
    expires_at: null,
    period: { kind: 'one-off' },
  },
  token: { id: 'tok_1', prefix: 'vbn_live_abcd1234' },
  connections: [connection],
  resources: [resource],
  policy: [
    {
      risk_id: 'supabase.read-data',
      quota: 100,
      rate_limit: { max: 60, window_seconds: 60 },
      gate: 'auto',
    },
  ],
  session: null,
};

const call: CallRequest = {
  tool: 'supabase__execute_sql',
  args: { query: 'select 1' },
  agent_label: 'orchestrator',
  client: { ip: '10.0.0.1', user_agent: 'claude-code' },
};

function sliceFor(action: 'R' | 'W'): Slice {
  return {
    provider: 'supabase',
    path: [
      { kind: 'name', value: 'project' },
      { kind: 'ident', value: 'prj_x' },
      { kind: 'name', value: 'schema' },
      { kind: 'ident', value: 'public' },
      { kind: 'name', value: 'table' },
      { kind: 'ident', value: 'users' },
      { kind: 'name', value: 'row' },
      { kind: 'ident', value: 'bulk' },
    ],
    action,
  };
}

/** Risk stage over the real decision core; the classifier is a stub that
 *  emits a read or a write slice. The mission's resources on the target
 *  connection go straight to the classifier and the env resolver. */
function riskStage(action: 'R' | 'W' | 'deny' | 'no-catalog'): RiskStage {
  const classifier: Classifier = {
    classify: () =>
      action === 'deny'
        ? { denied: 'bad args' }
        : { slices: [sliceFor(action === 'W' ? 'W' : 'R')] },
  };
  return {
    evaluate: async (c, req, target) =>
      evaluateCallForToken({
        tool: req.tool,
        args: req.args,
        resources: c.resources.filter((r) => r.connection_id === target.connection.id),
        token: { id: c.token.id, accepted_risks: acceptedRisksOf(c), denied_risks: [] },
        adapter: classifier,
        catalog: action === 'no-catalog' ? undefined : indexed,
      }),
  };
}

const resolveTarget: ResourceStage = {
  resolve: async () => ({ ok: true, target: { connection, resource } }),
};

const allowBudget: BudgetStage = {
  decide: async (_c, _call, input) => ({
    outcome: 'allowed',
    session_id: 'ses_1',
    remaining: Object.fromEntries(input.risks_touched.map((r) => [r, 99])),
    approval_id: null,
  }),
};

const upstreamOk: UpstreamStage = { execute: async () => ({ rows: [] }) };

function pipeline(over: Partial<CallPipelineDeps> = {}) {
  const audit = new MemoryAuditWriter();
  const p = new CallPipeline({
    resources: resolveTarget,
    risks: riskStage('R'),
    budget: allowBudget,
    upstream: upstreamOk,
    audit,
    now: () => NOW,
    ...over,
  });
  return { p, audit };
}

// ─── Pure checks ─────────────────────────────────────────────────────────────

describe('checkMissionActive', () => {
  test('active, unlimited mission passes', () => {
    expect(checkMissionActive(ctx, NOW)).toBeNull();
  });

  test('status other than active is mission-inactive with that status', () => {
    for (const status of ['expired', 'orphaned', 'revoked'] as const) {
      const r = checkMissionActive({ ...ctx, mission: { ...ctx.mission, status } }, NOW);
      expect(r?.code).toBe('mission-inactive');
      if (r?.code === 'mission-inactive') expect(r.status).toBe(status);
    }
  });

  test('a passed expires_at is mission-inactive/expired even if the row still says active', () => {
    const r = checkMissionActive(
      { ...ctx, mission: { ...ctx.mission, expires_at: '2026-10-13T09:59:59.000Z' } },
      NOW,
    );
    expect(r?.code).toBe('mission-inactive');
    if (r?.code === 'mission-inactive') {
      expect(r.status).toBe('expired');
      expect(r.reason).toContain('2026-10-13T09:59:59.000Z');
    }
  });

  test('a future expires_at passes', () => {
    expect(
      checkMissionActive(
        { ...ctx, mission: { ...ctx.mission, expires_at: '2026-10-13T10:00:01.000Z' } },
        NOW,
      ),
    ).toBeNull();
  });
});

describe('checkConnectionAvailable', () => {
  test('active and unowned pass: an unowned connection keeps serving its missions (spec §2)', () => {
    expect(checkConnectionAvailable(connection)).toBeNull();
    expect(checkConnectionAvailable({ ...connection, status: 'unowned' })).toBeNull();
  });

  test('expired and revoked refuse naming the owner', () => {
    for (const status of ['expired', 'revoked'] as const) {
      const r = checkConnectionAvailable({ ...connection, status });
      expect(r?.code).toBe('connection-unavailable');
      if (r?.code === 'connection-unavailable') {
        expect(r.status).toBe(status);
        expect(r.owner.display).toBe('ana@example.test');
      }
    }
  });
});

// ─── Pipeline ────────────────────────────────────────────────────────────────

describe('CallPipeline', () => {
  test('happy path: allowed, result returned, one audit entry with the §8 fields', async () => {
    const { p, audit } = pipeline();
    const out = await p.execute(ctx, call);
    expect(out.kind).toBe('allowed');
    if (out.kind !== 'allowed') return;
    expect(out.result).toEqual({ rows: [] });
    expect(audit.calls).toHaveLength(1);
    const e = audit.calls[0]!;
    expect(e).toMatchObject({
      kind: 'call',
      ts: NOW.toISOString(),
      mission_id: 'mis_1',
      session_id: 'ses_1',
      connection_id: 'con_1',
      resource_ref: 'prj_x',
      tool: 'supabase__execute_sql',
      arguments_hash: fingerprintArguments(call.args),
      risks_touched: ['supabase.read-data'],
      accepted_risks_snapshot: ['supabase.read-data'],
      decision: 'allowed',
      refusal_code: null,
      refusal_reason: null,
      approval_id: null,
      remaining_budget: { 'supabase.read-data': 99 },
      agent_label: 'orchestrator',
      upstream_error: null,
      client_ip: '10.0.0.1',
      client_user_agent: 'claude-code',
    });
    expect(e.slices_executed).toHaveLength(1);
    expect(typeof e.upstream_latency_ms).toBe('number');
  });

  test('inactive mission: refused first, nothing else consulted, audited with the code', async () => {
    let touched = false;
    const { p, audit } = pipeline({
      resources: {
        resolve: async () => {
          touched = true;
          return { ok: true, target: { connection, resource } };
        },
      },
    });
    const out = await p.execute({ ...ctx, mission: { ...ctx.mission, status: 'revoked' } }, call);
    expect(out.kind).toBe('refused');
    if (out.kind !== 'refused') return;
    expect(out.refusal.code).toBe('mission-inactive');
    expect(touched).toBe(false);
    expect(audit.calls[0]).toMatchObject({
      decision: 'refused',
      refusal_code: 'mission-inactive',
      connection_id: null,
      remaining_budget: null,
    });
    expect(audit.calls[0]!.refusal_reason).toBe(out.refusal.hint);
  });

  test('resource outside the mission: refused before any risk is evaluated', async () => {
    let risksEvaluated = false;
    const refusal = refuse.resourceNotInMission({
      cited_ref: 'prj_other',
      connection: { id: 'con_1', name: connection.display_name },
      allowed_resources: [{ ref: 'prj_x', env: 'staging', display_name: 'API staging' }],
    });
    const { p, audit } = pipeline({
      resources: { resolve: async () => ({ ok: false, refusal }) },
      risks: {
        evaluate: async () => {
          risksEvaluated = true;
          return { kind: 'allow', risks_touched: [], executed_slices: [] };
        },
      },
    });
    const out = await p.execute(ctx, call);
    expect(out.kind).toBe('refused');
    if (out.kind === 'refused') expect(out.refusal).toBe(refusal);
    expect(risksEvaluated).toBe(false);
    expect(audit.calls[0]!.refusal_code).toBe('resource-not-in-mission');
  });

  test('expired connection: connection-unavailable, target recorded in the audit', async () => {
    const { p, audit } = pipeline({
      resources: {
        resolve: async () => ({
          ok: true,
          target: { connection: { ...connection, status: 'expired' }, resource },
        }),
      },
    });
    const out = await p.execute(ctx, call);
    expect(out.kind).toBe('refused');
    if (out.kind === 'refused') expect(out.refusal.code).toBe('connection-unavailable');
    expect(audit.calls[0]).toMatchObject({ connection_id: 'con_1', resource_ref: 'prj_x' });
  });

  test('risk not accepted: the decision core refuses a write the policy does not accept; budget untouched', async () => {
    let budgetCalled = false;
    const { p, audit } = pipeline({
      risks: riskStage('W'),
      budget: {
        decide: async (...a) => {
          budgetCalled = true;
          return allowBudget.decide(...a);
        },
      },
    });
    const out = await p.execute(ctx, call);
    expect(out.kind).toBe('refused');
    if (out.kind !== 'refused' || out.refusal.code !== 'risk-not-accepted')
      throw new Error('wrong code');
    expect(out.refusal.missing_risks).toEqual(['supabase.bulk-row-write']);
    expect(out.refusal.executed_slices).toHaveLength(1);
    expect(out.refusal.hint).toContain('supabase.bulk-row-write');
    expect(budgetCalled).toBe(false);
    expect(audit.calls[0]).toMatchObject({
      refusal_code: 'risk-not-accepted',
      risks_touched: ['supabase.bulk-row-write'],
    });
    expect(audit.calls[0]!.slices_executed).toHaveLength(1);
  });

  test('classifier denial and missing catalog are rejected without a code (fail closed)', async () => {
    const denied = pipeline({ risks: riskStage('deny') });
    const d = await denied.p.execute(ctx, call);
    expect(d.kind).toBe('rejected');
    if (d.kind === 'rejected') expect(d.reason).toBe('bad args');
    expect(denied.audit.calls[0]).toMatchObject({
      decision: 'refused',
      refusal_code: null,
      refusal_reason: 'bad args',
    });

    const missing = pipeline({ risks: riskStage('no-catalog') });
    const m = await missing.p.execute(ctx, call);
    expect(m.kind).toBe('rejected');
    if (m.kind === 'rejected') expect(m.reason).toMatch(/catalog.*not loaded/);
  });

  test('budget refusal: nothing executed upstream, refusal and risks recorded', async () => {
    let executed = false;
    const refusal = refuse.budgetExhausted({
      risk_id: 'supabase.read-data',
      quota: 100,
      consumed: 100,
      period_end: null,
      claim_url: 'https://gateway.example.test/r/req_1',
    });
    const { p, audit } = pipeline({
      budget: { decide: async () => ({ outcome: 'refused', refusal }) },
      upstream: {
        execute: async () => {
          executed = true;
          return {};
        },
      },
    });
    const out = await p.execute(ctx, call);
    expect(out.kind).toBe('refused');
    if (out.kind === 'refused') expect(out.refusal).toBe(refusal);
    expect(executed).toBe(false);
    expect(audit.calls[0]).toMatchObject({
      refusal_code: 'budget-exhausted',
      risks_touched: ['supabase.read-data'],
      remaining_budget: null,
    });
  });

  test('approval consumed is carried into the audit entry', async () => {
    const { p, audit } = pipeline({
      budget: {
        decide: async () => ({
          outcome: 'allowed',
          session_id: 'ses_1',
          remaining: { 'supabase.read-data': 4 },
          approval_id: 'apr_1',
        }),
      },
    });
    await p.execute(ctx, call);
    expect(audit.calls[0]).toMatchObject({
      approval_id: 'apr_1',
      remaining_budget: { 'supabase.read-data': 4 },
    });
  });

  test('upstream failure after an allow: decision stays allowed, upstream_error set, outcome failed', async () => {
    const { p, audit } = pipeline({
      upstream: {
        execute: async () => {
          throw new Error('boom');
        },
      },
    });
    const out = await p.execute(ctx, call);
    expect(out.kind).toBe('failed');
    if (out.kind === 'failed') expect(out.error).toBe('boom');
    expect(audit.calls[0]).toMatchObject({
      decision: 'allowed',
      upstream_error: 'boom',
      session_id: 'ses_1',
    });
  });

  test('a plain upstream failure carries no refusal', async () => {
    const { p } = pipeline({
      upstream: {
        execute: async () => {
          throw new Error('boom');
        },
      },
    });
    const out = await p.execute(ctx, call);
    expect(out.kind === 'failed' && out.refusal).toBeNull();
  });

  test('UpstreamRefusalError: the entry stays allowed, the outcome carries the refusal', async () => {
    const refusal = refuse.connectionUnavailable({
      connection: { id: connection.id, name: connection.display_name },
      status: 'expired',
      owner: connection.owner,
    });
    const { p, audit } = pipeline({
      upstream: {
        execute: async () => {
          throw new UpstreamRefusalError(refusal, 'the provider rejected the credential');
        },
      },
    });
    const out = await p.execute(ctx, call);
    expect(out.kind).toBe('failed');
    if (out.kind === 'failed') {
      expect(out.refusal).toBe(refusal);
      expect(out.error).toBe('connection-unavailable: the provider rejected the credential');
    }
    expect(audit.calls).toHaveLength(1);
    expect(audit.calls[0]).toMatchObject({
      decision: 'allowed',
      refusal_code: null,
      upstream_error: 'connection-unavailable: the provider rejected the credential',
      remaining_budget: expect.any(Object) as object,
    });
  });

  test('a call with no target is a structural rejection, audited without a code', async () => {
    let evaluated = false;
    const { p, audit } = pipeline({
      resources: { resolve: async () => ({ ok: false, reason: "unknown tool 'x__y'" }) },
      risks: {
        evaluate: async () => {
          evaluated = true;
          return { kind: 'no-catalog', provider: 'x' };
        },
      },
    });
    const out = await p.execute(ctx, call);
    expect(out).toMatchObject({ kind: 'rejected', reason: "unknown tool 'x__y'" });
    expect(evaluated).toBe(false);
    expect(audit.calls[0]).toMatchObject({
      decision: 'refused',
      refusal_code: null,
      refusal_reason: "unknown tool 'x__y'",
      connection_id: null,
    });
  });

  test('an audit write failure propagates: no call completes without its entry', async () => {
    const failing: AuditWriter = {
      write: async () => {
        throw new Error('disk full');
      },
    };
    const { p } = pipeline({ audit: failing });
    await expect(p.execute(ctx, call)).rejects.toThrow('disk full');
  });
});
