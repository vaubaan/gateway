import { describe, expect, test } from 'vitest';
import { generateApiKey, hashApiKey, parseApiKey, verifyApiKey } from './api-key.ts';

describe('api-key — kind=mgmt', () => {
  test('generateApiKey("mgmt") produces a vbn_mgmt_ prefixed key', () => {
    const { apiKey, apiKeyPrefix } = generateApiKey('mgmt');
    expect(apiKey.startsWith('vbn_mgmt_')).toBe(true);
    expect(apiKey).toMatch(/^vbn_mgmt_[A-Za-z0-9]{8}_[A-Za-z0-9]{32}$/);
    expect(apiKeyPrefix).toMatch(/^[A-Za-z0-9]{8}$/);
    expect(apiKey).toContain(apiKeyPrefix);
  });

  test('parseApiKey recognises vbn_mgmt_ keys', () => {
    const { apiKey, apiKeyPrefix } = generateApiKey('mgmt');
    const parsed = parseApiKey(apiKey);
    expect(parsed).not.toBeNull();
    expect(parsed?.kind).toBe('mgmt');
    expect(parsed?.prefix).toBe(apiKeyPrefix);
  });

  test('parseApiKey distinguishes live / test / mgmt', () => {
    expect(parseApiKey(generateApiKey('live').apiKey)?.kind).toBe('live');
    expect(parseApiKey(generateApiKey('test').apiKey)?.kind).toBe('test');
    expect(parseApiKey(generateApiKey('mgmt').apiKey)?.kind).toBe('mgmt');
  });

  test('hash + verify roundtrip works for mgmt keys', async () => {
    const { apiKey } = generateApiKey('mgmt');
    const hash = await hashApiKey(apiKey);
    expect(await verifyApiKey(hash, apiKey)).toBe(true);
    expect(await verifyApiKey(hash, apiKey + 'X')).toBe(false);
  });

  test('parseApiKey rejects unknown prefix', () => {
    expect(parseApiKey('foobar_abcdefgh_zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz')).toBeNull();
  });
});
