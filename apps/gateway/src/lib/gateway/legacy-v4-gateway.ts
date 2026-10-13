/**
 * LEGACY v4 orchestrator — kept only so the v4 application code compiles
 * until feature P1.6 replaces `/mcp` with the v5 door. Not part of the v5
 * surface; `@vaubaan/gateway-core` now exposes the v5 pipeline skeleton
 * (`CallPipeline`, `DoorAuthenticator`) instead of this class. Deleted with
 * the rest of the v4 app code. Moved here from
 * `packages/gateway-core/src/gateway.ts` by feature P0.5; venv tools removed
 * (no v5 counterpart, plan §8-Q5).
 *
 * Spec : docs/spec/legacy/vaubaan-gateway.legacy.md, gateway-risk-model.md §8.
 *
 *   auth → load context (cached) → parse RPC → route by method →
 *   classify slice(s) → intersect with risk catalog → allow/deny →
 *   mint upstream token → execute → audit → respond.
 *
 * The gateway is framework-agnostic: it takes a parsed JSON-RPC payload and
 * returns a JSON-RPC response. Next.js handlers wrap this.
 */

import { injectionPlanFor, mergeInjectedArgs, stripInjectedArgs } from '@vaubaan/policy-engine';
import {
  UpstreamAuthError,
  type AccessTokenContext,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type McpToolDeclaration,
  type Provider,
  type ProviderAdmin,
  type ProviderBinding,
  type RiskId,
  type Slice,
} from '@vaubaan/shared';
import { PROVIDERS, parseApiKey, providerForTool, verifyApiKey } from '@vaubaan/shared';
import {
  AuthError,
  denyResponseBody,
  evaluateCallForToken,
  hashArguments,
  rpcError,
  rpcSuccess,
  type CacheClient,
  type ClassifyOutcome,
} from '@vaubaan/gateway-core';
import { resourceFromBinding, type IndexedRiskCatalog } from '@vaubaan/policy-engine';
import type { AuditLogRow, DelegationChainEntry } from '@vaubaan/shared';

/** v4 `audit_log` row. The v5 shape is `CallAuditEntry` in gateway-core. */
export interface LegacyAuditRow {
  organization_id: string;
  project_id: string | null;
  access_token_id: string | null;
  tool_name: string;
  arguments_hash: string;
  /** v4 vocabulary (`denied`) ; the v5 `AuditDecision` says `refused`. */
  decision: AuditLogRow['decision'];
  denial_reason: string | null;
  upstream_latency_ms: number | null;
  client_ip: string | null;
  client_user_agent: string | null;
  slices_executed: Slice[] | null;
  risks_touched: RiskId[] | null;
  token_accepted_risks_snapshot: RiskId[] | null;
  delegation_chain: DelegationChainEntry[] | null;
}

export interface LegacyAuditWriter {
  write(row: LegacyAuditRow): Promise<void>;
}

/** In-memory v4 writer for the legacy tests. */
export class MemoryLegacyAuditWriter implements LegacyAuditWriter {
  readonly rows: LegacyAuditRow[] = [];
  async write(row: LegacyAuditRow): Promise<void> {
    this.rows.push(row);
  }
}

function assertNotExpired(expiresAt: string | null | undefined): void {
  if (!expiresAt) return;
  if (Date.parse(expiresAt) <= Date.now()) {
    throw new AuthError('access token has expired.');
  }
}

function assertNotConsumed(consumedAt: string | null | undefined): void {
  if (consumedAt) {
    throw new AuthError('access token has already been consumed (single-use).');
  }
}

export interface ContextLoader {
  /** Load minimal access-token row for auth verification. Returns null if not found / revoked. */
  loadAccessTokenForAuth(
    apiKeyPrefix: string,
  ): Promise<{ id: string; api_key_hash: string; status: string } | null>;
  /** Load the full context for an authenticated access token. */
  loadAccessTokenContext(accessTokenId: string): Promise<AccessTokenContext | null>;
  /** Touch last_used_at — best-effort. */
  touchLastUsed?(accessTokenId: string): Promise<void>;
  /** Atomically mark a single-use token consumed (spec §8). Returns true on
   *  the first call (this caller wins), false when already consumed (race).
   *  Optional : when missing, the gateway just sets consumed_at locally and
   *  invalidates the cache, trusting eventual consistency. */
  consumeAccessToken?(accessTokenId: string): Promise<boolean>;
}

