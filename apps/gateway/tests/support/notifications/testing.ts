/**
 * Test helpers of the notifications: a fake web push transport that records what would
 * leave and answers what the test says, and a browser subscription of the right shape.
 * Not for production.
 */
import { createECDH } from 'node:crypto';

import type { PushOutcome, PushTransport } from '../../../src/server/notifications';
import type { PushSubscriptionKeys } from '../../../src/server/store/repositories/notification-devices';

export interface SentPush {
  readonly endpoint: string;
  /** The payload as the service worker would read it, decrypted. */
  readonly payload: string;
}

export interface FakePushTransport extends PushTransport {
  readonly sent: SentPush[];
  /** The answer of the next sends; `delivered` by default. */
  answer: PushOutcome;
  /** When set, every send waits for it: what a slow push service does. */
  hold: Promise<void> | null;
}

export function fakePushTransport(): FakePushTransport {
  const fake: FakePushTransport = {
    sent: [],
    answer: { kind: 'delivered' },
    hold: null,
    async send(subscription, payload) {
      if (fake.hold) await fake.hold;
      fake.sent.push({ endpoint: subscription.endpoint, payload });
      return fake.answer;
    },
  };
  return fake;
}

/** What `PushSubscription.toJSON()` gives in a browser whose push service is FCM. */
export function browserSubscription(token = 'device-1'): {
  endpoint: string;
  keys: { p256dh: string; auth: string };
} {
  const browser = createECDH('prime256v1');
  browser.generateKeys();
  return {
    endpoint: `https://fcm.googleapis.com/fcm/send/${token}`,
    keys: {
      p256dh: browser.getPublicKey().toString('base64url'),
      auth: Buffer.alloc(16, 9).toString('base64url'),
    },
  };
}

/** The same, as the repository stores it. */
export function storedSubscription(token = 'device-1'): PushSubscriptionKeys {
  const { endpoint, keys } = browserSubscription(token);
  return { endpoint, ...keys };
}
