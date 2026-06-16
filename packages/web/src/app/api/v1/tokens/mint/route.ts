/**
 * Unified token-mint — every caller mints a child token here.
 *
 *   POST /api/v1/tokens/mint
 *     Authorization: Bearer vbn_live_…
 *     body: {
 *       name, accepted_risks[], denied_risks?,
 *       scope: 'org' | 'project',
 *       projectId?, projectSlug?,
 *       bindings?: ProjectBinding[],   // for the preview gate computation
 *       context?,
 *       ttlSeconds?, ttlHours?,
 *       singleUse?,
 *     }
 *
 *   Responses
 *   - 201 { token, api_key, expires_at, accepted_risks } when all-allow.
 *   - 202 { approval_id, status: 'pending', poll_url, ... } when at least
 *         one risk is `confirm`.
 *   - 403 { error, denied_risks } when at least one risk is `deny` OR a
 *         subset/depth/expires_at invariant is violated.
 *
 * Spec : ADR unified-tokens-delegation-chain-and-escalation-channel.md §D3.
 */

import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import type { Provider, RiskPolicyOverride } from '@vaubaan/shared';
import type { IndexedRiskCatalog } from '@vaubaan/policy-engine';
import { getSupabaseServiceClient } from '@/lib/supabase/server';
import { requireToken } from '@/lib/auth/require-token';
import { pickChannel } from '@/lib/approvals';
import { mintChildToken, MintInvariantError, type MintParent } from '@/lib/approvals/mint';
import { getCatalog } from '@/lib/risk-catalog/loader';
import { computePreview, type PreviewBinding, type PreviewResponse } from '@/lib/mint/risk-preview';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DEFAULT_TTL_HOURS = 24;
const MAX_TTL_HOURS = 24 * 7;
const MAX_TTL_SECONDS = 3600;

const BindingSchema = z.object({
  provider: z.enum(['github', 'vercel', 'supabase', 'railway', 'bash']),
  resource_ref: z.string().min(1),
  env: z.string().min(1).optional().nullable(),
});

const BodySchema = z
  .object({
    name: z
      .string()
      .regex(/^[a-z0-9](-?[a-z0-9])*$/)
      .optional(),
    scope: z.enum(['org', 'project']),
    projectId: z.string().uuid().optional(),
    projectSlug: z.string().min(1).optional(),
    ttlHours: z.number().int().positive().max(MAX_TTL_HOURS).optional(),
    ttlSeconds: z.number().int().positive().max(MAX_TTL_SECONDS).optional(),
    singleUse: z.boolean().optional(),
    context: z.record(z.unknown()).optional(),
    bindings: z.array(BindingSchema).optional(),
    accepted_risks: z.array(z.string().min(1)),
    denied_risks: z.array(z.string().min(1)).optional(),
  })
  .refine((b) => b.ttlSeconds === undefined || b.singleUse === true, {
    message: '`ttlSeconds` requires `singleUse: true` (use `ttlHours` for session tokens).',
    path: ['singleUse'],
  });

function ttlExpiresAt(body: { ttlHours?: number; ttlSeconds?: number }): {
  expiresAt: string;
  ttlHours: number;
  ttlMs: number;
} {
  if (body.ttlSeconds !== undefined) {
    const ttlMs = body.ttlSeconds * 1000;
    return {
      expiresAt: new Date(Date.now() + ttlMs).toISOString(),
      ttlHours: body.ttlSeconds / 3600,
      ttlMs,
    };
  }
  const h = body.ttlHours ?? DEFAULT_TTL_HOURS;
  const ttlMs = h * 3600 * 1000;
  return {
    expiresAt: new Date(Date.now() + ttlMs).toISOString(),
    ttlHours: h,
    ttlMs,
  };
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 10).padEnd(8, '0');
}

interface ProjectRow {
  id: string;
  slug: string;
  name: string | null;
}

