import { describe, expect, it } from 'vitest';

import { IMAGE_PREFIX, PINNED_IMAGE } from '../../src/identifiers.js';

/**
 * The two image patterns are built from `[a-z0-9]+(?:[._-][a-z0-9]+)*`, which
 * Semgrep's `detect-redos` flags. Every repetition starts with a separator the
 * component class does not hold, so a string splits one way only and a
 * rejection is linear. These inputs would take seconds to minutes on a pattern
 * that backtracks; here each one is refused at once.
 */
describe('image patterns stay linear on hostile input', () => {
  const hostile = [
    `${'a'.repeat(50_000)}!`,
    `${'a.'.repeat(25_000)}!`,
    `${'a/'.repeat(25_000)}a@sha256:${'0'.repeat(63)}`,
    `${'a-'.repeat(25_000)}/b:${'t'.repeat(128)}@sha256:${'0'.repeat(64)}x`,
  ];

  it.each(hostile.map((value, index) => [index, value] as const))(
    'refuses hostile input %i quickly',
    (_index, value) => {
      for (const pattern of [PINNED_IMAGE, IMAGE_PREFIX]) {
        const started = performance.now();
        expect(pattern.test(value)).toBe(false);
        expect(performance.now() - started).toBeLessThan(250);
      }
    },
  );

  it('still accepts what it accepted', () => {
    expect(PINNED_IMAGE.test(`ghcr.io/acme/app:1.2.3@sha256:${'a'.repeat(64)}`)).toBe(true);
    expect(IMAGE_PREFIX.test('registry.fly.io/')).toBe(true);
    expect(IMAGE_PREFIX.test('ghcr.io/acme/app')).toBe(true);
  });
});
