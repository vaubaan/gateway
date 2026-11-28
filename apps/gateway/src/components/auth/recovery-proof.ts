/**
 * The proof of holding the master key (ADR administrators-live-in-the-instance §9),
 * made in the browser with Web Crypto: `HKDF-SHA-256(key, salt "", info
 * "vaubaan/recovery-proof/v1")`, then `HMAC-SHA-256` of
 * `"vaubaan-recovery-v1\n" + origin + "\n" + challenge`, base64url. The gateway
 * computes the same (`server/crypto/recovery-proof.ts`, `recoveryProof`). Pure: no React.
 */
const INFO = 'vaubaan/recovery-proof/v1';
const PREFIX = 'vaubaan-recovery-v1';

/** The 32 bytes of a master key file (base64, standard or url-safe), or `null`. */
export function keyBytes(text: string): Uint8Array | null {
  const trimmed = text.trim().replace(/-/g, '+').replace(/_/g, '/');
  if (!/^[A-Za-z0-9+/]+=*$/.test(trimmed)) return null;
  const padded = trimmed + '='.repeat((4 - (trimmed.length % 4)) % 4);
  try {
    const raw = atob(padded);
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
    return bytes.length === 32 ? bytes : null;
  } catch {
    // expected: the pasted proof is not base64: it is no proof
    return null;
  }
}

function base64url(bytes: ArrayBuffer): string {
  let raw = '';
  for (const byte of new Uint8Array(bytes)) raw += String.fromCharCode(byte);
  return btoa(raw).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function proofOf(key: Uint8Array, origin: string, challenge: string): Promise<string> {
  const encoder = new TextEncoder();
  const base = await crypto.subtle.importKey('raw', key.buffer as ArrayBuffer, 'HKDF', false, [
    'deriveBits',
  ]);
  const derived = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: encoder.encode(INFO) },
    base,
    256,
  );
  const mac = await crypto.subtle.importKey(
    'raw',
    derived,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign(
    'HMAC',
    mac,
    encoder.encode(`${PREFIX}\n${origin}\n${challenge}`),
  );
  return base64url(signature);
}
