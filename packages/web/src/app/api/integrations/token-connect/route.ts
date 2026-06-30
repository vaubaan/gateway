/**
 * POST /api/integrations/token-connect
 *
 * Generic paste-token connect endpoint for providers that use a single
 * API key / token (no OAuth). Validates the token against the provider's
 * verify endpoint, encrypts it, and stores in `provider_admins`.
 *
 * Body: { org: string, provider: string, token: string }
 */

import { type NextRequest, NextResponse } from 'next/server';
import { requireOrgMember } from '@/lib/auth/require-org-member';
import { getSupabaseServer, getSupabaseServiceClient } from '@/lib/supabase/server';
import { encodeByteaHexRaw } from '@/lib/providers/bytea';
import { encryptProviderSecret } from '@/lib/crypto';

export const dynamic = 'force-dynamic';

type TokenProvider = 'cloudflare-dns' | 'upstash-redis' | 'resend';

const VALID_PROVIDERS = new Set<TokenProvider>(['cloudflare-dns', 'upstash-redis', 'resend']);

interface ValidationResult {
  ok: boolean;
  error?: string;
  account?: string;
}

async function validateCloudflareDns(token: string): Promise<ValidationResult> {
  const res = await fetch('https://api.cloudflare.com/client/v4/user/tokens/verify', {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    return {
      ok: false,
      error: `Cloudflare rejected the token (${res.status}): ${text.slice(0, 200)}`,
    };
  }
  const json = (await res.json()) as { success?: boolean; result?: { status?: string } };
  if (!json.success || json.result?.status !== 'active') {
    return { ok: false, error: 'Token is not active.' };
  }

  const zonesRes = await fetch('https://api.cloudflare.com/client/v4/zones?per_page=1', {
    headers: { Authorization: `Bearer ${token}` },
  });
  let account: string | undefined;
  if (zonesRes.ok) {
    const zonesJson = (await zonesRes.json()) as {
      result?: Array<{ account?: { name?: string } }>;
    };
    account = zonesJson.result?.[0]?.account?.name ?? undefined;
  }
  return { ok: true, account };
}

async function validateUpstashRedis(token: string): Promise<ValidationResult> {
  const parts = token.split(':');
  if (parts.length < 2) {
    return { ok: false, error: 'Expected format: email:api_key' };
  }
  const basicAuth = Buffer.from(token).toString('base64');
  const res = await fetch('https://api.upstash.com/v2/redis/databases', {
    headers: { Authorization: `Basic ${basicAuth}` },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    return {
      ok: false,
      error: `Upstash rejected the credentials (${res.status}): ${text.slice(0, 200)}`,
    };
  }
  const email = parts[0]!;
  return { ok: true, account: email };
}

async function validateResend(token: string): Promise<ValidationResult> {
  if (!token.startsWith('re_')) {
    return { ok: false, error: 'Resend API key must start with re_' };
  }
  const res = await fetch('https://api.resend.com/domains', {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    return {
      ok: false,
      error: `Resend rejected the API key (${res.status}): ${text.slice(0, 200)}`,
    };
  }
  return { ok: true };
}

async function validateToken(provider: TokenProvider, token: string): Promise<ValidationResult> {
  switch (provider) {
    case 'cloudflare-dns':
      return validateCloudflareDns(token);
    case 'upstash-redis':
      return validateUpstashRedis(token);
    case 'resend':
      return validateResend(token);
  }
}

export async function POST(req: NextRequest) {
  const body = (await req.json()) as { org?: string; provider?: string; token?: string };
  const { org: slug, provider, token } = body;

  if (!slug || !provider || !token) {
    return NextResponse.json({ error: 'org, provider, and token are required' }, { status: 400 });
  }
  if (!VALID_PROVIDERS.has(provider as TokenProvider)) {
    return NextResponse.json({ error: `unsupported provider: ${provider}` }, { status: 400 });
  }

  const guard = await requireOrgMember(slug);
  if (!guard.ok) return guard.response;

  const auth = await getSupabaseServer();
  const { data: userData } = await auth.auth.getUser();
  if (!userData.user) {
    return NextResponse.json({ error: 'not authenticated' }, { status: 401 });
  }

  const result = await validateToken(provider as TokenProvider, token.trim());
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }

  const svc = getSupabaseServiceClient();
  const { error: insertErr } = await svc.from('provider_admins').upsert(
    {
      organization_id: guard.orgId,
      provider,
      status: 'connected',
      team_id: null,
      installation_id: null,
      access_token_encrypted: encodeByteaHexRaw(
        await encryptProviderSecret(guard.orgId, token.trim()),
      ),
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

  return NextResponse.json({ ok: true, account: result.account });
}
