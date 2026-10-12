/**
 * LEGACY v4 wiring — build a configured v4 `McpGateway` for the Next.js
 * runtime. Replaced by the v5 composition root (P0.4) and door (P1.6).
 *
 * Spec : docs/spec/legacy/vaubaan-gateway.legacy.md §7.
 */

import { GitHubAdapter, githubAvailableTools } from '@vaubaan/plugin-github';
import { VercelAdapter, vercelAvailableTools } from '@vaubaan/plugin-vercel';
import { SupabaseAdapter, supabaseAvailableTools } from '@vaubaan/plugin-supabase';
import { RailwayAdapter, railwayAvailableTools } from '@vaubaan/plugin-railway';
import { UpstashRedisAdapter, upstashRedisAvailableTools } from '@vaubaan/plugin-upstash-redis';
import { StripeAdapter, stripeAvailableTools, stripeExecuteCall } from '@vaubaan/plugin-stripe';
import { ResendAdapter, resendAvailableTools } from '@vaubaan/plugin-resend';
import { CloudflareDnsAdapter, cloudflareDnsAvailableTools } from '@vaubaan/plugin-cloudflare-dns';
import {
  PROVIDERS,
  type AccessTokenContext,
  type Provider,
  type ProviderAdmin,
  type ProviderBinding,
  type RiskId,
} from '@vaubaan/shared';
import type { IndexedRiskCatalog } from '@vaubaan/policy-engine';
import { MemoryCacheClient } from '@vaubaan/gateway-core';
import {
  McpGateway,
  type ContextLoader,
  type LegacyAuditRow,
  type LegacyAuditWriter,
  type UpstreamAdapter,
} from './legacy-v4-gateway';
import { getSupabaseServiceClient } from '@/lib/supabase/server';
import { decodeBytea, encodeByteaHexRaw } from '@/lib/providers/bytea';
import { decryptProviderSecret, encryptProviderSecret } from '@/lib/crypto';
import { getCatalog } from '@/lib/risk-catalog/loader';

function getGitHubAppCredentials() {
  const appId = process.env.GITHUB_APP_ID;
  const slug = process.env.GITHUB_APP_SLUG ?? 'vaubaan-gateway';
  const privateKey = process.env.GITHUB_APP_PRIVATE_KEY;
  if (!appId || !privateKey) return null;
  // Vercel env vars escape \n — un-escape before importing.
  const pem = privateKey.replace(/\\n/g, '\n');
  return { appId, appSlug: slug, privateKeyPem: pem };
}

interface TokenAuthRow {
  id: string;
  api_key_hash: string;
  status: string;
}

interface TokenRow {
  id: string;
  name: string;
  parent_id: string | null;
  scope: 'project';
  project_id: string;
  status: 'active' | 'revoked';
  api_key_prefix: string;
  expires_at: string | null;
  single_use: boolean;
  consumed_at: string | null;
  accepted_risks: unknown;
  denied_risks: unknown;
  depth: number;
  delegation_chain: unknown;
}

interface ProjectRow {
  id: string;
  slug: string;
  organization_id: string;
}

interface OrgRow {
  id: string;
  slug: string;
  name: string;
}

interface VenvEntry {
  key: string;
  source: string;
  updated_at: string;
}

/** v4 project-scoped secret store consumed by the Vercel and Supabase
 *  adapters (`_to_venv` / `_from_venv` tools). No v5 counterpart. */
class SupabaseVenvStore {
  constructor(private readonly client: ReturnType<typeof getSupabaseServiceClient>) {}

  async put(projectId: string, key: string, value: string, source: string): Promise<void> {
    const { error } = await this.client
      .from('project_env_vars')
      .upsert(
        { project_id: projectId, key, value, source, updated_at: new Date().toISOString() },
        { onConflict: 'project_id,key' },
      );
    if (error) throw new Error(`venv put failed: ${error.message}`);
  }

  async get(projectId: string, key: string): Promise<string> {
    const { data, error } = await this.client
      .from('project_env_vars')
      .select('value')
      .eq('project_id', projectId)
      .eq('key', key)
      .maybeSingle<{ value: string }>();
    if (error) throw new Error(`venv get failed: ${error.message}`);
    if (!data) throw new Error(`venv key '${key}' not found.`);
    return data.value;
  }

  async has(projectId: string, key: string): Promise<boolean> {
    const { data } = await this.client
      .from('project_env_vars')
      .select('key')
      .eq('project_id', projectId)
      .eq('key', key)
      .maybeSingle<{ key: string }>();
    return !!data;
  }

  async list(projectId: string): Promise<VenvEntry[]> {
    const { data, error } = await this.client
      .from('project_env_vars')
      .select('key, source, updated_at')
      .eq('project_id', projectId)
      .order('key');
    if (error) throw new Error(`venv list failed: ${error.message}`);
    return data ?? [];
  }

