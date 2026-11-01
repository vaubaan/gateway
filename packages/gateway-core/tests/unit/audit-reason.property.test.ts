/**
 * Properties of the audit copy of a structural reason (spec §6, §8): no argument
 * value the reason quotes survives, the result is bounded, and a second pass
 * changes nothing.
 *
 * Seeded and replayable (`propertyRuns`, FC_SEED / FC_RUNS).
 */
import { propertyRuns } from '@vaubaan/plugin-sdk/testing';
import fc from 'fast-check';
import { describe, it } from 'vitest';

import { ARGUMENT_PLACEHOLDER, AUDIT_REASON_MAX_LENGTH, auditReason } from '../../src/pipeline.ts';

/** Argument values made of digits and `/`: none can be found inside the placeholder. */
const argumentValue = fc.stringMatching(/^[0-9/]{3,20}$/);
/** The plugin's own words around a quoted value: letters and spaces only. */
const words = fc.stringMatching(/^[a-z ]{0,40}$/);
const args = fc.dictionary(fc.stringMatching(/^[a-z]{1,8}$/), argumentValue, {
  minKeys: 1,
  maxKeys: 4,
});

describe('audit reason', () => {
  it('keeps no argument value the reason quotes', () => {
    fc.assert(
      fc.property(words, words, args, (before, after, a) => {
        const quoted = Object.values(a);
        const reason = `${before}${quoted.join(' and ')}${after}`;
        const kept = auditReason(reason, a);
        return quoted.every((value) => !kept.includes(value));
      }),
      propertyRuns(),
    );
  });

  it('is never longer than the bound, and leaves a reason without arguments as it is', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 1_200 }), args, (reason, a) => {
        if (auditReason(reason, a).length > AUDIT_REASON_MAX_LENGTH) return false;
        return reason.length > AUDIT_REASON_MAX_LENGTH || auditReason(reason, {}) === reason;
      }),
      propertyRuns(),
    );
  });

  it('changes nothing on a second pass', () => {
    fc.assert(
      fc.property(words, words, args, (before, after, a) => {
        const once = auditReason(`${before}${Object.values(a).join(' ')}${after}`, a);
        return auditReason(once, a) === once && !ARGUMENT_PLACEHOLDER.match(/[0-9/]/);
      }),
      propertyRuns(),
    );
  });
});
