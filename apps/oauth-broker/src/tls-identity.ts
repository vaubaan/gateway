/**
 * The broker's TLS identity for the gateway API (ADR D6): a P-256 key pair
 * generated in memory at start, and a self-signed certificate for it. Nothing
 * is written to disk or logged but the SHA-256 of the public key, which is
 * public by nature and what the attestation binds. The gateway trusts the key
 * through the attestation, not through a certificate authority, so the
 * certificate carries nothing but the key: an X.509 v1 certificate, written
 * here in a few lines of DER rather than with a dependency (Node can read and
 * verify a certificate, not create one).
 */
import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { sha256 } from './crypto-util.ts';

export interface TlsIdentity {
  /** PEM, for `https.createServer`; lives in this process's memory only. */
  readonly key: string;
  readonly cert: string;
  /** base64url(SHA-256(DER SubjectPublicKeyInfo)): the second nonce of every attestation. */
  readonly publicKeySha256: string;
}

function tlv(tag: number, content: Buffer): Buffer {
  const n = content.length;
  const length =
    n < 0x80
      ? Buffer.from([n])
      : n < 0x100
        ? Buffer.from([0x81, n])
        : Buffer.from([0x82, n >> 8, n & 0xff]);
  if (n > 0xffff) throw new RangeError('DER element too long');
  return Buffer.concat([Buffer.from([tag]), length, content]);
}

const sequence = (...items: Buffer[]): Buffer => tlv(0x30, Buffer.concat(items));
const set = (...items: Buffer[]): Buffer => tlv(0x31, Buffer.concat(items));

/** ecdsa-with-SHA256, 1.2.840.10045.4.3.2, no parameters (RFC 5758 §3.2). */
const ECDSA_WITH_SHA256 = sequence(
  Buffer.from([0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x02]),
);
/** commonName, 2.5.4.3. */
const COMMON_NAME = Buffer.from([0x06, 0x03, 0x55, 0x04, 0x03]);

function utcTime(date: Date): Buffer {
  const iso = date.toISOString(); // 2026-10-27T10:00:00.000Z
  const text = `${iso.slice(2, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}Z`;
  return tlv(0x17, Buffer.from(text, 'ascii'));
}

function pem(label: string, der: Buffer): string {
  const lines = der.toString('base64').match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----\n`;
}

export function createTlsIdentity(now: Date = new Date()): TlsIdentity {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const spki = publicKey.export({ type: 'spki', format: 'der' });

  const serial = randomBytes(16);
  serial[0] = ((serial[0] ?? 0) & 0x7f) | 0x01; // positive, minimal
  const name = sequence(set(sequence(COMMON_NAME, tlv(0x0c, Buffer.from('oauth-broker', 'utf8')))));
  const tbs = sequence(
    tlv(0x02, serial),
    ECDSA_WITH_SHA256,
    name,
    sequence(
      utcTime(new Date(now.getTime() - 3_600_000)),
      utcTime(new Date(now.getTime() + 365 * 86_400_000)),
    ),
    name,
    spki,
  );
  const signature = sign('sha256', tbs, privateKey); // DER-encoded ECDSA signature
  const certificate = sequence(
    tbs,
    ECDSA_WITH_SHA256,
    tlv(0x03, Buffer.concat([Buffer.from([0x00]), signature])),
  );

  return {
    key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    cert: pem('CERTIFICATE', certificate),
    publicKeySha256: sha256(spki).toString('base64url'),
  };
}
