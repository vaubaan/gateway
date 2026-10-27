import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ConfigError, isAllowedUrl, parseConfig } from '../../src/config.ts';
import { type Flow, FlowStore, type FlowStart, type StartResult } from '../../src/flows.ts';
import { PROVIDERS } from '../../src/providers.ts';

const DIGEST = 'a'.repeat(64);
const URL_DIGEST = createHash('sha256')
  .update('https://gw.acme.example/connections/callback/google-calendar')
  .digest('hex');
const instance = { id: 'i_3f9a1c7e', key_sha256: DIGEST, return_url_sha256: [URL_DIGEST] };
const valid = {
  public_url: 'https://broker.example.com/',
  providers: { google: { client_id: 'cid.apps.googleusercontent.com' } },
  instances: [instance],
  platform: { local: { secrets: {} } },
};
const parse = (value: unknown): ReturnType<typeof parseConfig> =>
  parseConfig(JSON.stringify(value), PROVIDERS);

describe('configuration', () => {
  it('reads the enrollment as digests, defaults the ports and the secret name', () => {
    const config = parse(valid);
    expect(config.publicUrl).toBe('https://broker.example.com');
    expect([config.apiPort, config.httpPort]).toEqual([8443, 8080]);
    expect(config.clients.get('google')).toEqual({
      clientId: 'cid.apps.googleusercontent.com',
      secretName: 'google-client-secret',
    });
    expect(config.instances[0]?.keyDigest.toString('hex')).toBe(DIGEST);
    expect([...(config.instances[0]?.returnUrlDigests ?? [])]).toEqual([URL_DIGEST]);
  });

  it.each([
    ['not JSON', null],
    ['a provider the image does not serve', { ...valid, providers: { evil: { client_id: 'x' } } }],
    ['a key digest that is not hex', { ...valid, instances: [{ ...instance, key_sha256: 'xyz' }] }],
    ['a key enrolled twice', { ...valid, instances: [instance, { ...instance, id: 'i_other_1' }] }],
    [
      'an id enrolled twice',
      { ...valid, instances: [instance, { ...instance, key_sha256: 'b'.repeat(64) }] },
    ],
    ['a short id', { ...valid, instances: [{ ...instance, id: 'acme' }] }],
    [
      'a return URL in clear instead of its digest',
      { ...valid, instances: [{ ...instance, return_url_sha256: ['https://gw.example/cb'] }] },
    ],
    ['no return URL', { ...valid, instances: [{ ...instance, return_url_sha256: [] }] }],
    [
      'the former return_urls key',
      {
        ...valid,
        instances: [{ id: instance.id, key_sha256: DIGEST, return_urls: ['https://x.example/'] }],
      },
    ],
    ['a public URL with a query', { ...valid, public_url: 'https://broker.example.com/?a=1' }],
  ])('refuses %s', (_label, value) => {
    expect(() => (value === null ? parseConfig('{', PROVIDERS) : parse(value))).toThrow(
      ConfigError,
    );
  });

  it('allows plain http on loopback only', () => {
    expect(isAllowedUrl('http://127.0.0.1:8080/cb')).toBe(true);
    expect(isAllowedUrl('http://example.com/cb')).toBe(false);
    expect(isAllowedUrl('https://user:pw@example.com/')).toBe(false);
  });
});

function flowOf(result: StartResult): Flow {
  if (!('flow' in result)) throw new Error(`refused: ${result.full}`);
  return result.flow;
}

describe('flow store', () => {
  const start: FlowStart = {
    instanceId: 'i_3f9a1c7e',
    provider: 'google',
    scopes: ['email'],
    returnUrl: 'https://gw.example/cb',
    gatewayState: 's'.repeat(20),
    gatewayChallenge: 'c'.repeat(43),
  };

  it('keeps a flow ten minutes and a grant five, never past the flow', () => {
    let now = 0;
    const store = new FlowStore({ now: () => now });
    const flow = flowOf(store.start(start));
    now = 9 * 60_000;
    expect(store.awaitingCallback(flow.id)).toBe(flow);
    const grant = store.issueGrant(flow, 'code');
    expect(store.awaitingCallback(flow.id)).toBeUndefined(); // one callback per flow
    now = 10 * 60_000; // grant 1 minute old, flow 10 minutes old
    expect(store.takeByGrant(grant)).toBeUndefined();

    now = 0;
    const second = flowOf(store.start(start));
    const grant2 = store.issueGrant(second, 'code');
    now = 5 * 60_000;
    expect(store.takeByGrant(grant2)).toBeUndefined();
  });

  it('spends a grant at its first attempt', () => {
    const store = new FlowStore();
    const flow = flowOf(store.start(start));
    const grant = store.issueGrant(flow, 'code');
    expect(store.takeByGrant(grant)?.code).toBe('code');
    expect(store.takeByGrant(grant)).toBeUndefined();
    expect(store.size).toBe(0);
  });

  it('refuses a new flow when full, and sweeps expired ones', () => {
    let now = 0;
    const store = new FlowStore({ now: () => now, maxFlows: 2 });
    flowOf(store.start(start));
    flowOf(store.start({ ...start, instanceId: 'i_other_1' }));
    expect(store.start(start)).toEqual({ full: 'broker' });
    now = 11 * 60_000;
    flowOf(store.start(start));
    expect(store.size).toBe(1);
  });

  it('caps the flows of one instance, leaving the others free, and counts down as flows end', () => {
    let now = 0;
    const store = new FlowStore({ now: () => now, maxFlowsPerInstance: 2 });
    const first = flowOf(store.start(start));
    const second = flowOf(store.start(start));
    expect(store.start(start)).toEqual({ full: 'instance' });
    flowOf(store.start({ ...start, instanceId: 'i_other_1' })); // another instance is not affected

    store.end(first); // a refusal at the provider
    const third = flowOf(store.start(start));
    store.takeByGrant(store.issueGrant(second, 'code')); // a redeem
    flowOf(store.start(start));
    expect(store.start(start)).toEqual({ full: 'instance' });

    now = 11 * 60_000; // expired flows no longer count
    flowOf(store.start(start));
    store.end(third);
  });

  it('defaults to 500 flows per instance', () => {
    const store = new FlowStore();
    for (let i = 0; i < 500; i += 1) flowOf(store.start(start));
    expect(store.start(start)).toEqual({ full: 'instance' });
    flowOf(store.start({ ...start, instanceId: 'i_other_1' }));
  });

  it('gives each flow its own id and its own PKCE verifier', () => {
    const store = new FlowStore();
    const a = flowOf(store.start(start));
    const b = flowOf(store.start(start));
    expect(a.id).not.toBe(b.id);
    expect(a.brokerVerifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a.brokerVerifier).not.toBe(b.brokerVerifier);
  });
});
