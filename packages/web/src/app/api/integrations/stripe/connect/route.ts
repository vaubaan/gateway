/**
 * POST /api/integrations/stripe/connect
 *
 * Paste-token flow: validates the Stripe API key against `GET /v1/account`,
 * encrypts it, and upserts into `provider_admins`. Returns 200 on success
 * or an error JSON on failure.
 */

import { type NextRequest, NextResponse } from 'next/server';
import { getSupabaseServiceClient } from '@/lib/supabase/server';
import { requireOrgMember } from '@/lib/auth/require-org-member';
import { encodeByteaHexRaw } from '@/lib/providers/bytea';
import { encryptProviderSecret } from '@/lib/crypto';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const VALID_PREFIXES = ['sk_test_', 'sk_live_', 'rk_test_', 'rk_live_'];

export async function POST(req: NextRequest) {
  const body = (await req.json()) as { orgSlug?: string; apiKey?: string };
  const { orgSlug, apiKey } = body;

  if (!orgSlug || !apiKey) {
    return NextResponse.json({ error: 'orgSlug and apiKey are required' }, { status: 400 });
  }

  if (!VALID_PREFIXES.some((p) => apiKey.startsWith(p))) {
    return NextResponse.json(
      { error: 'Key must start with sk_test_, sk_live_, rk_test_, or rk_live_.' },
      { status: 400 },
    );
  }

  const guard = await requireOrgMember(orgSlug);
  if (!guard.ok) return guard.response;

  const res = await fetch('https://api.stripe.com/v1/account', {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: 'application/json',
    },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let detail = `Stripe rejected the key (HTTP ${res.status})`;
    try {
      const j = JSON.parse(text) as { error?: { message?: string } };
      if (j.error?.message) detail = j.error.message;
    } catch {
      // plain text fallback
    }
    return NextResponse.json({ error: detail }, { status: 400 });
  }

  const svc = getSupabaseServiceClient();
  const { error: upsertErr } = await svc.from('provider_admins').upsert(
    {
      organization_id: guard.orgId,
      provider: 'stripe',
      status: 'connected',
      access_token_encrypted: encodeByteaHexRaw(await encryptProviderSecret(guard.orgId, apiKey)),
      refresh_token_encrypted: null,
      expires_at: null,
      connected_by_user_id: guard.userId,
      connected_at: new Date().toISOString(),
    },
    { onConflict: 'organization_id,provider' },
  );

  if (upsertErr) {
    return NextResponse.json({ error: `persist failed: ${upsertErr.message}` }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
