import { describe, expect, it } from 'vitest';

import { loadInstanceConfig } from '../config';
import { ConfigError } from '../config/errors';
import { validEnv } from '../config/testing';
import { clientIpResolver, UNKNOWN_CLIENT } from './client-ip';

describe('trusted-edge mode (client_ip_header)', () => {
  it('reads the declared header alone, and ignores X-Forwarded-For', () => {
    const clientIp = clientIpResolver([], 'x-real-ip');
    const headers = new Headers({ 'x-real-ip': '203.0.113.7', 'x-forwarded-for': '198.51.100.1' });
    expect(clientIp(headers)).toBe('203.0.113.7');
    expect(clientIp(new Headers({ 'x-real-ip': '2001:db8::7' }))).toBe('2001:db8::7');
  });

  it('a missing, list-valued or malformed header reads as unknown', () => {
    const clientIp = clientIpResolver([], 'x-real-ip');
    expect(clientIp(new Headers())).toBe(UNKNOWN_CLIENT);
    expect(clientIp(new Headers({ 'x-real-ip': '203.0.113.7, 10.0.0.1' }))).toBe(UNKNOWN_CLIENT);
    expect(clientIp(new Headers({ 'x-real-ip': 'evil.example' }))).toBe(UNKNOWN_CLIENT);
  });

  it('is off by default', () => {
    expect(clientIpResolver([])(new Headers({ 'x-real-ip': '203.0.113.7' }))).toBe(UNKNOWN_CLIENT);
  });
});

function issuePaths(env: Record<string, string>): string[] {
  try {
    loadInstanceConfig({ env });
  } catch (err) {
    if (err instanceof ConfigError) return err.issues.map((i) => i.path);
    throw err;
  }
  return [];
}

describe('configuration: client_ip_header', () => {
  it('is null by default and accepts a known header, case-insensitively', () => {
    expect(loadInstanceConfig({ env: validEnv() }).config.clientIpHeader).toBeNull();
    const { config } = loadInstanceConfig({
      env: validEnv({ VAUBAAN_CLIENT_IP_HEADER: 'X-Real-IP' }),
    });
    expect(config.clientIpHeader).toBe('x-real-ip');
  });

  it('refuses an unknown header and the combination with trusted_proxies', () => {
    expect(issuePaths(validEnv({ VAUBAAN_CLIENT_IP_HEADER: 'x-forwarded-for' }))).toEqual([
      'client_ip_header',
    ]);
    expect(
      issuePaths(
        validEnv({ VAUBAAN_CLIENT_IP_HEADER: 'x-real-ip', VAUBAAN_TRUSTED_PROXIES: '10.0.0.0/8' }),
      ),
    ).toEqual(['client_ip_header']);
  });
});
