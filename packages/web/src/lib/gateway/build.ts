/**
 * Build a configured `McpGateway` for the current Next.js runtime.
 *
 * Spec : docs/spec/mcp-proxy.md §7.
 * ADRs : docs/decisions/redis-cache-upstash-with-memory-fallback.md.
 */

import { GitHubAdapter, githubAvailableTools } from '@vaubaan/providers-github';
import { VercelAdapter, vercelAvailableTools } from '@vaubaan/providers-vercel';
import { SupabaseAdapter, supabaseAvailableTools } from '@vaubaan/providers-supabase';
import type { BotContext, Provider, ProviderAdmin, Role } from '@vaubaan/shared';
import {
  McpGateway,
  buildCacheClient,
  SupabaseAuditWriter,
  type ContextLoader,
  type SupabaseLike,
  type UpstreamAdapter,
} from '@vaubaan/mcp-gateway';
import { getSupabaseServiceClient } from '@/lib/supabase/server';

/**
 * Supabase returns `bytea` columns as a `\xHEX` string. Decode to Uint8Array
 * so adapters can `new TextDecoder().decode(...)` the PAT.
 */
function parseByteaHex(raw: unknown): Uint8Array | null {
  if (raw === null || raw === undefined) return null;
  if (raw instanceof Uint8Array) return raw;
  if (typeof raw !== 'string') return null;
  const hex = raw.startsWith('\\x') ? raw.slice(2) : raw;
  if (!/^[0-9a-f]*$/i.test(hex) || hex.length % 2 !== 0) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function getGitHubAppCredentials() {
  const appId = process.env.GITHUB_APP_ID;
  const slug = process.env.GITHUB_APP_SLUG ?? 'vaubaan-gateway';
  const privateKey = process.env.GITHUB_APP_PRIVATE_KEY;
  if (!appId || !privateKey) return null;
  // Vercel env vars escape \n — un-escape before importing.
  const pem = privateKey.replace(/\\n/g, '\n');
  return { appId, appSlug: slug, privateKeyPem: pem };
}

interface BotAuthRow {
  id: string;
  api_key_hash: string;
  status: string;
}

interface BotRow {
  id: string;
  name: string;
  project_id: string;
  status: 'active' | 'revoked';
  api_key_prefix: string;
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
    async loadBotForAuth(prefix) {
      const { data } = await supabase
        .from('bots')
        .select('id, api_key_hash, status')
        .eq('api_key_prefix', prefix)
        .maybeSingle<BotAuthRow>();
      return data;
    },
    async loadBotContext(botId) {
      const { data: bot } = await supabase
        .from('bots')
        .select('id, name, project_id, status, api_key_prefix')
        .eq('id', botId)
        .maybeSingle<BotRow>();
      if (!bot) return null;
      const { data: project } = await supabase
        .from('projects')
        .select('id, slug, organization_id')
        .eq('id', bot.project_id)
        .maybeSingle<ProjectRow>();
      if (!project) return null;
      const { data: org } = await supabase
        .from('organizations')
        .select('id, slug, name')
        .eq('id', project.organization_id)
        .maybeSingle<OrgRow>();
      if (!org) return null;
      const { data: botRoles } = await supabase
        .from('bot_roles')
        .select('role:roles(*)')
        .eq('bot_id', botId);
      const roles: Role[] = ((botRoles ?? []) as unknown as Array<{ role: Role | null }>)
        .map((r) => r.role)
        .filter((r): r is Role => r !== null);
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
      const ctx: BotContext = {
        bot,
        project,
        organization: org,
        roles,
        bindings: bindings as BotContext['bindings'],
        provider_admins: providerAdmins as BotContext['provider_admins'],
      };
      return ctx;
    },
    async touchLastUsed(botId) {
      await supabase
        .from('bots')
        .update({ last_used_at: new Date().toISOString() })
        .eq('id', botId);
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
      access_token_encrypted: parseByteaHex(data.access_token_encrypted),
      refresh_token_encrypted: parseByteaHex(data.refresh_token_encrypted),
    };
  };

  // GitHub: PAT-fallback always available ; App credentials optional.
  const ghAdapter = new GitHubAdapter(getGitHubAppCredentials() ?? {});
  upstreamByProvider.github = {
    provider: 'github',
    availableTools: githubAvailableTools,
    executeCall: (admin, binding, tool, args) => ghAdapter.executeCall(admin, binding, tool, args),
    loadProviderAdmin,
  };

  // Vercel: paste-token mode (team token from .env.test or per-customer).
  const vercelAdapter = new VercelAdapter();
  upstreamByProvider.vercel = {
    provider: 'vercel',
    availableTools: vercelAvailableTools,
    executeCall: (admin, binding, tool, args) =>
      vercelAdapter.executeCall(admin, binding, tool, args),
    loadProviderAdmin,
  };

  // Supabase: paste-token mode (Management API PAT).
  const supabaseAdapter = new SupabaseAdapter();
  upstreamByProvider.supabase = {
    provider: 'supabase',
    availableTools: supabaseAvailableTools,
    executeCall: (admin, binding, tool, args) =>
      supabaseAdapter.executeCall(admin, binding, tool, args),
    loadProviderAdmin,
  };

  return new McpGateway({
    cache: buildCacheClient(),
    audit: new SupabaseAuditWriter(supabase as unknown as SupabaseLike),
    contextLoader,
    upstreamByProvider: upstreamByProvider as Record<Provider, UpstreamAdapter>,
    clientIp: opts.clientIp,
    clientUserAgent: opts.clientUserAgent,
  });
}
