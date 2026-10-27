import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createGcpConfidentialSpaceAdapter,
  parseGcpSettings,
  TEE_SERVER_SOCKET,
} from '../../src/platform/gcp-confidential-space.ts';
import { ATTESTATION_AUDIENCE, PlatformError } from '../../src/platform/types.ts';
import { selectPlatform } from '../../src/platform/index.ts';

const WIF =
  '//iam.googleapis.com/projects/123456/locations/global/workloadIdentityPools/broker/providers/attestation';
const settings = { workloadIdentityProvider: WIF, secretProject: 'broker-project' };
// Fake JWTs, joined at run time so that secret scanners do not mistake them for real ones.
const DEFAULT_TOKEN = [
  'eyJkZWZhdWx0Ijp0cnVlfQ',
  'eyJhdWQiOiJodHRwczovL3N0cy5nb29nbGVhcGlzLmNvbSJ9',
  'c2ln',
].join('.');
const CUSTOM_TOKEN = ['eyJjdXN0b20iOnRydWV9', 'eyJlYXRfbm9uY2UiOltdfQ', 'c2ln'].join('.');

interface TeeCall {
  method: string;
  path: string;
  type: string | undefined;
  body: string;
}

let dir: string;
let socketPath: string;
let server: Server;
let calls: TeeCall[];
let teeStatus: number;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'tee-'));
  socketPath = join(dir, 'teeserver.sock');
  calls = [];
  teeStatus = 200;
  // The launcher's TEE server: GET = default token, POST = custom token; the JWT is the whole body.
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString()));
    req.on('end', () => {
      calls.push({
        method: req.method ?? '',
        path: req.url ?? '',
        type: req.headers['content-type'],
        body,
      });
      res.writeHead(teeStatus, { 'content-type': 'text/html' });
      res.end(teeStatus !== 200 ? 'failure' : req.method === 'GET' ? DEFAULT_TOKEN : CUSTOM_TOKEN);
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(dir, { recursive: true, force: true });
});

