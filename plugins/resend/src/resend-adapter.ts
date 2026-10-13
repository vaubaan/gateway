/**
 * LEGACY v4 adapter — paste-token mode, one raw API key per binding.
 *
 * Kept so `apps/gateway/src/lib/gateway/build.ts` compiles until P1.6 rewrites
 * the execution door on `resendPlugin`. Nothing here is reached by the v5 gateway.
 *
 * @deprecated legacy v4, deleted in P1.6 — use `resendPlugin` from `./index.ts`.
 *
 * ResendAdapter — paste-token mode, all custom REST tools.
 *
 * Auth model : the user pastes a Resend API key (`re_*`). This is stored
 * encrypted in `provider_admins.access_token_encrypted` and decrypted by
 * the gateway build.ts before reaching the adapter.
 *
 * `mintUpstreamToken()` returns the raw stored secret (the API key string).
 * Binding validation calls `GET /domains` to verify the key is valid
 * and extract a display name from the first domain.
 *
 * Spec : docs/spec/resend.md §8.
 */

import type { McpToolDeclaration, ProviderAdmin, ProviderBinding } from '@vaubaan/shared';
import { availableTools } from './legacy-tools.ts';
import { executeCall, type FetchImpl } from './legacy-execute.ts';
import { classifyResendV4, type ClassifyResult } from './risk-classifier.ts';

export interface ResendAdapterConfig {
  /** Override fetch in tests. */
  fetchImpl?: FetchImpl;
}

export interface ValidateResult {
  ok: boolean;
  displayName?: string;
  error?: string;
}

/** @deprecated legacy v4, deleted in P1.6 — use `resendPlugin`. */
export class ResendAdapter {
  readonly provider = 'resend' as const;
  readonly availableTools: ReadonlyArray<McpToolDeclaration> = availableTools;
  private readonly fetchImpl: FetchImpl;

  constructor(config: ResendAdapterConfig = {}) {
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  authorizationUrl(_orgId: string, _returnUrl: string, _state: string): string {
    throw new Error(
      'ResendAdapter: OAuth flow not supported — use paste-token mode by inserting provider_admins directly.',
    );
  }

  async handleCallback(_orgId: string, _params: URLSearchParams) {
    throw new Error('ResendAdapter: OAuth callback not implemented.');
  }

  async mintUpstreamToken(admin: ProviderAdmin): Promise<{ token: string; expiresAt: Date }> {
    if (!admin.access_token_encrypted) {
      throw new Error('Resend ProviderAdmin has no access_token_encrypted.');
    }
    const token = new TextDecoder().decode(admin.access_token_encrypted);
    // Resend API keys do not expire — use a far-future date.
    return { token, expiresAt: new Date(Date.now() + 365 * 24 * 3600 * 1000) };
  }

  /**
   * Validate a binding by calling `GET /domains` with the stored API key.
   * The `resourceRef` is the operator-chosen slug. If the key is valid,
   * the response contains the list of domains — we use the first domain
   * name as the display name.
   */
  async validateBinding(admin: ProviderAdmin, resourceRef: string): Promise<ValidateResult> {
    try {
      const { token } = await this.mintUpstreamToken(admin);
      const res = await this.fetchImpl('https://api.resend.com/domains', {
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
          error: `Resend validation failed (${res.status}): ${text.slice(0, 300)}`,
        };
      }
      const data = JSON.parse(text) as { data?: Array<{ name?: string }> };
      const firstName = data.data?.[0]?.name;
      const displayName = firstName ?? resourceRef;
      return { ok: true, displayName };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return { ok: false, error: `Resend validation failed: ${message}` };
    }
  }

  async executeCall(
    admin: ProviderAdmin,
    binding: ProviderBinding,
    tool: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    const { token } = await this.mintUpstreamToken(admin);
    return executeCall(this.fetchImpl, token, tool, args, binding.metadata);
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
    return classifyResendV4(tool, args, bindings);
  }
}
