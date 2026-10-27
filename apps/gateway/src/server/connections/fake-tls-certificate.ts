/**
 * A throwaway self-signed TLS certificate for the fake OAuth broker — the
 * test stand-in for the key an enclave generates at start (ADR
 * oauth-broker-stateless-in-an-attested-enclave D6). Not for production.
 *
 * Node makes key pairs but not certificates, and no private key is kept in
 * the repository: this writes the few DER bytes of an X.509 v1 certificate
 * (ECDSA P-256, SHA-256, a common name, a day of validity) and signs them.
 * Nothing verifies its chain: the gateway checks the key it carries against
 * an attestation, which is the point.
 */
import { generateKeyPairSync, sign } from 'node:crypto';

export interface FakeTlsCertificate {
  readonly keyPem: string;
  readonly certPem: string;
}

export function fakeTlsCertificate(commonName = 'fake-oauth-broker'): FakeTlsCertificate {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  const algorithm = sequence(oid([1, 2, 840, 10045, 4, 3, 2])); // ecdsa-with-SHA256
  const name = sequence(set(sequence(oid([2, 5, 4, 3]), tlv(0x0c, Buffer.from(commonName)))));
  const now = Date.now();
  const tbs = sequence(
    integer(Buffer.from([0x01])),
    algorithm,
    name,
    sequence(utcTime(new Date(now - 60_000)), utcTime(new Date(now + 24 * 60 * 60_000))),
    name,
    spki,
  );
  const signature = sign('sha256', tbs, privateKey);
  const der = sequence(tbs, algorithm, tlv(0x03, Buffer.concat([Buffer.from([0]), signature])));
  return {
    keyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    certPem: pem('CERTIFICATE', der),
  };
}

function tlv(tag: number, content: Buffer): Buffer {
  const length = content.length;
  let header: Buffer;
  if (length < 0x80) header = Buffer.from([tag, length]);
  else if (length < 0x100) header = Buffer.from([tag, 0x81, length]);
  else header = Buffer.from([tag, 0x82, length >> 8, length & 0xff]);
  return Buffer.concat([header, content]);
}

function sequence(...parts: Buffer[]): Buffer {
  return tlv(0x30, Buffer.concat(parts));
}

function set(...parts: Buffer[]): Buffer {
  return tlv(0x31, Buffer.concat(parts));
}

function integer(value: Buffer): Buffer {
  return tlv(0x02, value);
}

function oid(arcs: readonly number[]): Buffer {
  const [first = 0, second = 0, ...rest] = arcs;
  const bytes = [first * 40 + second];
  for (const arc of rest) {
    const chunk = [arc & 0x7f];
    for (let v = arc >> 7; v > 0; v >>= 7) chunk.unshift((v & 0x7f) | 0x80);
    bytes.push(...chunk);
  }
  return tlv(0x06, Buffer.from(bytes));
}

function utcTime(at: Date): Buffer {
  const text = at.toISOString().replace(/[-:T]/g, '').slice(2, 14) + 'Z';
  return tlv(0x17, Buffer.from(text));
}

function pem(label: string, der: Buffer): string {
  const body = der
    .toString('base64')
    .replace(/(.{64})/g, '$1\n')
    .trimEnd();
  return `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----\n`;
}
