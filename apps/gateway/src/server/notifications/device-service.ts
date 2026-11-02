/**
 * A person's devices (spec §4.2 bis "Channels are the person's"): listed, added, renamed
 * and removed by that person only, every call keyed by the signed-in user. Adding and
 * removing are audited (`device-added`, `device-removed`) with the device's id and label,
 * never its subscription. An administrator reads how many devices a person has, never
 * which (`countsByUser`).
 */
import type { AuditWriter } from '@vaubaan/gateway-core';

import type { Clock } from '../store/clock';
import { toIso } from '../store/clock';
import type {
  DeviceDropReason,
  NotificationDeviceRecord,
  NotificationDevicesRepo,
  PushSubscriptionKeys,
} from '../store/repositories/notification-devices';
import type { UserRecord } from '../store/types';
import { isPushServiceEndpoint } from './web-push/push-services';

/** A label is one short line the person reads in the list. */
export const LABEL_MAX = 60;
/**
 * Live devices per person: every notification posts to each, one after the other, so the
 * list stays short (a phone, a laptop, a desk computer…). Beyond it, remove one first.
 */
export const DEVICES_MAX = 20;
const ENDPOINT_MAX = 2048;
const P256DH_BYTES = 65;
const AUTH_BYTES = 16;

/** What a page shows of a device: never the subscription. */
export interface DeviceView {
  readonly id: string;
  readonly label: string;
  readonly created_at: string;
  readonly last_delivered_at: string | null;
  readonly last_failure_at: string | null;
  readonly dropped_at: string | null;
  readonly dropped_reason: DeviceDropReason | null;
}

export const DEVICE_PROBLEMS = [
  'invalid-subscription',
  'unsupported-push-service',
  'invalid-label',
  'too-many-devices',
  'not-found',
] as const;
export type DeviceProblem = (typeof DEVICE_PROBLEMS)[number];

/** A `?problem=` of the page, when it is one of ours. */
export function isDeviceProblem(value: string | null): value is DeviceProblem {
  return value !== null && (DEVICE_PROBLEMS as readonly string[]).includes(value);
}

export type DeviceResult =
  | { readonly ok: true; readonly device: DeviceView }
  | { readonly ok: false; readonly problem: DeviceProblem };

export interface DeviceServiceDeps {
  readonly devices: NotificationDevicesRepo;
  readonly audit: AuditWriter;
  readonly clock: Clock;
}

export function viewOf(record: NotificationDeviceRecord): DeviceView {
  return {
    id: record.id,
    label: record.label,
    created_at: record.createdAt,
    last_delivered_at: record.lastDeliveredAt,
    last_failure_at: record.lastFailureAt,
    dropped_at: record.droppedAt,
    dropped_reason: record.droppedReason,
  };
}

/** A label trimmed to one line, or `null` when blank or too long. */
export function parseLabel(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const label = raw.replace(/\s+/g, ' ').trim();
  return label.length > 0 && label.length <= LABEL_MAX ? label : null;
}

/** A base64url key of exactly `bytes` octets, or `null`. */
function keyOf(raw: unknown, bytes: number): string | null {
  if (typeof raw !== 'string' || !/^[A-Za-z0-9_-]+={0,2}$/.test(raw)) return null;
  return Buffer.from(raw, 'base64url').length === bytes ? raw : null;
}

/**
 * The browser's `PushSubscription.toJSON()`: `{ endpoint, keys: { p256dh, auth } }`. The
 * keys must have the sizes RFC 8291 gives them; the endpoint must be a push service's.
 */
