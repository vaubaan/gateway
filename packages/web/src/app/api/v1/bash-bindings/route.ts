/**
 * GET  /api/v1/bash-bindings?orgSlug=&projectSlug=  — list bindings
 * POST /api/v1/bash-bindings                        — create binding
 *
 * The table is still named `ssh_bindings` for storage continuity ; the
 * provider exposed to users is `bash` (SSH is the transport). A binding
 * may carry an annotated bash script (`bash_content`) whose functions
 * become the MCP tools the binding exposes.
 */

import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getSupabaseServiceClient } from '@/lib/supabase/server';
import { requireOrgMember, resolveProject } from '@/lib/auth/require-org-member';
import { encodeByteaHex } from '@/lib/providers/bytea';
import { generateKeyPairSync } from 'node:crypto';
import { parseAnnotatedBash, ParseError } from '@/lib/bash/parse';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const CreateSchema = z.object({
  orgSlug: z.string().min(1),
  projectSlug: z.string().min(1),
  host_slug: z
    .string()
    .min(1)
    .regex(/^[\w-]+$/, 'host_slug must be alphanumeric with dashes'),
  host_address: z.string().min(1),
  port: z.number().int().min(1).max(65535).default(22),
  ssh_user: z.string().min(1).default('dev'),
  /** paste mode: private key PEM */
  ssh_private_key_pem: z.string().optional(),
  /** generate mode: generate a new key pair */
  generate_key: z.boolean().optional(),
  /** Optional : annotated bash script (may be added later via PATCH). */
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

  const svc = getSupabaseServiceClient();
  const { data: proj } = await resolveProject(guard.orgId, projectSlug);
  if (!proj) return NextResponse.json({ error: 'project not found' }, { status: 404 });

  const { data, error } = await svc
    .from('ssh_bindings')
    .select(
      'id, host_slug, host_address, port, ssh_user, parsed_meta, parse_error, created_at, updated_at',
    )
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

  const svc = getSupabaseServiceClient();
  const { data: proj } = await resolveProject(guard.orgId, body.projectSlug);
  if (!proj) return NextResponse.json({ error: 'project not found' }, { status: 404 });

  let privateKeyPem: string;
  let publicKeyOpenSsh: string | null = null;

  if (body.generate_key) {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519', {
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    privateKeyPem = privateKey;
    const derB64 = publicKey
      .replace(/-----BEGIN PUBLIC KEY-----/, '')
      .replace(/-----END PUBLIC KEY-----/, '')
      .replace(/\s+/g, '');
    publicKeyOpenSsh = `ssh-ed25519 ${derB64} vaubaan-gateway`;
  } else if (body.ssh_private_key_pem) {
    privateKeyPem = body.ssh_private_key_pem;
  } else {
    return NextResponse.json(
      { error: 'either generate_key or ssh_private_key_pem is required' },
      { status: 400 },
    );
  }

  // Parse the optional bash content up front so we can store cached meta.
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

  const { data: row, error } = await svc
    .from('ssh_bindings')
    .insert({
      project_id: proj.id,
      host_slug: body.host_slug,
      host_address: body.host_address,
      port: body.port,
      ssh_user: body.ssh_user,
      ssh_private_key: encodeByteaHex(privateKeyPem),
      bash_content: body.bash_content ?? null,
      parsed_meta: parsedMeta,
      parse_error: parseError,
    })
    .select('id, host_slug, host_address, port, ssh_user, parsed_meta, parse_error, created_at')
    .single();

  if (error) {
    if (error.code === '23505') {
      return NextResponse.json(
        { error: `A binding with host_slug '${body.host_slug}' already exists for this project.` },
        { status: 409 },
      );
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({
    binding: row,
    public_key: publicKeyOpenSsh,
  });
}