export interface UpstreamAdapter {
  provider: Provider;
  availableTools: ReadonlyArray<McpToolDeclaration>;
  /** Classify a concrete (tool, args) call into the slice(s) it touches.
   *  Returns `{ slices }` on success or `{ denied: reason }` when the call is
   *  structurally illegal (unknown tool, missing/unbound target). */
  classifyV4(
    tool: string,
    args: Record<string, unknown>,
    bindings: ReadonlyArray<ProviderBinding>,
  ): ClassifyOutcome;
  /** Execute the call against the upstream provider, using the resolved
   *  provider admin + the matched binding. Self-contained adapters (`ssh`)
   *  ignore admin / binding — they read their own credentials. */
  executeCall(
    admin: ProviderAdmin,
    binding: ProviderBinding,
    tool: string,
    args: Record<string, unknown>,
  ): Promise<unknown>;
  /** Load the full ProviderAdmin row (with tokens) — fetched by the caller, not cached. */
  loadProviderAdmin(orgId: string, provider: Provider): Promise<ProviderAdmin | null>;
  /**
   * When true the gateway skips the provider_admins "connected" check and
   * loadProviderAdmin — the adapter is responsible for all credential loading
   * inside `executeCallSelfContained`. Used by providers that store
   * credentials per-project (e.g. ssh) rather than per-org.
   */
  selfContained?: boolean;
  /**
   * Called instead of `executeCall` when `selfContained` is true. Receives
   * the full `AccessTokenContext` so the adapter can load per-project
   * credentials.
   */
  executeCallSelfContained?(
    ctx: AccessTokenContext,
    tool: string,
    args: Record<string, unknown>,
  ): Promise<unknown>;
  /**
   * Called after the first `executeCall` throws `UpstreamAuthError`. The adapter
   * should refresh the token (if it supports OAuth refresh) and retry the call.
   * Throws if refresh is not supported or fails.
   */
  retryAfterAuthFailure?(
    admin: ProviderAdmin,
    binding: ProviderBinding,
    tool: string,
    args: Record<string, unknown>,
  ): Promise<unknown>;
}

export interface GatewayConfig {
  cache: CacheClient;
  audit: LegacyAuditWriter;
  contextLoader: ContextLoader;
  upstreamByProvider: Record<Provider, UpstreamAdapter>;
  /** Per-provider indexed risk catalog (built at boot from the YAML files). */
  catalogByProvider: Partial<Record<Provider, IndexedRiskCatalog>>;
  /** TTL for the access-token context cache. Default 60s. */
  contextTtlSeconds?: number;
  /** Optional request metadata captured into audit_log. */
  clientIp?: string | null;
  clientUserAgent?: string | null;
  /** Called when a provider returns 401/403 and all retry/refresh attempts
   *  have failed. Marks the provider_admins row as `expired` and invalidates
   *  related caches so subsequent requests surface the correct status. */
  onProviderAuthFailure?(orgId: string, provider: Provider): Promise<void>;
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
    // All tokens are `vbn_live_*` since the unified-tokens migration ; scope
    // distinction lives on the DB row (org vs project). The gateway hot-path
    // only accepts project-scoped tokens (loadAccessTokenContext returns null
    // for org-scoped rows — they only authenticate /api/v1/tokens/*).

    const cacheKey = `vaubaan:ctx:${parsed.prefix}`;
    const cached = await this.cfg.cache.get<AccessTokenContext>(cacheKey);
    if (cached && cached.access_token.status === 'active') {
      // Re-verify hash on cache hit — defensive against cache poisoning.
      const tk = await this.cfg.contextLoader.loadAccessTokenForAuth(parsed.prefix);
      if (!tk || tk.status !== 'active') throw new AuthError('access token not found or revoked.');
      if (!(await verifyApiKey(tk.api_key_hash, raw))) throw new AuthError('api_key mismatch.');
      assertNotExpired(cached.access_token.expires_at);
      assertNotConsumed(cached.access_token.consumed_at);
      return cached;
    }

