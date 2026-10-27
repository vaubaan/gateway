/**
 * The whole broker, both listeners, against a fake provider (a local HTTP
 * server playing the token and revocation endpoints) and the local platform
 * adapter. The test plays the gateway (API calls over TLS, pinning the key the
 * attestation names) and the person's browser (the callback).
 */
import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { type AddressInfo } from 'node:net';
import { type TLSSocket } from 'node:tls';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type RunningBroker, startBroker } from '../../src/app.ts';
import { parseConfig } from '../../src/config.ts';
import { s256 } from '../../src/crypto-util.ts';
import { createLogger } from '../../src/log.ts';
import { createLocalAdapter } from '../../src/platform/local.ts';
import { type ProviderDefinition } from '../../src/providers.ts';

const KEY_A = `bk_${randomBytes(24).toString('base64url')}`;
const KEY_B = `bk_${randomBytes(24).toString('base64url')}`;
const CLIENT_SECRET = `cs_${randomBytes(16).toString('hex')}`;
const RETURN_A = 'https://gw-a.example/connections/callback/google-calendar';
const RETURN_B = 'https://gw-b.example/connections/callback/google-calendar';
const SCOPES = ['openid', 'email', 'https://www.googleapis.com/auth/calendar.events'];
const digest = (key: string): string => createHash('sha256').update(key).digest('hex');

// ---- the fake provider ------------------------------------------------------

interface ProviderCall {
  path: string;
  form: Record<string, string>;
}
const provider = {
  calls: [] as ProviderCall[],
  down: false,
  /** code → the S256 challenge the authorize URL carried for it */
  codes: new Map<string, string>(),
  revoked: new Set<string>(),
};
let providerServer: Server;

function idToken(email: string): string {
  const part = (value: object): string => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${part({ alg: 'RS256' })}.${part({ email })}.sig`;
}

function providerAnswer(
  path: string,
  form: Record<string, string>,
): { status: number; body: object | null } {
  if (provider.down) return { status: 503, body: { error: 'temporarily_unavailable' } };
  if (form.client_secret !== CLIENT_SECRET)
    return { status: 401, body: { error: 'invalid_client' } };
  if (path === '/revoke') {
    const token = form.token ?? '';
    if (provider.revoked.has(token)) return { status: 400, body: { error: 'invalid_token' } };
    provider.revoked.add(token);
    return { status: 200, body: null };
  }
  if (form.grant_type === 'authorization_code') {
    const challenge = provider.codes.get(form.code ?? '');
    provider.codes.delete(form.code ?? '');
    if (challenge === undefined || s256(form.code_verifier ?? '') !== challenge) {
      return { status: 400, body: { error: 'invalid_grant' } };
    }
    return {
      status: 200,
      body: {
        access_token: 'at_first',
        refresh_token: `rt_${randomBytes(8).toString('hex')}`,
        expires_in: 3599,
        scope: SCOPES.join(' '),
        token_type: 'Bearer',
        id_token: idToken('alice@acme.example'),
      },
    };
  }
  if (form.grant_type === 'refresh_token') {
    if (provider.revoked.has(form.refresh_token ?? ''))
      return { status: 400, body: { error: 'invalid_grant' } };
    return {
      status: 200,
      body: { access_token: 'at_refreshed', expires_in: 3599, token_type: 'Bearer' },
    };
  }
  return { status: 400, body: { error: 'unsupported_grant_type' } };
}

// ---- the broker -----------------------------------------------------------

let now = Date.parse('2026-10-27T10:00:00Z');
let broker: RunningBroker;
const logLines: string[] = [];

beforeAll(async () => {
  providerServer = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString()));
    req.on('end', () => {
      const form = Object.fromEntries(new URLSearchParams(body));
      provider.calls.push({ path: req.url ?? '', form });
      const { status, body: answer } = providerAnswer(req.url ?? '', form);
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(answer === null ? '' : JSON.stringify(answer));
    });
  });
  await new Promise<void>((resolve) => providerServer.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(providerServer.address() as AddressInfo).port}`;
  const fake: ProviderDefinition = {
    id: 'google',
    authorizeEndpoint: 'https://accounts.provider.example/authorize',
    tokenEndpoint: `${base}/token`,
    revokeEndpoint: `${base}/revoke`,
    allowedScopes: new Set(SCOPES),
    authorizeParams: { access_type: 'offline', prompt: 'consent' },
  };
  const providers = new Map([[fake.id, fake]]);
  const config = parseConfig(
    JSON.stringify({
      public_url: 'https://broker.example.com',
      providers: { google: { client_id: 'cid.example' } },
      instances: [
        { id: 'a', key_sha256: digest(KEY_A), return_urls: [RETURN_A] },
        { id: 'b', key_sha256: digest(KEY_B), return_urls: [RETURN_B] },
      ],
    }),
    providers,
  );
  broker = await startBroker({
    config: { ...config, apiPort: 0, httpPort: 0 },
    providers,
    platform: createLocalAdapter({ secrets: { 'google-client-secret': CLIENT_SECRET } }),
    log: createLogger((line) => logLines.push(line)),
    now: () => now,
    host: '127.0.0.1',
  });
});

