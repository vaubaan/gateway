import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import {
  type Capability,
  formatCapability,
  generateApiKey,
  hashApiKey,
  parseCapability,
} from '@vaubaan/shared';
import {
  evaluatePolicy,
  confirmDecisions,
  denyDecisions,
  type PolicyRule,
} from '@vaubaan/policy-engine';
import { getSupabaseServiceClient } from '@/lib/supabase/server';
import { requireOrgMember } from '@/lib/auth/require-org-member';
import { pickChannel } from '@/lib/approvals';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const BodySchema = z.object({
  orgSlug: z.string().min(1),
  projectSlug: z.string().min(1),
  name: z.string().regex(/^[a-z0-9](-?[a-z0-9])*$/),
  capabilities: z.array(z.string().min(1)).min(1),
  context: z.record(z.unknown()).optional(),
});

export async function POST(req: NextRequest) {
  let body: z.infer<typeof BodySchema>;
  try {
    body = BodySchema.parse(await req.json());
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'invalid body' },
      { status: 400 },
    );
  }

  // Parse every capability notation into its stored tuple form.
  let capabilities: Capability[];
  try {
    capabilities = body.capabilities.map((s) => {
      try {
        return parseCapability(s);
      } catch (e) {
        throw new Error(`invalid capability '${s}': ${e instanceof Error ? e.message : String(e)}`);
      }
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'invalid capability' },
      { status: 400 },
    );
  }

  const guard = await requireOrgMember(body.orgSlug);
  if (!guard.ok) return guard.response;

  const svc = getSupabaseServiceClient();

  const { data: project } = await svc
    .from('projects')
    .select('id, slug, name')
    .eq('organization_id', guard.orgId)
    .eq('slug', body.projectSlug)
    .maybeSingle<{ id: string; slug: string; name: string | null }>();
  if (!project) return NextResponse.json({ error: 'project not found' }, { status: 404 });
  const p = project;

  // Consult the project's policy (spec §5.1).
  const { data: rulesRaw } = await svc
    .from('policy_rules')
    .select('id, project_id, provider, plane, level, action, env_pattern, gate, priority')
    .eq('project_id', p.id);
  const rules = (rulesRaw ?? []) as PolicyRule[];
  const decisions = evaluatePolicy(capabilities, rules);

  // Hard deny — at least one capability is explicitly refused by policy.
  const denied = denyDecisions(decisions);
  if (denied.length > 0) {
    return NextResponse.json(
      {
        error: 'one or more requested capabilities are denied by policy',
        denied: denied.map((d) => ({
          capability: formatCapability(d.capability),
          matchedRule: d.matchedRule
            ? { id: d.matchedRule.id, priority: d.matchedRule.priority }
            : null,
          reason: d.matchedRule
            ? `policy rule ${d.matchedRule.id} sets gate='deny'`
            : 'no policy rule matches → default-deny',
        })),
      },
      { status: 403 },
    );
  }
  const gated = confirmDecisions(decisions);

  if (gated.length === 0) {
    // All-allow : fast path, mint immediately.
    const { apiKey, apiKeyPrefix } = generateApiKey('live');
    const apiKeyHash = await hashApiKey(apiKey);

    const { data: inserted, error: insertErr } = await svc
      .from('access_tokens')
      .insert({
        project_id: p.id,
        name: body.name,
        api_key_prefix: apiKeyPrefix,
        api_key_hash: apiKeyHash,
        status: 'active',
        capabilities,
        created_by: guard.userId,
      })
      .select('id, name, api_key_prefix, status, created_at')
      .single<{
        id: string;
        name: string;
        api_key_prefix: string;
        status: string;
        created_at: string;
      }>();
    if (insertErr || !inserted) {
      return NextResponse.json(
        { error: insertErr?.message ?? 'failed to insert access token' },
        { status: 500 },
      );
    }
    return NextResponse.json({ access_token: inserted, api_key: apiKey }, { status: 201 });
  }

  // Approval path — open a request, dispatch via the project's channel,
  // return 202. The mgmt poll endpoint (/api/v1/mgmt/tokens/pending/:id) is
  // shared : the dashboard UI may also poll it on the user's behalf.
  const channel = await pickChannel(svc, p.id);
  const { data: approval, error: aErr } = await svc
    .from('approval_requests')
    .insert({
      project_id: p.id,
      requested_by_user_id: guard.userId,
      requested_capabilities: capabilities,
      requested_token_name: body.name,
      requested_ttl_hours: 24,
      context: body.context ?? null,
      channel: channel.id,
      status: 'pending',
    })
    .select('id, expires_at')
    .single<{ id: string; expires_at: string }>();
  if (aErr || !approval) {
    return NextResponse.json(
      { error: aErr?.message ?? 'failed to open approval request' },
      { status: 500 },
    );
  }

  try {
    const { channelRef } = await channel.open({
      approvalId: approval.id,
      projectId: p.id,
      projectName: p.name ?? p.slug,
      capabilities,
      tokenName: body.name,
      ttlHours: 24,
      context: body.context,
    });
    if (channelRef) {
      await svc.from('approval_requests').update({ channel_ref: channelRef }).eq('id', approval.id);
    }
  } catch (e) {
    await svc
      .from('approval_requests')
      .update({ status: 'cancelled', decided_at: new Date().toISOString() })
      .eq('id', approval.id);
    return NextResponse.json(
      {
        error: 'approval channel dispatch failed',
        detail: e instanceof Error ? e.message : String(e),
      },
      { status: 502 },
    );
  }

  return NextResponse.json(
    {
      approval_id: approval.id,
      status: 'pending',
      channel: channel.id,
      poll_url: `/api/v1/mgmt/tokens/pending/${approval.id}`,
      expires_at: approval.expires_at,
      gated: gated.map((d) => ({
        capability: formatCapability(d.capability),
        matchedRule: d.matchedRule
          ? { id: d.matchedRule.id, priority: d.matchedRule.priority }
          : null,
      })),
    },
    { status: 202 },
  );
}
