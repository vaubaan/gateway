/**
 * POST /api/v1/services/:serviceId/test
 *
 * Body : { orgSlug, host_slug, tool, args }
 *
 * Loads the service's annotated bash from DB + the SSH binding for the given
 * host_slug (must belong to the same project), then executes the requested
 * tool function on the host. Returns stdout/stderr/exit_code/duration_ms.
 *
 * This is the in-UI exec path : it bypasses /mcp policy (the user is already
 * authenticated as an org member via session). The /mcp wiring comes in a
 * follow-up so external MCP clients can invoke the same tools through a
 * scoped access token.
 */

import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getSupabaseServiceClient } from '@/lib/supabase/server';
import { requireOrgMember } from '@/lib/auth/require-org-member';
import { decodeBytea } from '@/lib/providers/bytea';
import { sshExec } from '@vaubaan/providers-ssh';
import { buildToolInvocation } from '@/lib/services/exec';
import type { ParsedService, ParsedTool } from '@/lib/services/parse';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const BodySchema = z.object({
  orgSlug: z.string().min(1),
  host_slug: z.string().min(1),
  tool: z.string().min(1),
  args: z.record(z.string(), z.union([z.string(), z.number()])).default({}),
  timeout_s: z.number().int().min(1).max(300).default(30),
});

interface ServiceRow {
  id: string;
  project_id: string;
  bash_content: string;
  parsed_meta: ParsedService;
  projects: { organization_id: string };
}

interface BindingRow {
  id: string;
  host_address: string;
  port: number;
  ssh_user: string;
  ssh_private_key: unknown;
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ serviceId: string }> }) {
  const { serviceId } = await ctx.params;
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

  // 1. Load the service + verify org ownership.
  const { data: service } = await svc
    .from('runner_services')
    .select('id, project_id, bash_content, parsed_meta, projects!inner(organization_id)')
    .eq('id', serviceId)
    .maybeSingle<ServiceRow>();

  if (!service || service.projects.organization_id !== guard.orgId) {
    return NextResponse.json({ error: 'service not found in this org' }, { status: 404 });
  }

  // 2. Locate the requested tool in the parsed meta.
  const tool: ParsedTool | undefined = service.parsed_meta.tools.find(
    (t) => t.functionName === body.tool,
  );
  if (!tool) {
    return NextResponse.json(
      { error: `tool '${body.tool}' is not declared by this service` },
      { status: 400 },
    );
  }

  // 3. Build positional args from named values, in the declaration order.
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

  // 4. Resolve the SSH binding (project-scoped).
  const { data: binding } = await svc
    .from('ssh_bindings')
    .select('id, host_address, port, ssh_user, ssh_private_key')
    .eq('project_id', service.project_id)
    .eq('host_slug', body.host_slug)
    .maybeSingle<BindingRow>();

  if (!binding) {
    return NextResponse.json(
      { error: `no SSH binding for host_slug '${body.host_slug}' in this project` },
      { status: 404 },
    );
  }

  const keyBytes = decodeBytea(binding.ssh_private_key);
  if (!keyBytes) {
    return NextResponse.json({ error: 'SSH private key is missing or corrupt.' }, { status: 500 });
  }

  // 5. Build the bash invocation + execute over SSH.
  const { cmd } = buildToolInvocation(service.bash_content, tool.functionName, argv);
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
