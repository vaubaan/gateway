import { describe, expect, test } from 'vitest';

import { parseEventDetails } from './session-events.ts';

const CALL = {
  tool: 'github__push',
  fingerprint: 'sha256:abc',
  risk_ids: ['github.write-code'],
  agent_label: null,
};
const SPAN = { period_start: '2026-10-13T00:00:00.000Z', period_end: null };

interface Sample {
  readonly kind: string;
  readonly valid: Record<string, unknown>;
  readonly malformed: Record<string, unknown>;
}

const SAMPLES: Record<string, Sample> = {
  'an allowed call': {
    kind: 'call-allowed',
    valid: { ...CALL, remaining: { 'github.write-code': 4 }, approval_ids: [] },
    malformed: { ...CALL, remaining: { 'github.write-code': 'four' }, approval_ids: [] },
  },
  'a refused call': {
    kind: 'call-refused',
    valid: { ...CALL, agent_label: 'reviewer', refusal_code: 'budget-exhausted', request_id: 'r1' },
    malformed: { ...CALL, refusal_code: 'not-a-refusal-code', request_id: 'r1' },
  },
  'a dropped request': {
    kind: 'request',
    valid: { request_id: 'r1', request_kind: 'claim', tool: 'github__push', fingerprint: 'f' },
    malformed: { request_id: 'r1', request_kind: 'claim' },
  },
  'a closed request': {
    kind: 'request',
    valid: { request_id: 'r1', request_kind: 'approval', state: 'expired' },
    malformed: { request_id: 'r1', request_kind: 'approval', state: 'granted' },
  },
  'a granted approval': {
    kind: 'approval',
    valid: {
      request_id: 'r1',
      approval_id: 'a1',
      tool: 'github__merge_pull_request',
      fingerprint: 'f',
      expires_at: '2026-10-13T09:10:00.000Z',
    },
    malformed: { request_id: 'r1', approval_id: 'a1', tool: 'github__merge_pull_request' },
  },
  'a gate opened for the period': {
    kind: 'gate-opened',
    valid: { request_id: 'r1', ...SPAN, period_end: '2026-10-14T00:00:00.000Z' },
    // A period that never ends cannot bound an opening.
    malformed: { request_id: 'r1', ...SPAN },
  },
  'a gate edited on the mission': {
    kind: 'gate-changed',
    valid: { gate: 'approval', gate_before: 'auto' },
    malformed: { gate: 'sometimes', gate_before: 'auto' },
  },
  'a period reset': {
    kind: 'reset',
    valid: { request_id: 'r1', ...SPAN, credits: { 'github.write-code': 3 } },
    malformed: { request_id: 'r1', periodStart: SPAN.period_start, period_end: null, credits: {} },
  },
  'a quota extension': {
    kind: 'extension',
    valid: {
      request_id: 'r1',
      dimension: 'quota',
      amount: 2,
      period_start: SPAN.period_start,
      period_end: '2026-10-14T00:00:00.000Z',
      credits: { 'github.write-code': 2 },
    },
    malformed: { request_id: 'r1', dimension: 'quota', amount: 2, ...SPAN, credit: {} },
  },
  'an expiry extension': {
    kind: 'extension',
    valid: {
      request_id: 'r1',
      dimension: 'expiry',
      expires_at_before: null,
      expires_at: '2026-11-01T00:00:00.000Z',
    },
    malformed: { request_id: 'r1', dimension: 'expiry', expires_at_before: null },
  },
  'a token rotation': {
    kind: 'rotation',
    valid: { token_prefix: 'vbn_abcd' },
    malformed: { token_prefix: 12 },
  },
  'a revocation': {
    kind: 'revocation',
    valid: { tokens_revoked: 1 },
    malformed: { tokens_revoked: '1' },
  },
};

describe('parseEventDetails', () => {
  test.each(Object.entries(SAMPLES))('reads the details of %s', (_name, sample) => {
    expect(parseEventDetails(sample.kind, sample.valid)).toEqual({
      kind: sample.kind,
      details: sample.valid,
    });
  });

  test.each(Object.entries(SAMPLES))(
    'answers null for malformed details of %s',
    (_name, sample) => {
      expect(parseEventDetails(sample.kind, sample.malformed)).toBeNull();
    },
  );

  test('answers null for a kind it does not know', () => {
    expect(parseEventDetails('refused-call', CALL)).toBeNull();
    expect(parseEventDetails('gate-closed', { gate: 'approval', gate_before: 'auto' })).toBeNull();
  });

  test('answers null when the stored details are not an object', () => {
    for (const details of [null, undefined, 'text', 3, ['tool']]) {
      expect(parseEventDetails('rotation', details)).toBeNull();
    }
  });

  test('ignores the keys the shape does not name', () => {
    const details = { tokens_revoked: 2, note: 'kept as stored' };
    expect(parseEventDetails('revocation', details)).toEqual({ kind: 'revocation', details });
  });

  test('reads a call with the token it presented and its holder, and a call stored before tokens had one', () => {
    const before = { ...CALL, remaining: {}, approval_ids: [] };
    expect(parseEventDetails('call-allowed', before)).toEqual({
      kind: 'call-allowed',
      details: before,
    });
    for (const attribution of [
      { token_id: 't1', token_kind: 'member', holder: 'usr-bob' },
      { token_id: 't2', token_kind: 'named', holder: 'CI runner' },
      { token_id: null, token_kind: null, holder: null },
    ]) {
      const details = { ...before, ...attribution };
      expect(parseEventDetails('call-allowed', details)).toEqual({
        kind: 'call-allowed',
        details,
      });
    }
    // A kind outside the closed set, or a holder that is not text, is not a call event.
    expect(parseEventDetails('call-allowed', { ...before, token_kind: 'machine' })).toBeNull();
    expect(parseEventDetails('call-allowed', { ...before, holder: 7 })).toBeNull();
    expect(parseEventDetails('call-allowed', { ...before, token_id: {} })).toBeNull();
  });

  test('reads a token issued to a holder and one token revoked on its own', () => {
    const issued = {
      token_prefix: 'AbCd1234',
      token_kind: 'named',
      holder: 'CI runner',
      replaced_prefix: null,
    };
    expect(parseEventDetails('rotation', issued)).toEqual({ kind: 'rotation', details: issued });
    const revoked = {
      tokens_revoked: 1,
      token_prefix: 'AbCd1234',
      token_kind: 'member',
      holder: 'usr-bob',
    };
    expect(parseEventDetails('revocation', revoked)).toEqual({
      kind: 'revocation',
      details: revoked,
    });
    expect(parseEventDetails('rotation', { ...issued, token_kind: 'robot' })).toBeNull();
    expect(parseEventDetails('rotation', { ...issued, replaced_prefix: 3 })).toBeNull();
    expect(parseEventDetails('revocation', { ...revoked, token_prefix: 3 })).toBeNull();
  });

  test('tells the two shapes of an extension apart on its dimension', () => {
    const parsed = parseEventDetails('extension', SAMPLES['an expiry extension']?.valid);
    expect(parsed?.kind === 'extension' && parsed.details.dimension === 'expiry').toBe(true);
  });
});
