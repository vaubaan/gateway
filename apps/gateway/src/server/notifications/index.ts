/**
 * Notifications (spec §4.2 bis; ADR notifications-reach-the-persons-own-channels): the
 * person's devices, the events that notify them and the web push that reaches them.
 * Built once by the composition root as `root.notifications`, before the modules whose
 * acts notify (they receive `events`). Host-agnostic: never imports `next`.
 * Handbook: docs/handbook/notifications.md.
 */
import type { AuditWriter } from '@vaubaan/gateway-core';

import type { Authenticator } from '../auth/authenticator';
import type { Logger } from '../logging';
import { systemClock, type Clock } from '../store/clock';
import type { ConfigRepo } from '../store/repositories/config';
import type { NotificationDevicesRepo } from '../store/repositories/notification-devices';
import { createBackgroundRunner, type BackgroundRunner } from './background';
import { DeviceService } from './device-service';
import { createNotificationDispatch, type DispatchDeps } from './dispatch';
import type { NotificationEvents } from './events';
import { createDeviceHandlers, type DeviceHandlers } from './handlers';
import { createDeviceNotifier, fanOut, type Notifier } from './notifier';
import { createVapidKeyStore, type VapidKeyStore } from './vapid-keys';
import { createWebPushTransport, type PushTransport } from './web-push/transport';

export { NO_NOTIFICATIONS, type NotificationEvents, type RequestOpenedEvent } from './events';
export {
  DEVICES_API,
  DONE_PARAM,
  LABEL_FIELD,
  NOTIFICATIONS_PAGE,
  PROBLEM_PARAM,
  deviceActionPath,
} from './handlers';
export {
  DEVICES_MAX,
  isDeviceProblem,
  LABEL_MAX,
  type DeviceProblem,
  type DeviceView,
} from './device-service';
export type { Notification, NotificationKind } from './notification';
export type { Notifier } from './notifier';
export type { PushTransport, PushOutcome } from './web-push/transport';

/** Said at boot when the public URL is not https. */
export const NOTIFICATIONS_NEED_HTTPS =
  'public_url is not https: browsers will not subscribe to notifications, and push services may refuse them';

export interface NotificationsModuleDeps {
  readonly publicUrl: URL;
  readonly store: {
    readonly notificationDevices: NotificationDevicesRepo;
    readonly config: Pick<ConfigRepo, 'getSecret' | 'setSecret' | 'keys'>;
    readonly auditWriter: AuditWriter;
  };
  /** Who to tell and what to call things: the store's reads and the instance's name. */
  readonly lookups: Omit<DispatchDeps, 'notifier' | 'runner' | 'logger'>;
  /** The sign-in check of the handlers; read when a request arrives (built after this module). */
  readonly authenticator: () => Authenticator;
  readonly logger: Logger;
  /** Outbound HTTP to the push services (tests inject a fake). */
  readonly fetch?: typeof fetch;
  /** Tests: replaces the web push transport. */
  readonly transport?: PushTransport;
  readonly clock?: Clock;
}

export interface NotificationsModule {
  /** What the acts that notify call, after their write committed. */
  readonly events: NotificationEvents;
  readonly devices: DeviceService;
  readonly handlers: DeviceHandlers;
  /** The key pair, generated and sealed the first time it is needed. */
  readonly vapid: VapidKeyStore;
  /** Resolves once no notification work runs or waits (tests). */
  idle(): Promise<void>;
  /** Refuses new work and waits for what runs: before the store closes. */
  stop(): Promise<void>;
}

export function createNotificationsModule(deps: NotificationsModuleDeps): NotificationsModule {
  const clock = deps.clock ?? systemClock;
  const logger = deps.logger.child({ component: 'notifications' });
  if (deps.publicUrl.protocol !== 'https:') {
    // A browser subscribes only in a secure context, and a push service may refuse a VAPID
    // `sub` that is not https (RFC 8292 §2.1): said once, the instance runs the same.
    logger.warn(NOTIFICATIONS_NEED_HTTPS, { public_url: deps.publicUrl.origin });
  }
  const vapid = createVapidKeyStore(deps.store.config);
  const transport =
    deps.transport ??
    createWebPushTransport({
      fetch: deps.fetch ?? fetch,
      keys: () => vapid.keys(),
      subject: deps.publicUrl.origin,
      now: () => clock.now(),
    });
  // Wave 1 has one channel kind; a messaging address or mail joins this list.
  const notifier: Notifier = fanOut(
    [createDeviceNotifier({ devices: deps.store.notificationDevices, transport, logger })],
    logger,
  );
  const runner: BackgroundRunner = createBackgroundRunner(logger);
  const events = createNotificationDispatch({ ...deps.lookups, notifier, runner, logger });
  const devices = new DeviceService({
    devices: deps.store.notificationDevices,
    audit: deps.store.auditWriter,
    clock,
  });
  const handlers = createDeviceHandlers({
    publicUrl: deps.publicUrl,
    authenticator: deps.authenticator,
    service: devices,
  });
  return { events, devices, handlers, vapid, idle: () => runner.idle(), stop: () => runner.stop() };
}