afterAll(async () => {
  await broker.close();
  await new Promise<void>((resolve) => providerServer.close(() => resolve()));
});

beforeEach(() => {
  provider.down = false;
  provider.calls = [];
});

// ---- the gateway's side and the browser's ---------------------------------

interface Answer {
  status: number;
  json: Record<string, unknown> | undefined;
  peerKeySha256: string;
}

function api(
  path: string,
  body: unknown,
  key: string | null = KEY_A,
  raw?: string,
): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const payload = raw ?? JSON.stringify(body);
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (key !== null) headers.authorization = `Bearer ${key}`;
    // No certificate authority: the key is pinned through the attestation instead.
    const req = httpsRequest(
      {
        host: '127.0.0.1',
        port: broker.apiPort,
        path,
        method: 'POST',
        headers,
        rejectUnauthorized: false,
      },
      (res) => {
        const spki = (res.socket as TLSSocket)
          .getPeerX509Certificate()
          ?.publicKey.export({ type: 'spki', format: 'der' });
        let text = '';
        res.on('data', (chunk: Buffer) => (text += chunk.toString()));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            json: text === '' ? undefined : (JSON.parse(text) as Record<string, unknown>),
            peerKeySha256:
              spki === undefined ? '' : createHash('sha256').update(spki).digest('base64url'),
          }),
        );
      },
    );
    req.on('error', reject);
    req.end(payload);
  });
}

async function browser(path: string): Promise<{ status: number; location: URL | undefined }> {
  const res = await fetch(`http://127.0.0.1:${broker.httpPort}${path}`, { redirect: 'manual' });
  const location = res.headers.get('location');
  return { status: res.status, location: location === null ? undefined : new URL(location) };
}

interface Started {
  verifier: string;
  state: string;
  authorize: URL;
}

async function startFlow(key = KEY_A, returnUrl = RETURN_A): Promise<Started> {
  const verifier = randomBytes(32).toString('base64url');
  const state = randomBytes(24).toString('base64url');
  const res = await api(
    '/flows',
    {
      provider: 'google',
      scopes: SCOPES,
      return_url: returnUrl,
      state,
      challenge: s256(verifier),
      challenge_method: 'S256',
    },
    key,
  );
  expect(res.status).toBe(201);
  return { verifier, state, authorize: new URL(String(res.json?.authorize_url)) };
}

/** The person consents: the provider sends the browser back with a code. */
async function consent(flow: Started): Promise<{ grant: string; location: URL }> {
  const code = `code_${randomBytes(8).toString('hex')}`;
  provider.codes.set(code, flow.authorize.searchParams.get('code_challenge') ?? '');
  const back = await browser(
    `/oauth/callback/google?code=${code}&state=${flow.authorize.searchParams.get('state')}`,
  );
  expect(back.status).toBe(302);
  if (back.location === undefined) throw new Error('no redirect');
  return { grant: back.location.searchParams.get('grant') ?? '', location: back.location };
}

