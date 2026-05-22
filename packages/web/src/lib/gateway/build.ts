/**
 * Build a configured `McpGateway` for the current Next.js runtime.
 *
 * Spec : docs/spec/mcp-proxy.md §7.
 * ADRs : docs/decisions/redis-cache-upstash-with-memory-fallback.md.
 */

import { GitHubAdapter, githubAvailableTools } from '@vauban/providers-github';
import type { BotContext, Provider, ProviderAdmin, Role } from '@vauban/shared';
import {
  McpGateway,
  buildCacheClient,
  SupabaseAuditWriter,
  type ContextLoader,
  type SupabaseLike,
  type UpstreamAdapter,
} from '@vauban/mcp-gateway';
import { getSupabaseServiceClient } from '@/lib/supabase/server';

function getGitHubAppCredentials() {
  const appId = process.env.GITHUB_APP_ID;
  const slug = process.env.GITHUB_APP_SLUG ?? 'vauban-gateway';
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

  const ghCreds = getGitHubAppCredentials();
  if (ghCreds) {
    const adapter = new GitHubAdapter(ghCreds);
    upstreamByProvider.github = {
      provider: 'github',
      availableTools: githubAvailableTools,
      executeCall: (admin, binding, tool, args) => adapter.executeCall(admin, binding, tool, args),
      loadProviderAdmin: async (orgId, provider) => {
        const { data } = await supabase
          .from('provider_admins')
          .select('*')
          .eq('organization_id', orgId)
          .eq('provider', provider)
          .maybeSingle<ProviderAdmin>();
        return data;
      },
    };
  }

  return new McpGateway({
    cache: buildCacheClient(),
    audit: new SupabaseAuditWriter(supabase as unknown as SupabaseLike),
    contextLoader,
    upstreamByProvider: upstreamByProvider as Record<Provider, UpstreamAdapter>,
    clientIp: opts.clientIp,
    clientUserAgent: opts.clientUserAgent,
  });
}
