/**
 * POST /api/v1/stripe-bindings — create a per-project Stripe binding.
 *
 * Validates both keys against Stripe GET /v1/account, encrypts them,
 * and stores in `stripe_bindings`. Also upserts a `provider_bindings`
 * row so the catalog/risk resolution can discover the binding.
 */

import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getSupabaseServiceClient } from '@/lib/supabase/server';
import { requireOrgMember } from '@/lib/auth/require-org-member';
import { encodeByteaHexRaw } from '@/lib/providers/bytea';
import { encryptProviderSecret } from '@/lib/crypto';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const VALID_TEST_PREFIXES = ['sk_test_', 'rk_test_'];
const VALID_LIVE_PREFIXES = ['sk_live_', 'rk_live_'];

const CreateSchema = z.object({
  orgSlug: z.string().min(1),
  projectSlug: z.string().min(1),
  account_id: z
    .string()
    .min(1)
    .regex(/^acct_/, 'account_id must start with acct_'),
  test_key: z.string().optional(),
  live_key: z.string().optional(),
});

async function validateStripeKey(key: string): Promise<string | null> {
  const res = await fetch('https://api.stripe.com/v1/account', {
    headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
  });
  if (res.ok) return null;
  const text = await res.text().catch(() => '');
  try {
    const j = JSON.parse(text) as { error?: { message?: string } };
    if (j.error?.message) return j.error.message;
  } catch {
    // plain text fallback
  }
  return `Stripe rejected the key (HTTP ${res.status})`;
}

export async function POST(req: NextRequest) {
  let body: z.infer<typeof CreateSchema>;
  try {
    body = CreateSchema.parse(await req.json());
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'invalid body' },
      { status: 400 },
    );
  }

  if (!body.test_key && !body.live_key) {
    return NextResponse.json(
      { error: 'At least one key (test or live) is required.' },
      { status: 400 },
    );
  }

  if (body.test_key && !VALID_TEST_PREFIXES.some((p) => body.test_key!.startsWith(p))) {
    return NextResponse.json(
      { error: 'Test key must start with sk_test_ or rk_test_.' },
      { status: 400 },
    );
  }
  if (body.live_key && !VALID_LIVE_PREFIXES.some((p) => body.live_key!.startsWith(p))) {
    return NextResponse.json(
      { error: 'Live key must start with sk_live_ or rk_live_.' },
      { status: 400 },
    );
  }

  const guard = await requireOrgMember(body.orgSlug);
  if (!guard.ok) return guard.response;

  const svc = getSupabaseServiceClient();
  const { data: proj } = await svc
    .from('projects')
    .select('id')
    .eq('organization_id', guard.orgId)
    .eq('slug', body.projectSlug)
    .maybeSingle<{ id: string }>();

  if (!proj) {
    return NextResponse.json({ error: 'project not found in this org' }, { status: 404 });
  }

  if (body.test_key) {
    const err = await validateStripeKey(body.test_key);
    if (err) return NextResponse.json({ error: `Test key: ${err}` }, { status: 400 });
  }
  if (body.live_key) {
    const err = await validateStripeKey(body.live_key);
    if (err) return NextResponse.json({ error: `Live key: ${err}` }, { status: 400 });
  }

  const testEnc = body.test_key
    ? encodeByteaHexRaw(await encryptProviderSecret(guard.orgId, body.test_key))
    : null;
  const liveEnc = body.live_key
    ? encodeByteaHexRaw(await encryptProviderSecret(guard.orgId, body.live_key))
    : null;

  const { data: row, error } = await svc
    .from('stripe_bindings')
    .upsert(
      {
        project_id: proj.id,
        account_id: body.account_id,
        test_key_encrypted: testEnc,
        live_key_encrypted: liveEnc,
        created_by_user_id: guard.userId,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'project_id,account_id' },
    )
    .select('id, account_id, created_at')
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Upsert a provider_bindings row so catalog resolution finds the binding.
  await svc.from('provider_bindings').upsert(
    {
      project_id: proj.id,
      provider: 'stripe',
      resource_ref: body.account_id,
      display_name: `Stripe ${body.account_id}`,
      environment: null,
    },
    { onConflict: 'project_id,provider,environment' },
  );

  return NextResponse.json({ binding: row }, { status: 201 });
}
