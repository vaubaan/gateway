import { describe, expect, it, vi } from 'vitest';

import { silentLogger } from '../logging';
import { ManualClock } from '../store/clock';
import {
  REFRESH_MS,
  TELEMETRY_ENABLED_KEY,
  TelemetryLockedError,
  TelemetrySettingsService,
  type TelemetryState,
} from './settings';

function rig(config: { enabled: boolean; enabledSetByConfig: boolean }) {
  const values = new Map<string, string>();
  const clock = new ManualClock();
  const changes: TelemetryState[] = [];
  const store = {
    get: vi.fn(async (key: string) => values.get(key) ?? null),
    set: vi.fn(async (key: string, value: string) => {
      values.set(key, value);
    }),
  };
  const settings = new TelemetrySettingsService({
    config,
    store,
    logger: silentLogger,
    clock,
    onChange: (state) => changes.push(state),
  });
  return { settings, store, values, clock, changes };
}

const UNSET = { enabled: false, enabledSetByConfig: false };

describe('TelemetrySettingsService: who decides', () => {
  it('is off when neither the configuration nor the operator said anything', async () => {
    const { settings } = rig(UNSET);
    expect(settings.enabledNow()).toBe(false);
    expect(await settings.state()).toEqual({ enabled: false, source: 'default' });
    expect(settings.isLocked()).toBe(false);
  });

  it.each([true, false])(
    'the configuration wins when it sets %s, over a stored toggle',
    async (value) => {
      const { settings, values, store } = rig({ enabled: value, enabledSetByConfig: true });
      values.set(TELEMETRY_ENABLED_KEY, value ? 'false' : 'true');

      expect(await settings.state()).toEqual({ enabled: value, source: 'config' });
      expect(settings.enabledNow()).toBe(value);
      expect(settings.isLocked()).toBe(true);
      await expect(settings.setEnabled(!value)).rejects.toBeInstanceOf(TelemetryLockedError);
      expect(store.get).not.toHaveBeenCalled();
      expect(store.set).not.toHaveBeenCalled();
    },
  );

  it("stores the operator's toggle and applies it at once", async () => {
    const { settings, values, changes } = rig(UNSET);
    expect(await settings.setEnabled(true)).toEqual({
      before: { enabled: false, source: 'default' },
      after: { enabled: true, source: 'admin' },
    });
    expect(values.get(TELEMETRY_ENABLED_KEY)).toBe('true');
    expect(settings.enabledNow()).toBe(true);

    expect((await settings.setEnabled(false)).after).toEqual({ enabled: false, source: 'admin' });
    expect(settings.enabledNow()).toBe(false);
    expect(changes.map((c) => c.enabled)).toEqual([true, false]);
  });

  it('treats any stored value but "true" as off', async () => {
    const { settings, values } = rig(UNSET);
    values.set(TELEMETRY_ENABLED_KEY, 'yes');
    expect(await settings.state()).toEqual({ enabled: false, source: 'admin' });
  });

  it('re-reads the store in the background once its view is stale', async () => {
    const { settings, values, clock, store } = rig(UNSET);
    await settings.state();
    // Another replica (or a restore) changed the stored toggle.
    values.set(TELEMETRY_ENABLED_KEY, 'true');

    clock.advance(REFRESH_MS - 1);
    expect(settings.enabledNow()).toBe(false);
    expect(store.get).toHaveBeenCalledTimes(1);

    clock.advance(2);
    expect(settings.enabledNow()).toBe(false); // answered without waiting
    await vi.waitFor(() => expect(settings.enabledNow()).toBe(true));
    expect(store.get).toHaveBeenCalledTimes(2);
  });

  it('keeps the last known value when the store cannot be read', async () => {
    const { settings, store, clock } = rig(UNSET);
    await settings.setEnabled(true);
    store.get.mockRejectedValue(new Error('database is locked'));
    clock.advance(REFRESH_MS + 1);
    expect(settings.enabledNow()).toBe(true);
    await new Promise((resolve) => setImmediate(resolve));
    expect(settings.enabledNow()).toBe(true);
  });
});
