/**
 * LEGACY v4 adapter — paste-token mode, one raw secret per `provider_admins` row.
 *
 * Kept so `apps/gateway/src/lib/gateway/build.ts` compiles until P1.6
 * rewrites the execution door on `cloudflareDnsPlugin`. Nothing here is
 * reached by the v5 gateway.
 *
 * @deprecated legacy v4, deleted in P1.6 — use `cloudflareDnsPlugin` from `./index.ts`.
 *
 * Auth model : the user pastes a Cloudflare API Token (or Global API Key
 * in `email|key` format). This is stored encrypted in
 * `provider_admins.access_token_encrypted` and decrypted by the gateway
 * build.ts before reaching the adapter.
 *
 * `mintUpstreamToken()` returns the raw stored secret.
 * Binding validation calls `GET /zones?account.id=<resource_ref>` to
 * verify the token works and extract a display name from the first zone.
 */

import type { McpToolDeclaration, ProviderAdmin, ProviderBinding } from '@vaubaan/shared';
import { availableTools } from './tools.ts';
import { executeCall, type FetchImpl } from './execute.ts';
import { classifyCloudflareDnsV4, type ClassifyResult } from './risk-classifier.ts';

export interface CloudflareDnsAdapterConfig {
  fetchImpl?: FetchImpl;
}

export interface ValidateResult {
  ok: boolean;
  displayName?: string;
  error?: string;
}

/** @deprecated legacy v4, deleted in P1.6 — use `cloudflareDnsPlugin`. */
export class CloudflareDnsAdapter {
  readonly provider = 'cloudflare-dns' as const;
  readonly availableTools: ReadonlyArray<McpToolDeclaration> = availableTools;
  private readonly fetchImpl: FetchImpl;

  constructor(config: CloudflareDnsAdapterConfig = {}) {
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  authorizationUrl(_orgId: string, _returnUrl: string, _state: string): string {
    throw new Error(
      'CloudflareDnsAdapter: OAuth flow not supported — use paste-token mode by inserting provider_admins directly.',
    );
  }

  async handleCallback(_orgId: string, _params: URLSearchParams) {
    throw new Error('CloudflareDnsAdapter: OAuth callback not implemented.');
  }

  async mintUpstreamToken(admin: ProviderAdmin): Promise<{ token: string; expiresAt: Date }> {
    if (!admin.access_token_encrypted) {
      throw new Error('Cloudflare DNS ProviderAdmin has no access_token_encrypted.');
    }
    const token = new TextDecoder().decode(admin.access_token_encrypted);
    return { token, expiresAt: new Date(Date.now() + 365 * 24 * 3600 * 1000) };
  }

  /**
   * Validate a binding by calling `GET /zones?account.id=<resourceRef>`.
   * The `resourceRef` is the Cloudflare account_id. If the token is valid,
   * the response contains zones -- we use the first zone name as display name.
   */
  async validateBinding(admin: ProviderAdmin, resourceRef: string): Promise<ValidateResult> {
    try {
      const { token } = await this.mintUpstreamToken(admin);
      const headers: Record<string, string> = { Accept: 'application/json' };
      if (token.includes('|')) {
        const [email, key] = token.split('|', 2);
        headers['X-Auth-Email'] = email!;
        headers['X-Auth-Key'] = key!;
      } else {
        headers['Authorization'] = `Bearer ${token}`;
      }
      const res = await this.fetchImpl(
        `https://api.cloudflare.com/client/v4/zones?account.id=${encodeURIComponent(resourceRef)}`,
        { method: 'GET', headers },
      );
      const text = await res.text();
      if (!res.ok) {
        return {
          ok: false,
          error: `Cloudflare validation failed (${res.status}): ${text.slice(0, 300)}`,
        };
      }
      const data = JSON.parse(text) as { result?: Array<{ name?: string }> };
      const firstName = data.result?.[0]?.name;
      const displayName = firstName ?? resourceRef;
      return { ok: true, displayName };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return { ok: false, error: `Cloudflare validation failed: ${message}` };
    }
  }

  async executeCall(
    admin: ProviderAdmin,
    binding: ProviderBinding,
    tool: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    const { token } = await this.mintUpstreamToken(admin);
    const accountId = binding.resource_ref;
    return executeCall(this.fetchImpl, token, tool, args, accountId);
  }

  classifyV4(
    tool: string,
    args: Record<string, unknown>,
    bindings: ReadonlyArray<ProviderBinding>,
  ): ClassifyResult {
    return classifyCloudflareDnsV4(tool, args, bindings);
  }
}
