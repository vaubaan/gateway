/**
 * Message encryption for Web Push (RFC 8291) in the `aes128gcm` content coding (RFC 8188),
 * with Node's `crypto` only: ECDH on P-256, HKDF-SHA-256, AES-128-GCM.
 *
 *   ecdh_secret = ECDH(as_private, ua_public)
 *   IKM   = HKDF(salt = auth_secret, ikm = ecdh_secret,
 *                info = "WebPush: info" 0x00 ua_public as_public, 32)
 *   CEK   = HKDF(salt, IKM, "Content-Encoding: aes128gcm" 0x00, 16)
 *   NONCE = HKDF(salt, IKM, "Content-Encoding: nonce" 0x00, 12)
 *   body  = salt(16) ‖ rs(4) ‖ idlen(1) = 65 ‖ as_public(65)
 *           ‖ AES-128-GCM(CEK, NONCE, plaintext ‖ 0x02)
 *
 * In the crypto module, as every cipher and key derivation of the gateway (Semgrep rule
 * `vaubaan-encryption-only-in-the-crypto-module`); the notifications' transport calls it.
 *
 * One record, no padding: a payload is a few hundred octets, far below the 4096 of the
 * record size. The salt and the sender's ephemeral key are fresh per message; a test
 * injects them to replay the RFC 8291 Appendix A vector.
 */
import { createCipheriv, createECDH, hkdfSync, randomBytes } from 'node:crypto';

/** The record size the header announces (RFC 8188 §2.1). */
export const RECORD_SIZE = 4096;
const SALT_BYTES = 16;
const KEY_BYTES = 16;
const NONCE_BYTES = 12;
const IKM_BYTES = 32;
const PUBLIC_KEY_BYTES = 65;
const AUTH_SECRET_BYTES = 16;
const TAG_BYTES = 16;
/** The delimiter of the last (and only) record (RFC 8188 §2). */
const LAST_RECORD = 0x02;
/** Header (86) + delimiter + tag must stay within one record. */
export const MAX_PLAINTEXT_BYTES =
  RECORD_SIZE - (SALT_BYTES + 4 + 1 + PUBLIC_KEY_BYTES) - 1 - TAG_BYTES;

export class PushEncryptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PushEncryptionError';
  }
}

export interface EncryptInput {
  readonly plaintext: Uint8Array;
  /** The browser's `p256dh`: an uncompressed P-256 point. */
  readonly uaPublicKey: Uint8Array;
  /** The browser's `auth` secret. */
  readonly authSecret: Uint8Array;
}

/** Tests only: what is random in a real message. */
export interface EncryptRandomness {
  readonly salt: Uint8Array;
  /** The sender's ephemeral P-256 private key (32 octets). */
  readonly senderPrivateKey: Uint8Array;
}

function info(text: string, ...parts: Uint8Array[]): Buffer {
  return Buffer.concat([Buffer.from(`${text}\0`, 'latin1'), ...parts]);
}

function hkdf(ikm: Uint8Array, salt: Uint8Array, infoBytes: Uint8Array, length: number): Buffer {
  return Buffer.from(hkdfSync('sha256', ikm, salt, infoBytes, length));
}

/** The `aes128gcm` body of one push message to one browser. */
export function encryptPushMessage(
  input: EncryptInput,
  randomness: EncryptRandomness = freshRandomness(),
): Buffer {
  const { plaintext, uaPublicKey, authSecret } = input;
  if (uaPublicKey.length !== PUBLIC_KEY_BYTES || uaPublicKey[0] !== 0x04) {
    throw new PushEncryptionError('p256dh is not an uncompressed P-256 public key');
  }
  if (authSecret.length !== AUTH_SECRET_BYTES) {
    throw new PushEncryptionError('auth is not a 16-octet secret');
  }
  if (plaintext.length > MAX_PLAINTEXT_BYTES) {
    throw new PushEncryptionError('the payload does not fit in one record');
  }
  const sender = createECDH('prime256v1');
  sender.setPrivateKey(randomness.senderPrivateKey);
  const senderPublic = sender.getPublicKey();
  let ecdhSecret: Buffer;
  try {
    ecdhSecret = sender.computeSecret(uaPublicKey);
  } catch {
    throw new PushEncryptionError('p256dh is not a point of P-256');
  }
  const ikm = hkdf(
    ecdhSecret,
    authSecret,
    info('WebPush: info', uaPublicKey, senderPublic),
    IKM_BYTES,
  );
  const { salt } = randomness;
  const cek = hkdf(ikm, salt, info('Content-Encoding: aes128gcm'), KEY_BYTES);
  const nonce = hkdf(ikm, salt, info('Content-Encoding: nonce'), NONCE_BYTES);

  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  const sealed = Buffer.concat([
    cipher.update(Buffer.concat([plaintext, Buffer.from([LAST_RECORD])])),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  const header = Buffer.alloc(SALT_BYTES + 4 + 1);
  Buffer.from(salt).copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, SALT_BYTES);
  header.writeUInt8(PUBLIC_KEY_BYTES, SALT_BYTES + 4);
  return Buffer.concat([header, senderPublic, sealed]);
}

/** A fresh salt and a fresh ephemeral key: what every real message uses. */
function freshRandomness(): EncryptRandomness {
  const ephemeral = createECDH('prime256v1');
  ephemeral.generateKeys();
  return { salt: randomBytes(SALT_BYTES), senderPrivateKey: ephemeral.getPrivateKey() };
}
