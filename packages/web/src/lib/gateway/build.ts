/**
 * Build a configured `McpGateway` for the current Next.js runtime.
 *
 * Spec : docs/spec/vaubaan-gateway.md §7.
 * ADRs : docs/decisions/redis-cache-upstash-with-memory-fallback.md.
 */

import { GitHubAdapter, githubAvailableTools } from '@vaubaan/providers-github';
import { VercelAdapter, vercelAvailableTools } from '@vaubaan/providers-vercel';
import { SupabaseAdapter, supabaseAvailableTools } from '@vaubaan/providers-supabase';
import { RailwayAdapter, railwayAvailableTools } from '@vaubaan/providers-railway';
import type {
  AccessTokenContext,
  Provider,
  ProviderAdmin,
  ProviderBinding,
  RiskId,
} from '@vaubaan/shared';
import type { IndexedRiskCatalog } from '@vaubaan/policy-engine';
import {
  McpGateway,
  buildCacheClient,
  SupabaseAuditWriter,
  type ContextLoader,
  type SupabaseLike,
  type UpstreamAdapter,
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

interface TokenAuthRow {
  id: string;
  api_key_hash: string;
  status: string;
}

interface TokenRow {
  id: string;
  name: string;
  parent_id: string | null;
  scope: 'org' | 'project';
  project_id: string | null;
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

export function buildGateway(opts: {
  clientIp: string | null;
  clientUserAgent: string | null;
}): McpGateway {
  const supabase = getSupabaseServiceClient();

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
    classifyV4: (tool, args, bindings) => ghAdapter.classifyV4(tool, args, bindings),
    executeCall: (admin, binding, tool, args) => ghAdapter.executeCall(admin, binding, tool, args),
    loadProviderAdmin,
  };

  // Vercel: paste-token mode (team token from .env.test or per-customer).
  const vercelAdapter = new VercelAdapter();
  upstreamByProvider.vercel = {
    provider: 'vercel',
    availableTools: vercelAvailableTools,
    classifyV4: (tool, args, bindings) => vercelAdapter.classifyV4(tool, args, bindings),
    executeCall: (admin, binding, tool, args) =>
      vercelAdapter.executeCall(admin, binding, tool, args),
    loadProviderAdmin,
  };

  // Supabase: paste-token mode (Management API PAT).
  const supabaseAdapter = new SupabaseAdapter();
  upstreamByProvider.supabase = {
    provider: 'supabase',
    availableTools: supabaseAvailableTools,
    classifyV4: (tool, args, bindings) => supabaseAdapter.classifyV4(tool, args, bindings),
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
    classifyV4: (tool, args, bindings) => railwayAdapter.classifyV4(tool, args, bindings),
    executeCall: (admin, binding, tool, args) =>
      railwayAdapter.executeCall(admin, binding, tool, args),
    loadProviderAdmin,
  };

  // Bash : per-binding annotated dispatch lands in a follow-up PR. Until then
  // the bash provider has no /mcp tools — the UI runner endpoint
  // (/api/v1/bash-bindings/:id/run-tool) drives invocations through a
  // session-authenticated path.

  // Load per-provider risk catalogs at boot (lazy / cached in the loader).
  const catalogByProvider: Partial<Record<Provider, IndexedRiskCatalog>> = {};
  for (const provider of ['github', 'vercel', 'supabase', 'railway', 'bash'] as Provider[]) {
    const c = getCatalog(provider);
    if (c) catalogByProvider[provider] = c;
  }

  return new McpGateway({
    cache: buildCacheClient(),
    audit: new SupabaseAuditWriter(supabase as SupabaseLike),
    contextLoader,
    upstreamByProvider: upstreamByProvider as Record<Provider, UpstreamAdapter>,
    catalogByProvider,
    clientIp: opts.clientIp,
    clientUserAgent: opts.clientUserAgent,
  });
}
