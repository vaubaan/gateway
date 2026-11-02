/**
 * Web push message encryption against RFC 8291, Appendix A: given the salt and the
 * sender's key of the example, the body is exactly the example's, octet for octet.
 */
import { createDecipheriv, createECDH, hkdfSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  encryptPushMessage,
  MAX_PLAINTEXT_BYTES,
  PushEncryptionError,
  RECORD_SIZE,
} from './web-push-message';

const b64 = (value: string): Buffer => Buffer.from(value, 'base64url');

/** RFC 8291 Appendix A, whitespace removed. */
const VECTOR = {
  plaintext: 'When I grow up, I want to be a watermelon',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  asPublic:
    'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  uaPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  uaPublic:
    'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  header:
    'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  ciphertext: '8pfeW0KbunFT06SuDKoJH9Ql87S1QUrdirN6GcG7sFz1y1sqLgVi1VhjVkHsUoEsbI_0LpXMuGvnzQ',
} as const;

function exampleBody(): Buffer {
  return encryptPushMessage(
    {
      plaintext: Buffer.from(VECTOR.plaintext, 'utf8'),
      uaPublicKey: b64(VECTOR.uaPublic),
      authSecret: b64(VECTOR.auth),
    },
    { salt: b64(VECTOR.salt), senderPrivateKey: b64(VECTOR.asPrivate) },
  );
}

/** What the browser does (RFC 8291 §3.4 read from the receiving side). */
function decryptAsBrowser(body: Buffer, uaPrivate: Buffer, auth: Buffer): string {
  const salt = body.subarray(0, 16);
  const idLength = body.readUInt8(20);
  const senderPublic = body.subarray(21, 21 + idLength);
  const sealed = body.subarray(21 + idLength);
  const browser = createECDH('prime256v1');
  browser.setPrivateKey(uaPrivate);
  const secret = browser.computeSecret(senderPublic);
  const info = (text: string, ...parts: Buffer[]) =>
    Buffer.concat([Buffer.from(`${text}\0`), ...parts]);
  const ikm = Buffer.from(
    hkdfSync(
      'sha256',
      secret,
      auth,
      info('WebPush: info', browser.getPublicKey(), senderPublic),
      32,
    ),
  );
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, info('Content-Encoding: aes128gcm'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, info('Content-Encoding: nonce'), 12));
  const decipher = createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(sealed.subarray(sealed.length - 16));
  const plain = Buffer.concat([
    decipher.update(sealed.subarray(0, sealed.length - 16)),
    decipher.final(),
  ]);
  expect(plain.at(-1)).toBe(0x02);
  return plain.subarray(0, plain.length - 1).toString('utf8');
}

describe('web push encryption (RFC 8291, aes128gcm)', () => {
  it('produces the body of RFC 8291 Appendix A from its salt and keys', () => {
    const body = exampleBody();
    expect(body.subarray(0, 86).toString('base64url')).toBe(VECTOR.header);
    expect(body.subarray(86).toString('base64url')).toBe(VECTOR.ciphertext);
  });

  it('announces a 4096-octet record and the sender’s public key in the header', () => {
    const body = exampleBody();
    expect(body.readUInt32BE(16)).toBe(RECORD_SIZE);
    expect(body.readUInt8(20)).toBe(65);
    expect(body.subarray(21, 86).toString('base64url')).toBe(VECTOR.asPublic);
  });

  it('draws a fresh salt and key per message, and the browser opens it', () => {
    const browser = createECDH('prime256v1');
    browser.generateKeys();
    const auth = Buffer.alloc(16, 7);
    const input = {
      plaintext: Buffer.from('{"title":"acme"}'),
      uaPublicKey: browser.getPublicKey(),
      authSecret: auth,
    };
    const first = encryptPushMessage(input);
    const second = encryptPushMessage(input);
    expect(first.subarray(0, 16).equals(second.subarray(0, 16))).toBe(false);
    expect(decryptAsBrowser(first, browser.getPrivateKey(), auth)).toBe('{"title":"acme"}');
  });

  it('refuses keys of the wrong shape and a payload beyond one record', () => {
    const browser = createECDH('prime256v1');
    browser.generateKeys();
    const ok = {
      plaintext: Buffer.from('x'),
      uaPublicKey: browser.getPublicKey(),
      authSecret: Buffer.alloc(16),
    };
    expect(() => encryptPushMessage({ ...ok, uaPublicKey: Buffer.alloc(65) })).toThrow(
      PushEncryptionError,
    );
    expect(() => encryptPushMessage({ ...ok, uaPublicKey: Buffer.alloc(33, 2) })).toThrow(
      PushEncryptionError,
    );
    expect(() => encryptPushMessage({ ...ok, authSecret: Buffer.alloc(8) })).toThrow(
      PushEncryptionError,
    );
    expect(() =>
      encryptPushMessage({ ...ok, plaintext: Buffer.alloc(MAX_PLAINTEXT_BYTES + 1) }),
    ).toThrow(PushEncryptionError);
    expect(encryptPushMessage({ ...ok, plaintext: Buffer.alloc(MAX_PLAINTEXT_BYTES) }).length).toBe(
      RECORD_SIZE,
    );
  });
});
