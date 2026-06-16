/**
 * Org-scoped root tokens — list + create.
 *
 * Surfaces in the UI under "Management Keys" for compatibility with the
 * existing dashboard, but under the hood produces rows in the unified
 * `tokens` table with `scope='org', parent_id=NULL, depth=0`.
 *
 *   GET  /api/v1/orgs/:slug/management-keys
 *   POST /api/v1/orgs/:slug/management-keys     body: { name }
 *                                                returns { management_key, api_key }
 *
 * Spec : docs/spec/vaubaan-gateway.md §3.1, §8.
 * ADR  : docs/decisions/unified-tokens-delegation-chain-and-escalation-channel.md.
 */

import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { generateApiKey, hashApiKey } from '@vaubaan/shared';
import { getSupabaseServiceClient } from '@/lib/supabase/server';
import { requireOrgMember } from '@/lib/auth/require-org-member';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const CreateSchema = z.object({
  name: z.string().regex(/^[a-z0-9](-?[a-z0-9])*$/),
});

interface RootTokenRow {
  id: string;
  name: string;
  api_key_prefix: string;
  status: 'active' | 'revoked';
  last_used_at: string | null;
  created_by: string | null;
  created_at: string;
}

export async function GET(_req: NextRequest, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const guard = await requireOrgMember(slug);
  if (!guard.ok) return guard.response;

  const svc = getSupabaseServiceClient();
  // Org-scoped root tokens = scope='org' AND parent_id IS NULL.
  const { data, error } = await svc
    .from('tokens')
    .select('id, name, api_key_prefix, status, last_used_at, created_by, created_at')
    .eq('organization_id', guard.orgId)
    .eq('scope', 'org')
    .is('parent_id', null)
    .order('created_at', { ascending: false })
    .returns<RootTokenRow[]>();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ management_keys: data ?? [] });
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  let body: z.infer<typeof CreateSchema>;
  try {
    body = CreateSchema.parse(await req.json());
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'invalid body' },
      { status: 400 },
    );
  }

  const guard = await requireOrgMember(slug);
  if (!guard.ok) return guard.response;

  const svc = getSupabaseServiceClient();
  const { apiKey, apiKeyPrefix } = generateApiKey('live');
  const apiKeyHash = await hashApiKey(apiKey);

  const { data: inserted, error } = await svc
    .from('tokens')
    .insert({
      organization_id: guard.orgId,
      parent_id: null,
      scope: 'org',
      project_id: null,
      name: body.name,
      api_key_prefix: apiKeyPrefix,
      api_key_hash: apiKeyHash,
      status: 'active',
      accepted_risks: [],
      denied_risks: [],
      depth: 0,
      delegation_chain: [],
      created_by: guard.userId,
    })
    .select('id, name, api_key_prefix, status, last_used_at, created_by, created_at')
    .single<RootTokenRow>();
  if (error || !inserted) {
    return NextResponse.json(
      { error: error?.message ?? 'failed to insert root token' },
      { status: 500 },
    );
  }

  return NextResponse.json({ management_key: inserted, api_key: apiKey }, { status: 201 });
}
