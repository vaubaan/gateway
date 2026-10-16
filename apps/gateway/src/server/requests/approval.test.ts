import { describe, expect, it } from 'vitest';

import {
  APPROVAL_RESOLUTIONS,
  approvalOptions,
  checkApprovalDecision,
  closedGates,
  formatDelay,
  parseApprovalDecision,
  quoted,
  type ApprovalRiskSituation,
  type ApprovalSituation,
} from './approval';

const RISK = 'github.merge-protected';
const OTHER = 'github.delete-branch';

/** One-risk overrides (`gate`, `gate_open`) apply to the single risk of the request. */
type Overrides = Partial<ApprovalSituation> & Partial<Omit<ApprovalRiskSituation, 'risk_id'>>;

function situation(overrides: Overrides = {}): ApprovalSituation {
  const { gate = 'approval', gate_open = false, ...rest } = overrides;
  return {
    mission_state: 'active',
    period_end: '2026-10-14T00:00:00.000Z',
    risks: [{ risk_id: RISK, gate, gate_open }],
    tool: 'github__merge_pull_request',
    approval_valid_seconds: 600,
    request_expires_at: '2026-10-14T09:00:00.000Z',
    ...rest,
  };
}

/** A request that covers a call touching two gated risks. */
function twoRisks(
  first: Partial<ApprovalRiskSituation> = {},
  second: Partial<ApprovalRiskSituation> = {},
): ApprovalSituation {
  return situation({
    risks: [
      { risk_id: RISK, gate: 'approval', gate_open: false, ...first },
      { risk_id: OTHER, gate: 'approval', gate_open: false, ...second },
    ],
  });
}

const optionOf = (s: ApprovalSituation, resolution: string) => {
  const option = approvalOptions(s).find((o) => o.resolution === resolution);
  if (!option) throw new Error(`no option ${resolution}`);
  return option;
};

describe('approvalOptions', () => {
  it('always returns the three actions in the same order, each with one line of consequence', () => {
    const options = approvalOptions(situation());
    expect(options.map((o) => o.resolution)).toEqual([...APPROVAL_RESOLUTIONS]);
    expect(options.map((o) => o.label)).toEqual([
      'Approve this action',
      'Open the gate for the rest of the period',
      'Refuse',
    ]);
    for (const option of options) {
      expect(option.unavailable).toBeNull();
      expect(option.consequence.length).toBeGreaterThan(20);
      expect(option.consequence).not.toContain('\n');
    }
  });

  it('says what a grant covers: this tool, once, within the configured delay, against the budget', () => {
    const { consequence } = optionOf(situation(), 'grant');
    expect(consequence).toContain('github__merge_pull_request');
    expect(consequence).toContain('once, within 10 minutes');
    expect(consequence).toContain('quota and the rate limit');
    expect(optionOf(situation({ approval_valid_seconds: 90 }), 'grant').consequence).toContain(
      'within 90 seconds',
    );
  });

  it('says until when the gate would be open, and that it closes again', () => {
    const { consequence } = optionOf(situation(), 'open-gate');
    expect(consequence).toContain(`'${RISK}'`);
    expect(consequence).toContain('until the period ends (2026-10-14 00:00 UTC)');
    expect(consequence).toContain('approval again from the next period');
  });
});

describe('checkApprovalDecision', () => {
  it('accepts the three resolutions on an active mission whose risk is gated', () => {
    for (const resolution of APPROVAL_RESOLUTIONS) {
      expect(checkApprovalDecision(situation(), { resolution })).toBeNull();
    }
  });

  it('a refusal is always possible', () => {
    for (const state of ['revoked', 'orphaned', 'expired'] as const) {
      expect(
        checkApprovalDecision(situation({ mission_state: state }), { resolution: 'refuse' }),
      ).toBeNull();
    }
    expect(checkApprovalDecision(situation({ gate: null }), { resolution: 'refuse' })).toBeNull();
  });

  it.each([
    ['revoked', 'mission-closed'],
    ['orphaned', 'mission-closed'],
    ['expired', 'mission-expired'],
  ] as const)('a %s mission takes neither a grant nor an opening (%s)', (state, code) => {
    const s = situation({ mission_state: state });
    expect(checkApprovalDecision(s, { resolution: 'grant' })?.code).toBe(code);
    expect(checkApprovalDecision(s, { resolution: 'open-gate' })?.code).toBe(code);
    expect(optionOf(s, 'grant').unavailable?.code).toBe(code);
    expect(optionOf(s, 'refuse').unavailable).toBeNull();
  });

  it('an orphaned mission: the sentence states until when the request can still be granted', () => {
    const s = situation({ mission_state: 'orphaned' });
    const message = checkApprovalDecision(s, { resolution: 'grant' })?.message;
    expect(message).toContain('until it expires (2026-10-14 09:00 UTC)');
    expect(message).toContain('next refused call opens a new one');
    expect(optionOf(s, 'open-gate').unavailable?.message).toBe(message);
  });

  it('a risk that left the policy takes neither', () => {
    const s = situation({ gate: null });
    expect(checkApprovalDecision(s, { resolution: 'grant' })?.code).toBe('risk-not-in-policy');
    expect(checkApprovalDecision(s, { resolution: 'open-gate' })?.code).toBe('risk-not-in-policy');
  });

  it('a gate already auto or already open cannot be opened; a grant stays possible', () => {
    for (const s of [situation({ gate: 'auto' }), situation({ gate_open: true })]) {
      expect(checkApprovalDecision(s, { resolution: 'open-gate' })?.code).toBe('gate-not-closed');
      expect(checkApprovalDecision(s, { resolution: 'grant' })).toBeNull();
    }
  });

  it('a mission whose single period never ends has no "rest of the period"', () => {
    const s = situation({ period_end: null });
    expect(checkApprovalDecision(s, { resolution: 'open-gate' })).toMatchObject({
      code: 'no-period-end',
      message: expect.stringContaining('mission page') as string,
    });
    expect(checkApprovalDecision(s, { resolution: 'grant' })).toBeNull();
  });
});

