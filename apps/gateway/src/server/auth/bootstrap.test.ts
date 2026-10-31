import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openTestStore, type TestStore } from '../../../tests/support/store/testing';
import { BOOTSTRAP_REVOKED_KEY, BootstrapService } from './bootstrap';

const TOKEN = 'bootstrap-token-of-at-least-32-characters-long';

describe('BootstrapService', () => {
  let t: TestStore;
  beforeEach(() => {
    t = openTestStore();
  });
  afterEach(() => t.store.close());

  it('accepts the exact token while active and refuses anything else', async () => {
    const b = new BootstrapService(TOKEN, t.store.config, t.clock);
    expect(await b.state()).toEqual({ status: 'active' });
    expect(await b.verify(TOKEN)).toBe(true);
    expect(await b.verify(TOKEN + 'x')).toBe(false);
    expect(await b.verify(TOKEN.slice(0, -1))).toBe(false);
    expect(await b.verify('')).toBe(false);
  });

  it('is unavailable when the configuration carries no token (IdP set in the file)', async () => {
    const b = new BootstrapService(null, t.store.config, t.clock);
    expect(await b.state()).toEqual({ status: 'unavailable' });
    expect(await b.verify(TOKEN)).toBe(false);
    expect(await b.revoke()).toEqual({ status: 'unavailable' });
  });

  it('refuses the token once revoked, persists the revocation and keeps the first timestamp', async () => {
    const b = new BootstrapService(TOKEN, t.store.config, t.clock);
    expect(await b.revoke()).toEqual({ status: 'revoked', revokedAt: '2026-10-13T09:00:00.000Z' });
    expect(await t.store.config.get(BOOTSTRAP_REVOKED_KEY)).toBe('2026-10-13T09:00:00.000Z');
    expect(await b.verify(TOKEN)).toBe(false);
    t.clock.advance(60_000);
    expect(await b.revoke()).toEqual({ status: 'revoked', revokedAt: '2026-10-13T09:00:00.000Z' });
    // a fresh service over the same store sees the revocation (durable across restarts)
    expect(await new BootstrapService(TOKEN, t.store.config, t.clock).state()).toMatchObject({
      status: 'revoked',
    });
  });
});
