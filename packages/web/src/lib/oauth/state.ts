import { createHash, randomBytes } from 'node:crypto';

/**
 * OAuth state nonce — opaque, single-use, 5-min TTL.
 *
 * Format : `<orgIdB64>.<random>`. Caller stashes the full nonce in a
 * `vbn_oauth_state` cookie ; callback compares strict-equality.
 *
 * Spec : docs/spec/vaubaan-gateway.md §11 (anti-replay).
 */
export function generateState(orgId: string): string {
  const noise = randomBytes(24).toString('base64url');
  const tag = Buffer.from(orgId, 'utf8').toString('base64url');
  return `${tag}.${noise}`;
}

export function decodeStateOrgId(state: string): string | null {
  const i = state.indexOf('.');
  if (i < 0) return null;
  try {
    return Buffer.from(state.slice(0, i), 'base64url').toString('utf8');
  } catch {
    return null;
  }
}

export interface Pkce {
  verifier: string;
  challenge: string;
}

/**
 * PKCE (RFC 7636, S256). Used by the Railway OAuth flow : the `verifier` is
 * stashed in a single-use cookie, the `challenge` goes on the authorize URL.
 */
export function generatePkce(): Pkce {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}
