import { describe, expect, test } from 'vitest';

import {
  baseRiskId,
  formatRiskId,
  isExplicitRiskId,
  isServiceId,
  isRiskId,
  parseRiskId,
} from './risk-id.ts';

describe('parseRiskId', () => {
  test('account-scoped form', () => {
    expect(parseRiskId('github.merge-protected')).toEqual({
      service: 'github',
      env: null,
      name: 'merge-protected',
    });
  });

  test('env-scoped form', () => {
    expect(parseRiskId('supabase[prod].bulk-row-write')).toEqual({
      service: 'supabase',
      env: 'prod',
      name: 'bulk-row-write',
    });
  });

  test('hyphenated service and dotted name', () => {
    expect(parseRiskId('cloudflare-dns.zone.record-write')).toEqual({
      service: 'cloudflare-dns',
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
    expect(formatRiskId({ service: 'vercel', env: null, name: 'deploy' })).toBe('vercel.deploy');
    expect(formatRiskId({ service: 'vercel', env: '', name: 'deploy' })).toBe('vercel.deploy');
    expect(formatRiskId({ service: 'vercel', name: 'deploy' })).toBe('vercel.deploy');
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

describe('isServiceId / isExplicitRiskId', () => {
  test('service ids are lowercase hyphenated slugs', () => {
    expect(isServiceId('github')).toBe(true);
    expect(isServiceId('cloudflare-dns')).toBe(true);
    expect(isServiceId('upstash_redis')).toBe(false);
    expect(isServiceId('GitHub')).toBe(false);
    expect(isServiceId('-x')).toBe(false);
  });
  test('an explicit id carries no wildcard', () => {
    expect(isExplicitRiskId('github.read-code')).toBe(true);
    expect(isExplicitRiskId('github.*')).toBe(false);
    expect(isExplicitRiskId('*')).toBe(false);
  });
});
