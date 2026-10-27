/**
 * The gateway as the client of an OAuth broker (ADRs
 * google-calendar-through-an-oauth-broker D1, D2 and
 * oauth-broker-stateless-in-an-attested-enclave D1, D4, D6), against the fake
 * broker of the contract kit (`fake-oauth-broker.ts`), a real HTTPS server on
 * the loopback interface with a key of its own and the test-only attestation
 * platform. Every other provider call goes to a `mockFetch` that refuses all.
 *
 * What is pinned: the connect flow (`POST /flows` with the S256 challenge, the
 * `state` checked as for any flow, the grant redeemed with the verifier), what
 * is stored (the access token for the plugin, the refresh token sealed beside
 * it, host only), the refresh (`POST /token`) and the revocation
 * (`POST /revoke`) with the refresh token, the contract's refusals — a grant
 * redeemed twice or late, the wrong verifier, a bad key, a broker that is down:
 * a broker failure, never an expiry — and the attestation: nothing is sent to
 * a broker whose connection key no admitted attestation carries.
 */
import type { ConnectionContext, OAuth2BrokeredSpec } from '@vaubaan/plugin-sdk';
import { UpstreamAuthError } from '@vaubaan/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { productionAttestationKit } from './attestation-kit';
import { GCP_CONFIDENTIAL_SPACE } from './attestation-gcp';
import { AttestationVerifier, MAX_PIN_MS, NO_ADMITTED_VERSION } from './broker-attestation';
import { parseStoredCredential } from './credential-codec';
import { ConnectError, OAuthBrokerUnavailableError } from './errors';
import {
  FAKE_AUTHORIZE_URL,
  FAKE_BROKER_MEASUREMENT,
  FAKE_GRANT_TTL_MS,
  FakeOAuthBroker,
} from './fake-oauth-broker';
import {
  challengeOf,
  OAuthBrokerClient,
  OAuthBrokerError,
  type OAuthBrokerIo,
} from './oauth-broker';
import { AttestedChannel, FetchChannel, MAX_ANSWER_BYTES } from './broker-channel';
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
/** The broker and the gateway share one clock: the harness's, once it exists. */
let clockNow: () => number = () => Date.parse('2026-10-27T09:00:00.000Z');
/** What the plugin received in its discovery: the proof it never sees the refresh token. */
let seenByPlugin: ConnectionContext['credential'][] = [];

async function startBroker(attestation?: 'none'): Promise<FakeOAuthBroker> {
  return FakeOAuthBroker.start({
    keys: { [KEY]: 'instance-a', [OTHER_KEY]: 'instance-b' },
    account: 'alice@acme.example',
    now: () => clockNow(),
    ...(attestation ? { attestation } : {}),
  });
}

beforeEach(async () => {
  clockNow = () => Date.parse('2026-10-27T09:00:00.000Z');
  seenByPlugin = [];
  broker = await startBroker();
});

afterEach(async () => {
  await broker.stop();
});

function harness(
  key: string | null = KEY,
  allowlist: readonly string[] = [FAKE_BROKER_MEASUREMENT],
  brokerFetch?: typeof fetch,
): ConnectionsHarness {
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
    ...(broker.spkiHash ? { brokerAttestation: broker.attestationKit([...allowlist]) } : {}),
    ...(brokerFetch ? { brokerFetch } : {}),
  });
  broker.recordReturnUrl('instance-a', h.service.callbackUrl(PLUGIN).href);
  clockNow = () => h.clock.now().getTime();
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

async function storedOf(h: ConnectionsHarness, connectionId: string) {
  return parseStoredCredential((await h.store.connections.getCredential(connectionId)) ?? '');
}

async function expectConnectError(promise: Promise<unknown>, code: string): Promise<ConnectError> {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ConnectError);
  expect((err as ConnectError).code).toBe(code);
  return err as ConnectError;
}

function callsTo(path: string) {
  return broker.calls.filter((c) => c.path === path);
}

