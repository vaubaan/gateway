/**
 * POST /api/integrations/vercel/connect
 *
 * Stores a Vercel Personal Access Token (PAT) for the organization.
 * The PAT must be scoped to the target team. We validate it by calling
 * /v2/teams/:id before persisting.
 *
 * Body: { org: string (slug), token: string, teamId: string }
 */

import { type NextRequest, NextResponse } from 'next/server';
import { requireOrgMember } from '@/lib/auth/require-org-member';
import { getSupabaseServer, getSupabaseServiceClient } from '@/lib/supabase/server';
import { encodeByteaHexRaw } from '@/lib/providers/bytea';
import { encryptProviderSecret } from '@/lib/crypto';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const body = (await req.json()) as { org?: string; token?: string; teamId?: string };
  const { org: slug, token, teamId } = body;

  if (!slug || !token || !teamId) {
    return NextResponse.json({ error: 'org, token, and teamId are required' }, { status: 400 });
  }

  const guard = await requireOrgMember(slug);
  if (!guard.ok) return guard.response;

  const auth = await getSupabaseServer();
  const { data: userData } = await auth.auth.getUser();
  if (!userData.user) {
    return NextResponse.json({ error: 'not authenticated' }, { status: 401 });
  }

  // Validate the token + team by calling the Vercel API.
  const teamRes = await fetch(`https://api.vercel.com/v2/teams/${encodeURIComponent(teamId)}`, {
    headers: { Authorization: `Bearer ${token}` },
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
  const teamJson = (await teamRes.json()) as { name?: string; slug?: string };

  const svc = getSupabaseServiceClient();

  const { error: insertErr } = await svc.from('provider_admins').upsert(
    {
      organization_id: guard.orgId,
      provider: 'vercel',
      status: 'connected',
      team_id: teamId,
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

  return NextResponse.json({
    ok: true,
    teamName: teamJson.name ?? teamJson.slug ?? teamId,
  });
}
