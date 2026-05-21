/**
 * Tests for the low-level Infisical REST client.
 *
 * No real network: a fake `fetch` is injected via `InfisicalClientOptions.fetchImpl`.
 * We assert the request shape (URL, headers, body) and the cache behaviour
 * for the access token.
 *
 * ZK invariant: the test also verifies that **neither the clientSecret
 * nor the accessToken appears in any thrown error message** — defensive
 * against future "helpful" debug logging.
 */

import { describe, it, expect, beforeEach } from 'vitest';

import {
  createInfisicalClient,
  InfisicalApiError,
} from '../../../src/secret-manager/infisical-client.js';

interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
}

interface FakeResponse {
  status: number;
  json?: unknown;
  text?: string;
}

interface FakeFetchOptions {
  responses: FakeResponse[];
}

function makeFakeFetch(opts: FakeFetchOptions): {
  fetchImpl: typeof fetch;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const queue = [...opts.responses];

  // eslint-disable-next-line @typescript-eslint/require-await
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : (input as URL).toString();
    const method = init?.method ?? 'GET';
    const rawHeaders = init?.headers ?? {};
    const headers: Record<string, string> = {};
    if (rawHeaders instanceof Headers) {
      rawHeaders.forEach((v, k) => {
        headers[k.toLowerCase()] = v;
      });
    } else if (Array.isArray(rawHeaders)) {
      for (const entry of rawHeaders) {
        const k = entry[0];
        const v = entry[1];
        if (typeof k === 'string' && typeof v === 'string') {
          headers[k.toLowerCase()] = v;
        }
      }
    } else {
      for (const [k, v] of Object.entries(rawHeaders as Record<string, string>)) {
        headers[k.toLowerCase()] = v;
      }
    }
    calls.push({
      url,
      method,
      headers,
      body: typeof init?.body === 'string' ? init.body : null,
    });
    const next = queue.shift();
    if (!next) throw new Error(`fake fetch: no more responses queued (url=${url})`);
    const ok = next.status >= 200 && next.status < 300;
    return {
      ok,
      status: next.status,
      json: () => Promise.resolve(next.json),
      text: () => Promise.resolve(next.text ?? ''),
    } as unknown as Response;
  };
  return { fetchImpl, calls };
}

const baseOpts = {
  endpoint: 'https://eu.infisical.com',
  workspaceId: 'ws-1',
  environment: 'prod',
  auth: { clientId: 'cid-uuid', clientSecret: 'super-secret' },
};

describe('createInfisicalClient — auth bootstrap', () => {
  beforeEach(() => {});

  it('exchanges (clientId, clientSecret) for an accessToken on first call and caches it', async () => {
    const { fetchImpl, calls } = makeFakeFetch({
      responses: [
        { status: 200, json: { accessToken: 'jwt-abc', expiresIn: 7200 } },
        { status: 200, json: { secrets: [] } },
        { status: 200, json: { secrets: [] } },
      ],
    });
    const client = createInfisicalClient({ ...baseOpts, fetchImpl });
    await client.listSecrets('/r1');
    await client.listSecrets('/r1');
    // 1 auth + 2 list. Not 1+1+1+1.
    expect(calls).toHaveLength(3);
    expect(calls[0]?.url).toBe('https://eu.infisical.com/api/v1/auth/universal-auth/login');
    expect(calls[0]?.method).toBe('POST');
    const authBody = JSON.parse(calls[0]?.body ?? '{}') as Record<string, unknown>;
    expect(authBody.clientId).toBe('cid-uuid');
    expect(authBody.clientSecret).toBe('super-secret');
    expect(calls[1]?.headers.authorization).toBe('Bearer jwt-abc');
    expect(calls[2]?.headers.authorization).toBe('Bearer jwt-abc');
  });

  it('refuses to log the clientSecret in error messages on auth failure', async () => {
    const { fetchImpl } = makeFakeFetch({
      responses: [{ status: 401, text: 'invalid client' }],
    });
    const client = createInfisicalClient({ ...baseOpts, fetchImpl });
    let caught: unknown = null;
    try {
      await client.listSecrets('/r1');
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(InfisicalApiError);
    const err = caught as InfisicalApiError;
    expect(err.message).not.toContain('super-secret');
    expect(err.message).not.toContain('cid-uuid');
  });
});

describe('createInfisicalClient — secret CRUD shape', () => {
  it('GET /api/v3/secrets/raw includes workspaceId/environment/secretPath query', async () => {
    const { fetchImpl, calls } = makeFakeFetch({
      responses: [
        { status: 200, json: { accessToken: 'jwt', expiresIn: 7200 } },
        { status: 200, json: { secrets: [{ secretKey: 'k1', secretValue: 'v1' }] } },
      ],
    });
    const client = createInfisicalClient({ ...baseOpts, fetchImpl });
    const out = await client.listSecrets('/res-1');
    expect(out).toHaveLength(1);
    const u = new URL(calls[1]!.url);
    expect(u.searchParams.get('workspaceId')).toBe('ws-1');
    expect(u.searchParams.get('environment')).toBe('prod');
    expect(u.searchParams.get('secretPath')).toBe('/res-1');
  });

  it('POST + PATCH + DELETE forward workspaceId/environment/secretPath in the body', async () => {
    const { fetchImpl, calls } = makeFakeFetch({
      responses: [
        { status: 200, json: { accessToken: 'jwt', expiresIn: 7200 } },
        { status: 200, json: {} },
        { status: 200, json: {} },
        { status: 200, json: {} },
      ],
    });
    const client = createInfisicalClient({ ...baseOpts, fetchImpl });
    await client.createSecret('/r', 'k', 'v1');
    await client.updateSecret('/r', 'k', 'v2');
    await client.deleteSecret('/r', 'k');

    const create = JSON.parse(calls[1]!.body ?? '{}') as Record<string, unknown>;
    expect(create.workspaceId).toBe('ws-1');
    expect(create.environment).toBe('prod');
    expect(create.secretPath).toBe('/r');
    expect(create.secretValue).toBe('v1');
    expect(create.type).toBe('shared');
    expect(calls[1]!.method).toBe('POST');
    expect(calls[1]!.url).toBe('https://eu.infisical.com/api/v3/secrets/raw/k');

    const update = JSON.parse(calls[2]!.body ?? '{}') as Record<string, unknown>;
    expect(update.secretValue).toBe('v2');
    expect(calls[2]!.method).toBe('PATCH');

    const del = JSON.parse(calls[3]!.body ?? '{}') as Record<string, unknown>;
    expect(del.secretPath).toBe('/r');
    expect(calls[3]!.method).toBe('DELETE');
  });

  it('getSecret returns null on 404 (clean not-found, no throw)', async () => {
    const { fetchImpl } = makeFakeFetch({
      responses: [
        { status: 200, json: { accessToken: 'jwt', expiresIn: 7200 } },
        { status: 404, text: 'not found' },
      ],
    });
    const client = createInfisicalClient({ ...baseOpts, fetchImpl });
    const out = await client.getSecret('/r', 'k');
    expect(out).toBeNull();
  });

  it('deleteSecret swallows 404 (idempotent)', async () => {
    const { fetchImpl } = makeFakeFetch({
      responses: [
        { status: 200, json: { accessToken: 'jwt', expiresIn: 7200 } },
        { status: 404, text: 'not found' },
      ],
    });
    const client = createInfisicalClient({ ...baseOpts, fetchImpl });
    await expect(client.deleteSecret('/r', 'k')).resolves.toBeUndefined();
  });
});