// ---- the scenarios ---------------------------------------------------------

describe('a flow from start to redeem', () => {
  it('runs the authorization-code flow and answers the tokens to the instance only', async () => {
    const flow = await startFlow();
    const a = flow.authorize;
    expect(a.origin + a.pathname).toBe('https://accounts.provider.example/authorize');
    expect(Object.fromEntries(a.searchParams)).toMatchObject({
      client_id: 'cid.example',
      redirect_uri: 'https://broker.example.com/oauth/callback/google',
      response_type: 'code',
      scope: SCOPES.join(' '),
      code_challenge_method: 'S256',
      access_type: 'offline',
      prompt: 'consent',
    });
    // The broker's own state and its own challenge, not the gateway's.
    expect(a.searchParams.get('state')).not.toBe(flow.state);
    expect(a.searchParams.get('code_challenge')).not.toBe(s256(flow.verifier));

    const { grant, location } = await consent(flow);
    expect(location.origin + location.pathname).toBe(RETURN_A);
    expect([...location.searchParams.keys()].sort()).toEqual(['grant', 'state']);
    expect(location.searchParams.get('state')).toBe(flow.state);
    expect(provider.calls).toHaveLength(0); // the code waits in the flow, unexchanged

    const redeemed = await api('/grants/redeem', { grant, verifier: flow.verifier });
    expect(redeemed.status).toBe(200);
    expect(redeemed.json).toEqual({
      refresh_token: expect.stringMatching(/^rt_/) as unknown,
      access_token: 'at_first',
      expires_at: new Date(now + 3599_000).toISOString(),
      account: 'alice@acme.example',
      scopes: SCOPES,
    });
    expect(provider.calls[0]?.form).toMatchObject({
      grant_type: 'authorization_code',
      redirect_uri: 'https://broker.example.com/oauth/callback/google',
      client_id: 'cid.example',
    });

    // Spent: the second attempt gets the one answer.
    expect((await api('/grants/redeem', { grant, verifier: flow.verifier })).json).toMatchObject({
      error: 'invalid_grant',
    });
  });

  it('accepts one callback per flow', async () => {
    const flow = await startFlow();
    await consent(flow);
    const again = await browser(
      `/oauth/callback/google?code=other&state=${flow.authorize.searchParams.get('state')}`,
    );
    expect(again.status).toBe(400);
  });

  it('sends a refusal at the provider back as a protocol code, and forgets the flow', async () => {
    const flow = await startFlow();
    const id = flow.authorize.searchParams.get('state') ?? '';
    const back = await browser(`/oauth/callback/google?error=access_denied&state=${id}`);
    expect(back.status).toBe(302);
    expect(Object.fromEntries(back.location?.searchParams ?? [])).toEqual({
      error: 'access_denied',
      state: flow.state,
    });
    expect((await browser(`/oauth/callback/google?code=late&state=${id}`)).status).toBe(400);

    const odd = await startFlow();
    const weird = await browser(
      `/oauth/callback/google?error=${encodeURIComponent('<script>')}&state=${odd.authorize.searchParams.get('state')}`,
    );
    expect(weird.location?.searchParams.get('error')).toBe('server_error');
  });
});

