/**
 * The gateway as the client of an OAuth broker (ADR
 * google-calendar-through-an-oauth-broker D1, D2), against the fake broker of
 * the contract kit (`fake-oauth-broker.ts`), a real HTTP server on the loopback
 * interface. Every other provider call goes to a `mockFetch` that refuses all.
 *
 * What is pinned: the connect flow (`POST /flows` with the S256 challenge, the
 * `state` checked as for any flow, the grant redeemed with the verifier), what
 * is stored (the grant id and the access token, never a refresh token), the
 * refresh and the revocation through the broker, and the contract's refusals:
 * a grant redeemed twice or late, the wrong verifier, a bad key, a broker that
 * is down — a broker failure, never an expiry.
 */
import type { ConnectionContext, OAuth2BrokeredSpec } from '@vaubaan/plugin-sdk';
import { UpstreamAuthError } from '@vaubaan/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { parseStoredCredential } from './credential-codec';
import { ConnectError, OAuthBrokerUnavailableError } from './errors';
import { FAKE_AUTHORIZE_URL, FAKE_GRANT_TTL_MS, FakeOAuthBroker } from './fake-oauth-broker';
import { challengeOf, OAuthBrokerClient, OAuthBrokerError } from './oauth-broker';
import { REFRESH_SKEW_MS } from './credentials';
import { connectionsHarness, fixturePlugin, type ConnectionsHarness } from './testing';

const KEY = 'broker-key-of-instance-a-PLAINTEXT';
const OTHER_KEY = 'broker-key-of-instance-b';
const PLUGIN = 'calco';
const BROKERED: OAuth2BrokeredSpec = {
  kind: 'oauth2',
  broker: { provider: 'google' },
  scopes: ['https://www.googleapis.com/auth/calendar.events.readonly'],
};

let broker: FakeOAuthBroker;
let fakeNow = Date.parse('2026-10-27T09:00:00.000Z');
/** What the plugin received in its discovery: the proof it never sees the grant. */
let seenByPlugin: ConnectionContext['credential'][] = [];

beforeEach(async () => {
  fakeNow = Date.parse('2026-10-27T09:00:00.000Z');
  seenByPlugin = [];
  broker = await FakeOAuthBroker.start({
    keys: { [KEY]: 'instance-a', [OTHER_KEY]: 'instance-b' },
    account: 'alice@acme.example',
    now: () => fakeNow,
  });
});

afterEach(async () => {
  await broker.stop();
});

function harness(key: string | null = KEY): ConnectionsHarness {
  const h = connectionsHarness({
    plugins: [
      fixturePlugin({
        id: PLUGIN,
        displayName: 'Cal Co',
        credential: BROKERED,
        discoverResources: async (ctx) => {
          seenByPlugin.push(ctx.credential);
          return [{ provider: PLUGIN, ref: 'primary', displayName: 'Primary' }];
        },
      }),
    ],
    brokers: key === null ? [] : [broker.configFor(key)],
  });
  broker.recordReturnUrl('instance-a', h.service.callbackUrl(PLUGIN).href);
  // The broker and the gateway share one clock: the expiry it hands out is on the gateway's.
  fakeNow = h.clock.now().getTime();
  return h;
}

async function startFlow(h: ConnectionsHarness) {
  const alice = await h.actor('alice@example.com');
  const started = await h.service.start(alice, PLUGIN);
  if (started.kind !== 'redirect') throw new Error('expected a redirect');
  return { alice, authorizeUrl: started.url };
}

async function connect(h: ConnectionsHarness) {
  const { alice, authorizeUrl } = await startFlow(h);
  const back = broker.approve(authorizeUrl);
  const done = await h.service.complete(alice, PLUGIN, back.searchParams);
  return { alice, connection: done.connection, back };
}

async function expectConnectError(promise: Promise<unknown>, code: string): Promise<void> {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ConnectError);
  expect((err as ConnectError).code).toBe(code);
}

