import { describe, expect, it } from 'vitest';
import { ConfigError, isAllowedUrl, parseConfig } from '../../src/config.ts';
import { FlowStore, type FlowStart } from '../../src/flows.ts';
import { PROVIDERS } from '../../src/providers.ts';

const DIGEST = 'a'.repeat(64);
const valid = {
  public_url: 'https://broker.example.com/',
  providers: { google: { client_id: 'cid.apps.googleusercontent.com' } },
  instances: [
    {
      id: 'acme',
      key_sha256: DIGEST,
      return_urls: ['https://gw.acme.example/connections/callback/google-calendar'],
    },
  ],
  platform: { local: { secrets: {} } },
};
const parse = (value: unknown): ReturnType<typeof parseConfig> =>
  parseConfig(JSON.stringify(value), PROVIDERS);

describe('configuration', () => {
  it('reads the enrollment, defaults the ports and the secret name', () => {
    const config = parse(valid);
    expect(config.publicUrl).toBe('https://broker.example.com');
    expect([config.apiPort, config.httpPort]).toEqual([8443, 8080]);
    expect(config.clients.get('google')).toEqual({
      clientId: 'cid.apps.googleusercontent.com',
      secretName: 'google-client-secret',
    });
    expect(config.instances[0]?.keyDigest.toString('hex')).toBe(DIGEST);
  });

  it.each([
    ['not JSON', null],
    ['a provider the image does not serve', { ...valid, providers: { evil: { client_id: 'x' } } }],
    [
      'a key digest that is not hex',
      { ...valid, instances: [{ ...valid.instances[0], key_sha256: 'xyz' }] },
    ],
    [
      'a key enrolled twice',
      { ...valid, instances: [valid.instances[0], { ...valid.instances[0], id: 'other' }] },
    ],
    [
      'a plain-http return URL',
      { ...valid, instances: [{ ...valid.instances[0], return_urls: ['http://gw.example/cb'] }] },
    ],
    ['no return URL', { ...valid, instances: [{ ...valid.instances[0], return_urls: [] }] }],
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

describe('flow store', () => {
  const start: FlowStart = {
    instanceId: 'acme',
    provider: 'google',
    scopes: ['email'],
    returnUrl: 'https://gw.example/cb',
    gatewayState: 's'.repeat(20),
    gatewayChallenge: 'c'.repeat(43),
  };

  it('keeps a flow ten minutes and a grant five, never past the flow', () => {
    let now = 0;
    const store = new FlowStore({ now: () => now });
    const flow = store.start(start);
    if (flow === undefined) throw new Error('no flow');
    now = 9 * 60_000;
    expect(store.awaitingCallback(flow.id)).toBe(flow);
    const grant = store.issueGrant(flow, 'code');
    expect(store.awaitingCallback(flow.id)).toBeUndefined(); // one callback per flow
    now = 10 * 60_000; // grant 1 minute old, flow 10 minutes old
    expect(store.takeByGrant(grant)).toBeUndefined();

    now = 0;
    const second = store.start(start);
    if (second === undefined) throw new Error('no flow');
    const grant2 = store.issueGrant(second, 'code');
    now = 5 * 60_000;
    expect(store.takeByGrant(grant2)).toBeUndefined();
  });

  it('spends a grant at its first attempt', () => {
    const store = new FlowStore();
    const flow = store.start(start);
    if (flow === undefined) throw new Error('no flow');
    const grant = store.issueGrant(flow, 'code');
    expect(store.takeByGrant(grant)?.code).toBe('code');
    expect(store.takeByGrant(grant)).toBeUndefined();
    expect(store.size).toBe(0);
  });

  it('refuses a new flow when full, and sweeps expired ones', () => {
    let now = 0;
    const store = new FlowStore({ now: () => now, maxFlows: 2 });
    expect(store.start(start)).toBeDefined();
    expect(store.start(start)).toBeDefined();
    expect(store.start(start)).toBeUndefined();
    now = 11 * 60_000;
    expect(store.start(start)).toBeDefined();
    expect(store.size).toBe(1);
  });

  it('gives each flow its own id and its own PKCE verifier', () => {
    const store = new FlowStore();
    const a = store.start(start);
    const b = store.start(start);
    expect(a?.id).not.toBe(b?.id);
    expect(a?.brokerVerifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a?.brokerVerifier).not.toBe(b?.brokerVerifier);
  });
});