describe('a redeem is refused with one answer', () => {
  it('for another instance, and the grant is spent', async () => {
    const flow = await startFlow();
    const { grant } = await consent(flow);
    const res = await api('/grants/redeem', { grant, verifier: flow.verifier }, KEY_B);
    expect([res.status, res.json?.error]).toEqual([400, 'invalid_grant']);
    expect((await api('/grants/redeem', { grant, verifier: flow.verifier })).status).toBe(400);
    expect(provider.calls).toHaveLength(0);
  });

  it('with the wrong verifier, before any exchange', async () => {
    const flow = await startFlow();
    const { grant } = await consent(flow);
    const res = await api('/grants/redeem', {
      grant,
      verifier: randomBytes(32).toString('base64url'),
    });
    expect([res.status, res.json?.error]).toEqual([400, 'invalid_grant']);
    expect(provider.calls).toHaveLength(0);
  });

  it('when the grant is past its lifetime', async () => {
    const flow = await startFlow();
    const { grant } = await consent(flow);
    now += 5 * 60_000;
    const res = await api('/grants/redeem', { grant, verifier: flow.verifier });
    expect([res.status, res.json?.error]).toEqual([400, 'invalid_grant']);
  });

  it('when the provider refuses the code or is down', async () => {
    const flow = await startFlow();
    const { grant } = await consent(flow);
    provider.down = true;
    const res = await api('/grants/redeem', { grant, verifier: flow.verifier });
    expect([res.status, res.json?.error]).toEqual([400, 'invalid_grant']);
  });

  it('for an unknown grant', async () => {
    const res = await api('/grants/redeem', { grant: 'g'.repeat(43), verifier: 'v'.repeat(43) });
    expect([res.status, res.json?.error]).toEqual([400, 'invalid_grant']);
  });
});

describe('expiry of a flow', () => {
  it('ends a flow after ten minutes: the callback is refused', async () => {
    const flow = await startFlow();
    now += 10 * 60_000;
    const back = await browser(
      `/oauth/callback/google?code=x&state=${flow.authorize.searchParams.get('state')}`,
    );
    expect(back.status).toBe(400);
    expect(back.location).toBeUndefined();
  });
});

describe('starting a flow is refused', () => {
  const body = (overrides: Record<string, unknown>): Record<string, unknown> => ({
    provider: 'google',
    scopes: SCOPES,
    return_url: RETURN_A,
    state: 's'.repeat(32),
    challenge: s256('v'.repeat(43)),
    challenge_method: 'S256',
    ...overrides,
  });

  it.each([
    [
      'a return URL on record for another instance',
      { return_url: RETURN_B },
      403,
      'return_url_not_registered',
    ],
    [
      'a scope the provider may not be asked for',
      { scopes: ['https://mail.google.com/'] },
      400,
      'invalid_scope',
    ],
    ['no scope', { scopes: [] }, 400, 'invalid_scope'],
    ['a provider it does not serve', { provider: 'github' }, 400, 'unsupported_provider'],
    ['a plain challenge', { challenge_method: 'plain' }, 400, 'invalid_request'],
    ['a short state', { state: 'short' }, 400, 'invalid_request'],
  ])('for %s', async (_label, overrides, status, error) => {
    const res = await api('/flows', body(overrides));
    expect([res.status, res.json?.error]).toEqual([status, error]);
  });

  it('without a key, or with a key not enrolled', async () => {
    for (const key of [null, 'bk_not_enrolled']) {
      const res = await api('/flows', body({}), key);
      expect([res.status, res.json?.error]).toEqual([401, 'invalid_key']);
    }
  });

  it('for a body that is too large or not JSON', async () => {
    expect((await api('/flows', null, KEY_A, `{"x":"${'a'.repeat(20_000)}"}`)).status).toBe(413);
    expect((await api('/flows', null, KEY_A, '{nope')).json?.error).toBe('invalid_request');
  });
});

