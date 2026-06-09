/**
 * GET  /api/v1/services?orgSlug=&projectSlug=   — list services in a project
 * POST /api/v1/services                          — create a new service
 *
 * The body is the annotated bash. The server parses it, stores the cached
 * meta (or parse_error) alongside the raw bash, and rejects creation if the
 * file is structurally invalid.
 */

import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getSupabaseServiceClient } from '@/lib/supabase/server';
import { requireOrgMember, resolveProject } from '@/lib/auth/require-org-member';
import { parseAnnotatedBash, ParseError } from '@/lib/services/parse';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const CreateSchema = z.object({
  orgSlug: z.string().min(1),
  projectSlug: z.string().min(1),
  display_name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  bash_content: z.string().min(1).max(100_000),
});

export async function GET(req: NextRequest) {
  const orgSlug = req.nextUrl.searchParams.get('orgSlug');
  const projectSlug = req.nextUrl.searchParams.get('projectSlug');
  if (!orgSlug || !projectSlug) {
    return NextResponse.json({ error: 'orgSlug and projectSlug required' }, { status: 400 });
  }

  const guard = await requireOrgMember(orgSlug);
  if (!guard.ok) return guard.response;

  const { data: proj } = await resolveProject(guard.orgId, projectSlug);
  if (!proj) return NextResponse.json({ error: 'project not found' }, { status: 404 });

  const svc = getSupabaseServiceClient();
  const { data, error } = await svc
    .from('runner_services')
    .select('id, slug, display_name, description, parsed_meta, parse_error, updated_at')
    .eq('project_id', proj.id)
    .order('created_at', { ascending: true });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ services: data ?? [] });
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

  const guard = await requireOrgMember(body.orgSlug);
  if (!guard.ok) return guard.response;

  const { data: proj } = await resolveProject(guard.orgId, body.projectSlug);
  if (!proj) return NextResponse.json({ error: 'project not found' }, { status: 404 });

  // Parse before insert — slug & meta come from the bash itself.
  let parsed;
  try {
    parsed = parseAnnotatedBash(body.bash_content);
  } catch (e) {
    if (e instanceof ParseError) {
      return NextResponse.json({ error: `Parse error: ${e.message}` }, { status: 400 });
    }
    throw e;
  }

  const svc = getSupabaseServiceClient();
  const { data: row, error } = await svc
    .from('runner_services')
    .insert({
      project_id: proj.id,
      slug: parsed.slug,
      display_name: body.display_name,
      description: body.description ?? parsed.description ?? null,
      bash_content: body.bash_content,
      parsed_meta: parsed,
      parse_error: null,
      created_by: guard.userId,
    })
    .select('id, slug, display_name, description, parsed_meta, updated_at')
    .single();

  if (error) {
    if (error.code === '23505') {
      return NextResponse.json(
        { error: `A service with slug '${parsed.slug}' already exists in this project.` },
        { status: 409 },
      );
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ service: row }, { status: 201 });
}
