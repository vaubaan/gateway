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
import {
  vpsSshAvailableTools,
  isReadAllowed,
  sshExec,
  type VpsSshBinding,
} from '@vaubaan/providers-vps-ssh';
import type {
  AccessTokenContext,
  Provider,
  ProviderAdmin,
  ProviderBinding,
  Role,
} from '@vaubaan/shared';
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

interface VpsSshBindingRow {
  id: string;
  project_id: string;
  host_slug: string;
  host_address: string;
  port: number;
  ssh_user: string;
  ssh_private_key: unknown;
}

class VpsSshAdapter implements UpstreamAdapter {
  readonly provider = 'vps-ssh' as const;
  readonly availableTools = vpsSshAvailableTools;
  readonly selfContained = true;

  constructor(private readonly supabase: ReturnType<typeof getSupabaseServiceClient>) {}

  async executeCall(
    _admin: ProviderAdmin,
    _binding: ProviderBinding,
    _tool: string,
    _args: Record<string, unknown>,
  ): Promise<unknown> {
    throw new Error('use executeCallSelfContained for vps-ssh');
  }

  async loadProviderAdmin(): Promise<ProviderAdmin | null> {
    return null;
  }

  async executeCallSelfContained(
    ctx: AccessTokenContext,
    _tool: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    const hostSlug = typeof args['host_slug'] === 'string' ? args['host_slug'] : '';
    const cmd = typeof args['cmd'] === 'string' ? args['cmd'] : '';
    const timeoutRaw = typeof args['timeout_s'] === 'number' ? args['timeout_s'] : 30;
    const timeoutS = Math.min(timeoutRaw, 300);

    if (!hostSlug) throw new Error('host_slug is required');
    if (!cmd) throw new Error('cmd is required');

    // Determine if caller has only :read role (not :write)
    const vpsSshRoles = ctx.roles.filter((r) => r.provider === 'vps-ssh');
    const hasWrite = vpsSshRoles.some((r) => r.name === 'vps-ssh:write');
    if (!hasWrite && !isReadAllowed(cmd)) {
      throw new Error(
        `Command blocked by vps-ssh:read policy. Only read-only commands are allowed with this role.`,
      );
    }

    // Load the SSH binding for this project + host
    const { data: row } = await this.supabase
      .from('vps_ssh_bindings')
      .select('id, project_id, host_slug, host_address, port, ssh_user, ssh_private_key')
      .eq('project_id', ctx.project.id)
      .eq('host_slug', hostSlug)
      .maybeSingle<VpsSshBindingRow>();

    if (!row) {
      throw new Error(`SSH binding '${hostSlug}' not found for this project.`);
    }

    const keyBytes = decodeBytea(row.ssh_private_key);
    if (!keyBytes) {
      throw new Error(`SSH private key for '${hostSlug}' is missing or corrupt.`);
    }
    const keyPem = new TextDecoder().decode(keyBytes);

    const binding: VpsSshBinding = {
      host_address: row.host_address,
      port: row.port,
      ssh_user: row.ssh_user,
      ssh_private_key_pem: keyPem,
    };

    const result = await sshExec(binding, cmd, timeoutS);

    // Write to vps_ssh_audit (best-effort)
    void Promise.resolve(
      this.supabase.from('vps_ssh_audit').insert({
        project_id: ctx.project.id,
        access_token_id: ctx.access_token.id,
        host_slug: hostSlug,
        cmd,
        exit_code: result.exit_code,
        stdout_len: result.stdout.length,
        duration_ms: result.duration_ms,
      }),
    ).catch((e: unknown) => console.error('[vps-ssh] audit write failed', e));

    return result;
  }
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
        .select('id, name, project_id, status, api_key_prefix, expires_at')
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
      const { data: tokenRoles } = await supabase
        .from('access_token_roles')
        .select('role:roles(*)')
        .eq('access_token_id', accessTokenId);
      const roles: Role[] = ((tokenRoles ?? []) as unknown as Array<{ role: Role | null }>)
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
      const ctx: AccessTokenContext = {
        access_token: tk,
        project,
        organization: org,
        roles,
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
    executeCall: (admin, binding, tool, args) =>
      railwayAdapter.executeCall(admin, binding, tool, args),
    loadProviderAdmin,
  };

  // VPS-SSH: self-contained (per-project SSH bindings, no provider_admins row).
  const vpsSshAdapter = new VpsSshAdapter(supabase);
  upstreamByProvider['vps-ssh'] = vpsSshAdapter;

  return new McpGateway({
    cache: buildCacheClient(),
    audit: new SupabaseAuditWriter(supabase as SupabaseLike),
    contextLoader,
    upstreamByProvider: upstreamByProvider as Record<Provider, UpstreamAdapter>,
    clientIp: opts.clientIp,
    clientUserAgent: opts.clientUserAgent,
  });
}
