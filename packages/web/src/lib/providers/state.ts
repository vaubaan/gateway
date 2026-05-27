/**
 * Server-side helpers that turn a connected `provider_admins` row into the
 * shape the UI needs : a list of bindable resources, the granter's identity,
 * a deep-link to manage the connection on the provider's side, and a summary
 * of the scope that was granted.
 *
 * Used by:
 *   - Cloud providers card (org home) → rich state per provider
 *   - Bindings/new wizard            → dropdown of selectable resources
 */

import { buildAppJwt, mintInstallationToken } from '@vaubaan/providers-github';
import type { Provider, ProviderAdminStatus } from '@vaubaan/shared';
import { getSupabaseServiceClient } from '@/lib/supabase/server';

export interface ProviderResource {
  ref: string;
  name: string;
  url?: string;
  description?: string;
}

export interface ProviderState {
  provider: Provider;
  status: ProviderAdminStatus | 'not_connected';
  connectedAt: string | null;
  connectedByEmail: string | null;
  /** Deep-link to manage / revoke the install on the provider's side. */
  serviceUrl: string | null;
  /** Human label of what was granted (team name, account name, etc.). */
  account: string | null;
  /** Bullet list of permissions/scopes granted (provider-specific phrasing). */
  scopes: string[];
  /** Concrete bindable resources (repos, projects, ...) reachable with the granted token. */
  resources: ProviderResource[];
  /** Free-form error or note (e.g. token expired, listing failed). */
  error: string | null;
}

interface AdminRow {
  id: string;
  organization_id: string;
  provider: Provider;
  status: ProviderAdminStatus;
  installation_id: string | null;
  team_id: string | null;
  access_token_encrypted: unknown;
  refresh_token_encrypted: unknown;
  expires_at: string | null;
  connected_by_user_id: string | null;
  connected_at: string;
}

function decodeBytea(raw: unknown): Uint8Array | null {
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

function getGitHubAppCreds() {
  const appId = process.env.GITHUB_APP_ID;
  const slug = process.env.GITHUB_APP_SLUG ?? 'vaubaan-gateway';
  const privateKey = process.env.GITHUB_APP_PRIVATE_KEY;
  if (!appId || !privateKey) return null;
  return { appId, appSlug: slug, privateKeyPem: privateKey.replace(/\\n/g, '\n') };
}

async function loadGranterEmail(userId: string | null): Promise<string | null> {
  if (!userId) return null;
  const svc = getSupabaseServiceClient();
  // auth.admin.getUserById is the canonical way to fetch an auth user when you
  // hold the service-role key.
  const { data, error } = await svc.auth.admin.getUserById(userId);
  if (error || !data.user) return null;
  return data.user.email ?? null;
}

async function loadGitHubState(admin: AdminRow): Promise<ProviderState> {
  const creds = getGitHubAppCreds();
  const base: ProviderState = {
    provider: 'github',
    status: admin.status,
    connectedAt: admin.connected_at,
    connectedByEmail: await loadGranterEmail(admin.connected_by_user_id),
    serviceUrl: null,
    account: null,
    scopes: [],
    resources: [],
    error: null,
  };

  if (admin.status !== 'connected' || !admin.installation_id) {
    base.error = 'Not fully connected (no installation_id).';
    return base;
  }

  if (!creds) {
    base.error = 'GITHUB_APP_ID / GITHUB_APP_PRIVATE_KEY not configured on the server.';
    base.serviceUrl = `https://github.com/settings/installations/${admin.installation_id}`;
    return base;
  }

  try {
    const { token } = await mintInstallationToken({
      appId: creds.appId,
      privateKeyPem: creds.privateKeyPem,
      installationId: admin.installation_id,
    });
    const headers = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'vaubaan-mcp-proxy',
      'X-GitHub-Api-Version': '2022-11-28',
    };

    const appJwt = await buildAppJwt({ appId: creds.appId, privateKeyPem: creds.privateKeyPem });
    const [installRes, reposRes] = await Promise.all([
      fetch(`https://api.github.com/app/installations/${admin.installation_id}`, {
        // App-JWT endpoint, not installation-token.
        headers: { ...headers, Authorization: `Bearer ${appJwt}` },
      }),
      fetch(`https://api.github.com/installation/repositories?per_page=100`, { headers }),
    ]);

    if (installRes.ok) {
      const install = (await installRes.json()) as {
        account?: { login?: string; html_url?: string };
        repository_selection?: 'all' | 'selected';
        permissions?: Record<string, string>;
        html_url?: string;
      };
      base.account = install.account?.login ?? null;
      base.serviceUrl =
        install.html_url ?? `https://github.com/settings/installations/${admin.installation_id}`;
      if (install.repository_selection === 'all') {
        base.scopes.push('All repositories on this account');
      } else {
        base.scopes.push('Selected repositories only');
      }
      for (const [perm, level] of Object.entries(install.permissions ?? {})) {
        base.scopes.push(`${perm}: ${level}`);
      }
    } else {
      // Fallback service URL.
      base.serviceUrl = `https://github.com/settings/installations/${admin.installation_id}`;
    }

    if (reposRes.ok) {
      const json = (await reposRes.json()) as {
        repositories: Array<{ full_name: string; html_url: string; description: string | null }>;
      };
      base.resources = json.repositories.map((r) => ({
        ref: r.full_name,
        name: r.full_name,
        url: r.html_url,
        description: r.description ?? undefined,
      }));
    } else {
      base.error = `Could not list repositories (${reposRes.status}).`;
    }
  } catch (e) {
    base.error = e instanceof Error ? e.message : String(e);
  }

  return base;
}

