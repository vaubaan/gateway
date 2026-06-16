import { describe, expect, test } from 'vitest';
import { generateApiKey, hashApiKey, parseApiKey, verifyApiKey } from './api-key.ts';

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

  test('hash + verify roundtrip works for live keys', async () => {
    const { apiKey } = generateApiKey('live');
    const hash = await hashApiKey(apiKey);
    expect(await verifyApiKey(hash, apiKey)).toBe(true);
    expect(await verifyApiKey(hash, apiKey + 'X')).toBe(false);
  });

  test('parseApiKey rejects unknown prefix', () => {
    expect(parseApiKey('foobar_abcdefgh_zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz')).toBeNull();
  });
});
