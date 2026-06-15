/**
 * Build a configured `McpGateway` for the current Next.js runtime.
 *
 * Spec : docs/spec/vaubaan-gateway.md §7.
 * ADRs : docs/decisions/redis-cache-upstash-with-memory-fallback.md.
 */

import { GitHubAdapter, githubAvailableTools } from '@vaubaan/providers-github';
import { VercelAdapter, vercelAvailableTools, classifyVercelV4 } from '@vaubaan/providers-vercel';
import {
  SupabaseAdapter,
  supabaseAvailableTools,
  classifySupabaseV4,
} from '@vaubaan/providers-supabase';
import {
  RailwayAdapter,
  railwayAvailableTools,
  classifyRailwayV4,
} from '@vaubaan/providers-railway';
import type {
  AccessTokenContext,
  Capability,
  Provider,
  ProviderAdmin,
  ProviderBinding,
  RiskId,
} from '@vaubaan/shared';
import { isValidCapability } from '@vaubaan/shared';
import type { IndexedRiskCatalog } from '@vaubaan/policy-engine';
import {
  McpGateway,
  buildCacheClient,
  SupabaseAuditWriter,
  type ContextLoader,
  type SupabaseLike,
  type UpstreamAdapter,
  type V4ClassifierAdapter,
} from '@vaubaan/mcp-gateway';
import { getSupabaseServiceClient } from '@/lib/supabase/server';
import { decodeBytea, encodeByteaHex } from '@/lib/providers/bytea';
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

interface AccessTokenAuthRow {
  id: string;
  api_key_hash: string;
  status: string;
}

