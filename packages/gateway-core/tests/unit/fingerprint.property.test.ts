/**
 * Properties of the argument fingerprint (spec §6, §8): one value, one
 * fingerprint, whatever the order of an object's keys; two values that JSON
 * tells apart, two fingerprints.
 *
 * Seeded and replayable (`propertyRuns`, FC_SEED / FC_RUNS).
 */
import { propertyRuns } from '@vaubaan/plugin-sdk/testing';
import fc from 'fast-check';
import { describe, it } from 'vitest';

import { canonicalJson, fingerprintArguments } from '../../src/fingerprint.ts';

/** The same value with every object's keys in reverse order. */
function reversed(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reversed);
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .reverse()
        .map(([key, member]) => [key, reversed(member)]),
    );
  }
  return value;
}

const json = fc.jsonValue({ maxDepth: 3 });

describe('argument fingerprint', () => {
  it('does not depend on the order of the keys', () => {
    fc.assert(
      fc.property(
        json,
        (value) => fingerprintArguments(value) === fingerprintArguments(reversed(value)),
      ),
      propertyRuns(),
    );
  });

  it('is the same for a value and its JSON round trip', () => {
    fc.assert(
      fc.property(
        json,
        (value) =>
          fingerprintArguments(value) ===
          fingerprintArguments(JSON.parse(JSON.stringify(value)) as unknown),
      ),
      propertyRuns(),
    );
  });

  it('tells apart two values whose canonical JSON differs', () => {
    fc.assert(
      fc.property(json, json, (a, b) => {
        if (canonicalJson(a) === canonicalJson(b)) return true;
        return fingerprintArguments(a) !== fingerprintArguments(b);
      }),
      propertyRuns(),
    );
  });

  it('is 64 hexadecimal characters, and "no arguments" is the empty object', () => {
    fc.assert(
      fc.property(json, (value) => /^[0-9a-f]{64}$/.test(fingerprintArguments(value))),
      propertyRuns(),
    );
    fc.assert(
      fc.property(
        fc.constantFrom(undefined, null),
        (none) => fingerprintArguments(none) === fingerprintArguments({}),
      ),
      propertyRuns(),
    );
  });
});