async function loadVercelState(admin: AdminRow): Promise<ProviderState> {
  const base: ProviderState = {
    provider: 'vercel',
    status: admin.status,
    connectedAt: admin.connected_at,
    connectedByEmail: await loadGranterEmail(admin.connected_by_user_id),
    serviceUrl: admin.team_id ? `https://vercel.com/teams/${admin.team_id}/settings` : null,
    account: null,
    scopes: ['Manage projects & deployments for the team', 'Read/write all team resources'],
    resources: [],
    error: null,
  };
  const bytes = decodeBytea(admin.access_token_encrypted);
  if (!bytes) {
    base.error = 'Token missing — reconnect required.';
    return base;
  }
  const token = new TextDecoder().decode(bytes);
  let teamSlug: string | null = null;
  try {
    const teamId = admin.team_id;
    if (teamId) {
      const teamRes = await fetch(`https://api.vercel.com/v2/teams/${teamId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (teamRes.ok) {
        const team = (await teamRes.json()) as { name?: string; slug?: string };
        base.account = team.name ?? team.slug ?? teamId;
        teamSlug = team.slug ?? null;
        if (team.slug) base.serviceUrl = `https://vercel.com/${team.slug}/~/integrations`;
      }
    }
    const url = teamId
      ? `https://api.vercel.com/v9/projects?teamId=${encodeURIComponent(teamId)}&limit=100`
      : `https://api.vercel.com/v9/projects?limit=100`;
    const projRes = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (projRes.ok) {
      const json = (await projRes.json()) as {
        projects: Array<{ id: string; name: string; framework?: string | null }>;
      };
      base.resources = json.projects.map((p) => ({
        ref: p.id,
        name: p.name,
        description: p.framework ?? undefined,
        url: teamSlug ? `https://vercel.com/${teamSlug}/${p.name}` : undefined,
      }));
    } else {
      base.error = `Could not list Vercel projects (${projRes.status}).`;
    }
  } catch (e) {
    base.error = e instanceof Error ? e.message : String(e);
  }
  return base;
}

async function loadSupabaseState(admin: AdminRow): Promise<ProviderState> {
  const base: ProviderState = {
    provider: 'supabase',
    status: admin.status,
    connectedAt: admin.connected_at,
    connectedByEmail: await loadGranterEmail(admin.connected_by_user_id),
    serviceUrl: 'https://supabase.com/dashboard/account/tokens',
    account: null,
    scopes: ['Full Management API access (read & write all projects of the PAT owner)'],
    resources: [],
    error: null,
  };
  const bytes = decodeBytea(admin.access_token_encrypted);
  if (!bytes) {
    base.error = 'Token missing — reconnect required.';
    return base;
  }
  const token = new TextDecoder().decode(bytes);
  try {
    const [projectsRes, orgsRes] = await Promise.all([
      fetch('https://api.supabase.com/v1/projects', {
        headers: { Authorization: `Bearer ${token}` },
      }),
      fetch('https://api.supabase.com/v1/organizations', {
        headers: { Authorization: `Bearer ${token}` },
      }),
    ]);
    if (orgsRes.ok) {
      const orgs = (await orgsRes.json()) as Array<{ id: string; name: string }>;
      if (orgs.length > 0) {
        base.account = orgs.map((o) => o.name).join(', ');
      }
    }
    if (projectsRes.ok) {
      const projects = (await projectsRes.json()) as Array<{
        id: string;
        name: string;
        region?: string;
        organization_id?: string;
      }>;
      base.resources = projects.map((p) => ({
        ref: p.id,
        name: p.name,
        description: p.region,
        url: `https://supabase.com/dashboard/project/${p.id}`,
      }));
    } else {
      base.error = `Could not list Supabase projects (${projectsRes.status}).`;
    }
  } catch (e) {
    base.error = e instanceof Error ? e.message : String(e);
  }
  return base;
}

export async function loadProviderState(orgId: string, provider: Provider): Promise<ProviderState> {
  const svc = getSupabaseServiceClient();
  const { data: admin } = await svc
    .from('provider_admins')
    .select(
      'id, organization_id, provider, status, installation_id, team_id, access_token_encrypted, refresh_token_encrypted, expires_at, connected_by_user_id, connected_at',
    )
    .eq('organization_id', orgId)
    .eq('provider', provider)
    .maybeSingle<AdminRow>();

  if (!admin) {
    return {
      provider,
      status: 'not_connected',
      connectedAt: null,
      connectedByEmail: null,
      serviceUrl: null,
      account: null,
      scopes: [],
      resources: [],
      error: null,
    };
  }

  if (provider === 'github') return loadGitHubState(admin);
  if (provider === 'vercel') return loadVercelState(admin);
  return loadSupabaseState(admin);
}
