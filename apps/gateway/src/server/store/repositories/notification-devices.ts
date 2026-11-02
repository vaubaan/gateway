/**
 * The devices a person receives notifications on (migration 0030; spec §4.2 bis). The push
 * subscription — the push service's endpoint and the browser's keys — is sealed under the
 * master key, with `notification-device:<id>` as associated data; nothing else of it is
 * stored but the SHA-256 of the endpoint, which makes one subscription one row.
 *
 * Keyed by user (**[inv: lookups-keyed-by-parent]**): a device is renamed, removed or read
 * with its user only, and one of another user reads as missing. Only the notifier opens a
 * subscription (`subscriptionsOf`); a view never carries it.
 */

import { createHash } from 'node:crypto';

import { withImmediateTransaction } from '../db.ts';
import { openText, sealText } from '../encryptor.ts';
import type { Iso } from '../types.ts';
import { nowIso, parseEnum, type RepoContext } from './context.ts';

export const DEVICE_DROP_REASONS = ['gone'] as const;
/** Why a device no longer receives anything: `gone`, the push service forgot the subscription. */
export type DeviceDropReason = (typeof DEVICE_DROP_REASONS)[number];

/** What a browser's `PushSubscription` hands over: where to post, and the keys to encrypt to. */
export interface PushSubscriptionKeys {
  readonly endpoint: string;
  /** The browser's P-256 public key, base64url (65 octets, uncompressed). */
  readonly p256dh: string;
  /** The browser's authentication secret, base64url (16 octets). */
  readonly auth: string;
}

/** A device as its person sees it: never the subscription. */
export interface NotificationDeviceRecord {
  readonly id: string;
  readonly userId: string;
  readonly label: string;
  readonly createdAt: Iso;
  readonly lastDeliveredAt: Iso | null;
  readonly lastFailureAt: Iso | null;
  /** The push service's HTTP status of the last failure; `null` when it never answered. */
  readonly lastFailureStatus: number | null;
  readonly droppedAt: Iso | null;
  readonly droppedReason: DeviceDropReason | null;
}

/** A live device with its subscription opened: for the notifier only. */
export interface DeviceSubscription {
  readonly deviceId: string;
  readonly subscription: PushSubscriptionKeys;
}

/** What one device delivery came to, recorded on its row. */
export type DeliveryRecord =
  | { readonly kind: 'delivered' }
  | { readonly kind: 'failed'; readonly status: number | null }
  | { readonly kind: 'dropped'; readonly reason: DeviceDropReason };

export interface NotificationDevicesRepo {
  /**
   * Adds the device, or takes it over when the same subscription is already stored (the
   * same browser subscribing again, or another person on a shared browser): the earlier row
   * is replaced. Returns the device and the replaced row (its id and its person), if any.
   */
  add(input: {
    readonly userId: string;
    readonly label: string;
    readonly subscription: PushSubscriptionKeys;
  }): Promise<{
    readonly device: NotificationDeviceRecord;
    readonly replaced: NotificationDeviceRecord | null;
  }>;
  /** The person's devices, the dropped ones included, newest first. */
  listForUser(userId: string): Promise<NotificationDeviceRecord[]>;
  get(key: DeviceKey): Promise<NotificationDeviceRecord | null>;
  /** `null` when the person has no such device. */
  rename(key: DeviceKey, label: string): Promise<NotificationDeviceRecord | null>;
  /** The removed device; `null` when the person has no such device. */
  remove(key: DeviceKey): Promise<NotificationDeviceRecord | null>;
  /** The person's devices that are not dropped, subscription opened. */
  subscriptionsOf(userId: string): Promise<DeviceSubscription[]>;
  /** Records the outcome of one delivery; a dropped device stays dropped. */
  recordDelivery(key: DeviceKey, outcome: DeliveryRecord): Promise<void>;
  /** How many devices each person has, dropped ones left out (Administration → People). */
  countsByUser(): Promise<ReadonlyMap<string, number>>;
  /**
   * The endpoint digests of the person's live devices: what lets a browser tell whether
   * the subscription it holds is one this gateway still delivers to. Never an endpoint.
   */
  liveEndpointDigests(userId: string): Promise<string[]>;
}

/** A device is reached with its user only. */
export interface DeviceKey {
  readonly userId: string;
  readonly deviceId: string;
}

interface DeviceRow {
  id: string;
  user_id: string;
  label: string;
  created_at: string;
  last_delivered_at: string | null;
  last_failure_at: string | null;
  last_failure_status: number | null;
  dropped_at: string | null;
  dropped_reason: string | null;
}

interface SealedRow {
  id: string;
  subscription_blob: Buffer;
  key_version: number;
}

const COLUMNS = `id, user_id, label, created_at, last_delivered_at, last_failure_at,
  last_failure_status, dropped_at, dropped_reason`;

/** The associated data of a device's sealed subscription. */
export function deviceSubscriptionAd(id: string): string {
  return `notification-device:${id}`;
}

/** The one-way digest that makes a subscription one row; the endpoint is never stored clear. */
export function endpointDigest(endpoint: string): string {
  return createHash('sha256').update(endpoint, 'utf8').digest('hex');
}

function toRecord(row: DeviceRow): NotificationDeviceRecord {
  return {
    id: row.id,
    userId: row.user_id,
    label: row.label,
    createdAt: row.created_at,
    lastDeliveredAt: row.last_delivered_at,
    lastFailureAt: row.last_failure_at,
    lastFailureStatus: row.last_failure_status,
    droppedAt: row.dropped_at,
    droppedReason:
      row.dropped_reason === null
        ? null
        : parseEnum(DEVICE_DROP_REASONS, row.dropped_reason, 'notification_devices.dropped_reason'),
  };
}

