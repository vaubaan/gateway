/**
 * POST /api/v1/bash-bindings/:bindingId/run-tool
 *
 * Body : { orgSlug, host_slug, tool, args, timeout_s? }
 *
 * Loads the binding's script + the requested host (the env) + executes the
 * tool function on it via SSH. Returns stdout/stderr/exit_code/duration.
 *
 * Bypasses /mcp policy : the caller is authenticated as an org member via
 * session. /mcp wiring for per-binding dispatch lands in a follow-up PR.
 */

import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { hashArguments } from '@vaubaan/mcp-gateway';
import { getSupabaseServiceClient } from '@/lib/supabase/server';
import { requireOrgMember } from '@/lib/auth/require-org-member';
import { buildToolInvocation } from '@/lib/bash/exec';
import { execOnHost, loadHostBySlugInOrg } from '@/lib/bash/exec-host';
import { materializeArgs } from '@/lib/bash/args';
import type { ParsedScript, ParsedTool } from '@/lib/bash/parse';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const BodySchema = z.object({
  orgSlug: z.string().min(1),
  host_slug: z.string().min(1),
  tool: z.string().min(1),
  args: z.record(z.string(), z.union([z.string(), z.number()])).default({}),
  timeout_s: z.number().int().min(1).max(300).default(60),
});

interface BindingRow {
  id: string;
  project_id: string;
  bash_content: string | null;
  parsed_meta: ParsedScript | null;
  projects: { organization_id: string };
}

/**
 * Marker stored in `audit_log.denial_reason` for every row produced by this
 * REST shortcut. Lets ops grep for the rows that did NOT go through the
 * `/mcp` policy pipeline once `/mcp` dispatch is wired.
 *
 * TODO(bash-mcp-wiring): drop this and the entire `writeRestBypassAudit`
 * helper when `/mcp` per-binding dispatch lands — the audit row will then
 * come from the gateway's normal path instead.
 */
const REST_BYPASS_MARKER = 'rest-bypass';

interface AuditCallSummary {
  organizationId: string;
  projectId: string;
  toolName: string;
  capabilityShorthand: string;
  argumentsHash: string;
  upstreamLatencyMs: number | null;
  clientIp: string | null;
  clientUserAgent: string | null;
}

async function writeRestBypassAudit(
  svc: ReturnType<typeof getSupabaseServiceClient>,
  call: AuditCallSummary,
): Promise<void> {
  const { error } = await svc.from('audit_log').insert({
    organization_id: call.organizationId,
    project_id: call.projectId,
    access_token_id: null,
    tool_name: call.toolName,
    arguments_hash: call.argumentsHash,
    capability_matched: call.capabilityShorthand,
    decision: 'allowed',
    denial_reason: REST_BYPASS_MARKER,
    upstream_latency_ms: call.upstreamLatencyMs,
    client_ip: call.clientIp,
    client_user_agent: call.clientUserAgent,
  });
  if (error) {
    // Degrade gracefully — same policy as the gateway audit writer.
    console.error('[bash-rest-bypass] audit write failed', { error: error.message, call });
  }
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
    .from('bash_bindings')
    .select('id, project_id, bash_content, parsed_meta, projects!inner(organization_id)')
    .eq('id', bindingId)
    .maybeSingle<BindingRow>();

  if (!binding || binding.projects.organization_id !== guard.orgId) {
    return NextResponse.json({ error: 'binding not found in this org' }, { status: 404 });
  }
  if (!binding.bash_content || !binding.parsed_meta) {
    return NextResponse.json(
      { error: 'this binding has no script — add one before running tools' },
      { status: 400 },
    );
  }

  const tool: ParsedTool | undefined = binding.parsed_meta.tools.find(
    (t) => t.functionName === body.tool,
  );
  if (!tool) {
    return NextResponse.json(
      { error: `tool '${body.tool}' is not declared by this script` },
      { status: 400 },
    );
  }

  const materialized = materializeArgs(tool, body.args);
  if (!materialized.ok) {
    return NextResponse.json({ error: materialized.error }, { status: 400 });
  }
  const { argv } = materialized;

  const host = await loadHostBySlugInOrg(svc, {
    hostSlug: body.host_slug,
    bindingId,
    orgId: guard.orgId,
  });
  if (!host) {
    return NextResponse.json(
      { error: `no host '${body.host_slug}' attached to this binding` },
      { status: 404 },
    );
  }

  const { cmd } = buildToolInvocation(binding.bash_content, tool.functionName, argv);
  const auditBase: Omit<AuditCallSummary, 'upstreamLatencyMs'> = {
    organizationId: guard.orgId,
    projectId: binding.project_id,
    toolName: `bash__rest__${tool.functionName}`,
    capabilityShorthand: `bash:${tool.ring}:${tool.action}@${body.host_slug}`,
    argumentsHash: hashArguments(body.args),
    clientIp: req.headers.get('x-forwarded-for') ?? null,
    clientUserAgent: req.headers.get('user-agent') ?? null,
  };
  const startedAt = Date.now();
  try {
    const exec = await execOnHost(host, cmd, body.timeout_s);
    if (!exec.ok) {
      await writeRestBypassAudit(svc, {
        ...auditBase,
        upstreamLatencyMs: Date.now() - startedAt,
      });
      return NextResponse.json(
        { error: 'SSH private key is missing or corrupt.' },
        { status: 500 },
      );
    }
    const { result } = exec;
    await writeRestBypassAudit(svc, {
      ...auditBase,
      upstreamLatencyMs: result.duration_ms ?? Date.now() - startedAt,
    });
    return NextResponse.json({
      ok: result.exit_code === 0,
      exit_code: result.exit_code,
      stdout: result.stdout,
      stderr: result.stderr,
      duration_ms: result.duration_ms,
      truncated: result.truncated,
    });
  } catch (e) {
    await writeRestBypassAudit(svc, {
      ...auditBase,
      upstreamLatencyMs: Date.now() - startedAt,
    });
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
}
