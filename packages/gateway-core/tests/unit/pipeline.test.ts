/**
 * Call pipeline skeleton: order of checks, refusal per stage, audit entry on
 * every path, decision core wired through the risk stage.
 */
import { describe, expect, test } from 'vitest';
import type { RiskCatalog, Slice } from '@vaubaan/shared';
import { indexCatalog } from '@vaubaan/policy-engine';

import {
  CallPipeline,
  checkAccountAvailable,
  checkMissionActive,
  UPSTREAM_ERROR_SUMMARY_MAX_LENGTH,
  UpstreamFailureError,
  UpstreamRefusalError,
  upstreamErrorClassName,
  type BudgetStage,
  type CallPipelineDeps,
  type CallRequest,
  type ResourceStage,
  type RiskStage,
  type UpstreamStage,
} from '../../src/pipeline.ts';
import { MemoryAuditWriter, type AuditWriter } from '../../src/audit.ts';
import {
  acceptedRisksOf,
  type MissionAccount,
  type MissionContext,
  type MissionResource,
} from '../../src/types.ts';
import { evaluateCallForMission, type Classifier } from '../../src/risk-gateway.ts';
import { fingerprintArguments } from '../../src/fingerprint.ts';
import { refuse } from '../../src/errors.ts';

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
      },
    },
  ],
};
const indexed = indexCatalog(catalog);

const account: MissionAccount = {
  id: 'con_1',
  provider: 'supabase',
  display_name: 'Supabase (acme)',
  status: 'active',
  owner: { kind: 'user', id: 'usr_1', display: 'ana@example.test' },
};