describe('a plugin whose client is an OAuth broker', () => {
  it('is listed as not configured, with the reason, when no broker serves its provider', async () => {
    const h = harness(null);
    const [provider] = await h.service.providers();
    expect(provider?.unavailable).toMatch(/OAuth broker .* none is configured for "google"/);
    const alice = await h.actor('alice@example.com');
    await expectConnectError(h.service.start(alice, PLUGIN), 'broker-not-configured');
  });

  it('starts at the broker with the S256 challenge, never the verifier, and the gateway’s state', async () => {
    const h = harness();
    expect((await h.service.providers())[0]?.unavailable).toBeNull();
    const { authorizeUrl } = await startFlow(h);
    expect(authorizeUrl.startsWith(FAKE_AUTHORIZE_URL)).toBe(true);
    const [call] = broker.calls;
    expect(call).toMatchObject({ method: 'POST', path: '/v1/flows', instance: 'instance-a' });
    expect(call?.body).toMatchObject({
      provider: 'google',
      scopes: BROKERED.scopes,
      return_url: h.service.callbackUrl(PLUGIN).href,
      challenge_method: 'S256',
    });
    expect(call?.body).not.toHaveProperty('verifier');
    expect(typeof call?.body?.state).toBe('string');
  });

  it('redeems the grant with the verifier and keeps the grant id and the access token, no refresh token', async () => {
    const h = harness();
    const { connection } = await connect(h);
    const redeem = broker.calls.find((c) => c.path === '/v1/grants/redeem');
    const flows = broker.calls.find((c) => c.path === '/v1/flows');
    expect(redeem?.status).toBe(200);
    expect(challengeOf(String(redeem?.body?.verifier))).toBe(flows?.body?.challenge);

    const sealed = await h.store.connections.getCredential(connection.id);
    const stored = parseStoredCredential(sealed ?? '');
    expect(stored.brokerGrant).toEqual({ broker: 'main', grantId: broker.grantIds()[0] });
    expect(stored.secret).toMatchObject({ kind: 'oauth2', refreshToken: null });
    // The plugin's discovery saw an access token and nothing of the broker.
    expect(seenByPlugin).toHaveLength(1);
    expect(JSON.stringify(seenByPlugin[0])).not.toContain(broker.grantIds()[0] ?? 'none');
    expect(JSON.stringify(seenByPlugin[0])).not.toContain('brokerGrant');
    const view = (await h.service.listFor(await h.actor('alice@example.com')))[0];
    expect(view?.tokenAccount).toBe('alice@acme.example');
  });

  it('checks the state as for any flow: replayed or opened by another user, it is refused', async () => {
    const h = harness();
    const { alice, back } = await connect(h);
    await expectConnectError(h.service.complete(alice, PLUGIN, back.searchParams), 'state-invalid');

    const second = await startFlow(h);
    const bob = await h.actor('bob@example.com');
    const again = broker.approve(second.authorizeUrl);
    await expectConnectError(h.service.complete(bob, PLUGIN, again.searchParams), 'state-invalid');
  });

  it('reads a refusal at the provider as a denial', async () => {
    const h = harness();
    const { alice, authorizeUrl } = await startFlow(h);
    await expectConnectError(
      h.service.complete(alice, PLUGIN, broker.deny(authorizeUrl).searchParams),
      'provider-denied',
    );
  });

  it('shows a broker that is down when the flow starts as a broker failure', async () => {
    const h = harness();
    const alice = await h.actor('alice@example.com');
    broker.down();
    await expectConnectError(h.service.start(alice, PLUGIN), 'broker-failed');
  });

  it('refreshes through the broker, keeping the grant', async () => {
    const h = harness();
    const { connection } = await connect(h);
    const before = parseStoredCredential(
      (await h.store.connections.getCredential(connection.id)) ?? '',
    );
    h.clock.advance(60 * 60_000 - REFRESH_SKEW_MS + 1_000);
    const resolved = await h.broker.resolve(connection.id);
    expect(
      broker.calls.some((c) => c.path === `/v1/grants/${before.brokerGrant?.grantId}/token`),
    ).toBe(true);
    expect(resolved.brokerGrant).toEqual(before.brokerGrant);
    expect(resolved.credential.kind === 'oauth2' && resolved.credential.accessToken).not.toBe(
      before.secret.kind === 'oauth2' && before.secret.accessToken,
    );
  });

  it('a broker down at refresh time is the broker’s failure: the connection stays active', async () => {
    const h = harness();
    const { connection } = await connect(h);
    broker.down();
    await expect(h.broker.refresh(connection.id)).rejects.toBeInstanceOf(
      OAuthBrokerUnavailableError,
    );
    expect((await h.store.connections.getById(connection.id))?.status).toBe('active');
    // Discovery, once the token is about to expire, records the broker's failure, not an expiry.
    h.clock.advance(60 * 60_000);
    const record = await h.service.discover(await h.actor('alice@example.com'), connection.id);
    expect(record.error).toMatch(/OAuth broker 'main' answered 503/);
  });

  it('a grant the provider no longer accepts turns the connection expired', async () => {
    const h = harness();
    const { connection } = await connect(h);
    broker.refusingProvider();
    await expect(h.broker.refresh(connection.id)).rejects.toBeInstanceOf(UpstreamAuthError);
    expect((await h.store.connections.getById(connection.id))?.status).toBe('expired');
  });

  it('revoking the connection deletes the grant at the broker', async () => {
    const h = harness();
    const { alice, connection } = await connect(h);
    const [grantId] = broker.grantIds();
    expect(h.service.providerGrantOf(connection).grant.withdrawnByGateway).toBe(true);
    const revoked = await h.service.revoke(alice, connection.id);
    expect(revoked.providerGrant).toBe('revoked');
    expect(broker.revokedAtProvider).toEqual([grantId]);
    expect(broker.grantIds()).toEqual([]);
  });

  it('a broker down at revocation says the access was not withdrawn', async () => {
    const h = harness();
    const { alice, connection } = await connect(h);
    broker.down();
    const revoked = await h.service.revoke(alice, connection.id);
    expect(revoked.status).toBe('revoked');
    expect(revoked.providerGrant).toBe('failed');
  });
});