export async function POST(req: NextRequest) {
  const guard = await requireToken(req.headers.get('authorization'));
  if (!guard.ok) return guard.response;

  let body: z.infer<typeof BodySchema>;
  try {
    body = BodySchema.parse(await req.json());
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'invalid body' },
      { status: 400 },
    );
  }

  const svc = getSupabaseServiceClient();

  // Resolve the target project (if scope='project').
  let projectRow: ProjectRow | null = null;
  if (body.scope === 'project') {
    if (body.projectId) {
      const { data } = await svc
        .from('projects')
        .select('id, slug, name')
        .eq('organization_id', guard.orgId)
        .eq('id', body.projectId)
        .maybeSingle<ProjectRow>();
      projectRow = data ?? null;
    } else if (body.projectSlug) {
      const { data } = await svc
        .from('projects')
        .select('id, slug, name')
        .eq('organization_id', guard.orgId)
        .eq('slug', body.projectSlug)
        .maybeSingle<ProjectRow>();
      projectRow = data ?? null;
    } else {
      return NextResponse.json(
        { error: 'scope="project" requires projectId or projectSlug' },
        { status: 400 },
      );
    }
    if (!projectRow) {
      return NextResponse.json({ error: 'project not found in this org' }, { status: 404 });
    }
  }

  const { expiresAt, ttlHours, ttlMs } = ttlExpiresAt(body);
  const tokenName = body.name ?? `${body.scope}-${randomSuffix()}`;
  const singleUse = body.singleUse ?? false;

  // Compute the preview (gates) when bindings are provided + project scope.
  // For org-scoped mints we skip the preview (the row has no project policy).
  let preview: PreviewResponse | null = null;
  if (body.scope === 'project' && projectRow && body.bindings && body.bindings.length > 0) {
    const { data: rulesRaw } = await svc
      .from('project_risk_policies')
      .select('id, project_id, risk_id, env_scope, gate, created_at')
      .eq('project_id', projectRow.id);
    const overrides: RiskPolicyOverride[] = rulesRaw ?? [];

    const providers = new Set<Provider>(body.bindings.map((b) => b.provider));
    const catalogs: Partial<Record<Provider, IndexedRiskCatalog>> = {};
    for (const p of providers) {
      const c = getCatalog(p);
      if (c) catalogs[p] = c;
    }

    const previewBindings: PreviewBinding[] = body.bindings.map((b) => ({
      provider: b.provider,
      resource_ref: b.resource_ref,
      env: b.env ?? null,
    }));
    preview = computePreview({
      bindings: previewBindings,
      accepted_risks: body.accepted_risks,
      denied_risks: body.denied_risks ?? [],
      catalogs,
      overrides,
    });

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
  }

  // Approval gate ?
  if (preview && !preview.all_allowed && projectRow) {
    const channel = await pickChannel(svc, projectRow.id);
    const { data: approval, error: aErr } = await svc
      .from('approval_requests')
      .insert({
        project_id: projectRow.id,
        requested_by_user_id: guard.token.created_by,
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
        projectId: projectRow.id,
        projectName: projectRow.name ?? projectRow.slug,
        acceptedRisks: body.accepted_risks,
        needsApproval: preview.needs_approval,
        tokenName,
        ttlHours,
        context: {
          ...(body.context ?? {}),
          denied_risks: body.denied_risks ?? [],
          parent_token_id: guard.token.id,
        },
      });
      if (channelRef) {
        await svc
          .from('approval_requests')
          .update({ channel_ref: channelRef })
          .eq('id', approval.id);
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
        poll_url: `/api/v1/tokens/pending/${approval.id}`,
        expires_at: approval.expires_at,
        needs_approval: preview.needs_approval,
        risks: preview.risks,
      },
      { status: 202 },
    );
  }

  // Direct mint.
  const parent: MintParent = {
    id: guard.token.id,
    name: guard.token.name,
    organization_id: guard.token.organization_id,
    scope: guard.token.scope,
    project_id: guard.token.project_id,
    accepted_risks: guard.token.accepted_risks,
    denied_risks: guard.token.denied_risks,
    depth: guard.token.depth,
    delegation_chain: guard.token.delegation_chain,
    expires_at: guard.token.expires_at,
    created_at: guard.token.created_at,
    created_by: guard.token.created_by,
  };
  try {
    const minted = await mintChildToken(svc, {
      parent,
      tokenName,
      scope: body.scope,
      projectId: projectRow?.id ?? null,
      ttlMs,
      accepted_risks: body.accepted_risks,
      denied_risks: body.denied_risks ?? parent.denied_risks,
      singleUse,
      context: body.context ?? null,
      createdBy: guard.token.created_by,
    });
    const { data: tokenRow } = await svc
      .from('tokens')
      .select(
        'id, name, scope, project_id, organization_id, api_key_prefix, status, expires_at, created_at, depth, delegation_chain',
      )
      .eq('id', minted.tokenId)
      .maybeSingle();
    return NextResponse.json(
      {
        token: tokenRow,
        api_key: minted.apiKey,
        expires_at: expiresAt,
        accepted_risks: body.accepted_risks,
      },
      { status: 201 },
    );
  } catch (e) {
    if (e instanceof MintInvariantError) {
      return NextResponse.json({ error: e.message }, { status: e.httpStatus });
    }
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'failed to mint child token' },
      { status: 500 },
    );
  }
}