describe('a plugin whose client is an OAuth broker', () => {
  it('is listed as not configured, with the reason, when no broker serves its provider', async () => {
    const h = harness(null);
    const [provider] = await h.service.providers();
    expect(provider?.unavailable).toMatch(/OAuth broker .* none is configured for "google"/);
    expect(provider?.brokerAttested).toBeNull();
    const alice = await h.actor('alice@example.com');
    await expectConnectError(h.service.start(alice, PLUGIN), 'broker-not-configured');
  });

  it('attests the broker, then starts at it with the S256 challenge, never the verifier, and the gateway’s state', async () => {
    const h = harness();
    const [provider] = await h.service.providers();
    expect(provider).toMatchObject({ unavailable: null, viaBroker: true, brokerAttested: true });
    const { authorizeUrl } = await startFlow(h);
    expect(authorizeUrl.startsWith(FAKE_AUTHORIZE_URL)).toBe(true);
    const [attest, flows] = broker.calls;
    // No body, no key: the broker answers its cached evidence to anyone.
    expect(attest).toMatchObject({ method: 'POST', path: '/attest', status: 200, body: null });
    expect(attest?.withKey).toBe(false);
    expect(flows).toMatchObject({ method: 'POST', path: '/flows', instance: 'instance-a' });
    expect(flows?.body).toMatchObject({
      provider: 'google',
      scopes: BROKERED.scopes,
      return_url: h.service.callbackUrl(PLUGIN).href,
      challenge_method: 'S256',
    });
    expect(flows?.body).not.toHaveProperty('verifier');
    expect(typeof flows?.body?.state).toBe('string');
  });

  it('redeems the grant with the verifier and seals the refresh token beside the access token, out of the plugin’s sight', async () => {
    const h = harness();
    const { connection } = await connect(h);
    const [redeem] = callsTo('/grants/redeem');
    const [flows] = callsTo('/flows');
    expect(redeem?.status).toBe(200);
    expect(challengeOf(String(redeem?.body?.verifier))).toBe(flows?.body?.challenge);

    const stored = await storedOf(h, connection.id);
    const [refreshToken] = [...broker.providerRefreshTokens.keys()];
    expect(stored.brokerGrant).toEqual({ broker: 'main', refreshToken });
    expect(stored.secret).toMatchObject({ kind: 'oauth2', refreshToken: null });
    // The plugin's discovery saw an access token and nothing of the broker.
    expect(seenByPlugin).toHaveLength(1);
    expect(JSON.stringify(seenByPlugin[0])).not.toContain(refreshToken ?? 'none');
    expect(JSON.stringify(seenByPlugin[0])).not.toContain('brokerGrant');
    const view = (await h.service.listFor(await h.actor('alice@example.com')))[0];
    expect(view?.tokenAccount).toBe('alice@acme.example');
    expect(view?.oauthBroker).toEqual({ name: 'main', attested: true });
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

  it('refreshes with POST /token and the sealed refresh token, keeping it', async () => {
    const h = harness();
    const { connection } = await connect(h);
    const before = await storedOf(h, connection.id);
    h.clock.advance(60 * 60_000 - REFRESH_SKEW_MS + 1_000);
    const resolved = await h.broker.resolve(connection.id);
    const [refresh] = callsTo('/token');
    expect(refresh).toMatchObject({ status: 200, instance: 'instance-a' });
    expect(refresh?.body).toEqual({
      provider: 'google',
      refresh_token: before.brokerGrant?.refreshToken,
    });
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
    expect(record.error).toMatch(/OAuth broker 'main' could not be attested \(token: answered 503/);
  });

  it('a refresh token the provider refuses (invalid_grant) turns the connection expired', async () => {
    const h = harness();
    const { connection } = await connect(h);
    broker.refusingProvider();
    await expect(h.broker.refresh(connection.id)).rejects.toBeInstanceOf(UpstreamAuthError);
    expect((await h.store.connections.getById(connection.id))?.status).toBe('expired');
    expect(callsTo('/token')[0]).toMatchObject({ status: 400 });
  });

  it('revoking the connection relays the refresh token to POST /revoke', async () => {
    const h = harness();
    const { alice, connection } = await connect(h);
    const { brokerGrant } = await storedOf(h, connection.id);
    expect(h.service.providerGrantOf(connection).grant.withdrawnByGateway).toBe(true);
    const revoked = await h.service.revoke(alice, connection.id);
    expect(revoked.providerGrant).toBe('revoked');
    expect(callsTo('/revoke')[0]?.body).toEqual({
      provider: 'google',
      refresh_token: brokerGrant?.refreshToken,
    });
    expect(broker.revokedAtProvider).toEqual([brokerGrant?.refreshToken]);
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
    return { grant: back.searchParams.get('grant') ?? '' };
  }

  /** The client of the configured broker, as the gateway holds it. */
  function mainClient(h: ConnectionsHarness): OAuthBrokerClient {
    const client = h.brokers.byName('main');
    if (!client) throw new Error('no broker');
    return client;
  }

  function io(): OAuthBrokerIo {
    return { fetch, attestation: broker.attestationKit(), now: () => clockNow() };
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
    const { back } = await connect(h);
    const [redeem] = callsTo('/grants/redeem');
    const err = await refusal(
      mainClient(h).redeem(back.searchParams.get('grant') ?? '', String(redeem?.body?.verifier)),
    );
    expect(err).toMatchObject({ status: 400, code: 'invalid_grant', grantGone: true });
  });

  it('a grant redeemed late is refused', async () => {
    const h = harness();
    const { grant } = await pendingGrant(h);
    h.clock.advance(FAKE_GRANT_TTL_MS + 1);
    const err = await refusal(mainClient(h).redeem(grant, 'v'.repeat(43)));
    expect(err).toMatchObject({ status: 400, code: 'invalid_grant' });
  });

  it('a grant redeemed with the wrong verifier is refused', async () => {
    const h = harness();
    const { grant } = await pendingGrant(h);
    const err = await refusal(mainClient(h).redeem(grant, 'w'.repeat(43)));
    expect(err).toMatchObject({ status: 400, code: 'invalid_grant', grantGone: true });
  });

  it('a grant redeemed by another instance is refused', async () => {
    const h = harness();
    const { grant } = await pendingGrant(h);
    const other = new OAuthBrokerClient(broker.configFor(OTHER_KEY, 'other'), io());
    const err = await refusal(other.redeem(grant, 'v'.repeat(43)));
    expect(err).toMatchObject({ status: 400, code: 'invalid_grant' });
  });

  it('a bad key is refused, and it is not a dead grant', async () => {
    const client = new OAuthBrokerClient(broker.configFor('not-a-key'), io());
    const err = await refusal(client.token('google', 'rt_abcdefghijkl'));
    // The attestation takes no key; the call that follows is refused.
    expect(callsTo('/attest')[0]?.status).toBe(200);
    expect(err).toMatchObject({ status: 401, code: 'invalid_key', grantGone: false });
    expect(err.message).not.toContain('not-a-key');
  });

  it('a code the provider refuses at the redeem is invalid_grant: the connect fails', async () => {
    const h = harness();
    const { alice, authorizeUrl } = await startFlow(h);
    broker.refusingCode();
    const back = broker.approve(authorizeUrl);
    await expectConnectError(
      h.service.complete(alice, PLUGIN, back.searchParams),
      'token-exchange-failed',
    );
    expect(callsTo('/grants/redeem')[0]).toMatchObject({ status: 400 });
    expect(broker.providerRefreshTokens.size).toBe(0);
    expect(await h.store.connections.listOwnedBy([{ kind: 'user', id: alice.user.id }])).toEqual(
      [],
    );
  });

  it('a broker that is down is a failure of the broker, not of the grant', async () => {
    const client = new OAuthBrokerClient(broker.configFor(KEY), io());
    await client.token('google', 'rt_unknown').catch(() => null);
    broker.down();
    expect(await refusal(client.token('google', 'rt_abcdefghijkl'))).toMatchObject({
      status: 503,
      grantGone: false,
    });
    await broker.stop();
    expect(await refusal(client.token('google', 'rt_abcdefghijkl'))).toMatchObject({
      status: 0,
      grantGone: false,
    });
    // Restarted for afterEach.
    broker = await startBroker();
  });

  it('never sends the key anywhere but the Authorization header, and never to /attest', async () => {
    const h = harness();
    await connect(h);
    for (const call of broker.calls) expect(JSON.stringify(call.body)).not.toContain(KEY);
    expect(callsTo('/attest').map((c) => c.withKey)).toEqual([false]);
    expect(broker.calls.filter((c) => c.path !== '/attest').every((c) => c.withKey)).toBe(true);
  });
});

describe('the attestation of the broker', () => {
  async function failedStart(h: ConnectionsHarness): Promise<ConnectError> {
    const alice = await h.actor('alice@example.com');
    return expectConnectError(h.service.start(alice, PLUGIN), 'broker-failed');
  }

  it('is obtained once and pinned: the calls that follow reuse it, until it is an hour old', async () => {
    const h = harness();
    const { connection } = await connect(h);
    expect(callsTo('/attest')).toHaveLength(1);
    expect(h.brokers.byName('main')?.admitted).toMatchObject({
      platform: 'fake-enclave',
      measurement: FAKE_BROKER_MEASUREMENT,
      brokerVersion: 'fake',
    });
    h.clock.advance(MAX_PIN_MS + 1_000);
    await h.broker.refresh(connection.id);
    expect(callsTo('/attest')).toHaveLength(2);
  });

  it('accepts the broker’s cached evidence, and pins it until its own exp when that is sooner than an hour', async () => {
    const h = harness();
    // An evidence that holds 20 minutes, served cached for up to 5.
    broker.attestWith({ ttlMs: 20 * 60_000 });
    const { connection } = await connect(h);
    const start = clockNow();
    h.clock.advance(4 * 60_000);
    // Another instance asks within the refresh cycle: the same cached evidence, admitted.
    const other = new OAuthBrokerClient(broker.configFor(OTHER_KEY, 'other'), {
      fetch,
      attestation: broker.attestationKit(),
      now: () => clockNow(),
    });
    await other.token('google', 'rt_unknown').catch(() => null);
    expect(callsTo('/attest').map((c) => c.status)).toEqual([200, 200]);
    expect(other.admitted?.expiresAt).toBe(h.brokers.byName('main')?.admitted?.expiresAt);
    // The pin ends with the evidence (20 min), not after an hour.
    expect(h.brokers.byName('main')?.admitted?.expiresAt).toBe(start + 20 * 60_000);
    h.clock.advance(17 * 60_000);
    expect(h.brokers.byName('main')?.admitted).toBeNull();
    await h.broker.refresh(connection.id);
    expect(callsTo('/attest')).toHaveLength(3);
  });

  it('a second caller joins the attestation in progress; the first one timing out does not cut it short', async () => {
    harness();
    const channel = new AttestedChannel(broker.url, KEY, {
      verifier: new AttestationVerifier(broker.attestationKit()),
      now: () => clockNow(),
    });
    const held = broker.holdAttest();
    const impatient = new AbortController();
    const body = JSON.stringify({ provider: 'google', refresh_token: 'rt_unknown' });
    const first = channel.send('/token', body, impatient.signal);
    await held.arrived;
    const second = channel.send('/token', body, AbortSignal.timeout(10_000));
    impatient.abort(new DOMException('timed out', 'TimeoutError'));
    await expect(first).rejects.toMatchObject({ kind: 'unreachable' });
    held.release();
    expect((await second).status).toBe(400);
    // One attestation served both: the second caller waited for it.
    expect(callsTo('/attest')).toHaveLength(1);
    expect(callsTo('/token')).toHaveLength(1);
  });

  it('a 3xx answer is refused, on /attest and on a call: nothing is followed', async () => {
    const h = harness();
    broker.redirecting('/attest');
    expect((await failedStart(h)).message).toMatch(
      /could not be attested \(flows: answered 302 to attest\)/,
    );
    expect(callsTo('/flows')).toEqual([]);
  });

  it('a 3xx answer to a call is the broker’s failure, not followed', async () => {
    const h = harness();
    const { connection } = await connect(h);
    broker.redirecting('/token');
    const err = await h.broker.refresh(connection.id).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OAuthBrokerUnavailableError);
    expect((err as Error).message).toMatch(/answered 302 to token/);
    expect((await h.store.connections.getById(connection.id))?.status).toBe('active');
  });

  it('a release that admits no broker version sends the broker nothing', async () => {
    const h = harness(KEY, []);
    const err = await failedStart(h);
    expect(err.message).toContain(NO_ADMITTED_VERSION);
    expect(broker.calls).toEqual([]);
  });

  it('a broker version this release does not admit gets no flow, no verifier, no refresh token', async () => {
    const h = harness();
    broker.attestWith({ measurement: `sha256:${'0'.repeat(64)}` });
    const err = await failedStart(h);
    expect(err.message).toMatch(
      /is not attested \(flows: the broker runs a version this release does not admit\)/,
    );
    expect(callsTo('/flows')).toEqual([]);
  });

  it('evidence for another TLS key than the connection’s is refused (someone else answers)', async () => {
    const h = harness();
    broker.attestWith({ spkiHash: 'A'.repeat(43) });
    const err = await failedStart(h);
    expect(err.message).toMatch(/not bound to this connection’s key/);
    expect(callsTo('/flows')).toEqual([]);
  });

  it('a debug image is refused', async () => {
    const h = harness();
    broker.attestWith({ debug: true });
    expect((await failedStart(h)).message).toMatch(/debug image/);
  });

  it('a broker that restarted with a new key is attested again, then served', async () => {
    const h = harness();
    const { connection } = await connect(h);
    broker.rotateTlsKey();
    await h.broker.refresh(connection.id);
    expect(callsTo('/attest')).toHaveLength(2);
    expect(callsTo('/token')[0]?.status).toBe(200);
  });

  it('a key the broker presents and no attestation carries gets nothing', async () => {
    const h = harness();
    const { connection } = await connect(h);
    // The enclave's key changes, and the new attestation still names the old one.
    const old = broker.spkiHash ?? '';
    broker.rotateTlsKey();
    broker.attestWith({ spkiHash: old });
    await expect(h.broker.refresh(connection.id)).rejects.toBeInstanceOf(
      OAuthBrokerUnavailableError,
    );
    expect(callsTo('/token')).toEqual([]);
    expect((await h.store.connections.getById(connection.id))?.status).toBe('active');
  });
});

describe('a broker declared attestation: none', () => {
  beforeEach(async () => {
    await broker.stop();
    broker = await startBroker('none');
  });

  it('is reached as any HTTPS service, its certificate checked, without /attest, and every page says it is not attested', async () => {
    const h = harness(KEY, [], broker.trustingFetch());
    expect((await h.service.providers())[0]?.brokerAttested).toBe(false);
    const { connection } = await connect(h);
    expect(callsTo('/attest')).toEqual([]);
    expect(callsTo('/grants/redeem')[0]?.status).toBe(200);
    expect(
      (await h.service.get(await h.actor('alice@example.com'), connection.id)).oauthBroker,
    ).toEqual({
      name: 'main',
      attested: false,
    });
    expect(h.brokers.byName('main')?.admitted).toBeNull();
  });

  it('a certificate no authority of the gateway vouches for is refused: nothing is sent', async () => {
    const h = harness(KEY, [], globalThis.fetch);
    const alice = await h.actor('alice@example.com');
    const err = await expectConnectError(h.service.start(alice, PLUGIN), 'broker-failed');
    expect(err.message).toMatch(/could not be reached/);
    expect(broker.calls).toEqual([]);
  });

  it('a 3xx answer is refused, not followed', async () => {
    const h = harness(KEY, [], broker.trustingFetch());
    broker.redirecting('/flows');
    const err = await expectConnectError(
      h.service.start(await h.actor('alice@example.com'), PLUGIN),
      'broker-failed',
    );
    expect(err.message).toMatch(/could not be reached/);
  });

  it('an answer longer than 256 KiB is refused', async () => {
    const channel = new FetchChannel(
      broker.url,
      KEY,
      async () => new Response('x'.repeat(MAX_ANSWER_BYTES + 1), { status: 200 }),
    );
    await expect(channel.send('/token', '{}', AbortSignal.timeout(5_000))).rejects.toMatchObject({
      kind: 'unreachable',
      message: 'answered more than a broker answers',
    });
  });
});

describe('the attestation kit of this release', () => {
  it('verifies Google Confidential Space only: no test platform, and an empty allowlist admits nothing', () => {
    const kit = productionAttestationKit({ fetch });
    expect(kit.platforms.map((p) => p.platform)).toEqual([GCP_CONFIDENTIAL_SPACE]);
    expect(kit.allowlist).toEqual([]);
    expect(new AttestationVerifier(kit).admitsAny).toBe(false);
  });
});
