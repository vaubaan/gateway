/**
 * Infisical wrapper for E2E. Spec §12.3.
 *
 * Used only by the sweeper today : if an E2E run creates secrets in
 * an Infisical workspace and crashes before cleanup, the sweeper
 * deletes any secret whose key starts with `vauban-e2e-`.
 *
 * Auth flow: email/password login → JWT. We use the JWT for
 * subsequent calls. This is OK for nightly E2E (operator account
 * dedicated to test); production code uses M2M client creds.
 */

import { E2E_RESOURCE_PREFIX } from '../naming';

export interface InfisicalWorkspace {
  readonly id: string;
  readonly name: string;
  readonly slug?: string;
}

interface LoginResponse {
  readonly token?: string;
  readonly accessToken?: string;
  readonly mfaEnabled?: boolean;
}

export class InfisicalClient {
  private jwt: string | null = null;

  constructor(
    private readonly baseUrl: string,
    private readonly login: string,
    private readonly pwd: string,
  ) {}

  private async ensureAuth(): Promise<string> {
    if (this.jwt !== null) return this.jwt;
    const url = `https://${this.baseUrl.replace(/^https?:\/\//, '')}/api/v1/auth/login`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: this.login, password: this.pwd }),
    });
    if (res.status !== 200) {
      throw new Error(`Infisical login failed: ${res.status}`);
    }
    const body = (await res.json()) as LoginResponse;
    const tok = body.token ?? body.accessToken;
    if (tok === undefined) {
      throw new Error('Infisical login returned no token');
    }
    this.jwt = tok;
    return tok;
  }

  async ping(): Promise<void> {
    await this.ensureAuth();
  }

  /**
   * Best-effort sweeper hook : Infisical's data model varies by tier.
   * v1 only verifies auth — actual orphan cleanup of test secrets is
   * a TODO once a concrete scenario writes Infisical secrets (none
   * does in Phase 8 — Infisical is only registered as a SecretManager
   * config row, no actual secret pushes happen yet).
   */
  // eslint-disable-next-line @typescript-eslint/require-await -- placeholder until Phase 9+ writes test secrets.
  async listE2ESecrets(): Promise<readonly { workspaceId: string; key: string }[]> {
    return [];
  }

  static readonly prefix = E2E_RESOURCE_PREFIX;
}