interface AccessTokenRow {
  id: string;
  name: string;
  project_id: string;
  status: 'active' | 'revoked';
  api_key_prefix: string;
  expires_at: string | null;
  single_use: boolean;
  consumed_at: string | null;
  capabilities: unknown;
  /** v4 columns (migration 0025). Default `[]` when migration applied. */
  accepted_risks: unknown;
  denied_risks: unknown;
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

export function buildGateway(opts: {
  clientIp: string | null;
  clientUserAgent: string | null;
}): McpGateway {
  const supabase = getSupabaseServiceClient();

  const contextLoader: ContextLoader = {
    async loadAccessTokenForAuth(prefix) {
      const { data } = await supabase
        .from('access_tokens')
        .select('id, api_key_hash, status')
        .eq('api_key_prefix', prefix)
        .maybeSingle<AccessTokenAuthRow>();
      return data;
    },
    async loadAccessTokenContext(accessTokenId) {
      const { data: tk } = await supabase
        .from('access_tokens')
        .select(
          'id, name, project_id, status, api_key_prefix, expires_at, single_use, consumed_at, capabilities, accepted_risks, denied_risks',
        )
        .eq('id', accessTokenId)
        .maybeSingle<AccessTokenRow>();
      if (!tk) return null;
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
      const capabilities: Capability[] = Array.isArray(tk.capabilities)
        ? (tk.capabilities as unknown[]).filter(
            (c): c is Capability =>
              typeof c === 'object' && c !== null && isValidCapability(c as Capability),
          )
        : [];
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
      const bindings = (bindingsResp.data ?? []) as unknown;
      const providerAdmins = (providerAdminsResp.data ?? []) as unknown;
      const ctx: AccessTokenContext = {
        access_token: tk,
        project,
        organization: org,
        capabilities,
        accepted_risks,
        denied_risks,
        bindings: bindings as AccessTokenContext['bindings'],
        provider_admins: providerAdmins as AccessTokenContext['provider_admins'],
      };
      return ctx;
    },
    async touchLastUsed(accessTokenId) {
      await supabase
        .from('access_tokens')
        .update({ last_used_at: new Date().toISOString() })
        .eq('id', accessTokenId);
    },
    async consumeAccessToken(accessTokenId) {
      // Atomic single-use burn : the WHERE clause guarantees we win the race.
      const { data, error } = await supabase
        .from('access_tokens')
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
    // Supabase returns bytea as a hex-encoded `\x...` string. Convert to Uint8Array.
    return {
      ...data,
      access_token_encrypted: decodeBytea(data.access_token_encrypted),
      refresh_token_encrypted: decodeBytea(data.refresh_token_encrypted),
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
    toolCapabilities: (tool) => ghAdapter.toolCapabilities(tool),
    toolEnvResolution: (tool) => ghAdapter.toolEnvResolution(tool),
    classify: (tool, args, bindings) => ghAdapter.classify(tool, args, bindings),
    executeCall: (admin, binding, tool, args) => ghAdapter.executeCall(admin, binding, tool, args),
    resolveExcludeEnvs: (admin, binding) => ghAdapter.resolveExcludeEnvs(admin, binding),
    loadProviderAdmin,
  };

  // Vercel: paste-token mode (team token from .env.test or per-customer).
  const vercelAdapter = new VercelAdapter();
  upstreamByProvider.vercel = {
    provider: 'vercel',
    availableTools: vercelAvailableTools,
    toolCapabilities: (tool) => vercelAdapter.toolCapabilities(tool),
    toolEnvResolution: (tool) => vercelAdapter.toolEnvResolution(tool),
    classify: (tool, args, bindings) => vercelAdapter.classify(tool, args, bindings),
    executeCall: (admin, binding, tool, args) =>
      vercelAdapter.executeCall(admin, binding, tool, args),
    loadProviderAdmin,
  };

  // Supabase: paste-token mode (Management API PAT).
  const supabaseAdapter = new SupabaseAdapter();
  upstreamByProvider.supabase = {
    provider: 'supabase',
    availableTools: supabaseAvailableTools,
    toolCapabilities: (tool) => supabaseAdapter.toolCapabilities(tool),
    toolEnvResolution: (tool) => supabaseAdapter.toolEnvResolution(tool),
    classify: (tool, args, bindings) => supabaseAdapter.classify(tool, args, bindings),
    executeCall: (admin, binding, tool, args) =>
      supabaseAdapter.executeCall(admin, binding, tool, args),
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
          access_token_encrypted: encodeByteaHex(tokens.accessToken),
          refresh_token_encrypted: encodeByteaHex(tokens.refreshToken),
          expires_at: tokens.expiresAt.toISOString(),
        })
        .eq('id', admin.id);
    },
  });
  upstreamByProvider.railway = {
    provider: 'railway',
    availableTools: railwayAvailableTools,
    toolCapabilities: (tool) => railwayAdapter.toolCapabilities(tool),
    toolEnvResolution: (tool) => railwayAdapter.toolEnvResolution(tool),
    classify: (tool, args, bindings) => railwayAdapter.classify(tool, args, bindings),
    executeCall: (admin, binding, tool, args) =>
      railwayAdapter.executeCall(admin, binding, tool, args),
    loadProviderAdmin,
  };

  // Bash : per-binding annotated dispatch lands in a follow-up PR. Until then
  // the bash provider has no /mcp tools — the UI runner endpoint
  // (/api/v1/bash-bindings/:id/run-tool) drives invocations through a
  // session-authenticated path.

  // ── v4 plumbing ──────────────────────────────────────────────────────────
  // Wire the v4 classifiers we currently have. GitHub and SSH have no
  // classifyV4 shipped at the time of writing — tokens with v4
  // accepted_risks targeting those providers will get a `risk-not-accepted`
  // until the corresponding classifiers ship. The YAML catalogs are loaded
  // lazily by `getCatalog(provider)`.
  const v4ClassifierByProvider: Partial<Record<Provider, V4ClassifierAdapter>> = {
    vercel: { classifyV4: (tool, args, bindings) => classifyVercelV4(tool, args, bindings) },
    supabase: {
      classifyV4: (tool, args, bindings) => classifySupabaseV4(tool, args, bindings),
    },
    railway: {
      classifyV4: (tool, args, bindings) => classifyRailwayV4(tool, args, bindings),
    },
  };
  const v4CatalogByProvider: Partial<Record<Provider, IndexedRiskCatalog>> = {};
  for (const provider of ['github', 'vercel', 'supabase', 'railway', 'bash'] as Provider[]) {
    const c = getCatalog(provider);
    if (c) v4CatalogByProvider[provider] = c;
  }

  return new McpGateway({
    cache: buildCacheClient(),
    audit: new SupabaseAuditWriter(supabase as SupabaseLike),
    contextLoader,
    upstreamByProvider: upstreamByProvider as Record<Provider, UpstreamAdapter>,
    clientIp: opts.clientIp,
    clientUserAgent: opts.clientUserAgent,
    v4ClassifierByProvider,
    v4CatalogByProvider,
  });
}
