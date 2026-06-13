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

describe('formatCapability — short form when provider has a default plane', () => {
  test('vercel single-plane → short form', () => {
    expect(
      formatCapability({
        provider: 'vercel',
        plane: 'runtime',
        level: 'deployment',
        action: 'write',
        env: 'prod',
      }),
    ).toBe('vercel:deployment:write@prod');
  });

  test('github single-plane → short form env-less', () => {
    expect(
      formatCapability({ provider: 'github', plane: 'repo', level: 'code', action: 'read' }),
    ).toBe('github:code:read');
  });

  test('railway single-plane → short form env-less', () => {
    expect(
      formatCapability({
        provider: 'railway',
        plane: 'runtime',
        level: 'deployment',
        action: 'write',
      }),
    ).toBe('railway:deployment:write');
  });

  test('bash single-plane → short form', () => {
    expect(
      formatCapability({
        provider: 'bash',
        plane: 'host',
        level: 'process',
        action: 'write',
        env: 'vps-rp',
      }),
    ).toBe('bash:process:write@vps-rp');
  });

  test('supabase multi-plane → long form (no default)', () => {
    expect(
      formatCapability({
        provider: 'supabase',
        plane: 'db',
        level: 'rows',
        action: 'read',
        env: 'staging',
      }),
    ).toBe('supabase:db/rows:read@staging');
    expect(
      formatCapability({
        provider: 'supabase',
        plane: 'storage',
        level: 'objects',
        action: 'write',
      }),
    ).toBe('supabase:storage/objects:write');
  });
});

describe('capabilityKey — always long form (stable identity)', () => {
  test('github long-form key even though displayed short', () => {
    expect(
      capabilityKey({ provider: 'github', plane: 'repo', level: 'code', action: 'read' }),
    ).toBe('github:repo/code:read');
  });

  test('vercel long-form key for storage / audit', () => {
    expect(
      capabilityKey({
        provider: 'vercel',
        plane: 'runtime',
        level: 'config',
        action: 'write',
        env: 'prod',
      }),
    ).toBe('vercel:runtime/config:write@prod');
  });
});

describe('parseCapability — accepts both long and short form', () => {
  test('long form (github)', () => {
    expect(parseCapability('github:repo/code:read')).toEqual({
      provider: 'github',
      plane: 'repo',
      level: 'code',
      action: 'read',
    });
  });

  test('short form expands via DEFAULT_PLANE (github)', () => {
    expect(parseCapability('github:code:write@main')).toEqual({
      provider: 'github',
      plane: 'repo',
      level: 'code',
      action: 'write',
      env: 'main',
    });
  });

  test('short form expands via DEFAULT_PLANE (vercel)', () => {
    expect(parseCapability('vercel:deployment:write@prod')).toEqual({
      provider: 'vercel',
      plane: 'runtime',
      level: 'deployment',
      action: 'write',
      env: 'prod',
    });
  });

  test('short form expands via DEFAULT_PLANE (bash)', () => {
    expect(parseCapability('bash:process:read@vps-rp')).toEqual({
      provider: 'bash',
      plane: 'host',
      level: 'process',
      action: 'read',
      env: 'vps-rp',
    });
  });

  test('supabase short form rejected — multi-plane provider', () => {
    expect(() => parseCapability('supabase:rows:read@staging')).toThrow(/multiple planes/);
  });

  test('supabase long form accepted', () => {
    expect(parseCapability('supabase:db/rows:read@staging')).toEqual({
      provider: 'supabase',
      plane: 'db',
      level: 'rows',
      action: 'read',
      env: 'staging',
    });
  });

  test('accepts branch-like env slug in short form', () => {
    expect(parseCapability('github:code:write@feature/x')).toEqual({
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
  });

  test('rejects unsupported action', () => {
    expect(() => parseCapability('vercel:deployment:apply@prod')).toThrow();
    expect(() => parseCapability('vercel:deployment:propose')).toThrow();
  });

  test('round-trip short ↔ short', () => {
    const s = 'vercel:config:write@prod';
    expect(formatCapability(parseCapability(s))).toBe(s);
  });

  test('long input → short output (same identity)', () => {
    expect(formatCapability(parseCapability('github:repo/code:read'))).toBe('github:code:read');
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

describe('covers / isGranted — asymmetric env (fan-out for env-less grants)', () => {
  const need: Capability = {
    provider: 'vercel',
    plane: 'runtime',
    level: 'deployment',
    action: 'write',
    env: 'prod',
  };
  const envLessGrant: Capability = {
    provider: 'vercel',
    plane: 'runtime',
    level: 'deployment',
    action: 'write',
  };

  test('exact match covers', () => {
    expect(covers({ ...need }, need)).toBe(true);
  });

  test('grant @staging does not cover @prod', () => {
    expect(covers({ ...need, env: 'staging' }, need)).toBe(false);
  });

  test('env-less grant covers @prod (fan-out, spec §5.1 #3)', () => {
    expect(covers(envLessGrant, need)).toBe(true);
  });

  test('env-less grant covers env-less required', () => {
    expect(covers(envLessGrant, { ...envLessGrant })).toBe(true);
  });

  test('grant @prod does NOT cover env-less required (asymmetric)', () => {
    expect(covers(need, { ...envLessGrant })).toBe(false);
  });

  test('excludeEnvs narrows the fan-out (spec §5.1 #4)', () => {
    expect(covers(envLessGrant, need, { excludeEnvs: ['prod'] })).toBe(false);
    expect(covers(envLessGrant, { ...need, env: 'staging' }, { excludeEnvs: ['prod'] })).toBe(true);
  });

  test('excludeEnvs only bites env-less grants — explicit @X grant ignores it', () => {
    expect(covers({ ...need }, need, { excludeEnvs: ['prod'] })).toBe(true);
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

  test('isGranted with env-less grant fans out across envs', () => {
    const set: Capability[] = [envLessGrant];
    expect(isGranted(set, need)).toBe(true);
    expect(isGranted(set, { ...need, env: 'staging' })).toBe(true);
    expect(isGranted(set, need, { excludeEnvs: ['prod'] })).toBe(false);
  });
});
