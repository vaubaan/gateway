/**
 * Programmatic AccessToken mint — spin up an ephemeral MCP credential
 * without a user session.
 *
 *   POST /api/v1/mgmt/tokens
 *     Authorization: Bearer vbn_mgmt_…
 *
 *   Two body shapes are accepted (dual-mode during the v1→v4 transition).
 *   They MUST NOT be mixed — 400 if both `capabilities` and `accepted_risks`
 *   are present.
 *
 *   v1 (capability-based, legacy) :
 *     { projectSlug, capabilities[], name?, ttlHours?, ttlSeconds?, singleUse?,
 *       context? }
 *
 *   v4 (risk-based) :
 *     { projectSlug, bindings[], accepted_risks[], denied_risks?,
 *       name?, ttlHours?, ttlSeconds?, singleUse?, context? }
 *
 *   Both shapes return :
 *   - 201 { access_token, api_key, expires_at }
 *       when no human gate is required (every effective gate is `allow`).
 *   - 202 { approval_id, status: 'pending', channel, poll_url, expires_at,
 *           gated (v1) | needs_approval (v4) }
 *       when at least one risk / capability is gated `confirm`.
 *   - 403 with denied list when at least one gate is `deny`.
 *
 * Spec : docs/spec/vaubaan-gateway.md §3.1 + docs/spec/gateway-risk-model.md §9.
 */

import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import {
  type Capability,
  formatCapability,
  generateApiKey,
  hashApiKey,
  parseCapability,
  type Provider,
  type RiskPolicyOverride,
} from '@vaubaan/shared';
import {
  evaluatePolicy,
  confirmDecisions,
  denyDecisions,
  type IndexedRiskCatalog,
  type PolicyRule,
} from '@vaubaan/policy-engine';
import { getSupabaseServiceClient } from '@/lib/supabase/server';
import { requireManagementKey } from '@/lib/auth/require-management-key';
import { pickChannel } from '@/lib/approvals';
import { mintRiskAccessToken } from '@/lib/approvals/risk-mint';
import { getCatalog } from '@/lib/risk-catalog/loader';
import { computePreview, type PreviewBinding, type PreviewResponse } from './preview/route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DEFAULT_TTL_HOURS = 24;
const MAX_TTL_HOURS = 24 * 7;
const MAX_TTL_SECONDS = 3600; // 1h cap on ttlSeconds (single-use territory).

// ─── Body schemas ───────────────────────────────────────────────────────────

const BindingSchema = z.object({
  provider: z.enum(['github', 'vercel', 'supabase', 'railway', 'bash']),
  resource_ref: z.string().min(1),
  env: z.string().min(1).optional().nullable(),
});

const CommonShape = {
  projectSlug: z.string().min(1),
  name: z
    .string()
    .regex(/^[a-z0-9](-?[a-z0-9])*$/)
    .optional(),
  ttlHours: z.number().int().positive().max(MAX_TTL_HOURS).optional(),
  ttlSeconds: z.number().int().positive().max(MAX_TTL_SECONDS).optional(),
  singleUse: z.boolean().optional(),
  context: z.record(z.unknown()).optional(),
};

const V1BodySchema = z.object({
  ...CommonShape,
  capabilities: z.array(z.string().min(1)).min(1),
});

const V4BodySchema = z.object({
  ...CommonShape,
  bindings: z.array(BindingSchema).min(1),
  accepted_risks: z.array(z.string().min(1)),
  denied_risks: z.array(z.string().min(1)).optional(),
});

const UnionSchema = z.union([
  // v4 first (more specific — has `bindings` + `accepted_risks`).
  V4BodySchema,
  V1BodySchema,
]);

// ─── Helpers ────────────────────────────────────────────────────────────────

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

// ─── POST handler ───────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  const guard = await requireManagementKey(req.headers.get('authorization'));
  if (!guard.ok) return guard.response;

  let raw: unknown;
  try {
    raw = await req.json();
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'invalid body' },
      { status: 400 },
    );
  }

  // Refuse if both shapes are present — caller must pick one explicitly.
  if (
    typeof raw === 'object' &&
    raw !== null &&
    'capabilities' in raw &&
    ('accepted_risks' in raw || 'bindings' in raw)
  ) {
    return NextResponse.json(
      {
        error:
          'cannot mix v1 (capabilities[]) and v4 (bindings[]/accepted_risks[]) body shapes in the same request',
      },
      { status: 400 },
    );
  }

  let body: z.infer<typeof UnionSchema>;
  try {
    body = UnionSchema.parse(raw);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'invalid body' },
      { status: 400 },
    );
  }

  const svc = getSupabaseServiceClient();

  // Resolve project (must live in the bound org).
  const { data: project } = await svc
    .from('projects')
    .select('id, slug, name')
    .eq('organization_id', guard.orgId)
    .eq('slug', body.projectSlug)
    .maybeSingle<ProjectRow>();
  if (!project) {
    return NextResponse.json({ error: 'project not found in this org' }, { status: 404 });
  }

  if ('accepted_risks' in body && 'bindings' in body) {
    return await handleV4Mint(svc, guard, project, body);
  }
  // Otherwise it's the v1 shape (capabilities[]).
  return await handleV1Mint(svc, guard, project, body);
}

