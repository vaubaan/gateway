import { describe, expect, test } from 'vitest';
import {
  type Capability,
  capabilityKey,
  covers,
  formatCapability,
  isGranted,
  isValidCapability,
  parseCapability,
} from './capability.ts';

describe('formatCapability / capabilityKey — always full form', () => {
  test('write@env', () => {
    expect(
      formatCapability({
        provider: 'vercel',
        plane: 'runtime',
        level: 'deployment',
        action: 'write',
        env: 'prod',
      }),
    ).toBe('vercel:runtime/deployment:write@prod');
  });

  test('env-less read', () => {
    expect(
      capabilityKey({ provider: 'github', plane: 'repo', level: 'code', action: 'read' }),
    ).toBe('github:repo/code:read');
  });

  test('config write@prod', () => {
    expect(
      formatCapability({
        provider: 'vercel',
        plane: 'runtime',
        level: 'config',
        action: 'write',
        env: 'prod',
      }),
    ).toBe('vercel:runtime/config:write@prod');
  });
});

describe('parseCapability — round-trips', () => {
  const cases: Array<[string, Capability]> = [
    ['github:repo/code:read', { provider: 'github', plane: 'repo', level: 'code', action: 'read' }],
    [
      'github:repo/code:write@main',
      { provider: 'github', plane: 'repo', level: 'code', action: 'write', env: 'main' },
    ],
    [
      'vercel:runtime/deployment:write@prod',
      { provider: 'vercel', plane: 'runtime', level: 'deployment', action: 'write', env: 'prod' },
    ],
    [
      'vercel:runtime/config:write@prod',
      { provider: 'vercel', plane: 'runtime', level: 'config', action: 'write', env: 'prod' },
    ],
    [
      'supabase:db/rows:read@staging',
      { provider: 'supabase', plane: 'db', level: 'rows', action: 'read', env: 'staging' },
    ],
    [
      'supabase:storage/objects:write',
      { provider: 'supabase', plane: 'storage', level: 'objects', action: 'write' },
    ],
  ];
  for (const [s, cap] of cases) {
    test(`${s}`, () => {
      expect(parseCapability(s)).toEqual(cap);
      expect(formatCapability(cap)).toBe(s);
    });
  }

  test('accepts branch-like env slug', () => {
    expect(parseCapability('github:repo/code:write@feature/x')).toEqual({
      provider: 'github',
      plane: 'repo',
      level: 'code',
      action: 'write',
      env: 'feature/x',
    });
  });

  test('rejects malformed notation', () => {
    expect(() => parseCapability('garbage')).toThrow();
    expect(() => parseCapability('vercel/runtime/deployment:write')).toThrow();
    expect(() => parseCapability('vercel:runtime:write@prod')).toThrow();
  });

  test('rejects unsupported action', () => {
    expect(() => parseCapability('vercel:runtime/deployment:apply@prod')).toThrow();
    expect(() => parseCapability('vercel:runtime/deployment:propose')).toThrow();
  });
});

describe('isValidCapability', () => {
  test('valid', () => {
    expect(
      isValidCapability({
        provider: 'github',
        plane: 'repo',
        level: 'code',
        action: 'read',
      }),
    ).toBe(true);
  });
  test('empty provider', () => {
    expect(isValidCapability({ provider: '', plane: 'repo', level: 'code', action: 'read' })).toBe(
      false,
    );
  });
  test('unknown action', () => {
    expect(
      isValidCapability({
        provider: 'github',
        plane: 'repo',
        level: 'code',
        // @ts-expect-error — testing runtime check on a bad value
        action: 'apply',
      }),
    ).toBe(false);
  });
});

describe('covers / isGranted — exact 5-tuple, env defensive', () => {
  const need: Capability = {
    provider: 'vercel',
    plane: 'runtime',
    level: 'deployment',
    action: 'write',
    env: 'prod',
  };

  test('exact match covers', () => {
    expect(covers({ ...need }, need)).toBe(true);
  });

  test('wrong env does not cover', () => {
    expect(covers({ ...need, env: 'staging' }, need)).toBe(false);
  });

  test('env-less grant does not cover @prod requirement', () => {
    expect(
      covers({ provider: 'vercel', plane: 'runtime', level: 'deployment', action: 'write' }, need),
    ).toBe(false);
  });

  test('different provider does not cover', () => {
    expect(covers({ ...need, provider: 'railway' }, need)).toBe(false);
  });

  test('different plane does not cover', () => {
    expect(covers({ ...need, plane: 'data' }, need)).toBe(false);
  });

  test('different level does not cover', () => {
    expect(covers({ ...need, level: 'config' }, need)).toBe(false);
  });

  test('isGranted across a set', () => {
    const set: Capability[] = [
      { provider: 'github', plane: 'repo', level: 'code', action: 'read' },
      { provider: 'vercel', plane: 'runtime', level: 'deployment', action: 'write', env: 'prod' },
    ];
    expect(isGranted(set, need)).toBe(true);
    expect(isGranted(set, { ...need, env: 'staging' })).toBe(false);
  });
});
