/**
 * Programmatic AccessToken mint — spin up an ephemeral MCP credential
 * without a user session.
 *
 *   POST /api/v1/mgmt/tokens
 *     Authorization: Bearer vbn_mgmt_…
 *     body: { projectSlug, capabilities, name?, ttlHours?, context? }
 *
 *   - 201 { access_token, api_key, expires_at }
 *       when every requested capability is ai-allowed by the project's policy.
 *   - 202 { approval_id, status: 'pending', channel, poll_url, gated }
 *       when at least one capability is human-gated. The mint is opened as an
 *       approval_requests row, dispatched via the project's channel
 *       (manual | telegram). Poll the `poll_url` to retrieve the api_key
 *       once approved (cf. /api/v1/mgmt/tokens/pending/:approvalId).
 *
 * Behaviour
 *   - Auth via `Authorization: Bearer vbn_mgmt_…` (ManagementKey, org-scoped).
 *   - Validates that `projectSlug` resolves to a project of the bound org.
 *   - Parses every `capabilities[]` notation string (provider:plane/level:action@env)
 *     into a (provider, plane, level, action, env?) tuple — rejects malformed
 *     input with 400.
 *   - Consults the project's policy (spec §5.1) and routes human-gated
 *     requests through the ApprovalChannel (spec §8).
 *
 * Spec : docs/spec/vaubaan-gateway.md §3.1, §8 (mgmt endpoints).
 *         docs/spec/gateway-capability-model.draft.md §5, §5.1, §8.
 */

import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import {
  type Capability,
  formatCapability,
  generateApiKey,
  hashApiKey,
  parseCapability,
} from '@vaubaan/shared';
import { evaluatePolicy, humanGatedDecisions, type PolicyRule } from '@vaubaan/policy-engine';
import { getSupabaseServiceClient } from '@/lib/supabase/server';
import { requireManagementKey } from '@/lib/auth/require-management-key';
import { pickChannel } from '@/lib/approvals';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DEFAULT_TTL_HOURS = 24;
const MAX_TTL_HOURS = 24 * 7;
const MAX_TTL_SECONDS = 3600; // 1h cap on ttlSeconds (single-use territory).

const BodySchema = z.object({
  projectSlug: z.string().min(1),
  capabilities: z.array(z.string().min(1)).min(1),
  name: z
    .string()
    .regex(/^[a-z0-9](-?[a-z0-9])*$/)
    .optional(),
  ttlHours: z.number().int().positive().max(MAX_TTL_HOURS).optional(),
  ttlSeconds: z.number().int().positive().max(MAX_TTL_SECONDS).optional(),
  singleUse: z.boolean().optional(),
  context: z.record(z.unknown()).optional(),
});

/** Compute the token's expires_at and the effective ttl in hours/seconds.
 *  ttlSeconds wins when both are provided (single-use territory). */
function ttlExpiresAt(body: { ttlHours?: number; ttlSeconds?: number }): {
  expiresAt: string;
  ttlHours: number;
} {
  if (body.ttlSeconds !== undefined) {
    return {
      expiresAt: new Date(Date.now() + body.ttlSeconds * 1000).toISOString(),
      ttlHours: body.ttlSeconds / 3600,
    };
  }
  const h = body.ttlHours ?? DEFAULT_TTL_HOURS;
  return { expiresAt: new Date(Date.now() + h * 3600 * 1000).toISOString(), ttlHours: h };
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 10).padEnd(8, '0');
}

export async function POST(req: NextRequest) {
  const guard = await requireManagementKey(req.headers.get('authorization'));
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

  const svc = getSupabaseServiceClient();

  // Resolve project (must live in the bound org).
  const { data: project } = await svc
    .from('projects')
    .select('id, slug, name')
    .eq('organization_id', guard.orgId)
    .eq('slug', body.projectSlug)
    .maybeSingle<{ id: string; slug: string; name: string | null }>();
  if (!project) {
    return NextResponse.json({ error: 'project not found in this org' }, { status: 404 });
  }

  const { expiresAt, ttlHours } = ttlExpiresAt(body);
  const tokenName = body.name ?? `mgmt-${randomSuffix()}`;
  const singleUse = body.singleUse ?? false;

  // Consult the project's policy (spec §5.1).
  const { data: rulesRaw } = await svc
    .from('policy_rules')
    .select('id, project_id, provider, plane, level, action, env_pattern, gate, priority')
    .eq('project_id', project.id);
  const rules = (rulesRaw ?? []) as PolicyRule[];
  const decisions = evaluatePolicy(capabilities, rules);
  const gated = humanGatedDecisions(decisions);

  // Branch — fast path (all-ai) vs approval path (at least one human gate).
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

  // Approval path : create the pending row, dispatch via the project's channel.
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
    // Mark cancelled so we don't keep a dead pending row around.
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
