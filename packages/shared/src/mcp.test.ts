import { describe, expect, test } from 'vitest';

import { splitToolName, toolPrefixFor } from './mcp.ts';
import { REFUSAL_CODES, isRefusalCode } from './refusal.ts';

describe('toolPrefixFor / splitToolName', () => {
  test('maps hyphens to underscores and back', () => {
    expect(toolPrefixFor('cloudflare-dns')).toBe('cloudflare_dns__');
    expect(splitToolName('cloudflare_dns__list_records')).toEqual({
      providerId: 'cloudflare-dns',
      localName: 'list_records',
    });
  });

  test('plain provider', () => {
    expect(splitToolName('github__list_branches')).toEqual({
      providerId: 'github',
      localName: 'list_branches',
    });
  });

  test('splits on the first separator only', () => {
    expect(splitToolName('github__get__thing')).toEqual({
      providerId: 'github',
      localName: 'get__thing',
    });
  });

  test.each(['list_branches', '__x', 'github__', 'Git__x', '1a__x'])(
    'returns null for %j',
    (name) => {
      expect(splitToolName(name)).toBeNull();
    },
  );
});

describe('refusal codes', () => {
  test('exactly the eight codes of spec §4.1 and §6', () => {
    expect([...REFUSAL_CODES].sort()).toEqual(
      [
        'approval-required',
        'budget-exhausted',
        'connection-unavailable',
        'mission-inactive',
        'rate-limited',
        'resource-not-in-mission',
        'risk-not-accepted',
        'wrong-credential-kind',
      ].sort(),
    );
  });
  test('isRefusalCode narrows', () => {
    expect(isRefusalCode('rate-limited')).toBe(true);
    expect(isRefusalCode('forbidden')).toBe(false);
  });
});
