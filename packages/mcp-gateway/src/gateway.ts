/**
 * MCP Gateway core.
 *
 * Spec : docs/spec/vaubaan-gateway.md §6.2, §7.
 *
 *   auth → load context (cached) → parse RPC → route by method →
 *   evaluate policy → mint upstream token → execute → audit → respond.
 *
 * The gateway is framework-agnostic: it takes a parsed JSON-RPC payload and
 * returns a JSON-RPC response. Next.js handlers wrap this.
 */

import {
  evaluateCapability,
  filterAvailableTools,
  injectionPlanFor,
  mergeInjectedArgs,
  stripInjectedArgs,
  type IndexedRiskCatalog,
} from '@vaubaan/policy-engine';
import type {
  AccessTokenContext,
  Capability,
  EnvResolution,
  JsonRpcRequest,
  JsonRpcResponse,
  McpToolDeclaration,
  Provider,
  ProviderAdmin,
  ProviderBinding,
  RiskId,
  Slice,
} from '@vaubaan/shared';
import { parseApiKey, verifyApiKey } from '@vaubaan/shared';
import {
  denyResponseBody,
  evaluateCallForToken,
  shouldUseV4Path,
  type V4ClassifierAdapter,
} from './risk-gateway.ts';

/** What a provider plugin returns when classifying a concrete call. The
 *  optional `binding` is the binding the call resolved to ; the gateway uses
 *  it to derive per-binding policy knobs (excludeEnvs for env-less fan-out,
 *  spec §5.1 #4). */
export type ClassifyResult =
  | { capability: Capability; binding?: ProviderBinding }
  | { denied: string };
import type { CacheClient } from './cache.ts';
import { hashArguments, type AuditWriter } from './audit.ts';
import { AuthError, rpcError, rpcSuccess } from './errors.ts';

/** Build the `excludeEnvs` set that narrows a env-less grant's fan-out for a
 *  given binding (spec §5.1 #4). Two sources :
 *
 *   1. Static, per-binding column (`env_less_exclude_branch`) — read inline.
 *   2. Dynamic, provider-resolved (`env_less_exclude_protected` for github :
 *      the live protected-branches list, fetched via Octokit and cached).
 *      Delegated to `adapter.resolveExcludeEnvs(admin, binding)` when present.
 *
 *  Returns `undefined` when there's nothing to exclude — pass through to
 *  `evaluateCapability` as "no context" (true fan-out). */