describe('gcp-confidential-space adapter', () => {
  it('uses the launcher socket path of Confidential Space by default', () => {
    expect(TEE_SERVER_SOCKET).toBe('/run/container_launcher/teeserver.sock');
  });

  it('asks the TEE server for a custom OIDC token carrying the nonces, with the fixed audience', async () => {
    const adapter = createGcpConfidentialSpaceAdapter(settings, { socketPath });
    const nonces = ['n'.repeat(43), 'k'.repeat(43)];
    await expect(adapter.attest(nonces)).resolves.toEqual({
      platform: 'gcp-confidential-space',
      evidence: CUSTOM_TOKEN,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: 'POST', path: '/v1/token', type: 'application/json' });
    expect(JSON.parse(calls[0]?.body ?? '')).toEqual({
      audience: ATTESTATION_AUDIENCE,
      token_type: 'OIDC',
      nonces,
    });
    expect(ATTESTATION_AUDIENCE).toBe('oauth-broker-attestation');
  });

  it('fails when the TEE server refuses', async () => {
    teeStatus = 500;
    const adapter = createGcpConfidentialSpaceAdapter(settings, { socketPath });
    await expect(adapter.attest(['n'.repeat(43)])).rejects.toThrow(PlatformError);
  });

  it('unseals a secret: default token → STS → Secret Manager', async () => {
    const seen: { url: string; init: RequestInit | undefined }[] = [];
    const fakeFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      seen.push({ url, init });
      if (url === 'https://sts.googleapis.com/v1/token') {
        return Response.json({ access_token: 'federated', token_type: 'Bearer', expires_in: 3600 });
      }
      return Response.json({
        name: 'x',
        payload: { data: Buffer.from('client-secret\n').toString('base64') },
      });
    };
    const adapter = createGcpConfidentialSpaceAdapter(settings, { socketPath, fetch: fakeFetch });
    await expect(adapter.unsealSecret('google-client-secret')).resolves.toBe('client-secret');

    expect(calls).toEqual([{ method: 'GET', path: '/v1/token', type: undefined, body: '' }]);
    const form = new URLSearchParams(String(seen[0]?.init?.body));
    expect(Object.fromEntries(form)).toEqual({
      audience: WIF,
      grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
      requested_token_type: 'urn:ietf:params:oauth:token-type:access_token',
      scope: 'https://www.googleapis.com/auth/cloud-platform',
      subject_token_type: 'urn:ietf:params:oauth:token-type:jwt',
      subject_token: DEFAULT_TOKEN,
    });
    expect(seen[1]?.url).toBe(
      'https://secretmanager.googleapis.com/v1/projects/broker-project/secrets/google-client-secret/versions/latest:access',
    );
    expect((seen[1]?.init?.headers as Record<string, string>).authorization).toBe(
      'Bearer federated',
    );
  });

  it('starts without the secret when the federation refuses the image', async () => {
    const fakeFetch: typeof fetch = async () =>
      Response.json({ error: 'unauthorized_client' }, { status: 403 });
    const adapter = createGcpConfidentialSpaceAdapter(settings, { socketPath, fetch: fakeFetch });
    await expect(adapter.unsealSecret('google-client-secret')).rejects.toThrow('STS answered 403');
  });

  it.each([
    ['Secret Manager answers no JSON', 'not json', 'Secret Manager answered no JSON'],
    ['Secret Manager answers no payload', JSON.stringify({ name: 'x' }), 'no payload'],
    [
      'the secret is empty',
      JSON.stringify({ payload: { data: Buffer.from(' \n').toString('base64') } }),
      'empty',
    ],
  ])('fails with a named reason when %s', async (_label, secretAnswer, reason) => {
    const fakeFetch: typeof fetch = async (input) =>
      String(input).startsWith('https://sts.')
        ? Response.json({ access_token: 'federated' })
        : new Response(secretAnswer, { status: 200 });
    const adapter = createGcpConfidentialSpaceAdapter(settings, { socketPath, fetch: fakeFetch });
    await expect(adapter.unsealSecret('google-client-secret')).rejects.toThrow(reason);
  });

  it('fails with a named reason when STS answers no JSON or cannot be reached', async () => {
    const html: typeof fetch = async () => new Response('<html>', { status: 200 });
    await expect(
      createGcpConfidentialSpaceAdapter(settings, { socketPath, fetch: html }).unsealSecret('s'),
    ).rejects.toThrow('STS answered no JSON');
    const down: typeof fetch = async () => {
      throw new TypeError('fetch failed');
    };
    await expect(
      createGcpConfidentialSpaceAdapter(settings, { socketPath, fetch: down }).unsealSecret('s'),
    ).rejects.toThrow('STS could not be reached');
  });

  it('fails with a named reason when the TEE server socket is missing', async () => {
    const adapter = createGcpConfidentialSpaceAdapter(settings, {
      socketPath: join(dir, 'missing.sock'),
    });
    await expect(adapter.attest(['n'.repeat(43)])).rejects.toThrow('TEE server unreachable');
  });

  it('asks with the one nonce the broker uses: the SPKI digest', async () => {
    const adapter = createGcpConfidentialSpaceAdapter(settings, { socketPath });
    await adapter.attest(['k'.repeat(43)]);
    expect(JSON.parse(calls[0]?.body ?? '')).toEqual({
      audience: 'oauth-broker-attestation',
      token_type: 'OIDC',
      nonces: ['k'.repeat(43)],
    });
  });

  it('refuses malformed settings and secret names', async () => {
    expect(() =>
      parseGcpSettings({ workload_identity_provider: 'https://evil', secret_project: 'p' }),
    ).toThrow(PlatformError);
    expect(
      parseGcpSettings({ workload_identity_provider: WIF, secret_project: 'broker-project' }),
    ).toEqual(settings);
    const adapter = createGcpConfidentialSpaceAdapter(settings, { socketPath });
    await expect(adapter.unsealSecret('../other')).rejects.toThrow(PlatformError);
  });

  it('is chosen by name, and an unknown platform is refused', () => {
    expect(
      selectPlatform('gcp-confidential-space', {
        'gcp-confidential-space': { workload_identity_provider: WIF, secret_project: 'p1' },
      }).name,
    ).toBe('gcp-confidential-space');
    expect(selectPlatform('local', {}).name).toBe('none');
    expect(() => selectPlatform(undefined, {})).toThrow(PlatformError);
  });
});
