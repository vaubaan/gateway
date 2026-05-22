/**
 * Browser-side health probe. Given a Resource's catalog kind, its
 * provider_ref + provider_metadata, and an unsealed access record, do
 * a synchronous HTTP probe against the real provider API and report
 * the result.
 *
 * Replaces the deferred Runner-mediated `kind.healthTestCmd` execution
 * from the original spec. Rationale (validated with maintainer) : the
 * unsealed cleartext is already in the user's tab when they click
 * "Test now", so routing through a Runner buys no ZK gain — only one
 * more failure mode + latency.
 *
 * The probe never throws ; it always resolves to a `HealthProbeResult`
 * with `ok=true|false`. Caller persists it via `POST /resources/:rId/health`.
 */

export interface HealthProbeResult {
  readonly ok: boolean;
  readonly status: 'connected' | 'failed' | 'unknown';
  readonly message: string;
}

export interface ProbeInput {
  readonly kindId: string;
  readonly providerRef: string | null;
  readonly metadata: Record<string, unknown>;
  readonly access: Record<string, string>;
}

async function fetchOk(
  url: string,
  headers: Record<string, string>,
  expectStatuses: ReadonlyArray<number> = [200],
): Promise<HealthProbeResult> {
  try {
    const res = await fetch(url, { method: 'GET', headers, cache: 'no-store' });
    if (expectStatuses.includes(res.status)) {
      return { ok: true, status: 'connected', message: `GET ${url} → ${String(res.status)}` };
    }
    return { ok: false, status: 'failed', message: `GET ${url} → ${String(res.status)}` };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, status: 'failed', message: `network: ${msg}` };
  }
}

export async function runHealthProbe(input: ProbeInput): Promise<HealthProbeResult> {
  const { kindId, providerRef, metadata, access } = input;
  const ref = providerRef ?? '';

  // GITHUB ───────────────────────────────────────────────────────────
  if (kindId === 'github-org' || kindId === 'github-org-admin') {
    const token = access.GITHUB_TOKEN;
    if (!token) return { ok: false, status: 'unknown', message: 'no GITHUB_TOKEN unsealed' };
    return fetchOk(`https://api.github.com/orgs/${encodeURIComponent(ref)}`, {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
    });
  }
  if (kindId === 'github-repo') {
    const token = access.GITHUB_TOKEN;
    if (!token) return { ok: false, status: 'unknown', message: 'no GITHUB_TOKEN unsealed' };
    return fetchOk(`https://api.github.com/repos/${ref}`, {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
    });
  }

  // VERCEL ───────────────────────────────────────────────────────────
  if (kindId === 'vercel-team' || kindId === 'vercel-team-admin') {
    const token = access.VERCEL_TOKEN;
    const teamId = access.VERCEL_TEAM_ID ?? ref;
    if (!token) return { ok: false, status: 'unknown', message: 'no VERCEL_TOKEN unsealed' };
    return fetchOk(`https://api.vercel.com/v2/teams/${encodeURIComponent(teamId)}`, {
      Authorization: `Bearer ${token}`,
    });
  }
  if (kindId === 'vercel-project') {
    const token = access.VERCEL_TOKEN;
    const teamId = access.VERCEL_TEAM_ID ?? (metadata.team_id as string | undefined) ?? '';
    if (!token) return { ok: false, status: 'unknown', message: 'no VERCEL_TOKEN unsealed' };
    const url = teamId
      ? `https://api.vercel.com/v9/projects/${encodeURIComponent(ref)}?teamId=${encodeURIComponent(teamId)}`
      : `https://api.vercel.com/v9/projects/${encodeURIComponent(ref)}`;
    return fetchOk(url, { Authorization: `Bearer ${token}` });
  }

  // SUPABASE ─────────────────────────────────────────────────────────
  if (kindId === 'supabase-org' || kindId === 'supabase-org-admin') {
    const token = access.SUPABASE_ACCESS_TOKEN ?? access.SUPABASE_TOKEN;
    if (!token) {
      return { ok: false, status: 'unknown', message: 'no SUPABASE_ACCESS_TOKEN unsealed' };
    }
    // The mgmt API doesn't have a per-org get-by-slug endpoint, but
    // GET /v1/organizations returns the list scoped to the token's
    // identity. 200 + the ref in the list = healthy.
    try {
      const res = await fetch('https://api.supabase.com/v1/organizations', {
        headers: { Authorization: `Bearer ${token}` },
        cache: 'no-store',
      });
      if (res.status !== 200) {
        return {
          ok: false,
          status: 'failed',
          message: `GET /v1/organizations → ${String(res.status)}`,
        };
      }
      const orgs = (await res.json()) as ReadonlyArray<{ id?: string; slug?: string }>;
      const found = orgs.some((o) => o.id === ref || o.slug === ref);
      return found
        ? { ok: true, status: 'connected', message: `org ${ref} visible to the token` }
        : { ok: false, status: 'failed', message: `org ${ref} not in /organizations response` };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, status: 'failed', message: `network: ${msg}` };
    }
  }
  if (kindId === 'supabase-project') {
    const token = access.SUPABASE_ACCESS_TOKEN ?? access.SUPABASE_TOKEN;
    if (!token) {
      return { ok: false, status: 'unknown', message: 'no SUPABASE_ACCESS_TOKEN unsealed' };
    }
    return fetchOk(`https://api.supabase.com/v1/projects/${encodeURIComponent(ref)}`, {
      Authorization: `Bearer ${token}`,
    });
  }

  return {
    ok: false,
    status: 'unknown',
    message: `no probe defined for kind ${kindId} (handbook resources-and-access.md)`,
  };
}