export function parseSubscription(
  raw: unknown,
): { ok: true; subscription: PushSubscriptionKeys } | { ok: false; problem: DeviceProblem } {
  if (typeof raw !== 'object' || raw === null)
    return { ok: false, problem: 'invalid-subscription' };
  const { endpoint, keys } = raw as { endpoint?: unknown; keys?: unknown };
  if (typeof endpoint !== 'string' || endpoint.length > ENDPOINT_MAX) {
    return { ok: false, problem: 'invalid-subscription' };
  }
  if (typeof keys !== 'object' || keys === null)
    return { ok: false, problem: 'invalid-subscription' };
  const given = keys as { p256dh?: unknown; auth?: unknown };
  const p256dh = keyOf(given.p256dh, P256DH_BYTES);
  const auth = keyOf(given.auth, AUTH_BYTES);
  if (p256dh === null || auth === null) return { ok: false, problem: 'invalid-subscription' };
  if (!isPushServiceEndpoint(endpoint)) return { ok: false, problem: 'unsupported-push-service' };
  return { ok: true, subscription: { endpoint, p256dh, auth } };
}

export class DeviceService {
  constructor(private readonly deps: DeviceServiceDeps) {}

  async list(user: UserRecord): Promise<DeviceView[]> {
    return (await this.deps.devices.listForUser(user.id)).map(viewOf);
  }

  async add(
    user: UserRecord,
    input: { subscription: unknown; label: unknown },
  ): Promise<DeviceResult> {
    const label = parseLabel(input.label);
    if (label === null) return { ok: false, problem: 'invalid-label' };
    const parsed = parseSubscription(input.subscription);
    if (!parsed.ok) return parsed;
    // Checked before the write: two adds racing for the last place may both pass (accepted,
    // as for the instance's ceilings).
    if ((await this.deps.devices.liveEndpointDigests(user.id)).length >= DEVICES_MAX) {
      return { ok: false, problem: 'too-many-devices' };
    }
    const { device, replaced } = await this.deps.devices.add({
      userId: user.id,
      label,
      subscription: parsed.subscription,
    });
    // A subscription another person held on this browser leaves their list: said in theirs.
    if (replaced !== null && replaced.userId !== user.id) {
      await this.audit(
        user,
        'device-removed',
        { device_id: replaced.id, label: replaced.label },
        { taken_over: true },
        replaced.userId,
      );
    }
    await this.audit(user, 'device-added', null, {
      device_id: device.id,
      label: device.label,
      replaced: replaced !== null,
    });
    return { ok: true, device: viewOf(device) };
  }

  async rename(user: UserRecord, deviceId: string, raw: unknown): Promise<DeviceResult> {
    const label = parseLabel(raw);
    if (label === null) return { ok: false, problem: 'invalid-label' };
    const device = await this.deps.devices.rename({ userId: user.id, deviceId }, label);
    return device ? { ok: true, device: viewOf(device) } : { ok: false, problem: 'not-found' };
  }

  async remove(user: UserRecord, deviceId: string): Promise<DeviceResult> {
    const device = await this.deps.devices.remove({ userId: user.id, deviceId });
    if (!device) return { ok: false, problem: 'not-found' };
    await this.audit(user, 'device-removed', { device_id: device.id, label: device.label }, null);
    return { ok: true, device: viewOf(device) };
  }

  /** The digests of the person's live endpoints: the page tells whether this browser is one. */
  liveEndpointDigests(user: UserRecord): Promise<string[]> {
    return this.deps.devices.liveEndpointDigests(user.id);
  }

  /** How many live devices each person has: for an administrator, never which. */
  countsByUser(): Promise<ReadonlyMap<string, number>> {
    return this.deps.devices.countsByUser();
  }

  /** An entry by `actor` about the devices of `owner` (the same person, but for a takeover). */
  private audit(
    actor: UserRecord,
    act: 'device-added' | 'device-removed',
    before: Record<string, unknown> | null,
    after: Record<string, unknown> | null,
    ownerId: string = actor.id,
  ): Promise<void> {
    return this.deps.audit.write({
      kind: 'admin',
      ts: toIso(this.deps.clock.now()),
      user_id: actor.id,
      act,
      object: { type: 'user', id: ownerId },
      before,
      after,
      delegated_client_id: null,
    });
  }
}
