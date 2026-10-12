/**
 * GET  /api/v1/bash-bindings/:bindingId/hosts?orgSlug=
 *      — list hosts attached to a bash binding
 *
 * POST /api/v1/bash-bindings/:bindingId/hosts
 *      — attach a new host to this binding (creates one ssh_bindings row).
 *
 * Each host becomes one env in `bash:<ring>:<action>@<host_slug>`.
 */

import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getSupabaseServiceClient } from '@/lib/supabase/server';
import { requireOrgMember } from '@/lib/auth/require-org-member';
import { encodeByteaHex } from '@/lib/providers/bytea';
import { generateKeyPairSync } from 'node:crypto';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface BindingRow {
  id: string;
  project_id: string;
  projects: { organization_id: string };
}

const CreateSchema = z.object({
  orgSlug: z.string().min(1),
  host_slug: z
    .string()
    .min(1)
    .regex(/^[\w-]+$/, 'host_slug must be alphanumeric with dashes'),
  host_address: z.string().min(1),
  port: z.number().int().min(1).max(65535).default(22),
  ssh_user: z.string().min(1).default('dev'),
  ssh_private_key_pem: z.string().optional(),
  generate_key: z.boolean().optional(),
});

async function loadBinding(
  bindingId: string,
  orgSlug: string,
): Promise<{ ok: true; row: BindingRow } | { ok: false; response: NextResponse }> {
  const guard = await requireOrgMember(orgSlug);
  if (!guard.ok) return { ok: false, response: guard.response };

  const svc = getSupabaseServiceClient();
  const { data: row } = await svc
    .from('bash_bindings')
    .select('id, project_id, projects!inner(organization_id)')
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

  const res = await loadBinding(bindingId, orgSlug);
  if (!res.ok) return res.response;

  const svc = getSupabaseServiceClient();
  const { data, error } = await svc
    .from('ssh_bindings')
    .select('id, host_slug, host_address, port, ssh_user, created_at')
    .eq('bash_binding_id', bindingId)
    .order('host_slug', { ascending: true });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ hosts: data ?? [] });
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ bindingId: string }> }) {
  const { bindingId } = await ctx.params;
  let body: z.infer<typeof CreateSchema>;
  try {
    body = CreateSchema.parse(await req.json());
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'invalid body' },
      { status: 400 },
    );
  }

  const res = await loadBinding(bindingId, body.orgSlug);
  if (!res.ok) return res.response;

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

  const svc = getSupabaseServiceClient();
  const { data: row, error } = await svc
    .from('ssh_bindings')
    .insert({
      project_id: res.row.project_id,
      bash_binding_id: bindingId,
      host_slug: body.host_slug,
      host_address: body.host_address,
      port: body.port,
      ssh_user: body.ssh_user,
      ssh_private_key: encodeByteaHex(privateKeyPem),
    })
    .select('id, host_slug, host_address, port, ssh_user, created_at')
    .single();

  if (error) {
    if (error.code === '23505') {
      return NextResponse.json(
        { error: `A host with slug '${body.host_slug}' already exists for this project.` },
        { status: 409 },
      );
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ host: row, public_key: publicKeyOpenSsh }, { status: 201 });
}
