import { describe, expect, it } from 'vitest';

import * as shared from '../http/client-ip';
import { clientIpOf, clientIpResolver, trustedProxyList, UNKNOWN_CLIENT } from './client-ip';

// The rule itself is tested in `../http/client-ip.test.ts`.
describe('requests/client-ip', () => {
  it('is the shared client-address rule, not a copy of it', () => {
    expect(clientIpOf).toBe(shared.clientIpOf);
    expect(clientIpResolver).toBe(shared.clientIpResolver);
    expect(trustedProxyList).toBe(shared.trustedProxyList);
    expect(UNKNOWN_CLIENT).toBe(shared.UNKNOWN_CLIENT);
  });

  it('keys every caller on one value when no proxy is trusted', () => {
    const headers = new Headers({ 'x-forwarded-for': '203.0.113.7' });
    expect(clientIpResolver([])(headers)).toBe(UNKNOWN_CLIENT);
    expect(clientIpResolver(['10.0.0.0/8'])(headers)).toBe('203.0.113.7');
  });
});
