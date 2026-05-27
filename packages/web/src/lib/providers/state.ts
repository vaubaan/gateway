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
import { decodeBytea, encodeByteaHex } from './bytea';

export { encodeByteaHex } from './bytea';

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

/** Pull the first useful line out of a (potentially JSON) error body. */
async function readErrorSnippet(res: Response): Promise<string> {
  const text = await res.text().catch(() => '');
  if (!text) return `HTTP ${res.status}`;
  // JSON shape: {error:{message,...}} or {message,...} or {error_description,...}.
  try {
    const j = JSON.parse(text) as Record<string, unknown>;
    const msg =
      (typeof j.message === 'string' && j.message) ||
      (typeof j.error_description === 'string' && j.error_description) ||
      (typeof j.error === 'string' && j.error) ||
      (typeof j.error === 'object' &&
        j.error !== null &&
        typeof (j.error as Record<string, unknown>).message === 'string' &&
        ((j.error as Record<string, unknown>).message as string)) ||
      null;
    if (msg) return `HTTP ${res.status}: ${msg}`;
  } catch {
    // fall through — plain text
  }
  return `HTTP ${res.status}: ${text.slice(0, 200)}`;
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
      // Marketplace-Integration tokens often can't hit /v9/projects directly —
      // they're scoped to the integration's own configuration. Try the
      // integration-configurations endpoint as a fallback: it returns the
      // project IDs the integration is enabled on, with the same token.
      const fallbackProjects = await listVercelProjectsViaConfiguration(token, teamId, teamSlug);
      if (fallbackProjects.resources) {
        base.resources = fallbackProjects.resources;
        if (fallbackProjects.note) base.error = fallbackProjects.note;
      } else {
        const snippet = await readErrorSnippet(projRes);
        base.error =
          projRes.status === 403
            ? `${snippet} — Marketplace-Integration tokens are scoped to the integration's own configuration and can't list every team project. Bind by typing the Vercel project id (\`prj_…\`) manually, or reinstall as a fully-scoped integration.`
            : snippet;
      }
    }
  } catch (e) {
    base.error = e instanceof Error ? e.message : String(e);
  }
  return base;
}

/**
 * Fallback path for Vercel Marketplace tokens that 403 on `/v9/projects`. We
 * pull the integration's configuration object (`/v1/integrations/configurations`)
 * which lists the project IDs the integration is enabled on. The endpoint
 * accepts the integration's own access token.
 */
async function listVercelProjectsViaConfiguration(
  token: string,
  teamId: string | null,
  teamSlug: string | null,
): Promise<{ resources: ProviderResource[] | null; note?: string }> {
  const url = teamId
    ? `https://api.vercel.com/v1/integrations/configurations?view=account&teamId=${encodeURIComponent(teamId)}`
    : `https://api.vercel.com/v1/integrations/configurations?view=account`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) return { resources: null };
  const list = (await res.json()) as Array<{
    id: string;
    projects: string[] | null;
  }>;
  if (!Array.isArray(list) || list.length === 0) return { resources: null };
  const config = list[0]!;
  if (config.projects === null) {
    // "All projects" mode but we can't enumerate names without /v9/projects.
    return {
      resources: null,
      note: 'Integration is enabled on every project, but project names are not visible to the integration token. Bind by typing the Vercel project id (`prj_…`) manually.',
    };
  }
  const resources = config.projects.map((id) => ({
    ref: id,
    name: id,
    url: teamSlug ? `https://vercel.com/${teamSlug}/${id}` : undefined,
  }));
  return { resources };
}

/**
 * Refresh a Supabase access_token using the stored refresh_token. Persists the
 * new pair + expires_at. Returns the new access_token (or null on failure).
 */
async function refreshSupabaseToken(admin: AdminRow): Promise<string | null> {
  const clientId = process.env.SUPABASE_APP_CLIENT_ID;
  const clientSecret = process.env.SUPABASE_APP_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;
  const refreshBytes = decodeBytea(admin.refresh_token_encrypted);
  if (!refreshBytes) return null;
  const refresh = new TextDecoder().decode(refreshBytes);
  const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const res = await fetch('https://api.supabase.com/v1/oauth/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${basicAuth}`,
    },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refresh }),
  });
  if (!res.ok) return null;
  const json = (await res.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };
  const expiresAt = new Date(Date.now() + json.expires_in * 1000).toISOString();
  const svc = getSupabaseServiceClient();
  await svc
    .from('provider_admins')
    .update({
      access_token_encrypted: encodeByteaHex(json.access_token),
      refresh_token_encrypted: encodeByteaHex(json.refresh_token),
      expires_at: expiresAt,
    })
    .eq('id', admin.id);
  return json.access_token;
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
  let token = new TextDecoder().decode(bytes);

  // Supabase OAuth access_tokens expire in 1h. Pre-emptively refresh if we're
  // within 60s of expiry (or already past). On refresh failure we still try
  // the current token — it might be a paste-PAT (no expires_at).
  const expiresAt = admin.expires_at ? Date.parse(admin.expires_at) : null;
  if (expiresAt !== null && expiresAt - Date.now() < 60_000) {
    const fresh = await refreshSupabaseToken(admin);
    if (fresh) token = fresh;
  }

  try {
    let [projectsRes, orgsRes] = await Promise.all([
      fetch('https://api.supabase.com/v1/projects', {
        headers: { Authorization: `Bearer ${token}` },
      }),
      fetch('https://api.supabase.com/v1/organizations', {
        headers: { Authorization: `Bearer ${token}` },
      }),
    ]);

    // Reactive refresh: if the first call comes back 401/403 with a non-paste
    // token, try once more with a fresh access_token.
    if (
      (projectsRes.status === 401 || projectsRes.status === 403) &&
      admin.refresh_token_encrypted
    ) {
      const fresh = await refreshSupabaseToken(admin);
      if (fresh) {
        token = fresh;
        [projectsRes, orgsRes] = await Promise.all([
          fetch('https://api.supabase.com/v1/projects', {
            headers: { Authorization: `Bearer ${token}` },
          }),
          fetch('https://api.supabase.com/v1/organizations', {
            headers: { Authorization: `Bearer ${token}` },
          }),
        ]);
      }
    }

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
      const snippet = await readErrorSnippet(projectsRes);
      base.error =
        projectsRes.status === 401 || projectsRes.status === 403
          ? `${snippet} — the Supabase Management API rejected the stored token. Disconnect and reconnect Supabase to mint a fresh one. In the meantime, bind by typing a Supabase project ref (20 lowercase chars) manually.`
          : snippet;
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
