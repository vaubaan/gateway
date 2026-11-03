/**
 * Notifications (spec §4.2 bis; ADR notifications-reach-the-persons-own-channels): the
 * person's channels (devices, messaging addresses, mail), the events that notify them and
 * the transports that reach them.
 * Built once by the composition root as `root.notifications`, before the modules whose
 * acts notify (they receive `events`). Host-agnostic: never imports `next`.
 * Handbook: docs/handbook/notifications.md.
 */
import type { AuditWriter } from '@vaubaan/gateway-core';

import type { Authenticator } from '../auth/authenticator';
import type { LinkMailer } from '../auth/local-handlers';
import { systemResolver, type Resolver } from '../http/public-address';
import type { Logger } from '../logging';
import { systemClock, type Clock } from '../store/clock';
import type { ConfigRepo } from '../store/repositories/config';
import type { NotificationAddressesRepo } from '../store/repositories/notification-addresses';
import type { NotificationDevicesRepo } from '../store/repositories/notification-devices';
import type { NotificationMailRepo } from '../store/repositories/notification-mail';
import { AddressService } from './address-service';
import { createBackgroundRunner, type BackgroundRunner } from './background';
import { createChannelHandlers, type ChannelHandlers } from './channel-handlers';
import { DeviceService } from './device-service';
import { createNotificationDispatch, type DispatchDeps } from './dispatch';
import type { NotificationEvents } from './events';
import { createDeviceHandlers, NOTIFICATIONS_PAGE, type DeviceHandlers } from './handlers';
import { createMailNotifier, MailChannel, noticeMailerOf } from './mail-channel';
import { fetchPoster, publicOnlyPoster } from './messaging/posters';
import { createMessagingTransport, type MessagingTransport } from './messaging/transport';
import { createAddressNotifier, createDeviceNotifier, fanOut, type Notifier } from './notifier';
import { createVapidKeyStore, type VapidKeyStore } from './vapid-keys';
import { createWebPushTransport, type PushTransport } from './web-push/transport';

export { NO_NOTIFICATIONS, type NotificationEvents, type RequestOpenedEvent } from './events';
export {
  DEVICES_API,
  DONE_PARAM,
  isDoneAct,
  type DoneAct,
  LABEL_FIELD,
  NOTIFICATIONS_PAGE,
  PROBLEM_PARAM,
  deviceActionPath,
} from './handlers';
export {
  ADDRESS_FIELDS,
  ADDRESSES_API,
  MAIL_API,
  MAIL_FIELD,
  STATUS_PARAM,
  addressRemovePath,
} from './channel-handlers';
export {
  ADDRESSES_MAX,
  ADDRESS_PROBLEMS,
  type AddressProblem,
  type AddressView,
} from './address-service';
export { MAIL_PROBLEMS, type MailProblem, type MailStatus } from './mail-channel';
export { ADDRESS_KINDS, ADDRESS_URL_MAX, type AddressKind } from './messaging/address-rules';
export type { MessagingOutcome, MessagingTransport } from './messaging/transport';
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
    readonly notificationAddresses: NotificationAddressesRepo;
    readonly notificationMail: NotificationMailRepo;
    readonly config: Pick<ConfigRepo, 'getSecret' | 'setSecret' | 'keys'>;
    readonly auditWriter: AuditWriter;
  };
  /** Who to tell and what to call things: the store's reads and the instance's name. */
  readonly lookups: Omit<DispatchDeps, 'notifier' | 'runner' | 'logger'>;
  /** The sign-in check of the handlers; read when a request arrives (built after this module). */
  readonly authenticator: () => Authenticator;
  readonly logger: Logger;
  /**
   * Outbound HTTP to the push services and the messaging services (tests inject a fake; it
   * then also replaces the pinned socket of the free-host addresses).
   */
  readonly fetch?: typeof fetch;
  /** Tests: replaces the web push transport. */
  readonly transport?: PushTransport;
  /** Name resolution of the messaging addresses whose host is free (tests inject a fake). */
  readonly resolve?: Resolver;
  /** Tests: replaces the messaging transport. */
  readonly messagingTransport?: MessagingTransport;
  /** The instance's mail transport, when it delivers mail (§4.3): mail is then a channel. */
  readonly mailer?: LinkMailer;
  readonly clock?: Clock;
}

export interface NotificationsModule {
  /** What the acts that notify call, after their write committed. */
  readonly events: NotificationEvents;
  readonly devices: DeviceService;
  readonly addresses: AddressService;
  readonly mail: MailChannel;
  readonly handlers: DeviceHandlers & ChannelHandlers;
  /**
   * How many channels each person has — live devices, addresses, and mail when switched on
   * on an instance that delivers it — for an administrator, never which.
   */
  channelCounts(): Promise<ReadonlyMap<string, number>>;
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
  const resolve = deps.resolve ?? systemResolver;
  const messaging =
    deps.messagingTransport ??
    createMessagingTransport({
      vendorPost: fetchPoster(deps.fetch ?? fetch),
      // A fake `fetch` (tests, the e2e instance) stands in for every host; in production a
      // free host is reached through a socket pinned to the public addresses it resolved to.
      freeHostPost: deps.fetch ? fetchPoster(deps.fetch) : publicOnlyPoster(resolve),
      resolve,
    });
  const mailer = noticeMailerOf(deps.mailer);
  const notifier: Notifier = fanOut(
    [
      createDeviceNotifier({ devices: deps.store.notificationDevices, transport, logger }),
      createAddressNotifier({
        addresses: deps.store.notificationAddresses,
        transport: messaging,
        publicUrl: deps.publicUrl,
        logger,
      }),
      createMailNotifier({
        mail: deps.store.notificationMail,
        users: deps.lookups.users,
        mailer,
        publicUrl: deps.publicUrl,
        logger,
      }),
    ],
    logger,
  );
  const runner: BackgroundRunner = createBackgroundRunner(logger);
  const events = createNotificationDispatch({ ...deps.lookups, notifier, runner, logger });
  const devices = new DeviceService({
    devices: deps.store.notificationDevices,
    audit: deps.store.auditWriter,
    clock,
  });
  const addresses = new AddressService({
    addresses: deps.store.notificationAddresses,
    transport: messaging,
    audit: deps.store.auditWriter,
    clock,
    instanceName: deps.lookups.instanceName,
    settingsUrl: new URL(NOTIFICATIONS_PAGE, deps.publicUrl).href,
  });
  const mail = new MailChannel({
    mail: deps.store.notificationMail,
    mailer,
    audit: deps.store.auditWriter,
    clock,
  });
  const signIn = { publicUrl: deps.publicUrl, authenticator: deps.authenticator };
  const handlers = {
    ...createDeviceHandlers({ ...signIn, service: devices }),
    ...createChannelHandlers({ ...signIn, addresses, mail }),
  };
  async function channelCounts(): Promise<ReadonlyMap<string, number>> {
    const [byDevices, byAddresses, byMail] = await Promise.all([
      devices.countsByUser(),
      addresses.countsByUser(),
      mail.switchedOn(),
    ]);
    const counts = new Map(byDevices);
    for (const [userId, n] of byAddresses) counts.set(userId, (counts.get(userId) ?? 0) + n);
    for (const userId of byMail) counts.set(userId, (counts.get(userId) ?? 0) + 1);
    return counts;
  }
  return {
    events,
    devices,
    addresses,
    mail,
    handlers,
    vapid,
    channelCounts,
    idle: () => runner.idle(),
    stop: () => runner.stop(),
  };
}
