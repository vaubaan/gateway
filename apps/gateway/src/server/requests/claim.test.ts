import { describe, expect, it } from 'vitest';

import {
  checkClaimDecision,
  CLAIM_RESOLUTIONS,
  claimOptions,
  formatUtc,
  orphanedProblem,
  parseClaimDecision,
  type ClaimSituation,
} from './claim';

const RISK = 'github.write-feature-branch';
const NOW = new Date('2026-10-13T09:00:00.000Z');

function situation(overrides: Partial<ClaimSituation> = {}): ClaimSituation {
  return {
    now: NOW,
    mission_state: 'active',
    expires_at: '2026-10-20T00:00:00.000Z',
    period_end: '2026-10-14T00:00:00.000Z',
    risk_id: RISK,
    quota: 5,
    consumed: 5,
    request_expires_at: '2026-10-14T09:00:00.000Z',
    ...overrides,
  };
}

const optionOf = (s: ClaimSituation, resolution: string) => {
  const option = claimOptions(s).find((o) => o.resolution === resolution);
  if (!option) throw new Error(`no option ${resolution}`);
  return option;
};

describe('claimOptions', () => {
  it('always lists the four actions in the same order, each with one consequence line', () => {
    const options = claimOptions(situation());
    expect(options.map((o) => o.resolution)).toEqual([...CLAIM_RESOLUTIONS]);
    for (const option of options) {
      expect(option.consequence).not.toContain('\n');
      expect(option.consequence.length).toBeGreaterThan(20);
      expect(option.unavailable).toBeNull();
    }
  });

  it('says what stays exhausted and until when', () => {
    const s = situation();
    expect(optionOf(s, 'refuse').consequence).toContain(
      `'${RISK}' stays exhausted until the period ends (2026-10-14 00:00 UTC)`,
    );
    expect(optionOf(s, 'extend-expiry').consequence).toContain('stays exhausted');
    expect(optionOf(s, 'reset-period').consequence).toContain(
      `The counter of '${s.risk_id}' goes back to zero`,
    );
    expect(optionOf(s, 'reset-period').consequence).toContain(
      'The other risks of the mission keep what they consumed',
    );
    expect(optionOf(s, 'reset-period').consequence).not.toMatch(/every counter/i);
    expect(optionOf(s, 'extend-quota').consequence).toContain('for the current period only');
    expect(optionOf(s, 'extend-quota').consequence).toContain('the quota is 5 again');
  });

  it('a one-off mission has no next period', () => {
    const s = situation({ period_end: null });
    expect(optionOf(s, 'refuse').consequence).toContain('for the rest of this one-off mission');
    expect(optionOf(s, 'extend-quota').consequence).toContain(
      'a permanent change goes through the mission itself',
    );
  });

  it('bounds the quota extension by what was consumed', () => {
    expect(optionOf(situation({ consumed: 3 }), 'extend-quota').max_amount).toBe(3);
  });

  it('a new expiry must come after the later of now and the current expiry', () => {
    expect(optionOf(situation(), 'extend-expiry').after).toBe('2026-10-20T00:00:00.000Z');
    expect(
      optionOf(situation({ expires_at: '2026-10-01T00:00:00.000Z' }), 'extend-expiry').after,
    ).toBe(NOW.toISOString());
  });

  it('a mission that never expires has nothing to extend', () => {
    expect(optionOf(situation({ expires_at: null }), 'extend-expiry').unavailable?.code).toBe(
      'no-expiry',
    );
  });

  it.each(['revoked', 'orphaned'] as const)('a %s mission leaves only the refusal', (state) => {
    const options = claimOptions(situation({ mission_state: state }));
    expect(options.filter((o) => o.unavailable === null).map((o) => o.resolution)).toEqual([
      'refuse',
    ]);
    expect(options[0]?.unavailable?.code).toBe('mission-closed');
  });

  it('an orphaned mission: the sentence states until when the request can still be granted', () => {
    const [reset] = claimOptions(situation({ mission_state: 'orphaned' }));
    expect(reset?.unavailable?.message).toBe(orphanedProblem('2026-10-14T09:00:00.000Z'));
    expect(reset?.unavailable?.message).toContain(
      'can be granted once that authority is back, until it expires (2026-10-14 09:00 UTC)',
    );
    expect(reset?.unavailable?.message).toContain('next refused call opens a new one');
    // A revoked mission never comes back: nothing is promised.
    const [revoked] = claimOptions(situation({ mission_state: 'revoked' }));
    expect(revoked?.unavailable?.message).not.toContain('until it expires');
  });

  it('an expired mission can only be extended or refused', () => {
    const options = claimOptions(
      situation({ mission_state: 'expired', expires_at: '2026-10-01T00:00:00.000Z' }),
    );
    expect(options.filter((o) => o.unavailable === null).map((o) => o.resolution)).toEqual([
      'extend-expiry',
      'refuse',
    ]);
    expect(options[0]?.unavailable?.code).toBe('mission-expired');
  });

  it('a risk that left the policy cannot be reset or extended', () => {
    const s = situation({ quota: null });
    expect(optionOf(s, 'reset-period').unavailable?.code).toBe('risk-not-in-policy');
    expect(optionOf(s, 'extend-quota').unavailable?.code).toBe('risk-not-in-policy');
  });

  it('after a rollover nothing was consumed: no quota to give back, a reset stays possible', () => {
    const s = situation({ consumed: 0 });
    expect(optionOf(s, 'extend-quota').unavailable?.code).toBe('nothing-consumed');
    expect(optionOf(s, 'reset-period').unavailable).toBeNull();
  });
});

