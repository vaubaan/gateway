import { describe, expect, it } from 'vitest';

import { InstanceIdentifier, TELEMETRY_INSTANCE_ID_KEY } from './instance-id';

function memoryStore(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    get: (key: string) => Promise.resolve(values.get(key) ?? null),
    set: (key: string, value: string) => {
      values.set(key, value);
      return Promise.resolve();
    },
  };
}

function sequence(): () => Buffer {
  let n = 0;
  return () => Buffer.alloc(16, (n += 1));
}

describe('InstanceIdentifier', () => {
  it('draws the identifier on first use, stores it and answers it ever after', async () => {
    const store = memoryStore();
    const identifier = new InstanceIdentifier({ store, randomBytes: sequence() });
    expect(await identifier.peek()).toBeNull();
    const first = await identifier.current();
    expect(first).toBe('01'.repeat(16));
    expect(store.values.get(TELEMETRY_INSTANCE_ID_KEY)).toBe(first);
    expect(await identifier.current()).toBe(first);
    expect(await new InstanceIdentifier({ store, randomBytes: sequence() }).current()).toBe(first);
  });

  it('replaces a stored value that is not 128 bits of hex', async () => {
    const store = memoryStore({ [TELEMETRY_INSTANCE_ID_KEY]: 'acme-prod' });
    const identifier = new InstanceIdentifier({ store, randomBytes: sequence() });
    expect(await identifier.peek()).toBeNull();
    expect(await identifier.current()).toMatch(/^[0-9a-f]{32}$/);
  });

  it('regenerates on demand and says what it replaced', async () => {
    const store = memoryStore();
    const identifier = new InstanceIdentifier({ store, randomBytes: sequence() });
    const first = await identifier.current();
    const { before, after } = await identifier.regenerate();
    expect(before).toBe(first);
    expect(after).not.toBe(first);
    expect(await identifier.current()).toBe(after);
  });
});
