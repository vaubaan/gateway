import { describe, expect, test } from 'vitest';

import {
  baseRiskId,
  formatRiskId,
  isExplicitRiskId,
  isProviderId,
  isRiskId,
  parseRiskId,
} from './risk-id.ts';

describe('parseRiskId', () => {
  test('account-scoped form', () => {
    expect(parseRiskId('github.merge-protected')).toEqual({
      provider: 'github',
      env: null,
      name: 'merge-protected',
    });
  });

  test('env-scoped form', () => {
    expect(parseRiskId('supabase[prod].bulk-row-write')).toEqual({
      provider: 'supabase',
      env: 'prod',
      name: 'bulk-row-write',
    });
  });

  test('hyphenated provider and dotted name', () => {
    expect(parseRiskId('cloudflare-dns.zone.record-write')).toEqual({
      provider: 'cloudflare-dns',
      env: null,
      name: 'zone.record-write',
    });
  });

  test.each([
    '',
    'github',
    'github.',
    'Github.read',
    'github..read',
    'github[Prod].read',
    'github[].read',
    'github.read*',
    'github.*',
    'github_app.read',
    '*',
  ])('rejects malformed id %j', (raw) => {
    expect(parseRiskId(raw)).toBeNull();
    expect(isRiskId(raw)).toBe(false);
  });
});

describe('formatRiskId', () => {
  test('round-trips both forms', () => {
    for (const id of ['github.merge-protected', 'supabase[staging].bulk-row-write']) {
      expect(formatRiskId(parseRiskId(id)!)).toBe(id);
    }
  });

  test('null or empty env yields the account-scoped form', () => {
    expect(formatRiskId({ provider: 'vercel', env: null, name: 'deploy' })).toBe('vercel.deploy');
    expect(formatRiskId({ provider: 'vercel', env: '', name: 'deploy' })).toBe('vercel.deploy');
    expect(formatRiskId({ provider: 'vercel', name: 'deploy' })).toBe('vercel.deploy');
  });
});

describe('baseRiskId', () => {
  test('strips the env qualifier', () => {
    expect(baseRiskId('supabase[prod].bulk-row-write')).toBe('supabase.bulk-row-write');
    expect(baseRiskId('github.read-code')).toBe('github.read-code');
  });
  test('throws on a malformed id', () => {
    expect(() => baseRiskId('nope')).toThrow(/Malformed RiskId/);
  });
});

describe('isProviderId / isExplicitRiskId', () => {
  test('provider ids are lowercase hyphenated slugs', () => {
    expect(isProviderId('github')).toBe(true);
    expect(isProviderId('cloudflare-dns')).toBe(true);
    expect(isProviderId('upstash_redis')).toBe(false);
    expect(isProviderId('GitHub')).toBe(false);
    expect(isProviderId('-x')).toBe(false);
  });
  test('an explicit id carries no wildcard', () => {
    expect(isExplicitRiskId('github.read-code')).toBe(true);
    expect(isExplicitRiskId('github.*')).toBe(false);
    expect(isExplicitRiskId('*')).toBe(false);
  });
});
