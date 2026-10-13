/**
 * GitHub App installation-token minting.
 *
 * Spec : docs/spec/vaubaan-gateway.md §2.4 (the executor never sees a
 *        provider credential), §7.2 (connect a provider).
 * ADR  : docs/decisions/plugin-contract-and-credential-spec.md D2
 *        (`app-install` kind : the host stores the installation id, the
 *        plugin mints short-lived tokens from the company's app key).
 *
 * Two phases :
 *   1. Build a short-lived JWT signed with the App's private key (RS256,
 *      9 minutes — GitHub caps at 10).
 *   2. Exchange the JWT for an installation token (1h lifetime) via
 *      `POST /app/installations/{installation_id}/access_tokens`, optionally
 *      scoped down to a repository list and a permission subset.
 *
 * The app id and private key come from the company's app configuration
 * (`ctx.appConfig`), never from `process.env`. `fetchImpl` is the injected
 * fetch of the context ; tests pass `mockFetch`.
 */

import { UpstreamAuthError } from '@vaubaan/plugin-sdk';
import { SignJWT } from 'jose';
import { createPrivateKey } from 'node:crypto';

export const GITHUB_API_BASE = 'https://api.github.com';

/** Headers every call to the GitHub REST API carries. */
export const GITHUB_API_HEADERS = {
  Accept: 'application/vnd.github+json',
  'User-Agent': 'vaubaan-gateway',
  'X-GitHub-Api-Version': '2022-11-28',
} as const;

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
   * Optional repository names (WITHOUT owner — the owner is implicit from the
   * installation). When set, the minted token is scoped to these repos only.
   * Omit for an installation-wide token.
   */
  repositories?: string[];
  /**
   * Optional permission subset (e.g. `{ contents: 'read' }`). When set, the
   * minted token is scoped DOWN to these permissions (never beyond what the
   * App was granted at install). Omit for the App's full granted permissions.
   */
  permissions?: Record<string, string>;
  /** The injected fetch (`ctx.fetch`). Defaults to the global fetch when a caller passes none. */
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

/** Subset of the GitHub access_tokens response surfaced by `mint_install_token`. */
export interface ScopedInstallationToken extends InstallationToken {
  repositories: Array<{ id: number; name: string; full_name: string }>;
  permissions: Record<string, string>;
}

/** RS256 App JWT : `iss` = app id, 30 s clock-skew tolerance, 9 min lifetime. */
export async function buildAppJwt(creds: AppCredentials, now: Date = new Date()): Promise<string> {
  // createPrivateKey accepts both PKCS#1 (GitHub default download) and PKCS#8.
  const key = createPrivateKey(creds.privateKeyPem);
  const iat = Math.floor(now.getTime() / 1000) - 30;
  const exp = iat + 9 * 60;
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
    `${GITHUB_API_BASE}/app/installations/${encodeURIComponent(input.installationId)}/access_tokens`,
    {
      method: 'POST',
      headers: {
        ...GITHUB_API_HEADERS,
        Authorization: `Bearer ${jwt}`,
        ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(hasBody ? { body: JSON.stringify(body) } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
    },
  );
  if (!res.ok) {
    const errBody = await res.text();
    const msg = `GitHub App token mint failed (${res.status}): ${errBody.slice(0, 200)}`;
    if (res.status === 401 || res.status === 403) throw new UpstreamAuthError(msg, res.status);
    throw new Error(msg);
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
