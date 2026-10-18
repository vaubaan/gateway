/**
 * Structured refusals: every code, every field, the `hint` (spec §10).
 */
import { describe, expect, test } from 'vitest';
import type { Slice } from '@vaubaan/shared';

import {
  AUTH_FAILURE_MESSAGES,
  AUTH_FAILURE_REASONS,
  AUTH_REQUIRED_HTTP_STATUS,
  AUTH_REQUIRED_RPC_CODE,
  AuthError,
  GatewayError,
  REFUSAL_CODES,
  REFUSAL_RPC_CODE,
  isRefusal,
  isUnavailableConnectionStatus,
  refuse,
  refusalToRpcError,
  rpcError,
  rpcSuccess,
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
      hint: 'this mission does not accept [github.merge-protected]. Ask the mission creator to re-issue with these risks accepted, or restrict the operation.',
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
      approval_valid_seconds: 600,
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
  test('risk-not-accepted: missing risks, executed slices, the engine hint names the risks', () => {
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

  test('approval-required: risk, fingerprint, approval URL, expiry, validity; hint says replay identically', () => {
    const r = SAMPLES['approval-required']();
    if (r.code !== 'approval-required') throw new Error('wrong code');
    expect(r.risk_id).toBe('github.merge-protected');
    expect(r.fingerprint).toBe('sha256:0123456789abcdef');
    expect(r.approval_url).toBe('https://gateway.example.test/r/req_appr_1');
    expect(r.expires_at).toBe('2026-10-13T12:30:00.000Z');
    expect(r.approval_valid_seconds).toBe(600);
    expect(r.hint).toContain(r.approval_url);
    expect(r.hint).toContain(r.expires_at);
    expect(r.hint).toMatch(/replay this call with the same tool and exactly the same arguments/);
    expect(r.hint).toMatch(/within 600s of the grant/);
    expect(r.hint).toMatch(/used once/);
    expect(r.hint).toMatch(/Nothing was executed and nothing is held/);
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

  test('resource-not-in-mission: a whole-account mission says when a new resource is reached', () => {
    const r = refuse.resourceNotInMission({
      cited_ref: 'new-app',
      connection: { id: 'con_1', name: 'Fly (acme)' },
      allowed_resources: [{ ref: 'web', env: null, display_name: null }],
      reaches_later_resources: true,
    });
    expect(r.code).toBe('resource-not-in-mission');
    expect(r.cited_ref).toBe('new-app');
    expect(r.hint).toContain(
      'This mission reaches the whole account except the resources its owner hid or that are no longer found: web today.',
    );
    expect(r.hint).toContain(
      'A resource created through the gateway is reached right after its creation',
    );
    expect(r.hint).not.toContain('ask the mission creator to add the resource');
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

  test('mission-inactive: an orphaned mission is told how long an earlier request stays grantable', () => {
    const orphaned = refuse.missionInactive({ status: 'orphaned', reason: 'authority lost' });
    expect(orphaned.hint).toContain(
      'A request opened before the mission was orphaned can be granted only until it expires; after that, your next refused call opens a new one.',
    );
    // Only the reversible status carries that promise.
    for (const status of ['expired', 'revoked'] as const) {
      expect(refuse.missionInactive({ status, reason: 'x' }).hint).not.toContain(
        'until it expires',
      );
    }
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

describe('connection statuses', () => {
  test('only expired and revoked make a connection unavailable', () => {
    expect(isUnavailableConnectionStatus('expired')).toBe(true);
    expect(isUnavailableConnectionStatus('revoked')).toBe(true);
    expect(isUnavailableConnectionStatus('active')).toBe(false);
    expect(isUnavailableConnectionStatus('unowned')).toBe(false);
  });
});

describe('rpcError / rpcSuccess', () => {
  test('rpcError omits data when undefined and keeps it otherwise', () => {
    expect(rpcError(1, -32601, 'Method not found')).toEqual({
      jsonrpc: '2.0',
      id: 1,
      error: { code: -32601, message: 'Method not found' },
    });
    expect(rpcError('a', -32602, 'Invalid params', { field: 'x' }).error.data).toEqual({
      field: 'x',
    });
  });

  test('rpcSuccess wraps the result', () => {
    expect(rpcSuccess(null, { ok: true })).toEqual({
      jsonrpc: '2.0',
      id: null,
      result: { ok: true },
    });
  });
});

describe('transport errors', () => {
  test('AuthError carries the -32001 code and the 401 status', () => {
    const e = new AuthError('unknown bearer');
    expect(e).toBeInstanceOf(GatewayError);
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe('AuthError');
    expect(e.code).toBe(AUTH_REQUIRED_RPC_CODE);
    expect(e.code).toBe(-32001);
    expect(e.httpStatus).toBe(AUTH_REQUIRED_HTTP_STATUS);
    expect(e.httpStatus).toBe(401);
    expect(e.message).toBe('unknown bearer');
  });
});

describe('a mission token that stopped working', () => {
  test('is an authentication failure with its reason, never a refusal code', () => {
    expect([...AUTH_FAILURE_REASONS]).toEqual([
      'token-rotated',
      'token-revoked',
      'holder-removed',
      'holder-deactivated',
    ]);
    for (const reason of AUTH_FAILURE_REASONS) {
      const error = AuthError.tokenStopped(reason);
      expect(error).toBeInstanceOf(AuthError);
      expect(error.code).toBe(AUTH_REQUIRED_RPC_CODE);
      expect(error.httpStatus).toBe(AUTH_REQUIRED_HTTP_STATUS);
      expect(error.reason).toBe(reason);
      expect(error.message).toBe(AUTH_FAILURE_MESSAGES[reason]);
      // Each tells the agent to go back to a human, and none is a code of the closed set.
      expect(error.message).toMatch(/human/);
      expect((REFUSAL_CODES as readonly string[]).includes(reason)).toBe(false);
    }
    // The eight refusal codes are untouched.
    expect(REFUSAL_CODES).toHaveLength(8);
  });

  test('an unknown bearer carries no reason: nothing is said about a token that was never proven', () => {
    expect(new AuthError('unknown or revoked bearer.').reason).toBeNull();
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
