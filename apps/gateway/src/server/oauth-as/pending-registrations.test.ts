/**
 * Pending dynamic registrations are capped and expire (security review
 * 2026-10-15, external M2): an anonymous caller cannot grow the operator's
 * "Registered apps" page for ever.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { MAX_PENDING_REGISTRATIONS, PENDING_REGISTRATION_TTL_MS } from './clients';
import { OAuthProtocolError } from './errors';
import { LOOPBACK_REDIRECT, openOAuthRig, WEB_REDIRECT, type OAuthRig } from './testing';

const webClient = (i: number) => ({
  client_name: `Decoy ${i}`,
  redirect_uris: [WEB_REDIRECT],
  token_endpoint_auth_method: 'none',
});

describe('pending dynamic registrations', () => {
  let rig: OAuthRig;
  afterEach(() => rig.close());

  it(`refuses a new one while ${MAX_PENDING_REGISTRATIONS} wait; a loopback client is not held`, async () => {
    rig = await openOAuthRig();
    for (let i = 0; i < MAX_PENDING_REGISTRATIONS; i += 1) {
      expect((await rig.clients.register(webClient(i))).status).toBe('pending');
    }
    const refused = await rig.clients.register(webClient(999)).catch((err: unknown) => err);
    expect(refused).toBeInstanceOf(OAuthProtocolError);
    expect((refused as OAuthProtocolError).status).toBe(429);
    // Auto-approved by policy: not a registration that waits.
    const loopback = await rig.clients.register({
      redirect_uris: [LOOPBACK_REDIRECT],
      token_endpoint_auth_method: 'none',
    });
    expect(loopback.status).toBe('approved');
  });

  it('expires the ones that waited longer than a day, and only those', async () => {
    rig = await openOAuthRig();
    const old = await rig.clients.register(webClient(1));
    const decided = await rig.clients.register(webClient(2));
    await rig.clients.decide('operator-1', decided.client.id, 'approved');
    rig.clock.advance(PENDING_REGISTRATION_TTL_MS + 1000);
    const fresh = await rig.clients.register(webClient(3));
    expect(await rig.clients.get(old.client.id)).toBeNull();
    expect(await rig.clients.get(decided.client.id)).not.toBeNull();
    expect(await rig.clients.get(fresh.client.id)).not.toBeNull();
  });
});
