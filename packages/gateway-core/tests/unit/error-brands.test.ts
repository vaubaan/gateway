/**
 * The host's own upstream errors are recognised by their brand too (ADR
 * plugins-bundled-or-pinned-by-the-operator: no `instanceof` on these classes).
 */
import { describe, expect, test } from 'vitest';

import { refuse } from '../../src/errors.ts';
import {
  isUpstreamFailureError,
  isUpstreamRefusalError,
  UpstreamFailureError,
  UpstreamRefusalError,
} from '../../src/pipeline.ts';

const refusal = refuse.connectionUnavailable({
  connection: { id: 'c1', name: 'acme' },
  status: 'expired',
  owner: { kind: 'user', display: 'ada' },
});

describe('host error brands', () => {
  test('recognise their instances and nothing else', () => {
    expect(isUpstreamRefusalError(new UpstreamRefusalError(refusal))).toBe(true);
    const failure = new UpstreamFailureError({ summary: 's', detail: 'd', status: null });
    expect(isUpstreamFailureError(failure)).toBe(true);
    expect(isUpstreamRefusalError(failure)).toBe(false);
    expect(isUpstreamFailureError(new Error('d'))).toBe(false);
    expect(
      isUpstreamFailureError(
        Object.assign(new Error('d'), { summary: 's', detail: 'd', status: 1 }),
      ),
    ).toBe(false);
  });

  test('read the fields they promise', () => {
    const branded = Object.assign(new Error('x'), { refusal: { code: 'nope' } });
    Object.defineProperty(branded, Symbol.for('@vaubaan/plugin-sdk/UpstreamRefusalError'), {
      value: true,
    });
    expect(isUpstreamRefusalError(branded)).toBe(false);
  });
});
