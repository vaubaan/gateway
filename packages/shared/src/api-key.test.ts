import { describe, expect, test } from 'vitest';
import {
  apiKeyMatchesDigest,
  digestApiKey,
  generateApiKey,
  hashApiKeyArgon2id,
  parseApiKey,
  verifyApiKeyArgon2id,
} from './api-key.ts';

describe('api-key', () => {
  test('generateApiKey("live") produces a vbn_live_ prefixed key', () => {
    const { apiKey, apiKeyPrefix } = generateApiKey('live');
    expect(apiKey.startsWith('vbn_live_')).toBe(true);
    expect(apiKey).toMatch(/^vbn_live_[A-Za-z0-9]{8}_[A-Za-z0-9]{32}$/);
    expect(apiKeyPrefix).toMatch(/^[A-Za-z0-9]{8}$/);
    expect(apiKey).toContain(apiKeyPrefix);
  });

  test('generateApiKey("test") produces a vbn_test_ prefixed key', () => {
    const { apiKey, apiKeyPrefix } = generateApiKey('test');
    expect(apiKey.startsWith('vbn_test_')).toBe(true);
    expect(apiKey).toMatch(/^vbn_test_[A-Za-z0-9]{8}_[A-Za-z0-9]{32}$/);
    expect(apiKey).toContain(apiKeyPrefix);
  });

  test('parseApiKey distinguishes live / test', () => {
    expect(parseApiKey(generateApiKey('live').apiKey)?.kind).toBe('live');
    expect(parseApiKey(generateApiKey('test').apiKey)?.kind).toBe('test');
  });

  test('parseApiKey rejects the legacy vbn_mgmt_ prefix (dropped by unified-tokens ADR)', () => {
    expect(parseApiKey('vbn_mgmt_abcdefgh_zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz')).toBeNull();
  });

  test('the digest is the sha256 of the whole key, in lowercase hex', () => {
    // RFC 6234 test vector for "abc".
    expect(digestApiKey('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    const { apiKey } = generateApiKey('live');
    expect(digestApiKey(apiKey)).toMatch(/^[0-9a-f]{64}$/);
    expect(digestApiKey(apiKey)).toBe(digestApiKey(apiKey));
  });

  test('digest + match roundtrip works, and one changed character does not match', () => {
    const { apiKey } = generateApiKey('live');
    const digest = digestApiKey(apiKey);
    expect(apiKeyMatchesDigest(digest, apiKey)).toBe(true);
    expect(apiKeyMatchesDigest(digest, apiKey + 'X')).toBe(false);
    expect(apiKeyMatchesDigest(digest, apiKey.slice(0, -1))).toBe(false);
    expect(apiKeyMatchesDigest(digest, '')).toBe(false);
  });

  test('a stored value that is not a sha256 in lowercase hex matches nothing', () => {
    const { apiKey } = generateApiKey('live');
    const digest = digestApiKey(apiKey);
    for (const stored of [
      '',
      'not-a-digest',
      digest.slice(0, 62),
      digest.toUpperCase(),
      `${digest}\n`,
      `${digest}00`,
      apiKey,
    ]) {
      expect(apiKeyMatchesDigest(stored, apiKey), stored).toBe(false);
    }
  });

  test('argon2id hash + verify roundtrip still works (tokens of an earlier build)', async () => {
    const { apiKey } = generateApiKey('live');
    const hash = await hashApiKeyArgon2id(apiKey);
    expect(await verifyApiKeyArgon2id(hash, apiKey)).toBe(true);
    expect(await verifyApiKeyArgon2id(hash, apiKey + 'X')).toBe(false);
  });

  test('parseApiKey rejects wrong lengths', () => {
    const secret = 'z'.repeat(32);
    expect(parseApiKey(`vbn_live_abcdefgh_${secret}`)?.prefix).toBe('abcdefgh');
    expect(parseApiKey(`vbn_live_abcdefg_${secret}`)).toBeNull(); // prefix of 7
    expect(parseApiKey(`vbn_live_abcdefghi_${secret}`)).toBeNull(); // prefix of 9
    expect(parseApiKey(`vbn_live_abcdefgh_${secret.slice(1)}`)).toBeNull(); // secret of 31
    expect(parseApiKey(`vbn_live_abcdefgh_${secret}z`)).toBeNull(); // secret of 33
    expect(parseApiKey('vbn_live_abcdefgh')).toBeNull();
    expect(parseApiKey('vbn_live_')).toBeNull();
    expect(parseApiKey('')).toBeNull();
  });

  test('parseApiKey rejects a prefix or a secret outside base62', () => {
    expect(parseApiKey(`vbn_live_abcd-fgh_${'z'.repeat(32)}`)).toBeNull();
    expect(parseApiKey(`vbn_live_abcdefgh_${'!'.repeat(32)}`)).toBeNull();
    expect(parseApiKey(`vbn_test_abcdefgh_${'z'.repeat(31)}_`)).toBeNull();
    expect(parseApiKey(`vbn_test_abcdefgh_${'z'.repeat(31)}\n`)).toBeNull();
  });

  test('verifyApiKeyArgon2id answers false on a hash it cannot read', async () => {
    const { apiKey } = generateApiKey('live');
    expect(await verifyApiKeyArgon2id('not-an-argon2-hash', apiKey)).toBe(false);
    expect(await verifyApiKeyArgon2id('', apiKey)).toBe(false);
    expect(await verifyApiKeyArgon2id(digestApiKey(apiKey), apiKey)).toBe(false);
  });

  test('parseApiKey rejects unknown prefix', () => {
    expect(parseApiKey('foobar_abcdefgh_zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz')).toBeNull();
  });
});