describe('the contract’s refusals, at the client', () => {
  async function pendingGrant(h: ConnectionsHarness) {
    const { authorizeUrl } = await startFlow(h);
    const back = broker.approve(authorizeUrl);
    const flows = broker.calls.find((c) => c.path === '/v1/flows');
    return {
      grant: back.searchParams.get('grant') ?? '',
      challenge: String(flows?.body?.challenge),
    };
  }

  /** The client of the configured broker, as the gateway holds it. */
  async function mainClient(h: ConnectionsHarness) {
    const client = h.brokers.byName('main');
    if (!client) throw new Error('no broker');
    return client;
  }

  async function refusal(promise: Promise<unknown>): Promise<OAuthBrokerError> {
    const err = await promise.then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(OAuthBrokerError);
    return err as OAuthBrokerError;
  }

  it('a grant redeemed twice is refused the second time', async () => {
    const h = harness();
    const { alice, back } = await connect(h);
    void alice;
    const client = await mainClient(h);
    const redeem = broker.calls.find((c) => c.path === '/v1/grants/redeem');
    const err = await refusal(
      client.redeem(back.searchParams.get('grant') ?? '', String(redeem?.body?.verifier)),
    );
    expect(err).toMatchObject({ status: 400, code: 'invalid_grant', grantGone: true });
  });

  it('a grant redeemed late is refused', async () => {
    const h = harness();
    const { grant } = await pendingGrant(h);
    fakeNow += FAKE_GRANT_TTL_MS + 1;
    const err = await refusal((await mainClient(h)).redeem(grant, 'v'.repeat(43)));
    expect(err).toMatchObject({ status: 400, code: 'invalid_grant' });
  });

  it('a grant redeemed with the wrong verifier is refused', async () => {
    const h = harness();
    const { grant } = await pendingGrant(h);
    const err = await refusal((await mainClient(h)).redeem(grant, 'w'.repeat(43)));
    expect(err).toMatchObject({ status: 400, code: 'invalid_grant', grantGone: true });
  });

  it('a grant redeemed by another instance is refused', async () => {
    const h = harness();
    const { grant } = await pendingGrant(h);
    const other = new OAuthBrokerClient(broker.configFor(OTHER_KEY, 'other'), { fetch });
    const err = await refusal(other.redeem(grant, 'v'.repeat(43)));
    expect(err).toMatchObject({ status: 400, code: 'invalid_grant' });
  });

  it('a bad key is refused, and it is not a dead grant', async () => {
    const client = new OAuthBrokerClient(broker.configFor('not-a-key'), { fetch });
    const err = await refusal(client.token('g_abcdefghijkl'));
    expect(err).toMatchObject({ status: 401, code: 'invalid_key', grantGone: false });
    expect(err.message).not.toContain('not-a-key');
  });

  it('a broker that is down is a failure of the broker, not of the grant', async () => {
    const client = new OAuthBrokerClient(broker.configFor(KEY), { fetch });
    broker.down();
    expect(await refusal(client.token('g_abcdefghijkl'))).toMatchObject({
      status: 503,
      grantGone: false,
    });
    await broker.stop();
    expect(await refusal(client.token('g_abcdefghijkl'))).toMatchObject({
      status: 0,
      grantGone: false,
    });
    // Restarted for afterEach.
    broker = await FakeOAuthBroker.start({ keys: {} });
  });

  it('never sends the key anywhere but the Authorization header', async () => {
    const h = harness();
    await connect(h);
    for (const call of broker.calls) expect(JSON.stringify(call.body)).not.toContain(KEY);
  });
});