  async delete(projectId: string, key: string): Promise<void> {
    const { error } = await this.client
      .from('project_env_vars')
      .delete()
      .eq('project_id', projectId)
      .eq('key', key);
    if (error) throw new Error(`venv delete failed: ${error.message}`);
  }
}

/** v4 `audit_log` writer. Audit failures are logged, not thrown (v4 behaviour). */
class SupabaseLegacyAuditWriter implements LegacyAuditWriter {
  constructor(private readonly client: ReturnType<typeof getSupabaseServiceClient>) {}
  async write(row: LegacyAuditRow): Promise<void> {
    const { error } = await this.client.from('audit_log').insert(row);
    if (error) {
      console.error('[audit] failed to write row', { error: error.message, row });
    }
  }
}

export function buildGateway(opts: {
  clientIp: string | null;
  clientUserAgent: string | null;
}): McpGateway {
  const supabase = getSupabaseServiceClient();
  const venvStore = new SupabaseVenvStore(supabase);

  const contextLoader: ContextLoader = {
    async loadAccessTokenForAuth(prefix) {
      const { data } = await supabase
        .from('tokens')
        .select('id, api_key_hash, status')
        .eq('api_key_prefix', prefix)
        .maybeSingle<TokenAuthRow>();
      return data;
    },
    async loadAccessTokenContext(accessTokenId) {
      const { data: tk } = await supabase
        .from('tokens')
        .select(
          'id, name, parent_id, scope, project_id, status, api_key_prefix, expires_at, single_use, consumed_at, accepted_risks, denied_risks, depth, delegation_chain',
        )
        .eq('id', accessTokenId)
        .maybeSingle<TokenRow>();
      if (!tk || !tk.project_id) return null;
      const { data: project } = await supabase
        .from('projects')
        .select('id, slug, organization_id')
        .eq('id', tk.project_id)
        .maybeSingle<ProjectRow>();
      if (!project) return null;
      const { data: org } = await supabase
        .from('organizations')
        .select('id, slug, name')
        .eq('id', project.organization_id)
        .maybeSingle<OrgRow>();
      if (!org) return null;
      const accepted_risks: RiskId[] = Array.isArray(tk.accepted_risks)
        ? (tk.accepted_risks as unknown[]).filter((r): r is RiskId => typeof r === 'string')
        : [];
      const denied_risks: RiskId[] = Array.isArray(tk.denied_risks)
        ? (tk.denied_risks as unknown[]).filter((r): r is RiskId => typeof r === 'string')
        : [];
      const bindingsResp = await supabase
        .from('provider_bindings')
        .select('*')
        .eq('project_id', project.id);
      const providerAdminsResp = await supabase
        .from('provider_admins')
        .select('provider, status, installation_id, team_id')
        .eq('organization_id', org.id);
      // TODO(W9, clean-code-report) : replace these `as unknown` boundary
      // casts with a zod parse so a DB schema drift (renamed column, new
      // nullability) fails loudly at runtime instead of silently producing
      // half-typed AccessTokenContext rows. See report W9.
      const bindings = (bindingsResp.data ?? []) as unknown;
      const providerAdmins = (providerAdminsResp.data ?? []) as unknown;
      const delegationChain = Array.isArray(tk.delegation_chain)
        ? (tk.delegation_chain as AccessTokenContext['access_token']['delegation_chain'])
        : [];
      const ctx: AccessTokenContext = {
        access_token: {
          id: tk.id,
          name: tk.name,
          parent_id: tk.parent_id,
          scope: tk.scope,
          project_id: tk.project_id,
          status: tk.status,
          api_key_prefix: tk.api_key_prefix,
          expires_at: tk.expires_at,
          single_use: tk.single_use,
          consumed_at: tk.consumed_at,
          depth: tk.depth,
          delegation_chain: delegationChain,
        },
        project,
        organization: org,
        accepted_risks,
        denied_risks,
        bindings: bindings as AccessTokenContext['bindings'],
        provider_admins: providerAdmins as AccessTokenContext['provider_admins'],
      };
      return ctx;
    },
    async touchLastUsed(accessTokenId) {
      await supabase
        .from('tokens')
        .update({ last_used_at: new Date().toISOString() })
        .eq('id', accessTokenId);
    },
    async consumeAccessToken(accessTokenId) {
      // Atomic single-use burn : the WHERE clause guarantees we win the race.
      const { data, error } = await supabase
        .from('tokens')
        .update({ status: 'revoked', consumed_at: new Date().toISOString() })
        .eq('id', accessTokenId)
        .eq('single_use', true)
        .is('consumed_at', null)
        .select('id');
      if (error) {
        console.error('[gateway] consumeAccessToken failed', error);
        return false;
      }
      return (data ?? []).length > 0;
    },
  };

  const upstreamByProvider: Partial<Record<Provider, UpstreamAdapter>> = {};

  // ProviderAdmin loader (shared across providers — they all hit the same table).
  const loadProviderAdmin = async (
    orgId: string,
    provider: Provider,
  ): Promise<ProviderAdmin | null> => {
    const { data } = await supabase
      .from('provider_admins')
      .select('*')
      .eq('organization_id', orgId)
      .eq('provider', provider)
      .maybeSingle<ProviderAdmin>();
    if (!data) return null;
    const rawAccess = decodeBytea(data.access_token_encrypted);
    const rawRefresh = decodeBytea(data.refresh_token_encrypted);
    return {
      ...data,
      access_token_encrypted: rawAccess
        ? new TextEncoder().encode(await decryptProviderSecret(orgId, rawAccess))
        : null,
      refresh_token_encrypted: rawRefresh
        ? new TextEncoder().encode(await decryptProviderSecret(orgId, rawRefresh))
        : null,
    };
  };

  // GitHub: PAT-fallback always available ; App credentials optional.
  // loadGithubBindings is required by github__mint_install_token to scope the
  // minted token to the project's repos — ADR mint-install-token-credential.
  const loadGithubBindings = async (projectId: string): Promise<ProviderBinding[]> => {
    const { data } = await supabase
      .from('provider_bindings')
      .select('*')
      .eq('project_id', projectId)
      .eq('provider', 'github');
    return (data ?? []) as ProviderBinding[];
  };
  const ghAdapter = new GitHubAdapter({
    ...(getGitHubAppCredentials() ?? {}),
    loadGithubBindings,
  });
  upstreamByProvider.github = {
    provider: 'github',
    availableTools: githubAvailableTools,
    classifyV4: (tool, args, bindings) => ghAdapter.classifyV4(tool, args, bindings),
    executeCall: (admin, binding, tool, args) => ghAdapter.executeCall(admin, binding, tool, args),
    loadProviderAdmin,
  };

  // Vercel: PAT (Personal Access Token) scoped to a team.
  const vercelAdapter = new VercelAdapter({ venvStore });
  upstreamByProvider.vercel = {
    provider: 'vercel',
    availableTools: vercelAvailableTools,
    classifyV4: (tool, args, bindings) => vercelAdapter.classifyV4(tool, args, bindings),
    executeCall: (admin, binding, tool, args) =>
      vercelAdapter.executeCall(admin, binding, tool, args),
    loadProviderAdmin,
  };

  // Supabase: OAuth or paste-token mode (Management API).
  const supabaseAdapter = new SupabaseAdapter({
    venvStore,
    clientId: process.env.SUPABASE_APP_CLIENT_ID,
    clientSecret: process.env.SUPABASE_APP_CLIENT_SECRET,
    persistRefresh: async (admin, tokens) => {
      await supabase
        .from('provider_admins')
        .update({
          access_token_encrypted: encodeByteaHexRaw(
            await encryptProviderSecret(admin.organization_id, tokens.accessToken),
          ),
          refresh_token_encrypted: encodeByteaHexRaw(
            await encryptProviderSecret(admin.organization_id, tokens.refreshToken),
          ),
          expires_at: tokens.expiresAt.toISOString(),
        })
        .eq('id', admin.id);
    },
  });
  upstreamByProvider.supabase = {
    provider: 'supabase',
    availableTools: supabaseAvailableTools,
    classifyV4: (tool, args, bindings) => supabaseAdapter.classifyV4(tool, args, bindings),
    executeCall: (admin, binding, tool, args) =>
      supabaseAdapter.executeCall(admin, binding, tool, args),
    retryAfterAuthFailure: (admin, binding, tool, args) =>
      supabaseAdapter.retryAfterAuthFailure(admin, binding, tool, args),
    loadProviderAdmin,
  };

  // Railway: OAuth Auth app — short-lived (1h) token refreshed on the hot-path.
  const railwayAdapter = new RailwayAdapter({
    clientId: process.env.RAILWAY_CLIENT_ID,
    clientSecret: process.env.RAILWAY_CLIENT_SECRET,
    persistRefresh: async (admin, tokens) => {
      await supabase
        .from('provider_admins')
        .update({
          access_token_encrypted: encodeByteaHexRaw(
            await encryptProviderSecret(admin.organization_id, tokens.accessToken),
          ),
          refresh_token_encrypted: encodeByteaHexRaw(
            await encryptProviderSecret(admin.organization_id, tokens.refreshToken),
          ),
          expires_at: tokens.expiresAt.toISOString(),
        })
        .eq('id', admin.id);
    },
  });
  upstreamByProvider.railway = {
    provider: 'railway',
    availableTools: railwayAvailableTools,
    classifyV4: (tool, args, bindings) => railwayAdapter.classifyV4(tool, args, bindings),
    executeCall: (admin, binding, tool, args) =>
      railwayAdapter.executeCall(admin, binding, tool, args),
    retryAfterAuthFailure: (admin, binding, tool, args) =>
      railwayAdapter.retryAfterAuthFailure(admin, binding, tool, args),
    loadProviderAdmin,
  };

  // Bash : per-binding annotated dispatch lands in a follow-up PR. Until then
  // the bash provider has no /mcp tools — the UI runner endpoint
  // (/api/v1/bash-bindings/:id/run-tool) drives invocations through a
  // session-authenticated path.

  // Upstash Redis : paste-token mode (email:api_key from provider_admins).
  const upstashRedisAdapter = new UpstashRedisAdapter();
  upstreamByProvider['upstash-redis'] = {
    provider: 'upstash-redis',
    availableTools: upstashRedisAvailableTools,
    classifyV4: (tool, args, bindings) => upstashRedisAdapter.classifyV4(tool, args, bindings),
    executeCall: (admin, binding, tool, args) =>
      upstashRedisAdapter.executeCall(admin, binding, tool, args),
    loadProviderAdmin,
  };

  // Resend : paste-token mode (re_* API key from provider_admins).
  const resendAdapter = new ResendAdapter();
  upstreamByProvider.resend = {
    provider: 'resend',
    availableTools: resendAvailableTools,
    classifyV4: (tool, args, bindings) => resendAdapter.classifyV4(tool, args, bindings),
    executeCall: (admin, binding, tool, args) =>
      resendAdapter.executeCall(admin, binding, tool, args),
    loadProviderAdmin,
  };

  // Cloudflare DNS : paste-token mode (API Token or Global API Key from provider_admins).
  const cloudflareDnsAdapter = new CloudflareDnsAdapter();
  upstreamByProvider['cloudflare-dns'] = {
    provider: 'cloudflare-dns',
    availableTools: cloudflareDnsAvailableTools,
    classifyV4: (tool, args, bindings) => cloudflareDnsAdapter.classifyV4(tool, args, bindings),
    executeCall: (admin, binding, tool, args) =>
      cloudflareDnsAdapter.executeCall(admin, binding, tool, args),
    loadProviderAdmin,
  };

  // Stripe : per-project self-contained (keys in stripe_bindings, not provider_admins).
  const stripeAdapter = new StripeAdapter();
  upstreamByProvider.stripe = {
    provider: 'stripe',
    availableTools: stripeAvailableTools,
    classifyV4: (tool, args, bindings) => stripeAdapter.classifyV4(tool, args, bindings),
    selfContained: true,
    executeCall: () => {
      throw new Error('stripe is self-contained — use executeCallSelfContained');
    },
    loadProviderAdmin: async () => null,
    async executeCallSelfContained(ctx, tool, args) {
      const binding = ctx.bindings.find((b) => b.provider === 'stripe');
      if (!binding) throw new Error('no stripe binding on this project');
      const { data: sb } = await supabase
        .from('stripe_bindings')
        .select('test_key_encrypted, live_key_encrypted')
        .eq('project_id', ctx.project.id)
        .eq('account_id', binding.resource_ref)
        .maybeSingle<{ test_key_encrypted: string | null; live_key_encrypted: string | null }>();
      if (!sb) throw new Error('stripe_bindings row not found — re-bind required');
      const enc = sb.live_key_encrypted ?? sb.test_key_encrypted;
      if (!enc) throw new Error('no API key configured for this Stripe binding');
      const encBytes = decodeBytea(enc);
      if (!encBytes) throw new Error('stripe key decryption failed — corrupt bytea');
      const token = await decryptProviderSecret(ctx.organization.id, encBytes);
      return stripeExecuteCall(fetch, token, tool, args);
    },
  };

  // Load per-provider risk catalogs at boot (lazy / cached in the loader).
  const catalogByProvider: Partial<Record<Provider, IndexedRiskCatalog>> = {};
  for (const provider of PROVIDERS) {
    const c = getCatalog(provider);
    if (c) catalogByProvider[provider] = c;
  }

  return new McpGateway({
    // Per-request build: this cache never outlives the request (plan §3.1).
    cache: new MemoryCacheClient(),
    audit: new SupabaseLegacyAuditWriter(supabase),
    contextLoader,
    upstreamByProvider: upstreamByProvider as Record<Provider, UpstreamAdapter>,
    catalogByProvider,
    clientIp: opts.clientIp,
    clientUserAgent: opts.clientUserAgent,
    async onProviderAuthFailure(orgId, provider) {
      await supabase
        .from('provider_admins')
        .update({ status: 'expired' })
        .eq('organization_id', orgId)
        .eq('provider', provider)
        .eq('status', 'connected');
    },
  });
}
