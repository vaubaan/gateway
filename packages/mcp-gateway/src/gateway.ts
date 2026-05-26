/**
 * MCP Gateway core.
 *
 * Spec : docs/spec/mcp-proxy.md §6.2, §7.
 *
 *   auth → load context (cached) → parse RPC → route by method →
 *   evaluate policy → mint upstream token → execute → audit → respond.
 *
 * The gateway is framework-agnostic: it takes a parsed JSON-RPC payload and
 * returns a JSON-RPC response. Next.js handlers wrap this.
 */

import {
  evaluatePolicy,
  filterAvailableTools,
  injectionPlanFor,
  mergeInjectedArgs,
  stripInjectedArgs,
} from '@vaubaan/policy-engine';
import type {
  AccessTokenContext,
  JsonRpcRequest,
  JsonRpcResponse,
  McpToolDeclaration,
  Provider,
  ProviderAdmin,
  ProviderBinding,
} from '@vaubaan/shared';
import { parseApiKey, verifyApiKey } from '@vaubaan/shared';
import type { CacheClient } from './cache.ts';
import { hashArguments, type AuditWriter } from './audit.ts';
import { AuthError, rpcError, rpcSuccess } from './errors.ts';

export interface ContextLoader {
  /** Load minimal access-token row for auth verification. Returns null if not found / revoked. */
  loadAccessTokenForAuth(
    apiKeyPrefix: string,
  ): Promise<{ id: string; api_key_hash: string; status: string } | null>;
  /** Load the full context for an authenticated access token. */
  loadAccessTokenContext(accessTokenId: string): Promise<AccessTokenContext | null>;
  /** Touch last_used_at — best-effort. */
  touchLastUsed?(accessTokenId: string): Promise<void>;
}

export interface UpstreamAdapter {
  provider: Provider;
  availableTools: ReadonlyArray<McpToolDeclaration>;
  executeCall(
    admin: ProviderAdmin,
    binding: ProviderBinding,
    tool: string,
    args: Record<string, unknown>,
  ): Promise<unknown>;
  /** Full ProviderAdmin row (with tokens) — fetched by the caller, not cached. */
  loadProviderAdmin(orgId: string, provider: Provider): Promise<ProviderAdmin | null>;
}

export interface GatewayConfig {
  cache: CacheClient;
  audit: AuditWriter;
  contextLoader: ContextLoader;
  upstreamByProvider: Record<Provider, UpstreamAdapter>;
  /** TTL for the access-token context cache. Default 60s. */
  contextTtlSeconds?: number;
  /** Optional request metadata captured into audit_log. */
  clientIp?: string | null;
  clientUserAgent?: string | null;
}

export class McpGateway {
  private readonly cfg: GatewayConfig;

  constructor(cfg: GatewayConfig) {
    this.cfg = cfg;
  }

  /** Authenticate the request via Bearer api_key header. */
  async authenticate(authHeader: string | null | undefined): Promise<AccessTokenContext> {
    if (!authHeader || !authHeader.toLowerCase().startsWith('bearer ')) {
      throw new AuthError(
        'missing or malformed Authorization header (expected `Bearer vbn_live_...`).',
      );
    }
    const raw = authHeader.slice('bearer '.length).trim();
    const parsed = parseApiKey(raw);
    if (!parsed) throw new AuthError('api_key format invalid.');

    const cacheKey = `vaubaan:ctx:${parsed.prefix}`;
    const cached = await this.cfg.cache.get<AccessTokenContext>(cacheKey);
    if (cached && cached.access_token.status === 'active') {
      // Re-verify hash on cache hit — defensive against cache poisoning.
      const tk = await this.cfg.contextLoader.loadAccessTokenForAuth(parsed.prefix);
      if (!tk || tk.status !== 'active') throw new AuthError('access token not found or revoked.');
      if (!(await verifyApiKey(tk.api_key_hash, raw))) throw new AuthError('api_key mismatch.');
      return cached;
    }

    const tk = await this.cfg.contextLoader.loadAccessTokenForAuth(parsed.prefix);
    if (!tk) throw new AuthError('unknown api_key.');
    if (tk.status !== 'active') throw new AuthError('access token is revoked.');
    if (!(await verifyApiKey(tk.api_key_hash, raw))) throw new AuthError('api_key mismatch.');

    const ctx = await this.cfg.contextLoader.loadAccessTokenContext(tk.id);
    if (!ctx) throw new AuthError('access-token context could not be loaded.');

    await this.cfg.cache.set(cacheKey, ctx, this.cfg.contextTtlSeconds ?? 60);
    if (this.cfg.contextLoader.touchLastUsed) {
      Promise.resolve(this.cfg.contextLoader.touchLastUsed(tk.id)).catch((e: unknown) => {
        console.error('[gateway] touchLastUsed failed', e);
      });
    }
    return ctx;
  }