async function excludeEnvsFor(
  binding: ProviderBinding | undefined,
  adapter: UpstreamAdapter,
  admin: ProviderAdmin | undefined,
): Promise<{ excludeEnvs?: readonly string[] } | undefined> {
  if (!binding) return undefined;
  let exclude: readonly string[] = [];
  if (admin && adapter.resolveExcludeEnvs) {
    exclude = await adapter.resolveExcludeEnvs(admin, binding);
  } else if (binding.env_less_exclude_branch) {
    // Self-contained adapters (no provider admin loaded) still honor the
    // static branch exclude — only the dynamic protected-branches resolution
    // needs an admin.
    exclude = [binding.env_less_exclude_branch];
  }
  if (exclude.length === 0) return undefined;
  return { excludeEnvs: exclude };
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
  /** Env-less capability surface of a tool — for static tools/list filtering. */
  toolCapabilities(tool: string): readonly Capability[];
  /** How env is resolved at call time for this tool — drives the lockstep
   *  between the static filter and the runtime `covers()` check. See
   *  `EnvResolution` in `@vaubaan/shared`. */
  toolEnvResolution(tool: string): EnvResolution;
  /** Classify a concrete call into the capability it requires (env resolved). */
  classify(
    tool: string,
    args: Record<string, unknown>,
    bindings: ReadonlyArray<ProviderBinding>,
  ): ClassifyResult;
  executeCall(
    admin: ProviderAdmin,
    binding: ProviderBinding,
    tool: string,
    args: Record<string, unknown>,
  ): Promise<unknown>;
  /**
   * Resolve the runtime exclude set that narrows an env-less grant's fan-out
   * for this binding (spec §5.1 #4). Today only github implements it (static
   * branch + dynamic protected-branches list). Returning `[]` (or omitting
   * the method) means "no exclusion" = true fan-out.
   */
  resolveExcludeEnvs?(admin: ProviderAdmin, binding: ProviderBinding): Promise<readonly string[]>;
  /** Full ProviderAdmin row (with tokens) — fetched by the caller, not cached. */
  loadProviderAdmin(orgId: string, provider: Provider): Promise<ProviderAdmin | null>;
  /**
   * When true the gateway skips the provider_admins "connected" check and
   * loadProviderAdmin — the adapter is responsible for all credential loading
   * inside executeCall. Used by providers that store credentials per-project
   * (e.g. ssh) rather than per-org.
   *
   * Self-contained adapters should also implement `executeCallSelfContained`
   * so they receive the full request context (roles, project id, etc.).
   */
  selfContained?: boolean;
  /**
   * Called instead of `executeCall` when `selfContained` is true.
   * Receives the full `AccessTokenContext` so the adapter can load
   * per-project credentials and apply role-based policy internally.
   */
  executeCallSelfContained?(
    ctx: AccessTokenContext,
    tool: string,
    args: Record<string, unknown>,
  ): Promise<unknown>;
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
  /**
   * Optional v4 risk-based plumbing — when present, tokens with non-empty
   * `accepted_risks` route through the v4 path (`callToolV4`). Absent or
   * `undefined` ⇒ every token uses the v1 capability path (back-compat).
   *
   *  - `v4ClassifierByProvider` : per-provider plugin returning the
   *    `Slice[]` for a tool call (cf. `classifyV4` in
   *    `packages/providers/<vendor>/src/risk-classifier.ts`).
   *  - `v4CatalogByProvider`    : per-provider indexed risk catalog
   *    (`prepareCatalog(yamlContents)` at boot).
   *
   * Per-provider classifier/catalog absence ⇒ the v4 call is denied with
   * `risk-not-accepted` (catalog missing). The fallback to v1 only happens
   * when the TOKEN itself is v1-shaped (no accepted_risks).
   */
  v4ClassifierByProvider?: Partial<Record<Provider, V4ClassifierAdapter>>;
  v4CatalogByProvider?: Partial<Record<Provider, IndexedRiskCatalog>>;
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
    // `vbn_mgmt_*` is an admin credential — it authenticates against
    // /api/v1/mgmt/*, not the MCP gateway. Reject upfront.
    if (parsed.kind === 'mgmt') {
      throw new AuthError(
        'management keys (vbn_mgmt_…) cannot consume the MCP gateway. Use an AccessToken (vbn_live_…).',
      );
    }

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

  private listTools(ctx: AccessTokenContext): McpToolDeclaration[] {
    const out: McpToolDeclaration[] = [];
    for (const provider of ['github', 'vercel', 'supabase', 'railway', 'bash'] as Provider[]) {
      const adapter = this.cfg.upstreamByProvider[provider];
      if (!adapter) continue;
      const filtered = filterAvailableTools(ctx.capabilities, adapter);
      if (filtered.length === 0) continue;
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

  private async callTool(
    ctx: AccessTokenContext,
    id: string | number | null,
    params: Record<string, unknown>,
  ): Promise<JsonRpcResponse> {
    const toolName = typeof params.name === 'string' ? params.name : '';
    if (!toolName) return rpcError(id, -32602, 'tools/call requires params.name');
    const rawArgs = (params.arguments as Record<string, unknown> | undefined) ?? {};

    // v4 dispatch — if the token carries accepted_risks (v4 mint) AND we
    // have the v4 plumbing configured (catalogs + classifiers), route to
    // the v4 path. Tokens without accepted_risks fall through to v1.
    if (
      shouldUseV4Path({ accepted_risks: ctx.accepted_risks ?? [] }) &&
      this.cfg.v4ClassifierByProvider
    ) {
      return await this.callToolV4(ctx, id, toolName, rawArgs);
    }

    // Determine provider from tool prefix.
    const provider = this.providerFor(toolName);
    if (!provider) {
      const reason = `tool '${toolName}' does not match any supported provider (github__/vercel__/supabase__/railway__/bash__).`;
      await this.audit(ctx, toolName, rawArgs, 'denied', null, reason, null);
      return rpcError(id, -32603, `Vaubaan policy denied: ${reason}`);
    }

    const adapter = this.cfg.upstreamByProvider[provider];
    if (!adapter) {
      const reason = `provider '${provider}' is not enabled on this gateway.`;
      await this.audit(ctx, toolName, rawArgs, 'denied', null, reason, null);
      return rpcError(id, -32603, `Vaubaan policy denied: ${reason}`);
    }

    if (adapter.selfContained) {
      // Self-contained adapters (e.g. ssh) skip provider_admins +
      // loadProviderAdmin + scope-injection — they handle credential loading
      // inside executeCallSelfContained. Authorization still goes through
      // the unified classify + evaluateCapability path.
      const classified = adapter.classify(toolName, rawArgs, ctx.bindings);
      if ('denied' in classified) {
        await this.audit(ctx, toolName, rawArgs, 'denied', null, classified.denied, null);
        return rpcError(id, -32603, `Vaubaan policy denied: ${classified.denied}`);
      }
      const decision = evaluateCapability(
        ctx.capabilities,
        classified.capability,
        await excludeEnvsFor(classified.binding, adapter, undefined),
      );
      if (decision.decision === 'denied') {
        await this.audit(ctx, toolName, rawArgs, 'denied', null, decision.reason ?? null, null);
        return rpcError(id, -32603, `Vaubaan policy denied: ${decision.reason}`);
      }
      const capabilityMatched = decision.capabilityMatched ?? null;

      // Single-use consume (spec §8) for self-contained adapters too.
      if (ctx.access_token.single_use && this.cfg.contextLoader.consumeAccessToken) {
        const won = await this.cfg.contextLoader.consumeAccessToken(ctx.access_token.id);
        if (!won) {
          const reason = 'access token has already been consumed (single-use).';
          await this.audit(ctx, toolName, rawArgs, 'denied', null, reason, null);
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
        await this.audit(ctx, toolName, rawArgs, 'allowed', capabilityMatched, null, latency);
        return rpcSuccess(id, this.shapeMcpResult(result));
      } catch (e) {
        const latency = Date.now() - t0;
        const message = e instanceof Error ? e.message : String(e);
        await this.audit(ctx, toolName, rawArgs, 'allowed', capabilityMatched, null, latency);
        return rpcError(id, -32603, `Upstream call failed: ${message}`);
      }
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

    // Classify the concrete call into the capability it requires (provider
    // plugin, native semantics), with the injected args so env/target resolution
    // sees the same values the upstream will receive.
    const classified = adapter.classify(toolName, args, ctx.bindings);
    if ('denied' in classified) {
      await this.audit(ctx, toolName, args, 'denied', null, classified.denied, null);
      return rpcError(id, -32603, `Vaubaan policy denied: ${classified.denied}`);
    }

    // Load full ProviderAdmin (with tokens — never cached in clear) before the
    // policy check : the adapter may need upstream creds to resolve dynamic
    // excludeEnvs (e.g. github protected-branches lookup ; spec §5.1 #4).
    const admin = await adapter.loadProviderAdmin(ctx.organization.id, provider);
    if (!admin) {
      const reason = `provider_admin for '${provider}' could not be loaded — re-connect required.`;
      await this.audit(ctx, toolName, args, 'denied', null, reason, null);
      return rpcError(id, -32603, `Vaubaan policy denied: ${reason}`);
    }

    // Pure set membership : is the required capability in the granted set ?
    // The matched binding may carry per-binding exclude knobs that narrow the
    // fan-out of an env-less grant (spec §5.1 #4 ; github-only in MVP).
    const decision = evaluateCapability(
      ctx.capabilities,
      classified.capability,
      await excludeEnvsFor(classified.binding, adapter, admin),
    );
    if (decision.decision === 'denied') {
      await this.audit(ctx, toolName, args, 'denied', null, decision.reason ?? null, null);
      return rpcError(id, -32603, `Vaubaan policy denied: ${decision.reason}`);
    }
    const capabilityMatched = decision.capabilityMatched ?? null;

    // Single-use consume (spec §8) : burn the token *before* upstream so a
    // failed call doesn't leave the credential reusable. Race-safe via the
    // atomic SQL UPDATE in the loader ; if we lost the race, reject.
    if (ctx.access_token.single_use) {
      if (this.cfg.contextLoader.consumeAccessToken) {
        const won = await this.cfg.contextLoader.consumeAccessToken(ctx.access_token.id);
        if (!won) {
          const reason = 'access token has already been consumed (single-use).';
          await this.audit(ctx, toolName, args, 'denied', null, reason, null);
          return rpcError(id, -32603, `Vaubaan policy denied: ${reason}`);
        }
        await this.cfg.cache.del(`vaubaan:ctx:${ctx.access_token.api_key_prefix}`);
      }
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
      await this.audit(ctx, toolName, args, 'allowed', capabilityMatched, null, latency);
      return rpcSuccess(id, this.shapeMcpResult(result));
    } catch (e) {
      const latency = Date.now() - t0;
      const message = e instanceof Error ? e.message : String(e);
      await this.audit(ctx, toolName, args, 'allowed', capabilityMatched, null, latency);
      return rpcError(id, -32603, `Upstream call failed: ${message}`);
    }
  }

  /**
   * v4 risk-based call path — used when the token has non-empty
   * `accepted_risks`. Mirrors `callTool` (provider lookup, scope-injection,
   * single-use consume, executeCall, audit) but replaces the authorization
   * step with `evaluateCallForToken` (slices × catalog × accepted_risks).
   *
   * The audit row enriches `slices_executed`, `risks_touched`, and
   * `token_accepted_risks_snapshot` per spec v4 §12.
   *
   * Self-contained adapters (ssh / bash) are NOT supported on the v4 path
   * yet — the ssh classifier emits slices but the gateway routing for the
   * self-contained branch lives in the v1 callTool. Phase 4 follow-up.
   */
  private async callToolV4(
    ctx: AccessTokenContext,
    id: string | number | null,
    toolName: string,
    rawArgs: Record<string, unknown>,
  ): Promise<JsonRpcResponse> {
    const provider = this.providerFor(toolName);
    if (!provider) {
      const reason = `tool '${toolName}' does not match any supported provider (github__/vercel__/supabase__/railway__/bash__).`;
      await this.auditV4(ctx, toolName, rawArgs, 'denied', null, [], reason, null);
      return rpcError(id, -32603, `Vaubaan policy denied: ${reason}`);
    }

    const adapter = this.cfg.upstreamByProvider[provider];
    if (!adapter) {
      const reason = `provider '${provider}' is not enabled on this gateway.`;
      await this.auditV4(ctx, toolName, rawArgs, 'denied', null, [], reason, null);
      return rpcError(id, -32603, `Vaubaan policy denied: ${reason}`);
    }
    const v4Adapter = this.cfg.v4ClassifierByProvider?.[provider];
    if (!v4Adapter) {
      const reason = `v4 classifier not registered for provider '${provider}' — gateway misconfigured.`;
      await this.auditV4(ctx, toolName, rawArgs, 'denied', null, [], reason, null);
      return rpcError(id, -32603, `Vaubaan policy denied: ${reason}`);
    }
    const catalog = this.cfg.v4CatalogByProvider?.[provider];

    // Pre-compute args with scope injection so the classifier sees the same
    // values upstream will receive (mirrors v1 behaviour).
    const adminEntry = ctx.provider_admins.find((p) => p.provider === provider);
    const plan = adapter.selfContained
      ? null
      : injectionPlanFor(provider, {
          bindings: ctx.bindings,
          vercelTeamId: adminEntry?.team_id ?? null,
        });
    const args = plan ? mergeInjectedArgs(rawArgs, plan) : rawArgs;

    const verdict = evaluateCallForToken({
      tool: toolName,
      args,
      bindings: ctx.bindings,
      token: {
        id: ctx.access_token.id,
        accepted_risks: ctx.accepted_risks ?? [],
        denied_risks: ctx.denied_risks ?? [],
      },
      adapter: v4Adapter,
      catalog,
    });

    if (verdict.kind === 'no-catalog') {
      const reason = `risk catalog for '${provider}' is not loaded — refusing call (fail-closed).`;
      await this.auditV4(ctx, toolName, args, 'denied', null, [], reason, null);
      return rpcError(id, -32603, `Vaubaan policy denied: ${reason}`);
    }
    if (verdict.kind === 'classify-denied') {
      await this.auditV4(ctx, toolName, args, 'denied', null, [], verdict.reason, null);
      return rpcError(id, -32603, `Vaubaan policy denied: ${verdict.reason}`);
    }
    if (verdict.kind === 'deny') {
      const body = denyResponseBody(verdict);
      await this.auditV4(
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
    const risksMatched = verdict.risks_touched.join(',');

    // Self-contained adapters (e.g. ssh) execute differently. We delegate
    // to executeCallSelfContained without provider-admin loading.
    if (adapter.selfContained) {
      if (ctx.access_token.single_use && this.cfg.contextLoader.consumeAccessToken) {
        const won = await this.cfg.contextLoader.consumeAccessToken(ctx.access_token.id);
        if (!won) {
          const reason = 'access token has already been consumed (single-use).';
          await this.auditV4(
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
        await this.auditV4(
          ctx,
          toolName,
          args,
          'allowed',
          verdict.executed_slices,
          verdict.risks_touched,
          risksMatched,
          latency,
        );
        return rpcSuccess(id, this.shapeMcpResult(result));
      } catch (e) {
        const latency = Date.now() - t0;
        const message = e instanceof Error ? e.message : String(e);
        await this.auditV4(
          ctx,
          toolName,
          args,
          'allowed',
          verdict.executed_slices,
          verdict.risks_touched,
          risksMatched,
          latency,
        );
        return rpcError(id, -32603, `Upstream call failed: ${message}`);
      }
    }

    // Regular (provider-admin-backed) adapter.
    if (!adminEntry || adminEntry.status !== 'connected') {
      const reason = `provider '${provider}' is not connected for organization '${ctx.organization.slug}'.`;
      await this.auditV4(ctx, toolName, args, 'denied', verdict.executed_slices, [], reason, null);
      return rpcError(id, -32603, `Vaubaan policy denied: ${reason}`);
    }
    const admin = await adapter.loadProviderAdmin(ctx.organization.id, provider);
    if (!admin) {
      const reason = `provider_admin for '${provider}' could not be loaded — re-connect required.`;
      await this.auditV4(ctx, toolName, args, 'denied', verdict.executed_slices, [], reason, null);
      return rpcError(id, -32603, `Vaubaan policy denied: ${reason}`);
    }

    if (ctx.access_token.single_use && this.cfg.contextLoader.consumeAccessToken) {
      const won = await this.cfg.contextLoader.consumeAccessToken(ctx.access_token.id);
      if (!won) {
        const reason = 'access token has already been consumed (single-use).';
        await this.auditV4(
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

    const binding = ctx.bindings.find((b) => b.provider === provider);
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
      await this.auditV4(
        ctx,
        toolName,
        args,
        'allowed',
        verdict.executed_slices,
        verdict.risks_touched,
        risksMatched,
        latency,
      );
      return rpcSuccess(id, this.shapeMcpResult(result));
    } catch (e) {
      const latency = Date.now() - t0;
      const message = e instanceof Error ? e.message : String(e);
      await this.auditV4(
        ctx,
        toolName,
        args,
        'allowed',
        verdict.executed_slices,
        verdict.risks_touched,
        risksMatched,
        latency,
      );
      return rpcError(id, -32603, `Upstream call failed: ${message}`);
    }
  }

  private async auditV4(
    ctx: AccessTokenContext,
    tool: string,
    args: Record<string, unknown>,
    decision: 'allowed' | 'denied',
    executedSlices: readonly Slice[] | null,
    risksTouched: readonly RiskId[],
    denialOrMatched: string | null,
    latency: number | null,
  ): Promise<void> {
    try {
      await this.cfg.audit.write({
        organization_id: ctx.organization.id,
        project_id: ctx.project.id,
        access_token_id: ctx.access_token.id,
        tool_name: tool,
        arguments_hash: hashArguments(args),
        capability_matched: null,
        decision,
        denial_reason: decision === 'denied' ? denialOrMatched : null,
        upstream_latency_ms: latency,
        client_ip: this.cfg.clientIp ?? null,
        client_user_agent: this.cfg.clientUserAgent ?? null,
        slices_executed: executedSlices ? [...executedSlices] : null,
        risks_touched: [...risksTouched],
        token_accepted_risks_snapshot: ctx.accepted_risks ? [...ctx.accepted_risks] : null,
      });
    } catch (e) {
      console.error('[gateway] v4 audit write failed', e);
    }
  }

  private providerFor(tool: string): Provider | null {
    if (tool.startsWith('github__')) return 'github';
    if (tool.startsWith('vercel__')) return 'vercel';
    if (tool.startsWith('supabase__')) return 'supabase';
    if (tool.startsWith('railway__')) return 'railway';
    if (tool.startsWith('bash__')) return 'bash';
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
    capabilityMatched: string | null,
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
        capability_matched: capabilityMatched,
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
