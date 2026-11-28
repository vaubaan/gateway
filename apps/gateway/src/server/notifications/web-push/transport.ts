/**
 * The web push transport: one encrypted, signed POST to the push service of a browser
 * (RFC 8030 §5), and what its answer means for the device.
 *
 *   201 / 202          delivered (accepted by the push service)
 *   404 / 410          gone: the subscription no longer exists, the device is dropped
 *   anything else      failed: kept, the failure is recorded, nothing is retried
 *   no answer          failed, status `null` (an instance that cannot reach the push
 *                      services of the browser vendors fails here, every time)
 *
 * The endpoint is a capability URL: it never leaves this file but in the request itself,
 * and no outcome carries it.
 */
import type { PushSubscriptionKeys } from '../../store/repositories/notification-devices';
import { encryptPushMessage } from '../../crypto/web-push-message';
import { isPushServiceEndpoint } from './push-services';
import { vapidAuthorization, type VapidKeys } from './vapid';

/** How long a push service keeps an undelivered message: a day, then it is stale. */
export const PUSH_TTL_SECONDS = 24 * 60 * 60;
/** A push service that does not answer in this delay is a failure, not a wait. */
export const PUSH_TIMEOUT_MS = 10_000;

export type PushOutcome =
  | { readonly kind: 'delivered' }
  | { readonly kind: 'gone'; readonly status: number }
  | { readonly kind: 'failed'; readonly status: number | null };

/** Sends one payload to one subscription; never throws. */
export interface PushTransport {
  send(subscription: PushSubscriptionKeys, payload: string): Promise<PushOutcome>;
}

export interface WebPushTransportDeps {
  /** Outbound HTTP to the push services (tests inject a fake). */
  readonly fetch: typeof fetch;
  /** The instance's key pair, read when a message leaves. */
  readonly keys: () => Promise<VapidKeys>;
  /** `sub` of the VAPID token: the instance's public URL. */
  readonly subject: string;
  readonly now: () => Date;
}

const GONE = new Set([404, 410]);

/** What an HTTP status from a push service means for the device. */
export function outcomeOfStatus(status: number): PushOutcome {
  if (status >= 200 && status < 300) return { kind: 'delivered' };
  if (GONE.has(status)) return { kind: 'gone', status };
  return { kind: 'failed', status };
}

export function createWebPushTransport(deps: WebPushTransportDeps): PushTransport {
  return {
    async send(subscription, payload) {
      // Checked when the device was added; checked again, a row may predate a change of the list.
      if (!isPushServiceEndpoint(subscription.endpoint)) return { kind: 'failed', status: null };
      let request: RequestInit;
      try {
        const body = encryptPushMessage({
          plaintext: Buffer.from(payload, 'utf8'),
          uaPublicKey: Buffer.from(subscription.p256dh, 'base64url'),
          authSecret: Buffer.from(subscription.auth, 'base64url'),
        });
        const authorization = await vapidAuthorization({
          endpoint: subscription.endpoint,
          subject: deps.subject,
          keys: await deps.keys(),
          now: deps.now(),
        });
        request = {
          method: 'POST',
          headers: {
            Authorization: authorization,
            'Content-Encoding': 'aes128gcm',
            'Content-Type': 'application/octet-stream',
            TTL: String(PUSH_TTL_SECONDS),
            Urgency: 'high',
          },
          body: new Uint8Array(body),
          redirect: 'error',
          signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
        };
      } catch {
        // expected: the subscription's keys do not encrypt (or the VAPID keys are unreadable): a failed delivery
        return { kind: 'failed', status: null };
      }
      try {
        const response = await deps.fetch(subscription.endpoint, request);
        await response.body?.cancel().catch(() => undefined);
        return outcomeOfStatus(response.status);
      } catch {
        // expected: the push service did not answer (network, timeout): a failed delivery, recorded on the device
        return { kind: 'failed', status: null };
      }
    },
  };
}
