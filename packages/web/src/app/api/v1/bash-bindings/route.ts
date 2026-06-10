/**
 * GET  /api/v1/bash-bindings?orgSlug=&projectSlug=  — list bindings
 * POST /api/v1/bash-bindings                        — create a binding
 *                                                     (script holder ; hosts
 *                                                     are attached via the
 *                                                     /hosts subroute)
 *
 * A bash binding owns a single annotated script. Its identity is the slug.
 * 1..N SSH hosts attach to it as envs (per the spec : env = overlay on
 * data, not a separate copy of the data).
 */

import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getSupabaseServiceClient } from '@/lib/supabase/server';
import { requireOrgMember, resolveProject } from '@/lib/auth/require-org-member';
import { parseAnnotatedBash, ParseError } from '@/lib/bash/parse';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const CreateSchema = z.object({
  orgSlug: z.string().min(1),
  projectSlug: z.string().min(1),
  slug: z
    .string()
    .min(1)
    .regex(/^[a-z][a-z0-9-]*$/, 'slug must match [a-z][a-z0-9-]*'),
  display_name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  bash_content: z.string().max(100_000).optional(),
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
    .from('bash_bindings')
    .select('id, slug, display_name, description, parsed_meta, parse_error, updated_at')
    .eq('project_id', proj.id)
    .order('created_at', { ascending: true });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ bindings: data ?? [] });
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

  let parsedMeta: unknown = null;
  let parseError: string | null = null;
  if (body.bash_content) {
    try {
      parsedMeta = parseAnnotatedBash(body.bash_content);
    } catch (e) {
      if (e instanceof ParseError) parseError = e.message;
      else throw e;
    }
  }

  const svc = getSupabaseServiceClient();
  const { data: row, error } = await svc
    .from('bash_bindings')
    .insert({
      project_id: proj.id,
      slug: body.slug,
      display_name: body.display_name,
      description: body.description ?? null,
      bash_content: body.bash_content ?? null,
      parsed_meta: parsedMeta,
      parse_error: parseError,
      created_by: guard.userId,
    })
    .select('id, slug, display_name, description, parsed_meta, parse_error, updated_at')
    .single();

  if (error) {
    if (error.code === '23505') {
      return NextResponse.json(
        { error: `A bash binding with slug '${body.slug}' already exists in this project.` },
        { status: 409 },
      );
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ binding: row }, { status: 201 });
}