describe('parseApprovalDecision', () => {
  it('reads a JSON body or form fields', () => {
    for (const resolution of APPROVAL_RESOLUTIONS) {
      expect(parseApprovalDecision({ resolution })).toEqual({ ok: true, decision: { resolution } });
    }
  });

  it.each([
    [null],
    ['grant'],
    [['grant']],
    [{}],
    [{ resolution: 'approve' }],
    // A claim's resolution is not an approval's.
    [{ resolution: 'reset-period' }],
    // An approval takes a resolution and nothing else: no way to widen what is granted.
    [{ resolution: 'grant', fingerprint: 'f'.repeat(64) }],
    [{ resolution: 'open-gate', risk_id: 'github.read-code' }],
  ])('refuses %j', (raw) => {
    expect(parseApprovalDecision(raw)).toMatchObject({
      ok: false,
      problem: { code: 'invalid-decision' },
    });
  });
});

describe('formatDelay', () => {
  it.each([
    [600, '10 minutes'],
    [60, '1 minute'],
    [90, '90 seconds'],
    [1, '1 second'],
    [3600, '1 hour'],
    [7200, '2 hours'],
    [5400, '90 minutes'],
  ])('%i s reads "%s"', (seconds, text) => {
    expect(formatDelay(seconds)).toBe(text);
  });
});

describe('a request that covers a call touching several gated risks', () => {
  it('says that one approval covers them all, and names each', () => {
    const grant = optionOf(twoRisks(), 'grant');
    expect(grant.unavailable).toBeNull();
    expect(grant.consequence).toContain(
      'This one approval covers the 2 gated risks the call touches.',
    );
    expect(grant.consequence).toContain(`any other call on '${RISK}' and '${OTHER}' asks again`);
    // A one-risk request reads as it always did.
    expect(optionOf(situation(), 'grant').consequence).not.toContain('This one approval covers');
    expect(optionOf(situation(), 'grant').consequence).toContain(
      `any other call on '${RISK}' asks again`,
    );
  });

  it('opening the gate opens every gate still closed, and only those', () => {
    expect(closedGates(twoRisks())).toEqual([RISK, OTHER]);
    expect(optionOf(twoRisks(), 'open-gate').consequence).toContain(
      `Every call touching '${RISK}' and '${OTHER}' passes without asking you`,
    );
    expect(optionOf(twoRisks(), 'open-gate').consequence).toContain('The gates are approval again');

    const oneLeft = twoRisks({ gate_open: true });
    expect(closedGates(oneLeft)).toEqual([OTHER]);
    expect(checkApprovalDecision(oneLeft, { resolution: 'open-gate' })).toBeNull();
    expect(optionOf(oneLeft, 'open-gate').consequence).toContain(
      `Every call touching '${OTHER}' passes`,
    );
    expect(optionOf(oneLeft, 'open-gate').consequence).toContain('The gate is approval again');
  });

  it('nothing to open when every gate is auto or already open; a grant stays possible', () => {
    for (const s of [
      twoRisks({ gate: 'auto' }, { gate_open: true }),
      twoRisks({ gate_open: true }, { gate_open: true }),
    ]) {
      expect(closedGates(s)).toEqual([]);
      expect(checkApprovalDecision(s, { resolution: 'open-gate' })).toMatchObject({
        code: 'gate-not-closed',
        message: expect.stringContaining(`'${RISK}' and '${OTHER}'`) as string,
      });
      expect(checkApprovalDecision(s, { resolution: 'grant' })).toBeNull();
    }
  });

  it('one risk that left the policy blocks the grant of the whole call, and is named', () => {
    const s = twoRisks({}, { gate: null });
    expect(checkApprovalDecision(s, { resolution: 'grant' })).toEqual({
      code: 'risk-not-in-policy',
      message: `'${OTHER}' is no longer accepted by the mission.`,
    });
    expect(checkApprovalDecision(s, { resolution: 'open-gate' })?.code).toBe('risk-not-in-policy');
    expect(checkApprovalDecision(s, { resolution: 'refuse' })).toBeNull();
    expect(
      checkApprovalDecision(twoRisks({ gate: null }, { gate: null }), { resolution: 'grant' })
        ?.message,
    ).toBe(`'${RISK}' and '${OTHER}' are no longer accepted by the mission.`);
  });

  it('quotes a list of risks the way a sentence reads', () => {
    expect(quoted([])).toBe('');
    expect(quoted(['a'])).toBe("'a'");
    expect(quoted(['a', 'b'])).toBe("'a' and 'b'");
    expect(quoted(['a', 'b', 'c'])).toBe("'a', 'b' and 'c'");
  });
});
