/**
 * POST /api/v1/bash-bindings/:bindingId/run-tool
 *
 * Body : { orgSlug, tool, args, timeout_s? }
 *
 * Loads the binding's annotated bash script + private key, executes the
 * requested tool function over SSH on the bound host, returns stdout /
 * stderr / exit_code / duration.
 *
 * This is the in-UI exec path : it bypasses /mcp policy (the user is
 * authenticated as an org member via session). The /mcp wiring for
 * dynamic per-binding tools lands in a follow-up PR.
 */

import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getSupabaseServiceClient } from '@/lib/supabase/server';
import { requireOrgMember } from '@/lib/auth/require-org-member';
import { decodeBytea } from '@/lib/providers/bytea';
import { sshExec } from '@vaubaan/providers-ssh';
import { buildToolInvocation } from '@/lib/bash/exec';
import type { ParsedScript, ParsedTool } from '@/lib/bash/parse';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const BodySchema = z.object({
  orgSlug: z.string().min(1),
  tool: z.string().min(1),
  args: z.record(z.string(), z.union([z.string(), z.number()])).default({}),
  timeout_s: z.number().int().min(1).max(300).default(60),
});

interface BindingRow {
  id: string;
  host_address: string;
  port: number;
  ssh_user: string;
  ssh_private_key: unknown;
  bash_content: string | null;
  parsed_meta: ParsedScript | null;
  projects: { organization_id: string };
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ bindingId: string }> }) {
  const { bindingId } = await ctx.params;
  let body: z.infer<typeof BodySchema>;
  try {
    body = BodySchema.parse(await req.json());
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'invalid body' },
      { status: 400 },
    );
  }

  const guard = await requireOrgMember(body.orgSlug);
  if (!guard.ok) return guard.response;

  const svc = getSupabaseServiceClient();
  const { data: binding } = await svc
    .from('ssh_bindings')
    .select(
      'id, host_address, port, ssh_user, ssh_private_key, bash_content, parsed_meta, projects!inner(organization_id)',
    )
    .eq('id', bindingId)
    .maybeSingle<BindingRow>();

  if (!binding || binding.projects.organization_id !== guard.orgId) {
    return NextResponse.json({ error: 'binding not found in this org' }, { status: 404 });
  }
  if (!binding.bash_content || !binding.parsed_meta) {
    return NextResponse.json(
      { error: 'this binding has no script attached — add one before running tools' },
      { status: 400 },
    );
  }

  const tool: ParsedTool | undefined = binding.parsed_meta.tools.find(
    (t) => t.functionName === body.tool,
  );
  if (!tool) {
    return NextResponse.json(
      { error: `tool '${body.tool}' is not declared by this binding's script` },
      { status: 400 },
    );
  }

  const argv: string[] = [];
  for (const a of tool.args) {
    const raw = body.args[a.name];
    if (raw === undefined || raw === '') {
      if (a.required && a.defaultValue === undefined) {
        return NextResponse.json({ error: `arg '${a.name}' is required` }, { status: 400 });
      }
      argv.push(a.defaultValue ?? '');
    } else {
      argv.push(String(raw));
    }
  }

  const keyBytes = decodeBytea(binding.ssh_private_key);
  if (!keyBytes) {
    return NextResponse.json({ error: 'SSH private key is missing or corrupt.' }, { status: 500 });
  }

  const { cmd } = buildToolInvocation(binding.bash_content, tool.functionName, argv);
  try {
    const result = await sshExec(
      {
        host_address: binding.host_address,
        port: binding.port,
        ssh_user: binding.ssh_user,
        ssh_private_key_pem: new TextDecoder().decode(keyBytes),
      },
      cmd,
      body.timeout_s,
    );
    return NextResponse.json({
      ok: result.exit_code === 0,
      exit_code: result.exit_code,
      stdout: result.stdout,
      stderr: result.stderr,
      duration_ms: result.duration_ms,
      truncated: result.truncated,
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
}
