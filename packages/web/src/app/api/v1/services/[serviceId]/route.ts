/**
 * GET    /api/v1/services/:serviceId?orgSlug=   — fetch one (with bash + meta)
 * PATCH  /api/v1/services/:serviceId            — update display_name, description, bash_content
 * DELETE /api/v1/services/:serviceId?orgSlug=   — drop
 */

import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getSupabaseServiceClient } from '@/lib/supabase/server';
import { requireOrgMember } from '@/lib/auth/require-org-member';
import { parseAnnotatedBash, ParseError } from '@/lib/services/parse';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface ServiceRow {
  id: string;
  project_id: string;
  slug: string;
  display_name: string;
  description: string | null;
  bash_content: string;
  parsed_meta: unknown;
  parse_error: string | null;
  updated_at: string;
  projects: { organization_id: string };
}

async function loadOrFail(
  serviceId: string,
  orgSlug: string,
): Promise<{ ok: true; row: ServiceRow } | { ok: false; response: NextResponse }> {
  const guard = await requireOrgMember(orgSlug);
  if (!guard.ok) return { ok: false, response: guard.response };

  const svc = getSupabaseServiceClient();
  const { data: row } = await svc
    .from('runner_services')
    .select(
      'id, project_id, slug, display_name, description, bash_content, parsed_meta, parse_error, updated_at, projects!inner(organization_id)',
    )
    .eq('id', serviceId)
    .maybeSingle<ServiceRow>();

  if (!row || row.projects.organization_id !== guard.orgId) {
    return {
      ok: false,
      response: NextResponse.json({ error: 'service not found in this org' }, { status: 404 }),
    };
  }
  return { ok: true, row };
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ serviceId: string }> }) {
  const { serviceId } = await ctx.params;
  const orgSlug = req.nextUrl.searchParams.get('orgSlug');
  if (!orgSlug) return NextResponse.json({ error: 'orgSlug required' }, { status: 400 });

  const res = await loadOrFail(serviceId, orgSlug);
  if (!res.ok) return res.response;
  const { projects: _projects, ...service } = res.row;
  return NextResponse.json({ service });
}

const PatchSchema = z.object({
  orgSlug: z.string().min(1),
  display_name: z.string().min(1).max(100).optional(),
  description: z.string().max(500).optional(),
  bash_content: z.string().min(1).max(100_000).optional(),
});

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ serviceId: string }> }) {
  const { serviceId } = await ctx.params;
  let body: z.infer<typeof PatchSchema>;
  try {
    body = PatchSchema.parse(await req.json());
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'invalid body' },
      { status: 400 },
    );
  }

  const res = await loadOrFail(serviceId, body.orgSlug);
  if (!res.ok) return res.response;

  const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (body.display_name !== undefined) update.display_name = body.display_name;
  if (body.description !== undefined) update.description = body.description;
  if (body.bash_content !== undefined) {
    try {
      const parsed = parseAnnotatedBash(body.bash_content);
      if (parsed.slug !== res.row.slug) {
        return NextResponse.json(
          {
            error: `Cannot rename a service via PATCH (slug went from '${res.row.slug}' to '${parsed.slug}'). Delete and recreate.`,
          },
          { status: 400 },
        );
      }
      update.bash_content = body.bash_content;
      update.parsed_meta = parsed;
      update.parse_error = null;
    } catch (e) {
      if (e instanceof ParseError) {
        return NextResponse.json({ error: `Parse error: ${e.message}` }, { status: 400 });
      }
      throw e;
    }
  }

  const svc = getSupabaseServiceClient();
  const { data: updated, error } = await svc
    .from('runner_services')
    .update(update)
    .eq('id', serviceId)
    .select('id, slug, display_name, description, parsed_meta, updated_at')
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ service: updated });
}

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ serviceId: string }> }) {
  const { serviceId } = await ctx.params;
  const orgSlug = req.nextUrl.searchParams.get('orgSlug');
  if (!orgSlug) return NextResponse.json({ error: 'orgSlug required' }, { status: 400 });

  const res = await loadOrFail(serviceId, orgSlug);
  if (!res.ok) return res.response;

  const svc = getSupabaseServiceClient();
  const { error } = await svc.from('runner_services').delete().eq('id', serviceId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
