import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Store } from '../../../src/server/store/index.ts';
import { openTestStore, type TestStore } from '../../../src/server/store/testing.ts';

describe('config repository', () => {
  let t: TestStore;
  let store: Store;

  beforeEach(() => {
    t = openTestStore();
    store = t.store;
  });
  afterEach(() => store.close());

  it('stores clear values and overwrites them', async () => {
    expect(await store.config.get('telemetry.enabled')).toBeNull();
    await store.config.set('telemetry.enabled', 'true');
    await store.config.set('telemetry.enabled', 'false');
    expect(await store.config.get('telemetry.enabled')).toBe('false');
    expect(await store.config.keys()).toEqual(['telemetry.enabled']);
  });

  it('seals secrets with the key as associated data and stamps the key version', async () => {
    await store.config.setSecret('idp.client_secret', 'shh');
    expect(t.encryptor.sealCalls).toEqual([
      { associatedData: 'instance_config:idp.client_secret' },
    ]);
    expect(await store.config.getSecret('idp.client_secret')).toBe('shh');
    expect(await store.config.get('idp.client_secret')).toBeNull();
    const row = store.db
      .prepare<
        [string],
        { key_version: number; value: string | null }
      >('SELECT key_version, value FROM instance_config WHERE key = ?')
      .get('idp.client_secret');
    expect(row).toEqual({ key_version: 1, value: null });
  });

  it('a key is either a value or a secret, never both', async () => {
    await store.config.set('k', 'v');
    await store.config.setSecret('k', 's');
    expect(await store.config.get('k')).toBeNull();
    expect(await store.config.getSecret('k')).toBe('s');
    await store.config.set('k', 'v2');
    expect(await store.config.getSecret('k')).toBeNull();
    expect(await store.config.get('k')).toBe('v2');
  });

  it('deletes keys', async () => {
    await store.config.set('k', 'v');
    expect(await store.config.delete('k')).toBe(true);
    expect(await store.config.delete('k')).toBe(false);
    expect(await store.config.keys()).toEqual([]);
  });
});
