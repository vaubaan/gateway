/**
 * POST /api/integrations/vercel/connect
 *
 * Stores a Vercel Personal Access Token (PAT) for the organization.
 * Auto-detects the team via GET /v2/teams. If the PAT sees exactly one
 * team, connects immediately. If multiple, returns the list so the
 * frontend can let the user pick (then re-POST with teamId).
 *
 * Body: { org: string, token: string, teamId?: string }
 */

import { type NextRequest, NextResponse } from 'next/server';
import { requireOrgMember } from '@/lib/auth/require-org-member';
import { getSupabaseServer, getSupabaseServiceClient } from '@/lib/supabase/server';
import { encodeByteaHexRaw } from '@/lib/providers/bytea';
import { encryptProviderSecret } from '@/lib/crypto';

interface VercelTeam {
  id: string;
  name: string;
  slug: string;
}

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const body = (await req.json()) as { org?: string; token?: string; teamId?: string };
  const { org: slug, token, teamId } = body;

  if (!slug || !token) {
    return NextResponse.json({ error: 'org and token are required' }, { status: 400 });
  }

  const guard = await requireOrgMember(slug);
  if (!guard.ok) return guard.response;

  const auth = await getSupabaseServer();
  const { data: userData } = await auth.auth.getUser();
  if (!userData.user) {
    return NextResponse.json({ error: 'not authenticated' }, { status: 401 });
  }

  const headers = { Authorization: `Bearer ${token}` };

  let resolvedTeamId: string;
  let teamName: string;

  if (teamId) {
    const teamRes = await fetch(`https://api.vercel.com/v2/teams/${encodeURIComponent(teamId)}`, {
      headers,
    });
    if (!teamRes.ok) {
      const detail = (await teamRes.text()).slice(0, 200);
      return NextResponse.json(
        {
          error: `Vercel API rejected the token for team '${teamId}' (${teamRes.status}): ${detail}`,
        },
        { status: 400 },
      );
    }
    const teamJson = (await teamRes.json()) as VercelTeam;
    resolvedTeamId = teamId;
    teamName = teamJson.name ?? teamJson.slug ?? teamId;
  } else {
    const teamsRes = await fetch('https://api.vercel.com/v2/teams', { headers });
    if (!teamsRes.ok) {
      const detail = (await teamsRes.text()).slice(0, 200);
      return NextResponse.json(
        { error: `Failed to list Vercel teams (${teamsRes.status}): ${detail}` },
        { status: 400 },
      );
    }
    const teamsJson = (await teamsRes.json()) as { teams: VercelTeam[] };
    const teams = teamsJson.teams ?? [];

    if (teams.length === 0) {
      return NextResponse.json(
        { error: 'This token has no team access. Create a PAT scoped to a team.' },
        { status: 400 },
      );
    }
    if (teams.length > 1) {
      return NextResponse.json({
        ok: false,
        pickTeam: teams.map((t) => ({ id: t.id, name: t.name, slug: t.slug })),
      });
    }
    const single = teams[0]!;
    resolvedTeamId = single.id;
    teamName = single.name ?? single.slug;
  }

  const svc = getSupabaseServiceClient();

  const { error: insertErr } = await svc.from('provider_admins').upsert(
    {
      organization_id: guard.orgId,
      provider: 'vercel',
      status: 'connected',
      team_id: resolvedTeamId,
      access_token_encrypted: encodeByteaHexRaw(await encryptProviderSecret(guard.orgId, token)),
      refresh_token_encrypted: null,
      expires_at: null,
      connected_by_user_id: userData.user.id,
      connected_at: new Date().toISOString(),
    },
    { onConflict: 'organization_id,provider' },
  );
  if (insertErr) {
    return NextResponse.json({ error: `persist failed: ${insertErr.message}` }, { status: 500 });
  }

  return NextResponse.json({ ok: true, teamName });
}