  /** Handle a parsed JSON-RPC request. Routes by method. */
  async handle(ctx: AccessTokenContext, req: JsonRpcRequest): Promise<JsonRpcResponse> {
    const id = req.id ?? null;
    try {
      switch (req.method) {
        case 'initialize':
          return rpcSuccess(id, {
            protocolVersion: '2024-11-05',
            capabilities: { tools: {} },
            serverInfo: { name: 'vaubaan-mcp-proxy', version: '0.1.0' },
          });
        case 'tools/list':
          return rpcSuccess(id, { tools: this.listTools(ctx) });
        case 'tools/call':
          return await this.callTool(ctx, id, req.params ?? {});
        case 'ping':
          return rpcSuccess(id, {});
        default:
          return rpcError(id, -32601, `method '${req.method}' not supported by the MCP gateway.`);
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return rpcError(id, -32603, `internal error: ${message}`);
    }
  }

  private listTools(ctx: AccessTokenContext): McpToolDeclaration[] {
    const out: McpToolDeclaration[] = [];
    for (const provider of ['github', 'vercel', 'supabase'] as Provider[]) {
      const adapter = this.cfg.upstreamByProvider[provider];
      if (!adapter) continue;
      const providerRoles = ctx.roles.filter((r) => r.provider === provider);
      if (providerRoles.length === 0) continue;
      const filtered = filterAvailableTools(providerRoles, adapter.availableTools);
      const adminEntry = ctx.provider_admins.find((p) => p.provider === provider);
      const plan = injectionPlanFor(provider, {
        bindings: ctx.bindings,
        vercelTeamId: adminEntry?.team_id ?? null,
      });
      if (plan) {
        for (const tool of filtered) out.push(stripInjectedArgs(tool, plan));
      } else {
        out.push(...filtered);
      }
    }
    return out;
  }

  private async callTool(
    ctx: AccessTokenContext,
    id: string | number | null,
    params: Record<string, unknown>,
  ): Promise<JsonRpcResponse> {
    const toolName = typeof params.name === 'string' ? params.name : '';
    if (!toolName) return rpcError(id, -32602, 'tools/call requires params.name');
    const rawArgs = (params.arguments as Record<string, unknown> | undefined) ?? {};

    // Determine provider from tool prefix.
    const provider = this.providerFor(toolName);
    if (!provider) {
      const reason = `tool '${toolName}' does not match any supported provider (github__/vercel__/supabase__).`;
      await this.audit(ctx, toolName, rawArgs, 'denied', null, reason, null);
      return rpcError(id, -32603, `Vaubaan policy denied: ${reason}`);
    }

    const adapter = this.cfg.upstreamByProvider[provider];
    if (!adapter) {
      const reason = `provider '${provider}' is not enabled on this gateway.`;
      await this.audit(ctx, toolName, rawArgs, 'denied', null, reason, null);
      return rpcError(id, -32603, `Vaubaan policy denied: ${reason}`);
    }

    // Provider must be connected.
    const adminEntry = ctx.provider_admins.find((p) => p.provider === provider);
    if (!adminEntry || adminEntry.status !== 'connected') {
      const reason = `provider '${provider}' is not connected for organization '${ctx.organization.slug}'.`;
      await this.audit(ctx, toolName, rawArgs, 'denied', null, reason, null);
      return rpcError(id, -32603, `Vaubaan policy denied: ${reason}`);
    }

    // Server-side scope injection : if this token's project has a single
    // binding for the provider, the resource identifier is determined and
    // we auto-fill it. Caller-provided values win (admin can still override).
    const plan = injectionPlanFor(provider, {
      bindings: ctx.bindings,
      vercelTeamId: adminEntry.team_id ?? null,
    });
    const args = plan ? mergeInjectedArgs(rawArgs, plan) : rawArgs;

    // Evaluate policy with the injected args so target resolution + constraints
    // see the same values the upstream will receive.
    const decision = evaluatePolicy(ctx.roles, ctx.bindings, {
      provider,
      tool: toolName,
      arguments: args,
    });

    if (decision.decision === 'denied') {
      await this.audit(ctx, toolName, args, 'denied', null, decision.reason, null);
      return rpcError(id, -32603, `Vaubaan policy denied: ${decision.reason}`);
    }

    // Load full ProviderAdmin (with tokens — never cached in clear).
    const admin = await adapter.loadProviderAdmin(ctx.organization.id, provider);
    if (!admin) {
      const reason = `provider_admin for '${provider}' could not be loaded — re-connect required.`;
      await this.audit(ctx, toolName, args, 'denied', null, reason, null);
      return rpcError(id, -32603, `Vaubaan policy denied: ${reason}`);
    }

    // Pick binding for the project (if any).
    const binding = ctx.bindings.find((b) => b.provider === provider);
    if (!binding && provider !== 'github') {
      // For github we technically only need the resource to be in bindings via
      // the policy check; but for safety we still pull the binding for execute.
    }

    const t0 = Date.now();
    try {
      const result = await adapter.executeCall(
        admin,
        binding ?? {
          id: '',
          project_id: ctx.project.id,
          provider,
          resource_ref: '',
          display_name: null,
          created_at: '',
        },
        toolName,
        args,
      );
      const latency = Date.now() - t0;
      await this.audit(ctx, toolName, args, 'allowed', decision.roleMatched, null, latency);
      return rpcSuccess(id, this.shapeMcpResult(result));
    } catch (e) {
      const latency = Date.now() - t0;
      const message = e instanceof Error ? e.message : String(e);
      await this.audit(ctx, toolName, args, 'allowed', decision.roleMatched, null, latency);
      return rpcError(id, -32603, `Upstream call failed: ${message}`);
    }
  }

  private providerFor(tool: string): Provider | null {
    if (tool.startsWith('github__')) return 'github';
    if (tool.startsWith('vercel__')) return 'vercel';
    if (tool.startsWith('supabase__')) return 'supabase';
    return null;
  }

  /** Shape an arbitrary upstream result into the MCP content format. */
  private shapeMcpResult(result: unknown): unknown {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result, null, 2),
        },
      ],
      isError: false,
    };
  }

  private async audit(
    ctx: AccessTokenContext,
    tool: string,
    args: Record<string, unknown>,
    decision: 'allowed' | 'denied',
    roleMatched: string | null,
    denialReason: string | null,
    latency: number | null,
  ): Promise<void> {
    try {
      await this.cfg.audit.write({
        organization_id: ctx.organization.id,
        project_id: ctx.project.id,
        access_token_id: ctx.access_token.id,
        tool_name: tool,
        arguments_hash: hashArguments(args),
        role_matched: roleMatched,
        decision,
        denial_reason: denialReason,
        upstream_latency_ms: latency,
        client_ip: this.cfg.clientIp ?? null,
        client_user_agent: this.cfg.clientUserAgent ?? null,
      });
    } catch (e) {
      console.error('[gateway] audit write failed', e);
    }
  }
}