const resource: MissionResource = {
  id: 'res_1',
  account_id: 'con_1',
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
  token: {
    id: 'tok_1',
    prefix: 'vbn_live_abcd1234',
    holder: { kind: 'member', user_id: 'usr_1', display: 'ada@example.com' },
  },
  accounts: [account],
  resources: [resource],
  resource_sets: [{ id: 'set_1', account_id: 'con_1', position: 1, resource_ids: ['res_1'] }],
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
 *  account go straight to the classifier and the env resolver. */
function riskStage(action: 'R' | 'W' | 'deny' | 'no-catalog'): RiskStage {
  const classifier: Classifier = {
    classify: () =>
      action === 'deny'
        ? { denied: 'bad args' }
        : { slices: [sliceFor(action === 'W' ? 'W' : 'R')] },
  };
  return {
    evaluate: async (c, req, target) =>
      evaluateCallForMission({
        tool: req.tool,
        args: req.args,
        resources: c.resources.filter((r) => r.account_id === target.account.id),
        mission: { id: c.token.id, accepted_risks: acceptedRisksOf(c) },
        adapter: classifier,
        catalog: action === 'no-catalog' ? undefined : indexed,
      }),
  };
}

const resolveTarget: ResourceStage = {
  resolve: async () => ({ ok: true, target: { account, resource } }),
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

  test('an unreadable expires_at is mission-inactive/expired: the check fails closed', () => {
    for (const expires_at of ['not-a-date', '', '13/10/2026 at noon']) {
      const r = checkMissionActive({ ...ctx, mission: { ...ctx.mission, expires_at } }, NOW);
      expect(r?.code).toBe('mission-inactive');
      if (r?.code === 'mission-inactive') {
        expect(r.status).toBe('expired');
        expect(r.reason).toContain('unreadable');
      }
    }
  });

  test('an expired status without a stored expiry says so', () => {
    const r = checkMissionActive(
      { ...ctx, mission: { ...ctx.mission, status: 'expired', expires_at: null } },
      NOW,
    );
    expect(r?.code === 'mission-inactive' && r.reason).toBe(
      'the mission expired at an unknown time',
    );
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

describe('checkAccountAvailable', () => {
  test('active and unowned pass: an unowned account keeps serving its missions (spec §2)', () => {
    expect(checkAccountAvailable(account)).toBeNull();
    expect(checkAccountAvailable({ ...account, status: 'unowned' })).toBeNull();
  });

  test('expired refuses naming the owner who reconnects it', () => {
    const r = checkAccountAvailable({ ...account, status: 'expired' });
    expect(r?.code).toBe('account-unavailable');
    if (r?.code === 'account-unavailable') {
      expect(r.status).toBe('expired');
      expect(r.owner.display).toBe('ana@example.test');
    }
  });

  test('revoked, or lost to the mission, refuses account-revoked', () => {
    const revoked = checkAccountAvailable({ ...account, status: 'revoked' });
    expect(revoked).toMatchObject({ code: 'account-revoked', final: true });
    const withdrawn = checkAccountAvailable({ ...account, lost: 'access-withdrawn' });
    expect(withdrawn).toMatchObject({
      code: 'account-revoked',
      cause: 'access-withdrawn',
      final: false,
      account: { id: account.id },
    });
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
      // Spec §8 "the token used and its holder": from the authenticated context.
      token_id: 'tok_1',
      token_kind: 'member',
      token_holder: 'usr_1',
      session_id: 'ses_1',
      account_id: 'con_1',
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

  test('an argument JSON cannot carry (Infinity) is rejected before any stage: the approver would have read `null`', async () => {
    let touched = false;
    const { p, audit } = pipeline({
      resources: {
        resolve: async () => {
          touched = true;
          return { ok: true, target: { account, resource } };
        },
      },
    });
    // `1e999` in a JSON-RPC body parses to Infinity; serialized again it reads `null`.
    const args = JSON.parse('{"query":"select 1","limit":1e999}') as Record<string, unknown>;
    const out = await p.execute(ctx, { ...call, args });
    expect(out.kind).toBe('rejected');
    if (out.kind !== 'rejected') return;
    expect(out.reason).toContain('limit');
    expect(out.reason).toContain('Infinity');
    expect(touched).toBe(false);
    expect(audit.calls).toHaveLength(1);
    expect(audit.calls[0]).toMatchObject({
      decision: 'refused',
      refusal_code: null,
      account_id: null,
      remaining_budget: null,
    });
    // The caller reads which argument; the audit, which keeps no trace of the arguments
    // but their hash, keeps what was wrong and not the name the caller chose.
    const stored = audit.calls[0]!.refusal_reason ?? '';
    expect(stored).toContain('Infinity');
    expect(stored).toContain('arguments must be JSON values');
    expect(stored).not.toContain('limit');
  });

  test('a classifier denial that quotes an argument: the agent reads it whole, the audit entry holds no argument value', async () => {
    const secretPath = 'secrets/prod.env';
    const reason = `path: '${secretPath}' is not a file of this mission (asked by ops@acme.example)`;
    const { p, audit } = pipeline({
      risks: { evaluate: async () => ({ kind: 'classify-denied', reason }) },
    });
    const out = await p.execute(ctx, {
      ...call,
      args: { path: secretPath, nested: { by: ['ops@acme.example'] }, n: 12, ok: 'a' },
    });
    expect(out.kind).toBe('rejected');
    if (out.kind !== 'rejected') return;
    // The caller sent the arguments: it reads its own values back.
    expect(out.reason).toBe(reason);
    // The audit is read by others, for as long as retention says: by fingerprint only.
    const stored = audit.calls[0]!.refusal_reason ?? '';
    expect(stored).not.toContain(secretPath);
    expect(stored).not.toContain('ops@acme.example');
    expect(stored).toBe("path: '[argument]' is not a file of this mission (asked by [argument])");
    expect(out.audit.refusal_reason).toBe(stored);
  });

  test('the audit copy is redacted in one pass: a short value is not found inside a placeholder already written', async () => {
    // `argument` and `ment` are values too: replaced one after the other, the second
    // would be matched inside the `[argument]` the first one left.
    const reason = "argument 'ment' of statement 'argument-list' is refused";
    const { p, audit } = pipeline({
      risks: { evaluate: async () => ({ kind: 'classify-denied', reason }) },
    });
    await p.execute(ctx, { ...call, args: { a: 'argument', b: 'ment', c: 'argument-list' } });
    expect(audit.calls[0]!.refusal_reason).toBe(
      "[argument] '[argument]' of state[argument] '[argument]' is refused",
    );
  });

  test('a value with characters a pattern would read is replaced as text', async () => {
    const value = 'a.*(b)|[c]$^+?{1}\\';
    const { p, audit } = pipeline({
      risks: { evaluate: async () => ({ kind: 'classify-denied', reason: `bad: ${value}!` }) },
    });
    await p.execute(ctx, { ...call, args: { q: value } });
    expect(audit.calls[0]!.refusal_reason).toBe('bad: [argument]!');
  });

  test('the audit copy of a structural reason is bounded', async () => {
    const { p, audit } = pipeline({
      risks: { evaluate: async () => ({ kind: 'classify-denied', reason: 'x'.repeat(5000) }) },
    });
    const out = await p.execute(ctx, call);
    expect(out.kind === 'rejected' && out.reason.length).toBe(5000);
    expect(audit.calls[0]!.refusal_reason!.length).toBeLessThanOrEqual(500);
  });

  test('inactive mission: refused first, nothing else consulted, audited with the code', async () => {
    let touched = false;
    const { p, audit } = pipeline({
      resources: {
        resolve: async () => {
          touched = true;
          return { ok: true, target: { account, resource } };
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
      account_id: null,
      remaining_budget: null,
    });
    expect(audit.calls[0]!.refusal_reason).toBe(out.refusal.hint);
  });

  test('resource outside the mission: refused before any risk is evaluated', async () => {
    let risksEvaluated = false;
    const refusal = refuse.resourceNotInMission({
      cited_ref: 'prj_other',
      account: { id: 'con_1', name: account.display_name },
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

  test('expired account: account-unavailable, target recorded in the audit', async () => {
    const { p, audit } = pipeline({
      resources: {
        resolve: async () => ({
          ok: true,
          target: { account: { ...account, status: 'expired' }, resource },
        }),
      },
    });
    const out = await p.execute(ctx, call);
    expect(out.kind).toBe('refused');
    if (out.kind === 'refused') expect(out.refusal.code).toBe('account-unavailable');
    expect(audit.calls[0]).toMatchObject({ account_id: 'con_1', resource_ref: 'prj_x' });
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
      upstream_error: 'upstream call failed (Error)',
      session_id: 'ses_1',
    });
  });

  test('UpstreamFailureError: the audit stores the summary, the outcome carries the detail', async () => {
    const marker = 'select-marker-7f3a9c';
    const detail = `Supabase API POST /query 400: syntax error at or near "${marker}"`;
    const { p, audit } = pipeline({
      upstream: {
        execute: async () => {
          throw new UpstreamFailureError({
            summary: 'supabase answered HTTP 400 (Error)',
            detail,
            status: 400,
          });
        },
      },
    });
    const out = await p.execute(ctx, { ...call, args: { ...call.args, sql: marker } });
    expect(out).toMatchObject({ kind: 'failed', error: detail, refusal: null });
    expect(audit.calls[0]?.upstream_error).toBe('supabase answered HTTP 400 (Error)');
    expect(JSON.stringify(audit.calls)).not.toContain(marker);
    expect(JSON.stringify(out.audit)).not.toContain(marker);
  });

  test('a stage that throws a plain error: its message never reaches the audit', async () => {
    const marker = 'object-marker-7f3a9c';
    const { p, audit } = pipeline({
      upstream: {
        execute: async () => {
          throw new TypeError(`no such object ${marker}`);
        },
      },
    });
    const out = await p.execute(ctx, call);
    expect(out).toMatchObject({ kind: 'failed', error: `no such object ${marker}` });
    expect(audit.calls[0]?.upstream_error).toBe('upstream call failed (TypeError)');
    expect(JSON.stringify(audit.calls)).not.toContain(marker);
  });

  test('the stored summary is bounded, whatever the stage hands over', async () => {
    const { p, audit } = pipeline({
      upstream: {
        execute: async () => {
          throw new UpstreamFailureError({ summary: 'x'.repeat(5000), detail: 'd', status: null });
        },
      },
    });
    await p.execute(ctx, call);
    expect(audit.calls[0]?.upstream_error).toHaveLength(UPSTREAM_ERROR_SUMMARY_MAX_LENGTH);
  });

  test('upstreamErrorClassName: an identifier-shaped name, never free text', () => {
    expect(upstreamErrorClassName(new RangeError('x'))).toBe('RangeError');
    const renamed = new Error('x');
    renamed.name = "syntax error near 'secret'";
    expect(upstreamErrorClassName(renamed)).toBe('Error');
    renamed.name = 'A'.repeat(200);
    expect(upstreamErrorClassName(renamed)).toBe('Error');
    expect(upstreamErrorClassName('a thrown string')).toBe('Error');
    expect(upstreamErrorClassName(null)).toBe('Error');
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
    const refusal = refuse.accountUnavailable({
      account: { id: account.id, name: account.display_name },
      status: 'expired',
      owner: account.owner,
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
      expect(out.error).toBe('account-unavailable: the provider rejected the credential');
    }
    expect(audit.calls).toHaveLength(1);
    expect(audit.calls[0]).toMatchObject({
      decision: 'allowed',
      refusal_code: null,
      // The refusal and its status; the broker's message (which may quote the
      // provider) stays on the outcome.
      upstream_error: 'account-unavailable: expired',
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
      account_id: null,
    });
  });

  describe('a stage that throws before the decision: refused AND audited (spec §8)', () => {
    class ClassifierBug extends TypeError {
      constructor(message: string) {
        super(message);
        this.name = 'ClassifierBug';
      }
    }
    const neverUpstream = (): { stage: UpstreamStage; calls: () => number } => {
      let calls = 0;
      return {
        stage: {
          execute: async () => {
            calls += 1;
            return {};
          },
        },
        calls: () => calls,
      };
    };

    test('a classifier that throws: one audit entry, no budget, no upstream, no message kept', async () => {
      const upstream = neverUpstream();
      let budgetAsked = false;
      const seen: { stage: string; error: unknown }[] = [];
      const { p, audit } = pipeline({
        risks: {
          evaluate: async () => {
            // A classifier's error text can quote what it choked on.
            throw new ClassifierBug("cannot read 'select 1' of undefined");
          },
        },
        budget: {
          decide: async (...args) => {
            budgetAsked = true;
            return allowBudget.decide(...args);
          },
        },
        upstream: upstream.stage,
        onStageError: (stage, error) => seen.push({ stage, error }),
      });

      const out = await p.execute(ctx, call);

      expect(out.kind).toBe('rejected');
      if (out.kind !== 'rejected') return;
      expect(out.reason).toContain('risk stage');
      expect(out.reason).toContain('ClassifierBug');
      expect(out.reason).not.toContain('select 1');
      expect(budgetAsked).toBe(false);
      expect(upstream.calls()).toBe(0);
      expect(audit.calls).toHaveLength(1);
      expect(audit.calls[0]).toMatchObject({
        decision: 'refused',
        refusal_code: null,
        refusal_reason: out.reason,
        // What was known when the stage failed is kept.
        account_id: 'con_1',
        resource_ref: 'prj_x',
        tool: call.tool,
        arguments_hash: fingerprintArguments(call.args),
        token_id: 'tok_1',
        remaining_budget: null,
      });
      expect(JSON.stringify(audit.calls[0])).not.toContain('select 1');
      expect(seen).toHaveLength(1);
      expect(seen[0]!.stage).toBe('risk');
      expect(seen[0]!.error).toBeInstanceOf(ClassifierBug);
    });

    test('the resource stage throws: audited with no target', async () => {
      const upstream = neverUpstream();
      const { p, audit } = pipeline({
        resources: {
          resolve: async () => {
            throw new Error('SQLITE_IOERR');
          },
        },
        upstream: upstream.stage,
      });
      const out = await p.execute(ctx, call);
      expect(out.kind).toBe('rejected');
      if (out.kind === 'rejected') expect(out.reason).toContain('resource stage');
      expect(upstream.calls()).toBe(0);
      expect(audit.calls).toHaveLength(1);
      expect(audit.calls[0]).toMatchObject({
        decision: 'refused',
        refusal_code: null,
        account_id: null,
      });
    });

    test('the budget stage throws: audited with the risks the call touched, nothing forwarded', async () => {
      const upstream = neverUpstream();
      const { p, audit } = pipeline({
        budget: {
          decide: async () => {
            throw new Error('database is locked');
          },
        },
        upstream: upstream.stage,
      });
      const out = await p.execute(ctx, call);
      expect(out.kind).toBe('rejected');
      if (out.kind === 'rejected') {
        expect(out.reason).toContain('budget stage');
        expect(out.reason).not.toContain('database is locked');
      }
      expect(upstream.calls()).toBe(0);
      expect(audit.calls).toHaveLength(1);
      expect(audit.calls[0]).toMatchObject({
        decision: 'refused',
        refusal_code: null,
        risks_touched: ['supabase.read-data'],
        remaining_budget: null,
        session_id: null,
      });
    });

    test('a thrown value that is not an error, and a free-text error name, read `Error`', async () => {
      const named = new Error('x');
      named.name = 'drop table users; --';
      for (const thrown of ['a string', named]) {
        const { p, audit } = pipeline({
          risks: {
            evaluate: async () => {
              // eslint-disable-next-line @typescript-eslint/only-throw-error -- the case under test
              throw thrown;
            },
          },
        });
        const out = await p.execute(ctx, call);
        expect(out).toMatchObject({ kind: 'rejected' });
        expect(audit.calls[0]!.refusal_reason).toContain('(Error)');
        expect(audit.calls[0]!.refusal_reason).not.toContain('drop table');
      }
    });

    test('an observer that throws does not un-audit the refusal', async () => {
      const { p, audit } = pipeline({
        risks: {
          evaluate: async () => {
            throw new Error('boom');
          },
        },
        onStageError: () => {
          throw new Error('logger down');
        },
      });
      const out = await p.execute(ctx, call);
      expect(out.kind).toBe('rejected');
      expect(audit.calls).toHaveLength(1);
    });

    test('the audit write of that refusal failing still propagates', async () => {
      const failing: AuditWriter = {
        write: async () => {
          throw new Error('disk full');
        },
      };
      const { p } = pipeline({
        audit: failing,
        risks: {
          evaluate: async () => {
            throw new Error('boom');
          },
        },
      });
      await expect(p.execute(ctx, call)).rejects.toThrow('disk full');
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

  test('an audit write that fails after a successful forward is not an upstream failure', async () => {
    // The provider call happened. A writer that fails once must make the
    // call reject (no entry, no completed call) — never be caught as "the
    // provider failed" and stored as `upstream_error` on a second write.
    const stored = new MemoryAuditWriter();
    let writes = 0;
    const failsOnce: AuditWriter = {
      write: async (entry) => {
        writes += 1;
        if (writes === 1) throw new Error('SQLITE_BUSY');
        await stored.write(entry);
      },
    };
    let upstreamCalls = 0;
    const { p } = pipeline({
      audit: failsOnce,
      upstream: {
        execute: async () => {
          upstreamCalls += 1;
          return { rows: [] };
        },
      },
    });
    await expect(p.execute(ctx, call)).rejects.toThrow('SQLITE_BUSY');
    expect(upstreamCalls).toBe(1);
    expect(writes).toBe(1);
    expect(stored.calls.filter((e) => e.upstream_error !== null)).toEqual([]);
  });

  test('an audit write that fails after an upstream failure propagates too', async () => {
    const failing: AuditWriter = {
      write: async () => {
        throw new Error('disk full');
      },
    };
    const { p } = pipeline({
      audit: failing,
      upstream: {
        execute: async () => {
          throw new Error('boom');
        },
      },
    });
    await expect(p.execute(ctx, call)).rejects.toThrow('disk full');
  });
});
