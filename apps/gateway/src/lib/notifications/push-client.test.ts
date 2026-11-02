/**
 * What the browser side decides alone: which state a browser is in, the first name of a
 * device, and the public key as `applicationServerKey` takes it.
 */
import { describe, expect, it } from 'vitest';

import { DEVICES_API } from '@/server/notifications/handlers';
import { DEVICES_MAX, LABEL_MAX } from '@/server/notifications/device-service';
import { NOTIFICATION_WORDS } from '@/lib/vocabulary';

import {
  DEVICES_ROUTE,
  deviceLabelOf,
  endpointDigestOf,
  keyBytes,
  pushStateOf,
  type PushFacts,
} from './push-client';

const SUPPORTED: PushFacts = {
  serviceWorker: true,
  pushManager: true,
  notification: true,
  appleTouch: false,
  standalone: undefined,
  permission: 'default',
  subscribed: false,
};

describe('push state of a browser', () => {
  it('offers to subscribe a supported browser that is not subscribed', () => {
    expect(pushStateOf(SUPPORTED)).toBe('available');
    expect(pushStateOf({ ...SUPPORTED, subscribed: true })).toBe('subscribed');
    expect(pushStateOf({ ...SUPPORTED, permission: 'denied' })).toBe('denied');
  });

  it('asks an iPhone or iPad to install the interface first, whatever it supports', () => {
    expect(pushStateOf({ ...SUPPORTED, appleTouch: true, standalone: false })).toBe(
      'install-first',
    );
    expect(
      pushStateOf({ ...SUPPORTED, appleTouch: true, standalone: false, pushManager: false }),
    ).toBe('install-first');
    expect(pushStateOf({ ...SUPPORTED, appleTouch: true, standalone: true })).toBe('available');
  });

  it('says a browser without push cannot', () => {
    expect(pushStateOf({ ...SUPPORTED, pushManager: false })).toBe('unsupported');
    expect(pushStateOf({ ...SUPPORTED, serviceWorker: false })).toBe('unsupported');
    expect(pushStateOf({ ...SUPPORTED, notification: false, permission: null })).toBe(
      'unsupported',
    );
  });
});

describe('device label', () => {
  it('names the browser and the system from the user agent', () => {
    expect(
      deviceLabelOf(
        'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
      ),
    ).toBe('Safari on iPhone');
    expect(
      deviceLabelOf(
        'Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0 Mobile Safari/537.36',
      ),
    ).toBe('Chrome on Android');
    expect(
      deviceLabelOf(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0 Safari/537.36 Edg/142.0',
      ),
    ).toBe('Edge on Windows');
    expect(
      deviceLabelOf(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 15.1; rv:144.0) Gecko/20100101 Firefox/144.0',
      ),
    ).toBe('Firefox on macOS');
    expect(deviceLabelOf('curl/8')).toBe('Browser');
  });
});

describe('application server key', () => {
  it('decodes the URL-safe base64 the instance serves', () => {
    const raw = Buffer.concat([Buffer.from([0x04]), Buffer.alloc(64, 0xfb)]);
    expect(Buffer.from(keyBytes(raw.toString('base64url')))).toEqual(raw);
  });
});

describe('what the browser side repeats of the server', () => {
  it('posts to the route the server serves, and words its limits as the server sets them', () => {
    expect(DEVICES_ROUTE).toBe(DEVICES_API);
    expect(NOTIFICATION_WORDS.problems['invalid-label']).toContain(String(LABEL_MAX));
    expect(NOTIFICATION_WORDS.problems['too-many-devices']).toContain(String(DEVICES_MAX));
  });

  it('digests an endpoint as the store does (SHA-256, hex)', async () => {
    const { endpointDigest } = await import('@/server/store/repositories/notification-devices');
    const endpoint = 'https://fcm.googleapis.com/fcm/send/abc';
    expect(await endpointDigestOf(endpoint)).toBe(endpointDigest(endpoint));
  });
});
