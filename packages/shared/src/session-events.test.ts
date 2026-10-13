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

  test('answers null for a kind without a details shape', () => {
    expect(parseEventDetails('gate-opened', { risk_id: 'github.write-code' })).toBeNull();
    expect(parseEventDetails('approval', {})).toBeNull();
    expect(parseEventDetails('refused-call', CALL)).toBeNull();
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

  test('tells the two shapes of an extension apart on its dimension', () => {
    const parsed = parseEventDetails('extension', SAMPLES['an expiry extension']?.valid);
    expect(parsed?.kind === 'extension' && parsed.details.dimension === 'expiry').toBe(true);
  });
});