// ─── v1 flow (capability-based, legacy) ─────────────────────────────────────

async function handleV1Mint(
  svc: ReturnType<typeof getSupabaseServiceClient>,
  guard: { ok: true; orgId: string; managementKeyId: string },
  project: ProjectRow,
  body: z.infer<typeof V1BodySchema>,
): Promise<NextResponse> {
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

  const { expiresAt, ttlHours } = ttlExpiresAt(body);
  const tokenName = body.name ?? `mgmt-${randomSuffix()}`;
  const singleUse = body.singleUse ?? false;

  // Consult the project's v1 policy.
  const { data: rulesRaw } = await svc
    .from('policy_rules')
    .select('id, project_id, provider, plane, level, action, env_pattern, gate, priority')
    .eq('project_id', project.id);
  const rules = (rulesRaw ?? []) as PolicyRule[];
  const decisions = evaluatePolicy(capabilities, rules);

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
    const { apiKey, apiKeyPrefix } = generateApiKey('live');
    const apiKeyHash = await hashApiKey(apiKey);

    const { data: inserted, error: insertErr } = await svc
      .from('access_tokens')
      .insert({
        project_id: project.id,
        name: tokenName,
        api_key_prefix: apiKeyPrefix,
        api_key_hash: apiKeyHash,
        status: 'active',
        expires_at: expiresAt,
        capabilities,
        single_use: singleUse,
      })
      .select('id, name, project_id, api_key_prefix, status, expires_at, created_at')
      .single<{
        id: string;
        name: string;
        project_id: string;
        api_key_prefix: string;
        status: string;
        expires_at: string;
        created_at: string;
      }>();
    if (insertErr || !inserted) {
      return NextResponse.json(
        { error: insertErr?.message ?? 'failed to insert access token' },
        { status: 500 },
      );
    }
    return NextResponse.json(
      { access_token: inserted, api_key: apiKey, expires_at: expiresAt },
      { status: 201 },
    );
  }

  const channel = await pickChannel(svc, project.id);
  const { data: approval, error: aErr } = await svc
    .from('approval_requests')
    .insert({
      project_id: project.id,
      requested_by_management_key_id: guard.managementKeyId,
      requested_capabilities: capabilities,
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
      capabilities,
      tokenName,
      ttlHours,
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

// ─── v4 flow (risk-based) ───────────────────────────────────────────────────

async function handleV4Mint(
  svc: ReturnType<typeof getSupabaseServiceClient>,
  guard: { ok: true; orgId: string; managementKeyId: string },
  project: ProjectRow,
  body: z.infer<typeof V4BodySchema>,
): Promise<NextResponse> {
  const { ttlHours, ttlMs } = ttlExpiresAt(body);
  const tokenName = body.name ?? `mgmt-${randomSuffix()}`;
  const singleUse = body.singleUse ?? false;

  // Load project policy overrides for this project.
  const { data: rulesRaw } = await svc
    .from('project_risk_policies')
    .select('id, project_id, risk_id, env_scope, gate, created_at')
    .eq('project_id', project.id);
  const overrides: RiskPolicyOverride[] = rulesRaw ?? [];

  // Load only the catalogs we actually need (providers present in bindings).
  const providers = new Set<Provider>(body.bindings.map((b) => b.provider));
  const catalogs: Partial<Record<Provider, IndexedRiskCatalog>> = {};
  for (const p of providers) {
    const c = getCatalog(p);
    if (c) catalogs[p] = c;
  }

  const bindings: PreviewBinding[] = body.bindings.map((b) => ({
    provider: b.provider,
    resource_ref: b.resource_ref,
    env: b.env ?? null,
  }));
  const preview: PreviewResponse = computePreview({
    bindings,
    accepted_risks: body.accepted_risks,
    denied_risks: body.denied_risks ?? [],
    catalogs,
    overrides,
  });

  // Hard deny — at least one risk is `deny` (policy, env, unknown, or
  // explicit denied_risks).
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

  // Fast path : all-allow → mint direct.
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

  // Approval path : at least one `confirm`. Create the pending row and
  // dispatch via the project's configured channel.
  const channel = await pickChannel(svc, project.id);
  const { data: approval, error: aErr } = await svc
    .from('approval_requests')
    .insert({
      project_id: project.id,
      requested_by_management_key_id: guard.managementKeyId,
      // V4 column (migration 0030) — what's actually being requested.
      requested_risks: body.accepted_risks,
      // Legacy v1 column still NOT NULL (migration 0013) — write empty
      // array until migration 0031 drops the column.
      requested_capabilities: [],
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
      // The v1 channel implementations take `capabilities` — we pass [] for
      // now and add `risks` in the context until we extend ApprovalChannel
      // with a v4-aware payload (phase 6, EmailChannel).
      capabilities: [],
      tokenName,
      ttlHours,
      context: {
        ...(body.context ?? {}),
        accepted_risks: body.accepted_risks,
        needs_approval: preview.needs_approval,
        denied_risks: body.denied_risks ?? [],
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
      needs_approval: preview.needs_approval,
      risks: preview.risks,
    },
    { status: 202 },
  );
}
