import type { RiskVector } from '@vaubaan/shared';
import { describe, expect, it } from 'vitest';

import { RISK_KINDS, riskKindOf } from '../../src/index.ts';

const vector: RiskVector = {
  reversibility: 'reversible',
  blast: 'single',
  data: 'data',
  cost: 'free',
  visibility: 'internal',
};

describe('the kind of a catalog entry', () => {
  it('is a read when every pattern reads, whatever the vector', () => {
    expect(riskKindOf({ matches: ['a.b.R', 'a.c.R'] }, vector)).toBe('read');
    expect(riskKindOf({ matches: 'a.b.R' }, { ...vector, reversibility: 'irreversible' })).toBe(
      'read',
    );
  });

  it('is a write as soon as one pattern writes, destructive when the vector is irreversible', () => {
    expect(riskKindOf({ matches: ['a.b.R', 'a.c.W'] }, vector)).toBe('write');
    expect(riskKindOf({ matches: 'a.c.W' }, { ...vector, reversibility: 'irreversible' })).toBe(
      'destructive',
    );
  });

  it('orders the kinds from the mildest', () => {
    expect(RISK_KINDS).toEqual(['read', 'write', 'destructive']);
  });
});