    const tk = await this.cfg.contextLoader.loadAccessTokenForAuth(parsed.prefix);
    if (!tk) throw new AuthError('unknown api_key.');
    if (tk.status !== 'active') throw new AuthError('access token is revoked.');
    if (!(await verifyApiKey(tk.api_key_hash, raw))) throw new AuthError('api_key mismatch.');

    const ctx = await this.cfg.contextLoader.loadAccessTokenContext(tk.id);
    if (!ctx) throw new AuthError('access-token context could not be loaded.');
    assertNotExpired(ctx.access_token.expires_at);
    assertNotConsumed(ctx.access_token.consumed_at);

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
            serverInfo: { name: 'vaubaan-gateway', version: '0.1.0' },
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

  /**
   * `tools/list` is intentionally coarse : show every tool of a provider iff
   * the token has at least one accepted risk targeting that provider. Finer
   * per-tool gating fires at `tools/call` time when the slice intersects with
   * the catalog. The trade-off : a token may see a tool that 403s at call
   * time (clear `risk-not-accepted` body) instead of being silently filtered.
   * Coarse but predictable. Spec v4 §A6.
   */
  listTools(ctx: AccessTokenContext): McpToolDeclaration[] {
    const out: McpToolDeclaration[] = [];
    const targets = ctx.accepted_risks;
    for (const provider of PROVIDERS) {
      const adapter = this.cfg.upstreamByProvider[provider];
      if (!adapter) continue;
      const matchesProvider = targets.some(
        (r) => r.startsWith(`${provider}.`) || r.startsWith(`${provider}[`),
      );
      if (!matchesProvider) continue;
      const filtered = [...adapter.availableTools];
      // Self-contained adapters (e.g. ssh) load credentials per-call and
      // therefore have no scope-injection plan.
      if (adapter.selfContained) {
        out.push(...filtered);
        continue;
      }
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

  /**
   * Risk-based call path. Strict-fail at the MVP : a slice that touches a
   * risk not in the token's accepted set returns 403 `risk-not-accepted`
   * with the missing risks + executed slice + actionable hint.
   */
  private async callTool(
    ctx: AccessTokenContext,
    id: string | number | null,
    params: Record<string, unknown>,
  ): Promise<JsonRpcResponse> {
    const toolName = typeof params.name === 'string' ? params.name : '';
    if (!toolName) return rpcError(id, -32602, 'tools/call requires params.name');
    const rawArgs = (params.arguments as Record<string, unknown> | undefined) ?? {};

    const provider = this.providerFor(toolName);
    if (!provider) {
      const reason = `tool '${toolName}' does not match any supported provider prefix.`;
      await this.audit(ctx, toolName, rawArgs, 'denied', null, [], reason, null);
      return rpcError(id, -32603, `Vaubaan policy denied: ${reason}`);
    }

    const adapter = this.cfg.upstreamByProvider[provider];
    if (!adapter) {
      const reason = `provider '${provider}' is not enabled on this gateway.`;
      await this.audit(ctx, toolName, rawArgs, 'denied', null, [], reason, null);
      return rpcError(id, -32603, `Vaubaan policy denied: ${reason}`);
    }
    const catalog = this.cfg.catalogByProvider[provider];

    // Pre-compute args with scope injection so the classifier sees the same
    // values upstream will receive.
    const adminEntry = ctx.provider_admins.find((p) => p.provider === provider);
    const plan = adapter.selfContained
      ? null
      : injectionPlanFor(provider, {
          bindings: ctx.bindings,
          vercelTeamId: adminEntry?.team_id ?? null,
        });
    const args = plan ? mergeInjectedArgs(rawArgs, plan) : rawArgs;

    // The v4 adapters classify against bindings ; the v5 decision core takes
    // resources (env qualification through `resourceEnvResolver`). Bridge
    // both ways here until P1.6 deletes this file.
    const verdict = evaluateCallForToken({
      tool: toolName,
      args,
      resources: ctx.bindings.map(resourceFromBinding),
      token: {
        id: ctx.access_token.id,
        accepted_risks: ctx.accepted_risks,
        denied_risks: ctx.denied_risks,
      },
      adapter: { classify: (t, a) => adapter.classifyV4(t, { ...a }, ctx.bindings) },
      catalog,
    });

    if (verdict.kind === 'no-catalog') {
      const reason = `risk catalog for '${provider}' is not loaded — refusing call (fail-closed).`;
      await this.audit(ctx, toolName, args, 'denied', null, [], reason, null);
      return rpcError(id, -32603, `Vaubaan policy denied: ${reason}`);
    }
    if (verdict.kind === 'classify-denied') {
      await this.audit(ctx, toolName, args, 'denied', null, [], verdict.reason, null);
      return rpcError(id, -32603, `Vaubaan policy denied: ${verdict.reason}`);
    }
    if (verdict.kind === 'deny') {
      const body = denyResponseBody(verdict);
      await this.audit(
        ctx,
        toolName,
        args,
        'denied',
        verdict.executed_slices,
        verdict.missing_risks,
        body.hint,
        null,
      );
      return rpcError(id, -32603, `Vaubaan risk-not-accepted`, body);
    }

    // verdict.kind === 'allow'

    // Self-contained adapters (e.g. ssh) execute differently. We delegate
    // to executeCallSelfContained without provider-admin loading.
    if (adapter.selfContained) {
      if (ctx.access_token.single_use && this.cfg.contextLoader.consumeAccessToken) {
        const won = await this.cfg.contextLoader.consumeAccessToken(ctx.access_token.id);
        if (!won) {
          const reason = 'access token has already been consumed (single-use).';
          await this.audit(
            ctx,
            toolName,
            args,
            'denied',
            verdict.executed_slices,
            [],
            reason,
            null,
          );
          return rpcError(id, -32603, `Vaubaan policy denied: ${reason}`);
        }
        await this.cfg.cache.del(`vaubaan:ctx:${ctx.access_token.api_key_prefix}`);
      }
      const t0 = Date.now();
      try {
        const execFn = adapter.executeCallSelfContained?.bind(adapter);
        if (!execFn) {
          throw new Error(
            `self-contained adapter for '${provider}' has no executeCallSelfContained`,
          );
        }
        const result = await execFn(ctx, toolName, rawArgs);
        const latency = Date.now() - t0;
        await this.audit(
          ctx,
          toolName,
          args,
          'allowed',
          verdict.executed_slices,
          verdict.risks_touched,
          null,
          latency,
        );
        return rpcSuccess(id, this.shapeMcpResult(result));
      } catch (e) {
        const latency = Date.now() - t0;
        const message = e instanceof Error ? e.message : String(e);
        // B1 — the upstream threw AFTER we consumed the single-use token, so
        // the business consequence did NOT happen. Audit as 'denied' with the
        // upstream error as denial_reason. Without this, an operator querying
        // audit_log sees 'allowed' rows with no business effect.
        await this.audit(
          ctx,
          toolName,
          args,
          'denied',
          verdict.executed_slices,
          verdict.risks_touched,
          `upstream-error: ${message}`,
          latency,
        );
        return rpcError(id, -32603, `Upstream call failed: ${message}`);
      }
    }

    // Regular (provider-admin-backed) adapter.
    if (!adminEntry || adminEntry.status !== 'connected') {
      const reason = `provider '${provider}' is not connected for organization '${ctx.organization.slug}'.`;
      await this.audit(ctx, toolName, args, 'denied', verdict.executed_slices, [], reason, null);
      return rpcError(id, -32603, `Vaubaan policy denied: ${reason}`);
    }
    const admin = await adapter.loadProviderAdmin(ctx.organization.id, provider);
    if (!admin) {
      const reason = `provider_admin for '${provider}' could not be loaded — re-connect required.`;
      await this.audit(ctx, toolName, args, 'denied', verdict.executed_slices, [], reason, null);
      return rpcError(id, -32603, `Vaubaan policy denied: ${reason}`);
    }

    if (ctx.access_token.single_use && this.cfg.contextLoader.consumeAccessToken) {
      const won = await this.cfg.contextLoader.consumeAccessToken(ctx.access_token.id);
      if (!won) {
        const reason = 'access token has already been consumed (single-use).';
        await this.audit(ctx, toolName, args, 'denied', verdict.executed_slices, [], reason, null);
        return rpcError(id, -32603, `Vaubaan policy denied: ${reason}`);
      }
      await this.cfg.cache.del(`vaubaan:ctx:${ctx.access_token.api_key_prefix}`);
    }

    // B2 — if the classifier accepted the slice, a binding for this provider
    // MUST exist (the classifier consults `ctx.bindings` to validate args).
    // A missing binding here means a wiring inconsistency upstream — refuse
    // hard rather than fabricate an empty binding that the adapter may
    // mishandle.
    const binding = ctx.bindings.find((b) => b.provider === provider);
    if (!binding) {
      const reason = `binding-missing: no '${provider}' binding on this access token despite classifier acceptance.`;
      await this.audit(ctx, toolName, args, 'denied', verdict.executed_slices, [], reason, null);
      return rpcError(id, -32603, `Vaubaan policy denied: ${reason}`);
    }
    const t0 = Date.now();
    try {
      const result = await adapter.executeCall(admin, binding, toolName, args);
      const latency = Date.now() - t0;
      await this.audit(
        ctx,
        toolName,
        args,
        'allowed',
        verdict.executed_slices,
        verdict.risks_touched,
        null,
        latency,
      );
      return rpcSuccess(id, this.shapeMcpResult(result));
    } catch (e) {
      // On upstream 401/403: attempt refresh + retry before giving up.
      if (e instanceof UpstreamAuthError && adapter.retryAfterAuthFailure) {
        try {
          const retryResult = await adapter.retryAfterAuthFailure(admin, binding, toolName, args);
          const latency = Date.now() - t0;
          await this.audit(
            ctx,
            toolName,
            args,
            'allowed',
            verdict.executed_slices,
            verdict.risks_touched,
            null,
            latency,
          );
          return rpcSuccess(id, this.shapeMcpResult(retryResult));
        } catch {
          // Refresh failed — fall through to mark expired.
        }
      }
      if (e instanceof UpstreamAuthError) {
        await this.markProviderExpired(ctx, provider);
      }
      const latency = Date.now() - t0;
      const message = e instanceof Error ? e.message : String(e);
      await this.audit(
        ctx,
        toolName,
        args,
        'denied',
        verdict.executed_slices,
        verdict.risks_touched,
        `upstream-error: ${message}`,
        latency,
      );
      return rpcError(id, -32603, `Upstream call failed: ${message}`);
    }
  }

  private async markProviderExpired(ctx: AccessTokenContext, provider: Provider): Promise<void> {
    try {
      if (this.cfg.onProviderAuthFailure) {
        await this.cfg.onProviderAuthFailure(ctx.organization.id, provider);
      }
      await this.cfg.cache.del(`vaubaan:ctx:${ctx.access_token.api_key_prefix}`);
    } catch (e) {
      console.error('[gateway] markProviderExpired failed', e);
    }
  }

  private providerFor(tool: string): Provider | null {
    return providerForTool(tool);
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
    executedSlices: readonly Slice[] | null,
    risksTouched: readonly RiskId[],
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
        decision,
        denial_reason: decision === 'denied' ? denialReason : null,
        upstream_latency_ms: latency,
        client_ip: this.cfg.clientIp ?? null,
        client_user_agent: this.cfg.clientUserAgent ?? null,
        slices_executed: executedSlices ? [...executedSlices] : null,
        risks_touched: [...risksTouched],
        token_accepted_risks_snapshot: [...ctx.accepted_risks],
        delegation_chain: [...ctx.access_token.delegation_chain],
      });
    } catch (e) {
      console.error('[gateway] audit write failed', e);
    }
  }
}
