/**
 * Structured refusals: every code, every field, the `hint` (spec §10).
 */
import { describe, expect, test } from 'vitest';
import type { Slice } from '@vaubaan/shared';

import {
  REFUSAL_CODES,
  REFUSAL_RPC_CODE,
  isRefusal,
  refuse,
  refusalToRpcError,
  type Refusal,
  type RefusalCode,
} from '../../src/index.ts';

const slice: Slice = {
  provider: 'github',
  path: [
    { kind: 'name', value: 'repo' },
    { kind: 'ident', value: 'acme/api' },
    { kind: 'name', value: 'branch' },
    { kind: 'ident', value: 'main' },
  ],
  action: 'W',
};

/** One refusal per code, built with every field set. */
const SAMPLES: Record<RefusalCode, () => Refusal> = {
  'risk-not-accepted': () =>
    refuse.riskNotAccepted({
      missing_risks: ['github.merge-protected'],
      executed_slices: [slice],
    }),
  'budget-exhausted': () =>
    refuse.budgetExhausted({
      risk_id: 'github.push-feature-branch',
      quota: 50,
      consumed: 50,
      period_end: '2026-10-14T00:00:00.000Z',
      claim_url: 'https://gateway.example.test/r/req_claim_1',
    }),
  'approval-required': () =>
    refuse.approvalRequired({
      risk_id: 'github.merge-protected',
      fingerprint: 'sha256:0123456789abcdef',
      approval_url: 'https://gateway.example.test/r/req_appr_1',
      expires_at: '2026-10-13T12:30:00.000Z',
    }),
  'resource-not-in-mission': () =>
    refuse.resourceNotInMission({
      cited_ref: 'acme/billing',
      connection: { id: 'con_1', name: 'GitHub (acme)' },
      allowed_resources: [
        { ref: 'acme/api', env: null, display_name: 'API' },
        { ref: 'acme/web', env: 'prod', display_name: null },
      ],
    }),
  'rate-limited': () =>
    refuse.rateLimited({
      risk_id: 'github.read-repo',
      limit: { max: 60, window_seconds: 60 },
      retry_after_seconds: 12,
    }),
  'connection-unavailable': () =>
    refuse.connectionUnavailable({
      connection: { id: 'con_1', name: 'GitHub (acme)' },
      status: 'expired',
      owner: { kind: 'group', display: 'GitHub admins' },
    }),
  'mission-inactive': () =>
    refuse.missionInactive({ status: 'orphaned', reason: 'the share grounding it was revoked' }),
  'wrong-credential-kind': () =>
    refuse.wrongCredentialKind({
      door: 'management',
      presented: 'mission-token',
      expected: 'delegated-token',
    }),
};

describe('refusal codes', () => {
  test('there are exactly eight codes and a builder sample for each', () => {
    expect(REFUSAL_CODES).toHaveLength(8);
    expect(new Set(REFUSAL_CODES).size).toBe(8);
    expect(Object.keys(SAMPLES).sort()).toEqual([...REFUSAL_CODES].sort());
  });

  test.each(REFUSAL_CODES)(
    '%s carries its code, a non-empty hint, and passes the guard',
    (code) => {
      const r = SAMPLES[code]();
      expect(r.code).toBe(code);
      expect(typeof r.hint).toBe('string');
      expect(r.hint.length).toBeGreaterThan(20);
      expect(isRefusal(r)).toBe(true);
      // Serializable as-is into JSON-RPC `data`.
      expect(JSON.parse(JSON.stringify(r))).toEqual(r);
    },
  );
});

