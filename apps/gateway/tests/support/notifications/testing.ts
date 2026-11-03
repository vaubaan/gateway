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

/** One POST a messaging address would receive. */
export interface SentMessage {
  readonly url: string;
  readonly json: Record<string, unknown>;
  readonly init: RequestInit;
}

export interface FakeMessagingFetch {
  readonly fetch: typeof fetch;
  readonly sent: SentMessage[];
  /** The HTTP status of the next answers; 200 by default. */
  status: number;
}

/** A `fetch` that records what would be posted to a messaging service, and answers `status`. */
export function fakeMessagingFetch(): FakeMessagingFetch {
  const fake: FakeMessagingFetch = {
    sent: [],
    status: 200,
    fetch: async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      const body = typeof init?.body === 'string' ? init.body : '{}';
      fake.sent.push({ url, json: JSON.parse(body) as Record<string, unknown>, init: init ?? {} });
      return new Response(null, { status: fake.status });
    },
  };
  return fake;
}

/** A resolver that answers every name with `address` (a public one by default). */
export function fakeResolver(address = '93.184.215.14') {
  return async (): Promise<{ address: string; family: number }[]> => [
    { address, family: address.includes(':') ? 6 : 4 },
  ];
}

export interface SentMail {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
}

/** A mailer that records the notices it would send. */
export function fakeNoticeMailer(): {
  readonly sent: SentMail[];
  sendLink(): Promise<void>;
  sendNotice(input: SentMail): Promise<void>;
} {
  const sent: SentMail[] = [];
  return {
    sent,
    async sendLink() {
      throw new Error('fakeNoticeMailer: no link is mailed in these tests');
    },
    async sendNotice(input) {
      sent.push(input);
    },
  };
}

/** Incoming webhook addresses of each kind, of the right shape (none of them real). */
export const WEBHOOKS = {
  slack: 'https://hooks.slack.com/services/T0000/B0000/fixturefixturefixture',
  teams:
    'https://prod-01.westeurope.logic.azure.com/workflows/0000/triggers/manual/paths/invoke?sig=fixture',
  discord: 'https://discord.com/api/webhooks/1/fixture-token',
  ntfy: 'https://ntfy.sh/vaubaan-fixture-topic',
  generic: 'https://hooks.example.com/vaubaan',
} as const;
