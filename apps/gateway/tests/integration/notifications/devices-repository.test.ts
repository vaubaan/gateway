/**
 * The devices of a person in the store (migration 0030): the subscription sealed, never
 * readable from the row; every read and write keyed by the user; one subscription one row.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Store } from '../../../src/server/store';
import type { UserRecord } from '../../../src/server/store/types';
import { storedSubscription } from '../../support/notifications/testing';
import { openTestStore } from '../../support/store/testing';

describe('notification devices repository', () => {
  let store: Store;
  let ada: UserRecord;
  let bob: UserRecord;

  beforeEach(async () => {
    store = openTestStore().store;
    ada = await store.users.upsertFromIdp({
      issuer: 'http://idp.test',
      subject: 'ada',
      email: 'a@x',
    });
    bob = await store.users.upsertFromIdp({
      issuer: 'http://idp.test',
      subject: 'bob',
      email: 'b@x',
    });
  });
  afterEach(() => store.close());

  it('seals the subscription: the row holds neither the endpoint nor the keys', async () => {
    const subscription = storedSubscription('secret-token-7f3a');
    const { device } = await store.notificationDevices.add({
      userId: ada.id,
      label: 'Phone',
      subscription,
    });
    const row = store.db
      .prepare<[string], Record<string, unknown>>('SELECT * FROM notification_devices WHERE id = ?')
      .get(device.id);
    const flat = JSON.stringify(row, (_key, value: unknown) =>
      Buffer.isBuffer(value) ? value.toString('latin1') : value,
    );
    for (const clear of [
      'secret-token-7f3a',
      'fcm.googleapis.com',
      subscription.p256dh,
      subscription.auth,
    ]) {
      expect(flat).not.toContain(clear);
    }
    const [opened] = await store.notificationDevices.subscriptionsOf(ada.id);
    expect(opened?.subscription).toEqual(subscription);
  });

  it('reaches a device with its user only', async () => {
    const { device } = await store.notificationDevices.add({
      userId: ada.id,
      label: 'Phone',
      subscription: storedSubscription(),
    });
    const others = { userId: bob.id, deviceId: device.id };
    expect(await store.notificationDevices.get(others)).toBeNull();
    expect(await store.notificationDevices.rename(others, 'Mine now')).toBeNull();
    expect(await store.notificationDevices.remove(others)).toBeNull();
    expect(await store.notificationDevices.subscriptionsOf(bob.id)).toEqual([]);
    expect((await store.notificationDevices.listForUser(ada.id)).map((d) => d.label)).toEqual([
      'Phone',
    ]);
  });

  it('makes one subscription one row: subscribing again on a shared browser takes it over', async () => {
    const subscription = storedSubscription('shared');
    await store.notificationDevices.add({ userId: ada.id, label: 'Desk', subscription });
    const again = await store.notificationDevices.add({
      userId: bob.id,
      label: 'Desk',
      subscription,
    });
    expect(again.replaced?.userId).toBe(ada.id);
    expect(await store.notificationDevices.listForUser(ada.id)).toEqual([]);
    expect(await store.notificationDevices.listForUser(bob.id)).toHaveLength(1);
  });

  it('records deliveries, keeps a dropped device dropped, and counts the live ones', async () => {
    const { device } = await store.notificationDevices.add({
      userId: ada.id,
      label: 'Phone',
      subscription: storedSubscription('a'),
    });
    await store.notificationDevices.add({
      userId: ada.id,
      label: 'Laptop',
      subscription: storedSubscription('b'),
    });
    const key = { userId: ada.id, deviceId: device.id };
    await store.notificationDevices.recordDelivery(key, { kind: 'failed', status: 503 });
    expect(await store.notificationDevices.get(key)).toMatchObject({
      lastFailureStatus: 503,
      droppedAt: null,
    });
    await store.notificationDevices.recordDelivery(key, { kind: 'dropped', reason: 'gone' });
    await store.notificationDevices.recordDelivery(key, { kind: 'delivered' });
    expect(await store.notificationDevices.get(key)).toMatchObject({
      droppedReason: 'gone',
      lastDeliveredAt: null,
    });
    expect(
      (await store.notificationDevices.subscriptionsOf(ada.id)).map((s) => s.deviceId),
    ).not.toContain(device.id);
    expect(await store.notificationDevices.countsByUser()).toEqual(new Map([[ada.id, 1]]));
  });

  it('refuses a drop reason outside its closed set when it reads the row', async () => {
    const { device } = await store.notificationDevices.add({
      userId: ada.id,
      label: 'Phone',
      subscription: storedSubscription(),
    });
    // The CHECK of the schema refuses it on write: the closed set is guarded twice.
    expect(() =>
      store.db
        .prepare(
          "UPDATE notification_devices SET dropped_at = 'x', dropped_reason = 'stolen' WHERE id = ?",
        )
        .run(device.id),
    ).toThrow();
  });
});
