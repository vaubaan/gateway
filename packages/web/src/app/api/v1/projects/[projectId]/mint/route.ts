/**
 * User-session mint — mint a risk-based access_token from the dashboard.
 *
 *   POST /api/v1/projects/:projectId/mint
 *     Cookie: Supabase Auth session (user must be org member).
 *     Body  : {
 *       orgSlug,
 *       bindings[], accepted_risks[], denied_risks?,
 *       name?, ttlSeconds?, singleUse?, context?
 *     }
 *
 *   - 201 { access_token, api_key, expires_at, accepted_risks }
 *         when every effective gate is `allow`. The `api_key` is the
 *         plaintext live key, returned once.
 *   - 202 { approval_id, status: 'pending', channel, poll_url, expires_at,
 *           gated_risks, risks }
 *         when at least one gate is `confirm`. The dashboard surfaces a
 *         link to the approvals page.
 *   - 403 { error, denied_risks, risks } when at least one gate is `deny`.
 *
 * Mirrors `/api/v1/mgmt/tokens` but :
 *   - authenticates via cookie (`requireOrgMember`) instead of mgmt key,
 *   - logs `requested_by_user_id` instead of `requested_by_management_key_id`,
 *   - reuses `computeMintPreview` for the gate computation.
 *
 * Spec : docs/spec/gateway-risk-model.md §9.
 */

import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { getSupabaseServiceClient } from '@/lib/supabase/server';
import { requireOrgMember } from '@/lib/auth/require-org-member';
import { pickChannel } from '@/lib/approvals';
import { mintRiskAccessToken } from '@/lib/approvals/mint';
import { computeMintPreview } from '@/lib/mint/preview';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Hardcoded TTL cap for the UI form. The mgmt API still accepts `ttlHours`
 *  up to a week ; the user-flow caps at 1 day (matches the UI presets). */
const MAX_TTL_SECONDS = 24 * 3600;

const BindingSchema = z.object({
  provider: z.enum(['github', 'vercel', 'supabase', 'railway', 'bash']),
  resource_ref: z.string().min(1),
  env: z.string().min(1).optional().nullable(),
});

const BodySchema = z.object({
  orgSlug: z.string().min(1),
  name: z
    .string()
    .min(1)
    .max(80)
    .regex(/^[a-z0-9](-?[a-z0-9])*$/, 'name must be lowercase kebab-case')
    .optional(),
  ttlSeconds: z.number().int().positive().max(MAX_TTL_SECONDS).optional(),
  singleUse: z.boolean().optional(),
  context: z.record(z.unknown()).optional(),
  bindings: z.array(BindingSchema).min(1),
  accepted_risks: z.array(z.string().min(1)).min(1),
  denied_risks: z.array(z.string().min(1)).optional(),
});

interface ProjectRow {
  id: string;
  slug: string;
  name: string | null;
  organization_id: string;
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 10).padEnd(8, '0');
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await ctx.params;

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
  const { data: project } = await svc
    .from('projects')
    .select('id, slug, name, organization_id')
    .eq('id', projectId)
    .maybeSingle<ProjectRow>();
  if (!project || project.organization_id !== guard.orgId) {
    return NextResponse.json({ error: 'project not found in this org' }, { status: 404 });
  }

  const ttlSeconds = body.ttlSeconds ?? 3600;
  const ttlMs = ttlSeconds * 1000;
  const ttlHours = ttlSeconds / 3600;
  const tokenName = body.name ?? `ui-${randomSuffix()}`;
  const singleUse = body.singleUse ?? false;

  const bindings = body.bindings.map((b) => ({
    provider: b.provider,
    resource_ref: b.resource_ref,
    env: b.env ?? null,
  }));

  const preview = await computeMintPreview(svc, project.id, {
    bindings,
    accepted_risks: body.accepted_risks,
    denied_risks: body.denied_risks,
  });

  // 403 — at least one risk denied by catalog / policy / env-scope / wire opt-out.
  if (preview.denied.length > 0) {
    return NextResponse.json(
      {
        error: 'one or more requested risks are denied by catalog/policy',
        denied_risks: preview.denied,
        risks: preview.risks.filter((r) => r.effective_gate === 'deny'),
      },
      { status: 403 },
    );
  }

  // 201 — all-allow fast path.
  if (preview.all_allowed) {
    try {
      const minted = await mintRiskAccessToken(svc, {
        projectId: project.id,
        tokenName,
        ttlMs,
        accepted_risks: body.accepted_risks,
        denied_risks: body.denied_risks ?? [],
        singleUse,
      });
      const { data: token } = await svc
        .from('access_tokens')
        .select('id, name, project_id, api_key_prefix, status, expires_at, created_at')
        .eq('id', minted.accessTokenId)
        .maybeSingle<{
          id: string;
          name: string;
          project_id: string;
          api_key_prefix: string;
          status: string;
          expires_at: string;
          created_at: string;
        }>();
      return NextResponse.json(
        {
          access_token: token,
          api_key: minted.apiKey,
          expires_at: minted.expiresAt,
          accepted_risks: body.accepted_risks,
        },
        { status: 201 },
      );
    } catch (e) {
      return NextResponse.json(
        { error: e instanceof Error ? e.message : 'failed to mint access token' },
        { status: 500 },
      );
    }
  }

  // 202 — at least one `confirm` gate. Open an approval request and dispatch.
  const channel = await pickChannel(svc, project.id);
  const { data: approval, error: aErr } = await svc
    .from('approval_requests')
    .insert({
      project_id: project.id,
      requested_by_user_id: guard.userId,
      requested_risks: body.accepted_risks,
      requested_token_name: tokenName,
      requested_ttl_hours: ttlHours,
      requested_single_use: singleUse,
      context: body.context ?? null,
      channel: channel.id,
      status: 'pending',
    })
    .select('id, created_at, expires_at')
    .single<{ id: string; created_at: string; expires_at: string }>();
  if (aErr || !approval) {
    return NextResponse.json(
      { error: aErr?.message ?? 'failed to open approval request' },
      { status: 500 },
    );
  }

  try {
    const { channelRef } = await channel.open({
      approvalId: approval.id,
      projectId: project.id,
      projectName: project.name ?? project.slug,
      acceptedRisks: body.accepted_risks,
      needsApproval: preview.needs_approval,
      tokenName,
      ttlHours,
      context: {
        ...(body.context ?? {}),
        denied_risks: body.denied_risks ?? [],
        requested_by_user_id: guard.userId,
      },
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
      gated_risks: preview.needs_approval,
      risks: preview.risks,
    },
    { status: 202 },
  );
}
