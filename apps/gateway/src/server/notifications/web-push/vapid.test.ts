/**
 * The VAPID header (RFC 8292): an ES256 token for the push service's origin, valid less than
 * a day, naming the instance, signed by the key whose public half rides as `k`.
 */
import { decodeProtectedHeader, importJWK, jwtVerify } from 'jose';
import { describe, expect, it } from 'vitest';

import {
  generateVapidKeys,
  parseVapidKeys,
  vapidAuthorization,
  vapidPublicKey,
  VapidKeyError,
  VAPID_TOKEN_SECONDS,
} from './vapid';

const NOW = new Date('2026-11-02T10:00:00.000Z');
const ENDPOINT = 'https://fcm.googleapis.com/fcm/send/device-token-123';

describe('VAPID (RFC 8292)', () => {
  it('signs a token the public key verifies, for the endpoint’s origin', async () => {
    const keys = generateVapidKeys();
    const header = await vapidAuthorization({
      endpoint: ENDPOINT,
      subject: 'https://gateway.example.com',
      keys,
      now: NOW,
    });
    const match = /^vapid t=([^,]+), k=([A-Za-z0-9_-]+)$/.exec(header);
    expect(match).not.toBeNull();
    const [, token = '', k = ''] = match ?? [];
    expect(k).toBe(vapidPublicKey(keys));
    expect(decodeProtectedHeader(token)).toEqual({ typ: 'JWT', alg: 'ES256' });

    const { d: _private, ...publicJwk } = keys.privateJwk;
    const { payload } = await jwtVerify(token, await importJWK(publicJwk, 'ES256'), {
      currentDate: NOW,
      audience: 'https://fcm.googleapis.com',
      subject: 'https://gateway.example.com',
    });
    expect((payload.exp ?? 0) - NOW.getTime() / 1000).toBe(VAPID_TOKEN_SECONDS);
    expect(VAPID_TOKEN_SECONDS).toBeLessThanOrEqual(24 * 3600);
  });

  it('gives the public key as the uncompressed point a browser subscribes with', () => {
    const raw = Buffer.from(vapidPublicKey(generateVapidKeys()), 'base64url');
    expect(raw.length).toBe(65);
    expect(raw[0]).toBe(0x04);
  });

  it('reads back what it generated, and refuses anything else', () => {
    const keys = generateVapidKeys();
    expect(parseVapidKeys(JSON.stringify(keys))).toEqual(keys);
    expect(() => parseVapidKeys('{}')).toThrow(VapidKeyError);
    const { d: _private, ...publicOnly } = keys.privateJwk;
    expect(() => parseVapidKeys(JSON.stringify({ privateJwk: publicOnly }))).toThrow(VapidKeyError);
  });
});