describe('refresh and revocation', () => {
  it('refreshes with the client secret added, and writes nothing', async () => {
    const res = await api('/token', { provider: 'google', refresh_token: 'rt_alive' });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({
      access_token: 'at_refreshed',
      expires_at: new Date(now + 3599_000).toISOString(),
    });
    expect(provider.calls[0]?.form).toEqual({
      grant_type: 'refresh_token',
      refresh_token: 'rt_alive',
      client_id: 'cid.example',
      client_secret: CLIENT_SECRET,
    });
  });

  it('relays a revocation, idempotently, then the refresh is invalid_grant', async () => {
    expect((await api('/revoke', { provider: 'google', refresh_token: 'rt_gone' })).status).toBe(
      204,
    );
    expect((await api('/revoke', { provider: 'google', refresh_token: 'rt_gone' })).status).toBe(
      204,
    );
    expect(provider.calls[0]?.form).toMatchObject({ token: 'rt_gone' });
    const res = await api('/token', { provider: 'google', refresh_token: 'rt_gone' });
    expect([res.status, res.json?.error]).toEqual([400, 'invalid_grant']);
  });

  it('says the provider is unavailable rather than invalid_grant when it is down', async () => {
    provider.down = true;
    expect((await api('/token', { provider: 'google', refresh_token: 'rt_alive' })).status).toBe(
      502,
    );
    expect((await api('/revoke', { provider: 'google', refresh_token: 'rt_alive' })).status).toBe(
      502,
    );
  });
});

describe('attestation', () => {
  it('binds the gateway nonce and the key of the TLS connection', async () => {
    const nonce = randomBytes(32).toString('base64url');
    const res = await api('/attest', { nonce });
    expect(res.status).toBe(200);
    expect(res.json?.platform).toBe('none');
    const claims = JSON.parse(
      Buffer.from(String(res.json?.evidence).split('.')[1] ?? '', 'base64url').toString(),
    ) as Record<string, unknown>;
    expect(claims.eat_nonce).toEqual([nonce, res.peerKeySha256]);
    expect(res.peerKeySha256).toBe(broker.publicKeySha256);
    expect(claims.aud).toBe('oauth-broker-attestation');
  });

  it('refuses a nonce that is not 32 bytes in base64url', async () => {
    const res = await api('/attest', { nonce: 'short' });
    expect([res.status, res.json?.error]).toEqual([400, 'invalid_request']);
  });

  it('answers without a key: the gateway sends no secret before it has verified', async () => {
    const res = await api('/attest', { nonce: randomBytes(32).toString('base64url') }, null);
    expect(res.status).toBe(200);
  });

  it('is rate-limited, since anyone may call it', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 8; i += 1) {
      statuses.push(
        (await api('/attest', { nonce: randomBytes(32).toString('base64url') })).status,
      );
    }
    expect(statuses).toContain(429);
    const refused = await api('/attest', { nonce: randomBytes(32).toString('base64url') });
    expect([refused.status, refused.json?.error]).toEqual([429, 'rate_limited']);
  });
});

describe('the two listeners', () => {
  it('serves each its own paths', async () => {
    expect((await browser('/healthz')).status).toBe(200);
    expect((await browser('/flows')).status).toBe(404);
    expect((await api('/oauth/callback/google', {})).status).toBe(404);
    expect((await api('/healthz', {})).status).toBe(404);
  });

  it('survive a request target that is not a URL', async () => {
    const { connect } = await import('node:net');
    const reply = await new Promise<string>((resolve) => {
      const socket = connect(broker.httpPort, '127.0.0.1', () => {
        socket.write('GET http://[ HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n');
      });
      let text = '';
      socket.on('data', (chunk: Buffer) => (text += chunk.toString()));
      socket.on('close', () => resolve(text));
    });
    expect(reply).toMatch(/^HTTP\/1\.1 (400|404)/);
    expect((await browser('/healthz')).status).toBe(200);
  });
});

describe('logs', () => {
  it('carry no secret, key, token, code, verifier or state', async () => {
    const flow = await startFlow();
    const { grant } = await consent(flow);
    await api('/grants/redeem', { grant, verifier: flow.verifier });
    const all = logLines.join('');
    for (const secret of [
      CLIENT_SECRET,
      KEY_A,
      KEY_B,
      flow.verifier,
      flow.state,
      grant,
      'rt_',
      'at_first',
      'code_',
    ]) {
      expect(all).not.toContain(secret);
    }
    expect(all).toContain('"route":"/oauth/callback/:provider"');
  });

  it('name the route of a refused call', async () => {
    await api('/flows', {}, 'bk_not_enrolled');
    expect(logLines.at(-1)).toContain('"route":"/flows","status":401');
  });
});