describe('checkClaimDecision', () => {
  it('accepts each resolution in the nominal situation', () => {
    const s = situation();
    expect(checkClaimDecision(s, { resolution: 'reset-period' })).toBeNull();
    expect(checkClaimDecision(s, { resolution: 'extend-quota', amount: 5 })).toBeNull();
    expect(
      checkClaimDecision(s, {
        resolution: 'extend-expiry',
        expires_at: '2026-11-01T00:00:00.000Z',
      }),
    ).toBeNull();
    expect(checkClaimDecision(s, { resolution: 'refuse' })).toBeNull();
  });

  it.each([0, -1, 1.5, Number.NaN])('refuses the amount %s', (amount) => {
    expect(checkClaimDecision(situation(), { resolution: 'extend-quota', amount })?.code).toBe(
      'invalid-amount',
    );
  });

  it('refuses more than what was consumed, naming the bound', () => {
    const problem = checkClaimDecision(situation({ consumed: 3 }), {
      resolution: 'extend-quota',
      amount: 4,
    });
    expect(problem?.code).toBe('invalid-amount');
    expect(problem?.message).toContain('At most 3');
  });

  it('refuses an expiry that is not later than the current one, or not a date', () => {
    const s = situation();
    expect(
      checkClaimDecision(s, { resolution: 'extend-expiry', expires_at: '2026-10-20T00:00:00.000Z' })
        ?.code,
    ).toBe('invalid-expiry');
    expect(
      checkClaimDecision(s, { resolution: 'extend-expiry', expires_at: 'tomorrow' })?.code,
    ).toBe('invalid-expiry');
  });

  it('a refusal is always possible', () => {
    for (const state of ['active', 'expired', 'orphaned', 'revoked'] as const) {
      expect(
        checkClaimDecision(situation({ mission_state: state, quota: null }), {
          resolution: 'refuse',
        }),
      ).toBeNull();
    }
  });

  it('applies the same availability as the options', () => {
    expect(
      checkClaimDecision(situation({ mission_state: 'revoked' }), { resolution: 'reset-period' })
        ?.code,
    ).toBe('mission-closed');
    expect(
      checkClaimDecision(situation({ expires_at: null }), {
        resolution: 'extend-expiry',
        expires_at: '2027-01-01T00:00:00.000Z',
      })?.code,
    ).toBe('no-expiry');
  });
});

describe('parseClaimDecision', () => {
  it('reads a JSON body', () => {
    expect(parseClaimDecision({ resolution: 'reset-period' })).toEqual({
      ok: true,
      decision: { resolution: 'reset-period' },
    });
    expect(parseClaimDecision({ resolution: 'extend-quota', amount: 3 })).toEqual({
      ok: true,
      decision: { resolution: 'extend-quota', amount: 3 },
    });
  });

  it('reads form fields, where every value is a string', () => {
    expect(parseClaimDecision({ resolution: 'extend-quota', amount: ' 3 ' })).toEqual({
      ok: true,
      decision: { resolution: 'extend-quota', amount: 3 },
    });
  });

  it('reads a datetime-local value as UTC, whatever the time zone of the process', () => {
    expect(
      parseClaimDecision({ resolution: 'extend-expiry', expires_at: '2026-11-01T10:00' }),
    ).toEqual({
      ok: true,
      decision: { resolution: 'extend-expiry', expires_at: '2026-11-01T10:00:00.000Z' },
    });
    expect(
      parseClaimDecision({ resolution: 'extend-expiry', expires_at: '2026-11-01T10:00:00+02:00' }),
    ).toMatchObject({ decision: { expires_at: '2026-11-01T08:00:00.000Z' } });
  });

  it.each([
    [null, 'invalid-decision'],
    ['reset-period', 'invalid-decision'],
    [[], 'invalid-decision'],
    [{}, 'invalid-decision'],
    [{ resolution: 'grant-everything' }, 'invalid-decision'],
    [{ resolution: 'reset-period', amount: 3 }, 'invalid-decision'],
    [{ resolution: 'refuse', risk_id: 'github.*' }, 'invalid-decision'],
    [{ resolution: 'extend-quota' }, 'invalid-amount'],
    [{ resolution: 'extend-quota', amount: 'many' }, 'invalid-amount'],
    [{ resolution: 'extend-quota', amount: 1.5 }, 'invalid-amount'],
    [{ resolution: 'extend-expiry' }, 'invalid-expiry'],
    [{ resolution: 'extend-expiry', expires_at: '' }, 'invalid-expiry'],
    [{ resolution: 'extend-expiry', expires_at: 42 }, 'invalid-expiry'],
  ])('refuses %j with %s', (raw, code) => {
    const parsed = parseClaimDecision(raw);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.problem.code).toBe(code);
  });
});

describe('formatUtc', () => {
  it('is minute-precise and says UTC', () => {
    expect(formatUtc('2026-10-14T09:05:59.123Z')).toBe('2026-10-14 09:05 UTC');
  });
});
