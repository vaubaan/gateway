import { describe, expect, it } from 'vitest';

import { parseDuration } from './duration';

describe('parseDuration', () => {
  it('parses seconds, minutes, hours and days', () => {
    expect(parseDuration('30s')).toBe(30);
    expect(parseDuration('10m')).toBe(600);
    expect(parseDuration(' 24h ')).toBe(86_400);
    expect(parseDuration('7d')).toBe(604_800);
  });

  it('rejects anything else', () => {
    for (const bad of ['', '0s', '-1m', '1.5h', '10', 'h', '1w', '10 m', '1e3s']) {
      expect(parseDuration(bad), bad).toBeNull();
    }
  });
});
