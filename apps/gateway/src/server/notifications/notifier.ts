/**
 * The notifier contract (ADR notifications-reach-the-persons-own-channels): one method,
 * `notify(userId, notification)`, implemented once per channel kind. Wave 1 has the kind
 * "device" (web push); a messaging address or mail is another `Notifier` added to
 * `fanOut`, with no change to what notifies or what a notification says.
 *
 * A notifier delivers to the person's own channels only, best effort: a failure is
 * recorded on the channel and logged, never retried and never thrown at the caller.
 */
import type { Logger } from '../logging';
import type { NotificationDevicesRepo } from '../store/repositories/notification-devices';
import { serializePayload, type Notification } from './notification';
import type { PushTransport } from './web-push/transport';

export interface Notifier {
  notify(userId: string, notification: Notification): Promise<void>;
}

/** Every channel kind, one after the other; one kind failing does not keep the others back. */
export function fanOut(notifiers: readonly Notifier[], logger: Logger): Notifier {
  return {
    async notify(userId, notification) {
      for (const notifier of notifiers) {
        try {
          await notifier.notify(userId, notification);
        } catch (err) {
          logger.warn('a notification channel failed', {
            kind: notification.kind,
            error_class: err instanceof Error ? err.name : typeof err,
          });
        }
      }
    },
  };
}

export interface DeviceNotifierDeps {
  readonly devices: Pick<NotificationDevicesRepo, 'subscriptionsOf' | 'recordDelivery'>;
  readonly transport: PushTransport;
  readonly logger: Logger;
}

/** The kind "device": a web push to every live device of the person. */
export function createDeviceNotifier(deps: DeviceNotifierDeps): Notifier {
  const { devices, transport, logger } = deps;
  return {
    async notify(userId, notification) {
      const payload = serializePayload(notification);
      for (const { deviceId, subscription } of await devices.subscriptionsOf(userId)) {
        const outcome = await transport.send(subscription, payload);
        const key = { userId, deviceId };
        // Never the endpoint: it is a capability URL (spec §6).
        if (outcome.kind === 'delivered') {
          await devices.recordDelivery(key, { kind: 'delivered' });
        } else if (outcome.kind === 'gone') {
          await devices.recordDelivery(key, { kind: 'dropped', reason: 'gone' });
          logger.info('notification device dropped: its push service no longer knows it', {
            device_id: deviceId,
            status: outcome.status,
          });
        } else {
          await devices.recordDelivery(key, { kind: 'failed', status: outcome.status });
          logger.warn('notification not delivered', {
            device_id: deviceId,
            kind: notification.kind,
            status: outcome.status ?? 'no answer',
          });
        }
      }
    },
  };
}
