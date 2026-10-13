/**
 * LEGACY v4 adapter — paste-token mode, one raw API key per binding.
 *
 * Kept so `apps/gateway/src/lib/gateway/build.ts` compiles until P1.6
 * rewrites the execution door on `stripePlugin`. Nothing here is reached by
 * the v5 gateway.
 *
 * @deprecated legacy v4, deleted in P1.6 — use `stripePlugin` from `./index.ts`.
 */

import type { McpToolDeclaration, ProviderAdmin, ProviderBinding } from '@vaubaan/shared';
import { availableTools } from './tools.ts';
import { executeCall, type FetchImpl } from './execute.ts';
import { classifyStripeV4, type ClassifyResult } from './risk-classifier.ts';

export interface StripeAdapterConfig {
  /** Override fetch in tests. */
  fetchImpl?: FetchImpl;
}

export interface ValidateResult {
  ok: boolean;
  displayName?: string;
  error?: string;
}

/** @deprecated legacy v4, deleted in P1.6 — use `stripePlugin`. */
export class StripeAdapter {
  readonly provider = 'stripe' as const;
  readonly availableTools: ReadonlyArray<McpToolDeclaration> = availableTools;
  private readonly fetchImpl: FetchImpl;

  constructor(config: StripeAdapterConfig = {}) {
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  authorizationUrl(_orgId: string, _returnUrl: string, _state: string): string {
    throw new Error(
      'StripeAdapter: OAuth flow not supported — use paste-token mode by inserting provider_admins directly.',
    );
  }

  async handleCallback(_orgId: string, _params: URLSearchParams) {
    throw new Error('StripeAdapter: OAuth callback not implemented.');
  }

  async mintUpstreamToken(admin: ProviderAdmin): Promise<{ token: string; expiresAt: Date }> {
    if (!admin.access_token_encrypted) {
      throw new Error('Stripe ProviderAdmin has no access_token_encrypted.');
    }
    const token = new TextDecoder().decode(admin.access_token_encrypted);
    // Stripe API keys do not expire — use a far-future date.
    return { token, expiresAt: new Date(Date.now() + 365 * 24 * 3600 * 1000) };
  }

  /**
   * Validate a binding by calling `GET /v1/account` with the stored API key.
   * The `resourceRef` is the expected Stripe account id (`acct_*`). If the
   * key is valid, the response contains the `id` field matching the account.
   */
  async validateBinding(admin: ProviderAdmin, resourceRef: string): Promise<ValidateResult> {
    try {
      const { token } = await this.mintUpstreamToken(admin);
      const res = await this.fetchImpl('https://api.stripe.com/v1/account', {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
        },
      });
      const text = await res.text();
      if (!res.ok) {
        return {
          ok: false,
          error: `Stripe validation failed (${res.status}): ${text.slice(0, 300)}`,
        };
      }
      const data = JSON.parse(text) as { id?: string; business_profile?: { name?: string } };
      const displayName = data.business_profile?.name ?? data.id ?? resourceRef;
      return { ok: true, displayName };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return { ok: false, error: `Stripe validation failed: ${message}` };
    }
  }

  async executeCall(
    admin: ProviderAdmin,
    _binding: ProviderBinding,
    tool: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    const { token } = await this.mintUpstreamToken(admin);
    return executeCall(this.fetchImpl, token, tool, args);
  }

  /**
   * v4 classifier — emit the slice(s) the call touches. The provider plugin's
   * sole authorization responsibility.
   */
  classifyV4(
    tool: string,
    args: Record<string, unknown>,
    bindings: ReadonlyArray<ProviderBinding>,
  ): ClassifyResult {
    return classifyStripeV4(tool, args, bindings);
  }
}
