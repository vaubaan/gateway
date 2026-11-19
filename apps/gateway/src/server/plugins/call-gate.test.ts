import { describe, expect, it } from 'vitest';

import { createPluginCallGate } from './call-gate';

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('the calls of a service against a swap of its plugin', () => {
  it('a swap with no call running happens at once', async () => {
    const gate = createPluginCallGate();
    expect(await gate.swap('acme', () => 'swapped')).toBe('swapped');
  });

  it('a call already running finishes on the previous version: the swap waits for it', async () => {
    const gate = createPluginCallGate();
    const release = await gate.enter('acme');
    let swapped = false;
    const swap = gate.swap('acme', () => {
      swapped = true;
    });
    await tick();
    expect(swapped).toBe(false);
    release();
    await swap;
    expect(swapped).toBe(true);
  });

  it('a call arriving during the swap waits for it, then meets the new version', async () => {
    const gate = createPluginCallGate();
    const running = await gate.enter('acme');
    let version = 'old';
    const swap = gate.swap('acme', () => {
      version = 'new';
    });
    let seen: string | null = null;
    const late = gate.enter('acme').then((release) => {
      seen = version;
      release();
    });
    await tick();
    expect(seen).toBeNull();
    running();
    await Promise.all([swap, late]);
    expect(seen).toBe('new');
  });

  it('the calls of another service are never held', async () => {
    const gate = createPluginCallGate();
    const running = await gate.enter('acme');
    void gate.swap('acme', () => undefined);
    const other = await gate.enter('beta');
    expect(gate.running('beta')).toBe(1);
    other();
    running();
  });

  it('a release called twice counts once', async () => {
    const gate = createPluginCallGate();
    const first = await gate.enter('acme');
    const second = await gate.enter('acme');
    first();
    first();
    expect(gate.running('acme')).toBe(1);
    second();
    expect(gate.running('acme')).toBe(0);
  });

  it('a swap that throws rejects and lets the calls through', async () => {
    const gate = createPluginCallGate();
    await expect(
      gate.swap('acme', () => {
        throw new Error('refused');
      }),
    ).rejects.toThrow('refused');
    const release = await gate.enter('acme');
    expect(gate.running('acme')).toBe(1);
    release();
  });
});