function parseStoredSubscription(text: string): PushSubscriptionKeys {
  const value: unknown = JSON.parse(text);
  if (typeof value !== 'object' || value === null) {
    throw new Error('notification_devices.subscription_blob: unexpected shape');
  }
  const { endpoint, p256dh, auth } = value as Partial<PushSubscriptionKeys>;
  if (typeof endpoint !== 'string' || typeof p256dh !== 'string' || typeof auth !== 'string') {
    throw new Error('notification_devices.subscription_blob: unexpected shape');
  }
  return { endpoint, p256dh, auth };
}

export function createNotificationDevicesRepo(ctx: RepoContext): NotificationDevicesRepo {
  const { db, encryptor } = ctx;
  const byKey = db.prepare<[string, string], DeviceRow>(
    `SELECT ${COLUMNS} FROM notification_devices WHERE id = ? AND user_id = ?`,
  );
  const byUser = db.prepare<[string], DeviceRow>(
    `SELECT ${COLUMNS} FROM notification_devices WHERE user_id = ?
     ORDER BY created_at DESC, id DESC`,
  );
  const liveSealed = db.prepare<[string], SealedRow>(
    `SELECT id, subscription_blob, key_version FROM notification_devices
     WHERE user_id = ? AND dropped_at IS NULL ORDER BY created_at, id`,
  );
  const byDigest = db.prepare<[string], DeviceRow>(
    `SELECT ${COLUMNS} FROM notification_devices WHERE endpoint_digest = ?`,
  );
  const deleteByDigest = db.prepare<[string]>(
    'DELETE FROM notification_devices WHERE endpoint_digest = ?',
  );
  const liveDigests = db.prepare<[string], { endpoint_digest: string }>(
    `SELECT endpoint_digest FROM notification_devices
     WHERE user_id = ? AND dropped_at IS NULL`,
  );
  const insert = db.prepare<[string, string, string, string, Buffer, number, string]>(
    `INSERT INTO notification_devices
       (id, user_id, label, endpoint_digest, subscription_blob, key_version, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const renameStmt = db.prepare<[string, string, string]>(
    'UPDATE notification_devices SET label = ? WHERE id = ? AND user_id = ?',
  );
  const removeStmt = db.prepare<[string, string]>(
    'DELETE FROM notification_devices WHERE id = ? AND user_id = ?',
  );
  const delivered = db.prepare<[string, string, string]>(
    `UPDATE notification_devices SET last_delivered_at = ?
     WHERE id = ? AND user_id = ? AND dropped_at IS NULL`,
  );
  const failed = db.prepare<[string, number | null, string, string]>(
    `UPDATE notification_devices SET last_failure_at = ?, last_failure_status = ?
     WHERE id = ? AND user_id = ? AND dropped_at IS NULL`,
  );
  const dropped = db.prepare<[string, string, string, string]>(
    `UPDATE notification_devices SET dropped_at = ?, dropped_reason = ?
     WHERE id = ? AND user_id = ? AND dropped_at IS NULL`,
  );
  const counts = db.prepare<[], { user_id: string; count: number }>(
    `SELECT user_id, COUNT(*) AS count FROM notification_devices
     WHERE dropped_at IS NULL GROUP BY user_id`,
  );

  return {
    async add({ userId, label, subscription }) {
      const id = ctx.newId();
      // Sealed before the transaction: the encryptor is asynchronous, the driver is not.
      const sealed = await sealText(
        encryptor,
        deviceSubscriptionAd(id),
        JSON.stringify(subscription),
      );
      const now = nowIso(ctx);
      const digest = endpointDigest(subscription.endpoint);
      const replaced = withImmediateTransaction(db, () => {
        const earlier = byDigest.get(digest);
        if (earlier) deleteByDigest.run(digest);
        insert.run(id, userId, label, digest, sealed.blob, sealed.keyVersion, now);
        return earlier ? toRecord(earlier) : null;
      });
      const row = byKey.get(id, userId);
      if (!row) throw new Error(`notification_devices: '${id}' was not written`);
      return { device: toRecord(row), replaced };
    },
    async listForUser(userId) {
      return byUser.all(userId).map(toRecord);
    },
    async get({ userId, deviceId }) {
      const row = byKey.get(deviceId, userId);
      return row ? toRecord(row) : null;
    },
    async rename({ userId, deviceId }, label) {
      if (renameStmt.run(label, deviceId, userId).changes === 0) return null;
      const row = byKey.get(deviceId, userId);
      return row ? toRecord(row) : null;
    },
    async remove({ userId, deviceId }) {
      return withImmediateTransaction(db, () => {
        const row = byKey.get(deviceId, userId);
        if (!row) return null;
        removeStmt.run(deviceId, userId);
        return toRecord(row);
      });
    },
    async subscriptionsOf(userId) {
      const out: DeviceSubscription[] = [];
      for (const row of liveSealed.all(userId)) {
        const text = await openText(encryptor, deviceSubscriptionAd(row.id), {
          blob: row.subscription_blob,
          keyVersion: row.key_version,
        });
        out.push({ deviceId: row.id, subscription: parseStoredSubscription(text) });
      }
      return out;
    },
    async recordDelivery({ userId, deviceId }, outcome) {
      const now = nowIso(ctx);
      if (outcome.kind === 'delivered') delivered.run(now, deviceId, userId);
      else if (outcome.kind === 'failed') failed.run(now, outcome.status, deviceId, userId);
      else dropped.run(now, outcome.reason, deviceId, userId);
    },
    async countsByUser() {
      return new Map(counts.all().map((row) => [row.user_id, row.count]));
    },
    async liveEndpointDigests(userId) {
      return liveDigests.all(userId).map((row) => row.endpoint_digest);
    },
  };
}
