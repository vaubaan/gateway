/**
 * Severity — the score that orders permissions and its word, one function for
 * the gateway's interface and the site.
 */
import { describe, expect, it } from 'vitest';

import { RISK_VECTOR_AXES } from '@vaubaan/shared';

import { MAX_SEVERITY, SEVERITY_RANKS, severityLevel, severityOf } from '../../src/severity.ts';

describe('severity', () => {
  it('ranks the axes exactly like the shared vector vocabulary', () => {
    expect(SEVERITY_RANKS).toEqual(RISK_VECTOR_AXES);
  });

  it('is 0 for the mildest vector and MAX_SEVERITY for the worst', () => {
    expect(
      severityOf({
        reversibility: 'reversible',
        blast: 'single',
        data: 'metadata',
        cost: 'free',
        visibility: 'internal',
        persistence: 'stateless',
      }),
    ).toBe(0);
    expect(
      severityOf({
        reversibility: 'irreversible',
        blast: 'bulk',
        data: 'pii',
        cost: 'unbounded',
        visibility: 'public',
        persistence: 'posture',
      }),
    ).toBe(MAX_SEVERITY);
  });

  it('buckets the score into four levels', () => {
    expect([0, 3, 4, 6, 7, 9, 10, MAX_SEVERITY].map(severityLevel)).toEqual([
      'low',
      'low',
      'medium',
      'medium',
      'high',
      'high',
      'critical',
      'critical',
    ]);
  });
});
