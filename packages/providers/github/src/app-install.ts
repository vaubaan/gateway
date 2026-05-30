/**
 * GitHub App JIT installation-token minting.
 *
 * Spec  : docs/spec/vaubaan-gateway.md §4.5, §9.1.
 * ADRs  : docs/decisions/oauth-app-install-per-provider.md,
 *         docs/decisions/trust-model-clear-at-rest-idp-style.md.
 *
 * Two phases :
 *   1. Build a short-lived JWT signed with the App's private key (RS256, 10min iat→exp).
 *   2. Exchange the JWT for an installation_token (1h lifetime) via:
 *        POST /app/installations/{installation_id}/access_tokens
 *
 * The private key is read from `GITHUB_APP_PRIVATE_KEY` (PEM) at runtime —
 * never stored in DB. The `installation_id` is per-org and stored in
 * `provider_admins.installation_id`.
 */

import { SignJWT } from 'jose';
import { createPrivateKey } from 'node:crypto';

export interface AppCredentials {
  appId: string;
  privateKeyPem: string;
}

export interface InstallationToken {
  token: string;
  expiresAt: Date;
}

export interface MintInstallationTokenInput extends AppCredentials {
  installationId: string;
  /**
   * Optional repository names (WITHOUT owner — owner is implicit from the
   * installation). When set, the minted token is scoped to these repos only.
   * Omit for an installation-wide token.
   */
  repositories?: string[];
  /**
   * Optional permissions sub-set (e.g. `{ contents: 'read' }`). When set, the
   * minted token is scoped DOWN to these permissions (cannot exceed what the
   * App was granted at install). Omit for the App's full granted permissions.
   */
  permissions?: Record<string, string>;
  /** Override for testing — replaces global fetch. */
  fetchImpl?: typeof fetch;
}

/** Subset of the GitHub access_tokens response surfaced by mint_install_token. */
export interface ScopedInstallationToken extends InstallationToken {
  repositories: Array<{ id: number; name: string; full_name: string }>;
  permissions: Record<string, string>;
}

export async function buildAppJwt(creds: AppCredentials, now: Date = new Date()): Promise<string> {
  // createPrivateKey accepts both PKCS#1 (GitHub default download) and PKCS#8.
  const key = createPrivateKey(creds.privateKeyPem);
  const iat = Math.floor(now.getTime() / 1000) - 30; // 30s clock-skew tolerance
  const exp = iat + 9 * 60; // 9 minutes — GitHub max is 10
  return new SignJWT({})
    .setProtectedHeader({ alg: 'RS256' })
    .setIssuer(creds.appId)
    .setIssuedAt(iat)
    .setExpirationTime(exp)
    .sign(key);
}

export async function mintInstallationToken(
  input: MintInstallationTokenInput,
): Promise<ScopedInstallationToken> {
  const jwt = await buildAppJwt(input);
  const fetchFn = input.fetchImpl ?? fetch;
  const body: Record<string, unknown> = {};
  if (input.repositories && input.repositories.length > 0) body.repositories = input.repositories;
  if (input.permissions && Object.keys(input.permissions).length > 0) {
    body.permissions = input.permissions;
  }
  const hasBody = Object.keys(body).length > 0;
  const res = await fetchFn(
    `https://api.github.com/app/installations/${encodeURIComponent(input.installationId)}/access_tokens`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'vaubaan-gateway',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(hasBody ? { body: JSON.stringify(body) } : {}),
    },
  );
  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`GitHub App token mint failed (${res.status}): ${errBody.slice(0, 200)}`);
  }
  const data = (await res.json()) as {
    token: string;
    expires_at: string;
    repositories?: Array<{ id: number; name: string; full_name: string }>;
    permissions?: Record<string, string>;
  };
  return {
    token: data.token,
    expiresAt: new Date(data.expires_at),
    repositories: data.repositories ?? [],
    permissions: data.permissions ?? {},
  };
}
