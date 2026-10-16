import { describe, expect, it, vi } from 'vitest';

import {
  INSTANCE_NAME_KEY,
  InstanceNameLockedError,
  InstanceNameService,
  InvalidInstanceNameError,
} from './settings';

const PUBLIC_URL = new URL('https://gateway-production-1a2b.up.railway.app');
const HOST = PUBLIC_URL.host;

function rig(instanceName: string | null = null) {
  const values = new Map<string, string>();
  const store = {
    get: vi.fn(async (key: string) => values.get(key) ?? null),
    set: vi.fn(async (key: string, value: string) => {
      values.set(key, value);
    }),
    delete: vi.fn(async (key: string) => values.delete(key)),
  };
  const service = new InstanceNameService({
    config: { instanceName, publicUrl: PUBLIC_URL },
    store,
  });
  return { service, store, values };
}

describe('InstanceNameService: who names the instance', () => {
  it('shows the host of the public URL when neither the configuration nor an administrator named it', async () => {
    const { service } = rig();
    expect(await service.identity()).toEqual({
      label: HOST,
      name: null,
      host: HOST,
      source: 'default',
    });
    expect(service.isLocked()).toBe(false);
  });

  it('shows the name an administrator saved, trimmed, with the host beside it', async () => {
    const { service, values } = rig();
    const change = await service.setName('  Dalae prod  ');
    expect(values.get(INSTANCE_NAME_KEY)).toBe('Dalae prod');
    expect(change).toEqual({
      before: { name: null, source: 'default' },
      after: { name: 'Dalae prod', source: 'admin' },
    });
    expect(await service.identity()).toEqual({
      label: 'Dalae prod',
      name: 'Dalae prod',
      host: HOST,
      source: 'admin',
    });
  });

  it('clears the name on a blank value: the host is shown again', async () => {
    const { service, values } = rig();
    await service.setName('Dalae prod');
    const change = await service.setName('   ');
    expect(values.has(INSTANCE_NAME_KEY)).toBe(false);
    expect(change.after).toEqual({ name: null, source: 'default' });
    expect((await service.identity()).label).toBe(HOST);
  });

  it('the configuration wins over a stored name, and the change is refused', async () => {
    const { service, values, store } = rig('Fiabilis AI');
    values.set(INSTANCE_NAME_KEY, 'stored by hand');
    expect(service.isLocked()).toBe(true);
    expect(await service.identity()).toMatchObject({ label: 'Fiabilis AI', source: 'config' });
    await expect(service.setName('other')).rejects.toBeInstanceOf(InstanceNameLockedError);
    await expect(service.setName('')).rejects.toBeInstanceOf(InstanceNameLockedError);
    expect(store.set).not.toHaveBeenCalled();
    expect(store.delete).not.toHaveBeenCalled();
  });

  it('refuses an invalid name and stores nothing', async () => {
    const { service, store } = rig();
    await expect(service.setName('x'.repeat(65))).rejects.toMatchObject({
      constructor: InvalidInstanceNameError,
      problem: 'too-long',
    });
    await expect(service.setName('a\nb')).rejects.toMatchObject({ problem: 'control-character' });
    expect(store.set).not.toHaveBeenCalled();
  });

  it('ignores a stored value that is not a valid name', async () => {
    const { service, values } = rig();
    values.set(INSTANCE_NAME_KEY, 'two\nlines');
    expect(await service.identity()).toMatchObject({ label: HOST, source: 'default' });
  });
});
