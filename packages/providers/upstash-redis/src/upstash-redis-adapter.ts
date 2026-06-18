/**
 * UpstashRedisAdapter — paste-token mode, all custom REST tools.
 *
 * Auth model : the user pastes their Upstash email + Management API key,
 * concatenated as `email:api_key`. This is stored encrypted in
 * `provider_admins.access_token_encrypted`.
 *
 * For Management API calls: decode the stored secret, split on first `:`,
 * use Basic Auth header.
 * For Data API calls: call `GET /v2/redis/database/{id}` to get the
 * per-database `rest_token`, then use it as Bearer token.
 *
 * `mintUpstreamToken()` returns the raw stored secret (the `email:api_key`
 * string). Binding validation calls `GET /v2/redis/database/{id}` to
 * verify the database exists.
 */

import type { McpToolDeclaration, ProviderAdmin, ProviderBinding } from '@vaubaan/shared';
import { availableTools } from './tools.ts';
import { executeCall, type FetchImpl } from './execute.ts';
import { classifyUpstashRedisV4, type ClassifyResult } from './risk-classifier.ts';

export interface UpstashRedisAdapterConfig {
  /** Override fetch in tests. */
  fetchImpl?: FetchImpl;
}

export interface ValidateResult {
  ok: boolean;
  displayName?: string;
  error?: string;
}

export class UpstashRedisAdapter {
  readonly provider = 'upstash-redis' as const;
  readonly availableTools: ReadonlyArray<McpToolDeclaration> = availableTools;
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
      const { token: credentials } = await this.mintUpstreamToken(admin);
      const data = (await executeCall(
        this.fetchImpl,
        credentials,
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
    const { token: credentials } = await this.mintUpstreamToken(admin);
    return executeCall(this.fetchImpl, credentials, binding.resource_ref, tool, args);
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
    return classifyUpstashRedisV4(tool, args, bindings);
  }
}
