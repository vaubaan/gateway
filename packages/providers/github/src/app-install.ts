/**
 * GitHub App JIT installation-token minting.
 *
 * Spec  : docs/spec/mcp-proxy.md §4.5, §9.1.
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

import { SignJWT, importPKCS8 } from 'jose';

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
  /** Override for testing — replaces global fetch. */
  fetchImpl?: typeof fetch;
}

export async function buildAppJwt(creds: AppCredentials, now: Date = new Date()): Promise<string> {
  const key = await importPKCS8(creds.privateKeyPem, 'RS256');
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
): Promise<InstallationToken> {
  const jwt = await buildAppJwt(input);
  const fetchFn = input.fetchImpl ?? fetch;
  const res = await fetchFn(
    `https://api.github.com/app/installations/${encodeURIComponent(input.installationId)}/access_tokens`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'vauban-mcp-proxy',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    },
  );
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GitHub App token mint failed (${res.status}): ${body.slice(0, 200)}`);
  }
  const data = (await res.json()) as { token: string; expires_at: string };
  return { token: data.token, expiresAt: new Date(data.expires_at) };
}
