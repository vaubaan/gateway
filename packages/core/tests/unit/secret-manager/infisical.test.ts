/**
 * Tests for the `infisical` SecretManager — round-trip put/get/list/revoke
 * against an in-memory fake of `InfisicalClient`.
 *
 * The fake exposes the exact `InfisicalClient` interface, so the
 * production `createInfisicalSecretManager` can be wired with it via
 * the `injectedClient` parameter.
 *
 * ZK invariant: we assert the value stored in the fake is **base64 of
 * the JSON sealed blob**, not the JSON itself — that ensures the
 * Infisical operator (the entity that would see this value) never sees
 * the recipient list as plain text.
 */

import { describe, it, expect } from 'vitest';

import { createInfisicalSecretManager } from '../../../src/secret-manager/infisical.js';
import type {
  InfisicalClient,
  InfisicalSecret,
} from '../../../src/secret-manager/infisical-client.js';
import type { SealedBlob } from '../../../src/secret-manager/interface.js';

function makeFakeClient(): InfisicalClient & {
  store: Map<string, InfisicalSecret>;
} {
  const store = new Map<string, InfisicalSecret>();
  const keyOf = (path: string, k: string): string => `${path}#${k}`;

  return {
    endpoint: 'https://eu.infisical.com',
    workspaceId: 'ws-1',
    environment: 'prod',
    store,
    listSecrets: (path) => {
      const prefix = `${path}#`;
      const out: InfisicalSecret[] = [];
      for (const [k, v] of store.entries()) {
        if (k.startsWith(prefix)) out.push(v);
      }
      return Promise.resolve(out);
    },
    getSecret: (path, key) => Promise.resolve(store.get(keyOf(path, key)) ?? null),
    createSecret: (path, key, value) => {
      if (store.has(keyOf(path, key))) {
        return Promise.reject(new Error('create on existing'));
      }
      store.set(keyOf(path, key), { secretKey: key, secretValue: value });
      return Promise.resolve();
    },
    updateSecret: (path, key, value) => {
      if (!store.has(keyOf(path, key))) {
        return Promise.reject(new Error('update on missing'));
      }
      store.set(keyOf(path, key), { secretKey: key, secretValue: value });
      return Promise.resolve();
    },
    upsertSecret: (path, key, value) => {
      store.set(keyOf(path, key), { secretKey: key, secretValue: value });
      return Promise.resolve();
    },
    deleteSecret: (path, key) => {
      store.delete(keyOf(path, key));
      return Promise.resolve();
    },
  };
}

const blob: SealedBlob = {
  v: 1,
  recipients: [
    { fp: '0123456789abcdef0123456789abcdef', ct: 'AAAA' },
    { fp: 'fedcba9876543210fedcba9876543210', ct: 'BBBB' },
  ],
};

const opts = {
  endpoint: 'https://eu.infisical.com',
  workspaceId: 'ws-1',
  environment: 'prod',
  name: 'default',
  auth: { clientId: 'cid', clientSecret: 'csec' },
};

describe('infisical SecretManager', () => {
  it('put then get round-trips the canonical SealedBlob', async () => {
    const fake = makeFakeClient();
    const sm = createInfisicalSecretManager(opts, fake);
    await sm.put('res-1', 'main', blob);
    const out = await sm.get('res-1', 'main');
    expect(out).toEqual(blob);
  });

  it('stores the secret value as base64(JSON), not as raw JSON', async () => {
    const fake = makeFakeClient();
    const sm = createInfisicalSecretManager(opts, fake);
    await sm.put('res-1', 'main', blob);
    const stored = [...fake.store.values()][0];
    expect(stored).toBeDefined();
    // The recipient `fp` value must NOT appear directly in the stored
    // secretValue — it should be base64-wrapped. (Recipients are still
    // recoverable by base64-decode-then-JSON-parse, which is the spec
    // §4.4 behaviour; we just don't hand them in cleartext to ops.)
    expect(stored!.secretValue).not.toContain(blob.recipients[0]!.fp);
    const decoded = JSON.parse(atob(stored!.secretValue)) as SealedBlob;
    expect(decoded).toEqual(blob);
  });

  it('get returns null on missing entry (clean not-found)', async () => {
    const fake = makeFakeClient();
    const sm = createInfisicalSecretManager(opts, fake);
    const out = await sm.get('res-1', 'nothere');
    expect(out).toBeNull();
  });

  it('list enumerates accessKeys under a resource', async () => {
    const fake = makeFakeClient();
    const sm = createInfisicalSecretManager(opts, fake);
    await sm.put('res-1', 'main', blob);
    await sm.put('res-1', 'admin', blob);
    await sm.put('res-2', 'main', blob);
    const keys = await sm.list!('res-1');
    expect([...keys].sort()).toEqual(['admin', 'main']);
  });

  it('revoke deletes the entry; subsequent get returns null', async () => {
    const fake = makeFakeClient();
    const sm = createInfisicalSecretManager(opts, fake);
    await sm.put('res-1', 'main', blob);
    await sm.revoke('res-1', 'main');
    const out = await sm.get('res-1', 'main');
    expect(out).toBeNull();
  });

  it('rejects an invalid sealed blob (wrong shape) at put time', async () => {
    const fake = makeFakeClient();
    const sm = createInfisicalSecretManager(opts, fake);
    const bad = { v: 2, recipients: [] } as unknown as SealedBlob;
    await expect(sm.put('r', 'k', bad)).rejects.toThrow(/not a valid SealedBlobV1/);
  });
});
