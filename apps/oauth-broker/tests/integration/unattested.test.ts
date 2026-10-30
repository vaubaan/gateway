/**
 * The broker without an enclave (platform `unattested`): one plain HTTP
 * listener for the API and the browser, secrets from the environment, no
 * attestation. The flow itself is the one broker-flow.test.ts covers; this
 * file checks what the mode changes.
 */
import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { type AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type RunningBroker, startBroker } from '../../src/app.ts';
import { parseConfig } from '../../src/config.ts';
import { s256 } from '../../src/crypto-util.ts';
import { createLogger } from '../../src/log.ts';
import { selectPlatform } from '../../src/platform/index.ts';
import { PlatformError } from '../../src/platform/types.ts';
import { createUnattestedAdapter, secretVariable } from '../../src/platform/unattested.ts';
import { type ProviderDefinition } from '../../src/providers.ts';

const KEY = `bk_${randomBytes(24).toString('base64url')}`;
const CLIENT_SECRET = `cs_${randomBytes(16).toString('hex')}`;
const RETURN_URL = 'https://gw.example/connections/callback/google-calendar';
const SCOPES = ['openid', 'email', 'https://www.googleapis.com/auth/calendar.events'];
const digest = (value: string): string => createHash('sha256').update(value).digest('hex');

function idToken(email: string): string {
  const part = (value: object): string => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${part({ alg: 'RS256' })}.${part({ email })}.sig`;
}

let providerServer: Server;
let broker: RunningBroker;
const logLines: string[] = [];
const env: Record<string, string | undefined> = {};

beforeAll(async () => {
  providerServer = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString()));
    req.on('end', () => {
      const form = Object.fromEntries(new URLSearchParams(body));
      const ok = form.client_secret === CLIENT_SECRET;
      res.writeHead(ok ? 200 : 401, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify(
          ok
            ? {
                access_token: 'at_first',
                refresh_token: 'rt_provider',
                expires_in: 3599,
                scope: SCOPES.join(' '),
                token_type: 'Bearer',
                id_token: idToken('alice@acme.example'),
              }
            : { error: 'invalid_client' },
        ),
      );
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
  env.OAUTH_BROKER_SECRET_GOOGLE_CLIENT_SECRET = CLIENT_SECRET;
  env.OAUTH_BROKER_SECRET_REFRESH_TOKEN_SEALING_KEY = randomBytes(32).toString('base64');
  env.UNRELATED = 'kept';
  const config = parseConfig(
    JSON.stringify({
      public_url: 'https://broker.example.com',
      providers: { google: { client_id: 'cid.example' } },
      instances: [
        { id: 'i_7c1e93ab', key_sha256: digest(KEY), return_url_sha256: [digest(RETURN_URL)] },
      ],
    }),
    providers,
  );
  broker = await startBroker({
    config: { ...config, apiPort: 0, httpPort: 0 },
    providers,
    platform: createUnattestedAdapter(env),
    log: createLogger((line) => logLines.push(line)),
    host: '127.0.0.1',
  });
});

afterAll(async () => {
  await broker.close();
  await new Promise<void>((resolve) => providerServer.close(() => resolve()));
});

function call(path: string, body?: unknown, key: string | null = KEY): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (key !== null) headers.authorization = `Bearer ${key}`;
  return fetch(`http://127.0.0.1:${broker.httpPort}${path}`, {
    method: 'POST',
    headers,
    body: body === undefined ? '' : JSON.stringify(body),
    redirect: 'manual',
  });
}

describe('a broker without an enclave', () => {
  it('opens one plain HTTP listener, with no TLS identity, and says it is not attested', () => {
    expect(broker.apiPort).toBeNull();
    expect(broker.publicKeySha256).toBeNull();
    expect(broker.certificate).toBeNull();
    const started = logLines.map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(started.find((l) => l.event === 'started')).toMatchObject({
      platform: 'unattested',
      attested: false,
    });
  });

  it('reads each secret from its variable once, and removes it from the environment', () => {
    expect(env.OAUTH_BROKER_SECRET_GOOGLE_CLIENT_SECRET).toBeUndefined();
    expect(env.OAUTH_BROKER_SECRET_REFRESH_TOKEN_SEALING_KEY).toBeUndefined();
    expect(env.UNRELATED).toBe('kept');
    expect(secretVariable('refresh-token-sealing-key')).toBe(
      'OAUTH_BROKER_SECRET_REFRESH_TOKEN_SEALING_KEY',
    );
  });

  it('refuses to start without a secret, naming the variable but not a value', async () => {
    const adapter = createUnattestedAdapter({});
    await expect(adapter.unsealSecret('google-client-secret')).rejects.toThrow(
      new PlatformError('OAUTH_BROKER_SECRET_GOOGLE_CLIENT_SECRET is not set'),
    );
    const empty = createUnattestedAdapter({ OAUTH_BROKER_SECRET_GOOGLE_CLIENT_SECRET: '' });
    await expect(empty.unsealSecret('google-client-secret')).rejects.toThrow(PlatformError);
  });

  it('is selected by OAUTH_BROKER_PLATFORM=unattested', () => {
    expect(selectPlatform('unattested', {})).toMatchObject({ name: 'unattested', attested: false });
  });

  it('answers 404 not_attested to /attest', async () => {
    const res = await call('/attest', undefined, null);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: 'not_attested' });
  });

  it('serves the API, the callback and /healthz on the same port', async () => {
    const health = await fetch(`http://127.0.0.1:${broker.httpPort}/healthz`);
    expect([health.status, await health.json()]).toEqual([200, { status: 'ok' }]);

    expect((await call('/flows', {}, `bk_${randomBytes(24).toString('base64url')}`)).status).toBe(
      401,
    );

    const verifier = randomBytes(32).toString('base64url');
    const started = await call('/flows', {
      provider: 'google',
      scopes: SCOPES,
      return_url: RETURN_URL,
      state: randomBytes(24).toString('base64url'),
      challenge: s256(verifier),
      challenge_method: 'S256',
    });
    expect(started.status).toBe(201);
    const authorize = new URL(
      String(((await started.json()) as Record<string, unknown>).authorize_url),
    );

    const back = await fetch(
      `http://127.0.0.1:${broker.httpPort}/oauth/callback/google?code=c_1&state=${authorize.searchParams.get('state')}`,
      { redirect: 'manual' },
    );
    expect(back.status).toBe(302);
    const grant = new URL(back.headers.get('location') ?? '').searchParams.get('grant');

    const redeemed = await call('/grants/redeem', { grant, verifier });
    expect(redeemed.status).toBe(200);
    expect(await redeemed.json()).toMatchObject({
      refresh_token: expect.stringMatching(/^v1\./) as unknown,
      access_token: 'at_first',
      account: 'alice@acme.example',
    });
  });

  it('keeps each method to its paths', async () => {
    const get = await fetch(`http://127.0.0.1:${broker.httpPort}/flows`);
    expect(get.status).toBe(405);
    expect((await call('/healthz')).status).toBe(405);
    expect((await call('/nowhere')).status).toBe(405);
    expect((await fetch(`http://127.0.0.1:${broker.httpPort}/nowhere`)).status).toBe(404);
  });
});
