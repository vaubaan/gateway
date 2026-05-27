/**
 * Org Management Keys — list + create.
 *
 *   GET  /api/v1/orgs/:slug/management-keys
 *   POST /api/v1/orgs/:slug/management-keys     body: { name }
 *                                                returns { management_key, api_key }
 *                                                api_key visible **once** (argon2id at-rest).
 *
 * Spec : docs/spec/mcp-proxy.md §3.1 (ManagementKey), §8.
 * ADR  : docs/decisions/org-management-keys-for-runner.md.
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

interface ManagementKeyRow {
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
  const { data, error } = await svc
    .from('org_management_keys')
    .select('id, name, api_key_prefix, status, last_used_at, created_by, created_at')
    .eq('organization_id', guard.orgId)
    .order('created_at', { ascending: false })
    .returns<ManagementKeyRow[]>();
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
  const { apiKey, apiKeyPrefix } = generateApiKey('mgmt');
  const apiKeyHash = await hashApiKey(apiKey);

  const { data: inserted, error } = await svc
    .from('org_management_keys')
    .insert({
      organization_id: guard.orgId,
      name: body.name,
      api_key_prefix: apiKeyPrefix,
      api_key_hash: apiKeyHash,
      status: 'active',
      created_by: guard.userId,
    })
    .select('id, name, api_key_prefix, status, last_used_at, created_by, created_at')
    .single<ManagementKeyRow>();
  if (error || !inserted) {
    return NextResponse.json(
      { error: error?.message ?? 'failed to insert management key' },
      { status: 500 },
    );
  }

  return NextResponse.json({ management_key: inserted, api_key: apiKey }, { status: 201 });
}
