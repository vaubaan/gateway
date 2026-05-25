/**
 * Bot RW operations.
 *
 *   PATCH  /api/v1/bots/:botId   body: { name?, status?, roleIds? }
 *   DELETE /api/v1/bots/:botId
 *
 * Spec : docs/spec/mcp-proxy.md §8.5.
 *
 * Cache invalidation : on every mutation we delete the cached BotContext
 * for the bot's api_key_prefix so the next /mcp call picks up changes
 * within ≤1 round-trip (no 60s staleness window).
 */

import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { buildCacheClient } from '@vaubaan/mcp-gateway';
import { getSupabaseServiceClient } from '@/lib/supabase/server';
import { requireOrgAdmin } from '@/lib/auth/require-admin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const PatchSchema = z
  .object({
    orgSlug: z.string().min(1),
    name: z
      .string()
      .regex(/^[a-z0-9](-?[a-z0-9])*$/)
      .optional(),
    status: z.enum(['active', 'revoked']).optional(),
    roleIds: z.array(z.string().uuid()).optional(),
  })
  .refine((b) => b.name || b.status || b.roleIds, {
    message: 'must provide at least one of name, status, roleIds',
  });

async function invalidateCache(prefix: string) {
  await buildCacheClient().del(`vaubaan:ctx:${prefix}`);
}

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ botId: string }> }) {
  const { botId } = await ctx.params;
  let body: z.infer<typeof PatchSchema>;
  try {
    body = PatchSchema.parse(await req.json());
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'invalid body' },
      { status: 400 },
    );
  }

  const guard = await requireOrgAdmin(body.orgSlug);
  if (!guard.ok) return guard.response;

  const svc = getSupabaseServiceClient();

  // Confirm the bot belongs to a project of this org.
  const { data: bot } = await svc
    .from('bots')
    .select('id, project_id, api_key_prefix, projects!inner(organization_id)')
    .eq('id', botId)
    .maybeSingle<{
      id: string;
      project_id: string;
      api_key_prefix: string;
      projects: { organization_id: string };
    }>();
  if (!bot || bot.projects.organization_id !== guard.orgId) {
    return NextResponse.json({ error: 'bot not found in this org' }, { status: 404 });
  }

  const updates: Record<string, string> = {};
  if (body.name) updates.name = body.name;
  if (body.status) updates.status = body.status;
  if (Object.keys(updates).length > 0) {
    const { error } = await svc.from('bots').update(updates).eq('id', botId);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  }

  if (body.roleIds) {
    await svc.from('bot_roles').delete().eq('bot_id', botId);
    if (body.roleIds.length > 0) {
      const { error } = await svc
        .from('bot_roles')
        .insert(body.roleIds.map((rid) => ({ bot_id: botId, role_id: rid })));
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    }
  }

  await invalidateCache(bot.api_key_prefix);
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ botId: string }> }) {
  const { botId } = await ctx.params;
  const orgSlug = req.nextUrl.searchParams.get('orgSlug');
  if (!orgSlug)
    return NextResponse.json({ error: 'orgSlug query param required' }, { status: 400 });

  const guard = await requireOrgAdmin(orgSlug);
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

  const { error } = await svc.from('bots').delete().eq('id', botId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  await invalidateCache(bot.api_key_prefix);
  return NextResponse.json({ ok: true });
}