describe('refusal fields', () => {
  test('risk-not-accepted: missing risks, executed slices, default hint names the risks', () => {
    const r = SAMPLES['risk-not-accepted']();
    expect(r.code).toBe('risk-not-accepted');
    if (r.code !== 'risk-not-accepted') return;
    expect(r.missing_risks).toEqual(['github.merge-protected']);
    expect(r.executed_slices).toEqual([slice]);
    expect(r.hint).toContain('github.merge-protected');
  });

  test('risk-not-accepted: an engine-provided hint is kept verbatim', () => {
    const r = refuse.riskNotAccepted({
      missing_risks: ['x.y'],
      executed_slices: [],
      hint: 'engine hint',
    });
    expect(r.hint).toBe('engine hint');
  });

  test('budget-exhausted: risk, quota, consumed, period end, claim URL; hint hands the URL to a human', () => {
    const r = SAMPLES['budget-exhausted']();
    if (r.code !== 'budget-exhausted') throw new Error('wrong code');
    expect(r.risk_id).toBe('github.push-feature-branch');
    expect(r.quota).toBe(50);
    expect(r.consumed).toBe(50);
    expect(r.period_end).toBe('2026-10-14T00:00:00.000Z');
    expect(r.claim_url).toBe('https://gateway.example.test/r/req_claim_1');
    expect(r.hint).toContain(r.claim_url);
    expect(r.hint).toContain(r.period_end!);
    expect(r.hint).toMatch(/human/i);
  });

  test('budget-exhausted: one-off mission has a null period end and the hint says so', () => {
    const r = refuse.budgetExhausted({
      risk_id: 'a.b',
      quota: 1,
      consumed: 1,
      period_end: null,
      claim_url: 'https://gateway.example.test/r/x',
    });
    expect(r.period_end).toBeNull();
    expect(r.hint).toMatch(/no next period/);
  });

  test('approval-required: risk, fingerprint, approval URL, expiry; hint says replay identically', () => {
    const r = SAMPLES['approval-required']();
    if (r.code !== 'approval-required') throw new Error('wrong code');
    expect(r.risk_id).toBe('github.merge-protected');
    expect(r.fingerprint).toBe('sha256:0123456789abcdef');
    expect(r.approval_url).toBe('https://gateway.example.test/r/req_appr_1');
    expect(r.expires_at).toBe('2026-10-13T12:30:00.000Z');
    expect(r.hint).toContain(r.approval_url);
    expect(r.hint).toMatch(/replay this call with exactly the same arguments/);
    expect(r.hint).toMatch(/Nothing was executed/);
  });

  test('resource-not-in-mission: cited ref, connection, allowed resources listed in the hint', () => {
    const r = SAMPLES['resource-not-in-mission']();
    if (r.code !== 'resource-not-in-mission') throw new Error('wrong code');
    expect(r.cited_ref).toBe('acme/billing');
    expect(r.connection).toEqual({ id: 'con_1', name: 'GitHub (acme)' });
    expect(r.allowed_resources.map((x) => x.ref)).toEqual(['acme/api', 'acme/web']);
    expect(r.hint).toContain('acme/billing');
    expect(r.hint).toContain('acme/api, acme/web');
  });

  test('resource-not-in-mission: empty selection says "no resource"', () => {
    const r = refuse.resourceNotInMission({
      cited_ref: 'x',
      connection: { id: 'c', name: 'C' },
      allowed_resources: [],
    });
    expect(r.hint).toContain('no resource');
  });

  test('rate-limited: risk, limit, retry delay', () => {
    const r = SAMPLES['rate-limited']();
    if (r.code !== 'rate-limited') throw new Error('wrong code');
    expect(r.risk_id).toBe('github.read-repo');
    expect(r.limit).toEqual({ max: 60, window_seconds: 60 });
    expect(r.retry_after_seconds).toBe(12);
    expect(r.hint).toContain('12s');
  });

  test('connection-unavailable: connection, status, owner to contact', () => {
    const r = SAMPLES['connection-unavailable']();
    if (r.code !== 'connection-unavailable') throw new Error('wrong code');
    expect(r.connection).toEqual({ id: 'con_1', name: 'GitHub (acme)' });
    expect(r.status).toBe('expired');
    expect(r.owner).toEqual({ kind: 'group', display: 'GitHub admins' });
    expect(r.hint).toContain('GitHub admins');
    expect(r.hint).toContain('expired');
  });

  test('connection-unavailable: a user owner is named by email', () => {
    const r = refuse.connectionUnavailable({
      connection: { id: 'c', name: 'Vercel' },
      status: 'revoked',
      owner: { kind: 'user', display: 'ana@example.test' },
    });
    expect(r.hint).toContain('ana@example.test');
  });

  test('mission-inactive: status and reason', () => {
    const r = SAMPLES['mission-inactive']();
    if (r.code !== 'mission-inactive') throw new Error('wrong code');
    expect(r.status).toBe('orphaned');
    expect(r.reason).toBe('the share grounding it was revoked');
    expect(r.hint).toContain('orphaned');
    expect(r.hint).toContain(r.reason);
  });

  test('wrong-credential-kind: door, presented, expected', () => {
    const r = SAMPLES['wrong-credential-kind']();
    if (r.code !== 'wrong-credential-kind') throw new Error('wrong code');
    expect(r.door).toBe('management');
    expect(r.presented).toBe('mission-token');
    expect(r.expected).toBe('delegated-token');
    expect(r.hint).toContain('management door');
    expect(r.hint).toContain('delegated-token');
  });
});

describe('isRefusal', () => {
  test('rejects non-refusals', () => {
    expect(isRefusal(null)).toBe(false);
    expect(isRefusal('risk-not-accepted')).toBe(false);
    expect(isRefusal({ code: 'not-a-code', hint: 'x' })).toBe(false);
    expect(isRefusal({ code: 'rate-limited' })).toBe(false);
    expect(isRefusal({ code: 'rate-limited', hint: '' })).toBe(false);
  });
});

describe('refusalToRpcError', () => {
  test('maps to -32603 with the whole refusal as data and the code in the message', () => {
    const r = SAMPLES['budget-exhausted']();
    const err = refusalToRpcError(7, r);
    expect(err.jsonrpc).toBe('2.0');
    expect(err.id).toBe(7);
    expect(err.error.code).toBe(REFUSAL_RPC_CODE);
    expect(err.error.code).toBe(-32603);
    expect(err.error.message).toContain('budget-exhausted');
    expect(err.error.data).toBe(r);
  });

  test('null id is preserved', () => {
    const err = refusalToRpcError(null, SAMPLES['rate-limited']());
    expect(err.id).toBeNull();
  });
});
