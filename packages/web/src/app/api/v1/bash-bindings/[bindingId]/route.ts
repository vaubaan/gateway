/**
 * GET    /api/v1/bash-bindings/:bindingId?orgSlug=   — fetch one (with script)
 * PATCH  /api/v1/bash-bindings/:bindingId            — update bash_content
 * DELETE /api/v1/bash-bindings/:bindingId?orgSlug=   — drop
 */

import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getSupabaseServiceClient } from '@/lib/supabase/server';
import { requireOrgMember } from '@/lib/auth/require-org-member';
import { parseAnnotatedBash, ParseError } from '@/lib/bash/parse';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface BindingRow {
  id: string;
  project_id: string;
  host_slug: string;
  host_address: string;
  port: number;
  ssh_user: string;
  bash_content: string | null;
  parsed_meta: unknown;
  parse_error: string | null;
  created_at: string;
  updated_at: string;
  projects: { organization_id: string };
}

async function loadOrFail(
  bindingId: string,
  orgSlug: string,
): Promise<{ ok: true; row: BindingRow } | { ok: false; response: NextResponse }> {
  const guard = await requireOrgMember(orgSlug);
  if (!guard.ok) return { ok: false, response: guard.response };

  const svc = getSupabaseServiceClient();
  const { data: row } = await svc
    .from('ssh_bindings')
    .select(
      'id, project_id, host_slug, host_address, port, ssh_user, bash_content, parsed_meta, parse_error, created_at, updated_at, projects!inner(organization_id)',
    )
    .eq('id', bindingId)
    .maybeSingle<BindingRow>();

  if (!row || row.projects.organization_id !== guard.orgId) {
    return {
      ok: false,
      response: NextResponse.json({ error: 'binding not found in this org' }, { status: 404 }),
    };
  }
  return { ok: true, row };
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ bindingId: string }> }) {
  const { bindingId } = await ctx.params;
  const orgSlug = req.nextUrl.searchParams.get('orgSlug');
  if (!orgSlug) return NextResponse.json({ error: 'orgSlug required' }, { status: 400 });

  const res = await loadOrFail(bindingId, orgSlug);
  if (!res.ok) return res.response;
  const { projects: _projects, ...binding } = res.row;
  return NextResponse.json({ binding });
}

const PatchSchema = z.object({
  orgSlug: z.string().min(1),
  bash_content: z.string().max(100_000).nullable().optional(),
});

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ bindingId: string }> }) {
  const { bindingId } = await ctx.params;
  let body: z.infer<typeof PatchSchema>;
  try {
    body = PatchSchema.parse(await req.json());
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'invalid body' },
      { status: 400 },
    );
  }

  const res = await loadOrFail(bindingId, body.orgSlug);
  if (!res.ok) return res.response;

  const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (body.bash_content !== undefined) {
    if (body.bash_content === null || body.bash_content === '') {
      update.bash_content = null;
      update.parsed_meta = null;
      update.parse_error = null;
    } else {
      try {
        update.parsed_meta = parseAnnotatedBash(body.bash_content);
        update.bash_content = body.bash_content;
        update.parse_error = null;
      } catch (e) {
        if (e instanceof ParseError) {
          return NextResponse.json({ error: `Parse error: ${e.message}` }, { status: 400 });
        }
        throw e;
      }
    }
  }

  const svc = getSupabaseServiceClient();
  const { data: updated, error } = await svc
    .from('ssh_bindings')
    .update(update)
    .eq('id', bindingId)
    .select(
      'id, host_slug, host_address, port, ssh_user, bash_content, parsed_meta, parse_error, updated_at',
    )
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ binding: updated });
}

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ bindingId: string }> }) {
  const { bindingId } = await ctx.params;
  const orgSlug = req.nextUrl.searchParams.get('orgSlug');
  if (!orgSlug) {
    return NextResponse.json({ error: 'orgSlug query param required' }, { status: 400 });
  }

  const res = await loadOrFail(bindingId, orgSlug);
  if (!res.ok) return res.response;

  const svc = getSupabaseServiceClient();
  const { error } = await svc.from('ssh_bindings').delete().eq('id', bindingId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true });
}
