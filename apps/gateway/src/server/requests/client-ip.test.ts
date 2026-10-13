import { describe, expect, it } from 'vitest';

import { clientIpResolver, UNKNOWN_CLIENT } from './client-ip';

const xff = (value: string): Headers => new Headers({ 'x-forwarded-for': value });

describe('clientIpResolver', () => {
  it('ignores X-Forwarded-For when no proxy is trusted: one shared key', () => {
    const clientIp = clientIpResolver([]);
    expect(clientIp(xff('203.0.113.7'))).toBe(UNKNOWN_CLIENT);
    expect(clientIp(new Headers())).toBe(UNKNOWN_CLIENT);
  });

  it('returns the right-most hop that is not a trusted proxy', () => {
    const clientIp = clientIpResolver(['10.0.0.0/8', '192.168.1.1']);
    expect(clientIp(xff('203.0.113.7, 10.1.2.3'))).toBe('203.0.113.7');
    expect(clientIp(xff('203.0.113.7, 192.168.1.1, 10.1.2.3'))).toBe('203.0.113.7');
  });

  it('does not believe what the client wrote to the left of its own address', () => {
    const clientIp = clientIpResolver(['10.0.0.0/8']);
    // The client forged "1.1.1.1"; the proxy appended the real peer.
    expect(clientIp(xff('1.1.1.1, 203.0.113.7, 10.1.2.3'))).toBe('203.0.113.7');
  });

  it('is unknown when every hop is a trusted proxy, or the header is absent', () => {
    const clientIp = clientIpResolver(['10.0.0.0/8']);
    expect(clientIp(xff('10.1.2.3, 10.4.5.6'))).toBe(UNKNOWN_CLIENT);
    expect(clientIp(new Headers())).toBe(UNKNOWN_CLIENT);
  });

  it('stops at a malformed hop', () => {
    const clientIp = clientIpResolver(['10.0.0.0/8']);
    expect(clientIp(xff('203.0.113.7, not-an-address, 10.1.2.3'))).toBe(UNKNOWN_CLIENT);
  });

  it('handles IPv6, ports and brackets', () => {
    const clientIp = clientIpResolver(['::1', 'fd00::/8']);
    expect(clientIp(xff('2001:db8::7, fd00::1'))).toBe('2001:db8::7');
    expect(clientIp(xff('203.0.113.7:51234, [::1]:443'))).toBe('203.0.113.7');
  });

  it('skips invalid entries of trusted_proxies instead of trusting more', () => {
    const clientIp = clientIpResolver(['not-a-cidr', '10.0.0.0/99', '10.0.0.1']);
    expect(clientIp(xff('203.0.113.7, 10.0.0.1'))).toBe('203.0.113.7');
    // 10.0.0.2 is not trusted: the bad /99 entry added nothing.
    expect(clientIp(xff('203.0.113.7, 10.0.0.2'))).toBe('10.0.0.2');
  });
});
