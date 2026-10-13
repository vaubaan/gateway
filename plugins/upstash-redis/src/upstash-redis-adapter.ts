/**
 * @deprecated legacy v4, deleted in P1.6.
 *
 * `UpstashRedisAdapter` — the v4 `UpstreamAdapter` duck type the gateway
 * pipeline (`apps/gateway/src/lib/gateway/build.ts`) still instantiates. It
 * is a thin shell over the v5 modules : the one classifier (`classify.ts`)
 * and the one upstream caller (`execute.ts`). The v4 stored secret is the
 * `email:api_key` concatenation ; `parseLegacyCredentials` splits it.
 */

import type { McpToolDeclaration, ProviderAdmin, ProviderBinding } from '@vaubaan/shared';

import { parseLegacyCredentials } from './credential.ts';
import { callUpstashTool, type FetchImpl } from './execute.ts';
import { classifyUpstashRedisV4, type ClassifyResult } from './risk-classifier.ts';
import { upstashRedisTools } from './tools.ts';

/** @deprecated legacy v4, deleted in P1.6. */
export interface UpstashRedisAdapterConfig {
  /** Override fetch in tests. */
  fetchImpl?: FetchImpl;
}

/** @deprecated legacy v4, deleted in P1.6. */
export interface ValidateResult {
  ok: boolean;
  displayName?: string;
  error?: string;
}

/** @deprecated legacy v4, deleted in P1.6 — use `upstashRedisPlugin`. */
export class UpstashRedisAdapter {
  readonly provider = 'upstash-redis' as const;
  readonly availableTools: ReadonlyArray<McpToolDeclaration> = upstashRedisTools;
  private readonly fetchImpl: FetchImpl;

  constructor(config: UpstashRedisAdapterConfig = {}) {
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  authorizationUrl(_orgId: string, _returnUrl: string, _state: string): string {
    throw new Error(
      'UpstashRedisAdapter: OAuth flow not supported — use paste-token mode by inserting provider_admins directly.',
    );
  }

  async handleCallback(_orgId: string, _params: URLSearchParams) {
    throw new Error('UpstashRedisAdapter: OAuth callback not implemented.');
  }

  async mintUpstreamToken(admin: ProviderAdmin): Promise<{ token: string; expiresAt: Date }> {
    if (!admin.access_token_encrypted) {
      throw new Error('Upstash Redis ProviderAdmin has no access_token_encrypted.');
    }
    const token = new TextDecoder().decode(admin.access_token_encrypted);
    return { token, expiresAt: new Date(Date.now() + 365 * 24 * 3600 * 1000) };
  }

  async validateBinding(admin: ProviderAdmin, resourceRef: string): Promise<ValidateResult> {
    try {
      const { token } = await this.mintUpstreamToken(admin);
      const data = (await callUpstashTool(
        { fetch: this.fetchImpl, auth: parseLegacyCredentials(token) },
        null,
        'upstash_redis__get_database',
        { databaseId: resourceRef },
      )) as { database_name?: string; database_id?: string };
      const displayName = data.database_name ?? resourceRef;
      return { ok: true, displayName };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return { ok: false, error: `Upstash Redis validation failed: ${message}` };
    }
  }

  async executeCall(
    admin: ProviderAdmin,
    binding: ProviderBinding,
    tool: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    const { token } = await this.mintUpstreamToken(admin);
    return callUpstashTool(
      { fetch: this.fetchImpl, auth: parseLegacyCredentials(token) },
      binding.resource_ref,
      tool,
      args,
    );
  }

  classifyV4(
    tool: string,
    args: Record<string, unknown>,
    bindings: ReadonlyArray<ProviderBinding>,
  ): ClassifyResult {
    return classifyUpstashRedisV4(tool, args, bindings);
  }
}
