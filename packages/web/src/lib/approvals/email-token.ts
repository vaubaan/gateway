/**
 * Email approval token — HMAC-signed compact token used in the approve links
 * emailed to the operator.
 *
 * Spec : docs/spec/gateway-risk-model.md §7.1, §10.
 *
 * We don't pull in a JWT library — the token is a small JSON payload
 * (`approvalId`, `decision`, `exp`) encoded as base64url + a SHA-256 HMAC
 * over the payload. Format :
 *
 *   <base64url(payload-json)>.<base64url(hmac-sha256-sig)>
 *
 * Web Crypto (`globalThis.crypto.subtle`) is available in both Node 18+
 * runtimes and Vercel Edge. The signing secret comes from
 * `EMAIL_SIGNING_SECRET` env var (rotated periodically — old tokens stop
 * verifying immediately, which is the desired behaviour for security).
 */

export interface EmailApprovalToken {
  /** approval_requests.id this token is signed for. */
  approvalId: string;
  /** Which decision the click maps to. The link is distinct per decision so
   *  the operator sees explicit "Approve" / "Deny" buttons in the email. */
  decision: 'approve' | 'deny';
  /** Unix seconds. The token is rejected past `exp`. Typically set to the
   *  approval's `expires_at`. */
  exp: number;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

function b64urlEncode(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(s: string): Uint8Array {
  const pad = s.length % 4;
  const padded = (s + (pad ? '='.repeat(4 - pad) : '')).replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function importKey(secret: string): Promise<CryptoKey> {
  return globalThis.crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

/** Sign an approval token. Returns the compact form `<payload>.<sig>`. */
export async function signEmailToken(payload: EmailApprovalToken, secret: string): Promise<string> {
  const json = JSON.stringify(payload);
  const payloadB64 = b64urlEncode(enc.encode(json));
  const key = await importKey(secret);
  const sig = await globalThis.crypto.subtle.sign('HMAC', key, enc.encode(payloadB64));
  return `${payloadB64}.${b64urlEncode(new Uint8Array(sig))}`;
}

export class EmailTokenError extends Error {
  constructor(public readonly code: 'malformed' | 'bad-signature' | 'expired') {
    super(code);
    this.name = 'EmailTokenError';
  }
}

/** Verify and decode an approval token. Throws `EmailTokenError` on any
 *  failure (malformed shape, bad signature, expired). */
export async function verifyEmailToken(token: string, secret: string): Promise<EmailApprovalToken> {
  const parts = token.split('.');
  if (parts.length !== 2) {
    throw new EmailTokenError('malformed');
  }
  const [payloadB64, sigB64] = parts as [string, string];
  let payload: EmailApprovalToken;
  try {
    const json = dec.decode(b64urlDecode(payloadB64));
    payload = JSON.parse(json) as EmailApprovalToken;
  } catch {
    throw new EmailTokenError('malformed');
  }
  if (
    typeof payload.approvalId !== 'string' ||
    (payload.decision !== 'approve' && payload.decision !== 'deny') ||
    typeof payload.exp !== 'number'
  ) {
    throw new EmailTokenError('malformed');
  }
  const key = await importKey(secret);
  const sigBytes = b64urlDecode(sigB64);
  // Copy into a fresh ArrayBuffer so the type checker doesn't see a
  // potential SharedArrayBuffer-backed view (Web Crypto rejects those).
  const sig = new Uint8Array(sigBytes).buffer;
  const ok = await globalThis.crypto.subtle.verify('HMAC', key, sig, enc.encode(payloadB64));
  if (!ok) throw new EmailTokenError('bad-signature');
  if (Date.now() / 1000 > payload.exp) throw new EmailTokenError('expired');
  return payload;
}
