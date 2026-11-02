/**
 * The web push transport: what leaves (one signed, encrypted POST to a push service, and to
 * nothing else) and what the answer means for the device.
 */
import { createECDH } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { isPushServiceEndpoint } from './push-services';
import { createWebPushTransport, outcomeOfStatus, PUSH_TTL_SECONDS } from './transport';
import { generateVapidKeys } from './vapid';

function subscription(endpoint = 'https://updates.push.services.mozilla.com/wpush/v2/abc') {
  const browser = createECDH('prime256v1');
  browser.generateKeys();
  return {
    endpoint,
    p256dh: browser.getPublicKey().toString('base64url'),
    auth: Buffer.alloc(16, 3).toString('base64url'),
  };
}

function recordingFetch(status: number) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(null, { status });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

function transport(fetchImpl: typeof fetch) {
  const keys = generateVapidKeys();
  return createWebPushTransport({
    fetch: fetchImpl,
    keys: async () => keys,
    subject: 'https://gateway.example.com',
    now: () => new Date('2026-11-02T10:00:00.000Z'),
  });
}

describe('web push transport', () => {
  it('posts one encrypted, signed message to the subscription’s endpoint', async () => {
    const { calls, fetchImpl } = recordingFetch(201);
    const target = subscription();
    expect(await transport(fetchImpl).send(target, '{"title":"x"}')).toEqual({ kind: 'delivered' });
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.url).toBe(target.endpoint);
    const headers = new Headers(call?.init.headers);
    expect(headers.get('content-encoding')).toBe('aes128gcm');
    expect(headers.get('ttl')).toBe(String(PUSH_TTL_SECONDS));
    expect(headers.get('authorization')).toMatch(/^vapid t=.+, k=.+$/);
    expect(call?.init.redirect).toBe('error');
    const body = Buffer.from(call?.init.body as Uint8Array);
    // The payload never travels clear.
    expect(body.toString('latin1')).not.toContain('title');
  });

  it('reads 404 and 410 as gone, anything else as a failure', () => {
    expect(outcomeOfStatus(202)).toEqual({ kind: 'delivered' });
    expect(outcomeOfStatus(404)).toEqual({ kind: 'gone', status: 404 });
    expect(outcomeOfStatus(410)).toEqual({ kind: 'gone', status: 410 });
    expect(outcomeOfStatus(413)).toEqual({ kind: 'failed', status: 413 });
    expect(outcomeOfStatus(503)).toEqual({ kind: 'failed', status: 503 });
  });

  it('never throws: an unreachable push service is a failure with no status', async () => {
    const down = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;
    expect(await transport(down).send(subscription(), '{}')).toEqual({
      kind: 'failed',
      status: null,
    });
  });

  it('reaches no endpoint outside the push services, and no broken keys', async () => {
    const { calls, fetchImpl } = recordingFetch(201);
    const send = transport(fetchImpl);
    for (const endpoint of [
      'http://fcm.googleapis.com/fcm/send/x',
      'https://169.254.169.254/latest/meta-data',
      'https://gateway.internal/push',
      'https://fcm.googleapis.com.evil.example/x',
    ]) {
      expect(await send.send(subscription(endpoint), '{}')).toEqual({
        kind: 'failed',
        status: null,
      });
    }
    expect(await send.send({ ...subscription(), p256dh: 'AA' }, '{}')).toEqual({
      kind: 'failed',
      status: null,
    });
    expect(calls).toEqual([]);
  });
});

describe('push services', () => {
  it('admits the browser vendors’ services over https only', () => {
    expect(isPushServiceEndpoint('https://fcm.googleapis.com/fcm/send/a')).toBe(true);
    expect(isPushServiceEndpoint('https://updates.push.services.mozilla.com/wpush/v2/a')).toBe(
      true,
    );
    expect(isPushServiceEndpoint('https://web.push.apple.com/QAbc')).toBe(true);
    expect(isPushServiceEndpoint('https://wns2-par02p.notify.windows.com/w/?token=a')).toBe(true);
    expect(isPushServiceEndpoint('https://fcm.googleapis.com:8443/a')).toBe(false);
    expect(isPushServiceEndpoint('https://user:pw@fcm.googleapis.com/a')).toBe(false);
    expect(isPushServiceEndpoint('https://notfcm.googleapis.com/a')).toBe(false);
    expect(isPushServiceEndpoint('not a url')).toBe(false);
  });
});
