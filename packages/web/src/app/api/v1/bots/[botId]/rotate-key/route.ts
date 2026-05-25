/**
 * POST /api/v1/bots/:botId/rotate-key  body: { orgSlug }
 *
 * Generates a fresh api_key, hashes it, replaces the existing prefix+hash,
 * invalidates the cache for the OLD prefix so the rotated-out key is rejected
 * on the next /mcp call.
 *
 * Spec : docs/spec/mcp-proxy.md §8.5, §9.6.
 *
 * Returns the new api_key in cleartext — visible 1× per the ADR
 * api-key-format-vbn-live-argon2id.
 */

import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { generateApiKey, hashApiKey } from '@vaubaan/shared';
import { buildCacheClient } from '@vaubaan/mcp-gateway';
import { getSupabaseServiceClient } from '@/lib/supabase/server';
import { requireOrgAdmin } from '@/lib/auth/require-admin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const BodySchema = z.object({ orgSlug: z.string().min(1) });

export async function POST(req: NextRequest, ctx: { params: Promise<{ botId: string }> }) {
  const { botId } = await ctx.params;
  let body: z.infer<typeof BodySchema>;
  try {
    body = BodySchema.parse(await req.json());
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'invalid body' },
      { status: 400 },
    );
  }

  const guard = await requireOrgAdmin(body.orgSlug);
  if (!guard.ok) return guard.response;

  const svc = getSupabaseServiceClient();
  const { data: bot } = await svc
    .from('bots')
    .select('id, api_key_prefix, projects!inner(organization_id)')
    .eq('id', botId)
    .maybeSingle<{
      id: string;
      api_key_prefix: string;
      projects: { organization_id: string };
    }>();
  if (!bot || bot.projects.organization_id !== guard.orgId) {
    return NextResponse.json({ error: 'bot not found in this org' }, { status: 404 });
  }

  const { apiKey, apiKeyPrefix } = generateApiKey('live');
  const apiKeyHash = await hashApiKey(apiKey);

  const { error } = await svc
    .from('bots')
    .update({ api_key_prefix: apiKeyPrefix, api_key_hash: apiKeyHash, status: 'active' })
    .eq('id', botId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Drop the old prefix's cached BotContext so the rotated-out key 401s
  // immediately rather than waiting for the 60s TTL.
  await buildCacheClient().del(`vaubaan:ctx:${bot.api_key_prefix}`);

  return NextResponse.json({ api_key: apiKey, api_key_prefix: apiKeyPrefix });
}
