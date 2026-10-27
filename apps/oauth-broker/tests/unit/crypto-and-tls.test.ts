import { X509Certificate, createHash, createPrivateKey } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { isBase64Url32, s256, safeEqual } from '../../src/crypto-util.ts';
import { createTlsIdentity } from '../../src/tls-identity.ts';

describe('crypto helpers', () => {
  it('computes the PKCE S256 of RFC 7636 appendix B', () => {
    expect(s256('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    );
  });

  it('accepts exactly 32 bytes of canonical base64url', () => {
    expect(isBase64Url32(Buffer.alloc(32, 7).toString('base64url'))).toBe(true);
    expect(isBase64Url32(Buffer.alloc(31).toString('base64url'))).toBe(false);
    expect(isBase64Url32(`${Buffer.alloc(32).toString('base64url')}=`)).toBe(false);
    // Same length, non-zero trailing bits: not the canonical encoding of 32 bytes.
    expect(isBase64Url32('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB')).toBe(false);
  });

  it('compares unequal lengths as unequal', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abcd')).toBe(false);
  });
});

describe('TLS identity', () => {
  it('is a self-signed certificate of a fresh P-256 key, whose SPKI digest is published', () => {
    const identity = createTlsIdentity();
    const cert = new X509Certificate(identity.cert);
    expect(cert.subject).toBe('CN=oauth-broker');
    expect(cert.verify(cert.publicKey)).toBe(true);
    expect(cert.publicKey.asymmetricKeyDetails?.namedCurve).toBe('prime256v1');
    expect(cert.checkPrivateKey(createPrivateKey(identity.key))).toBe(true);
    const spki = cert.publicKey.export({ type: 'spki', format: 'der' });
    expect(identity.publicKeySha256).toBe(createHash('sha256').update(spki).digest('base64url'));
    expect(new Date(cert.validTo).getTime()).toBeGreaterThan(Date.now());
  });

  it('never repeats a key', () => {
    expect(createTlsIdentity().publicKeySha256).not.toBe(createTlsIdentity().publicKeySha256);
  });
});
