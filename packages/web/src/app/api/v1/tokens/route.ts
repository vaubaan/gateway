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
import { requireOrgMember } from '@/lib/auth/require-org-member';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const BodySchema = z.object({
  orgSlug: z.string().min(1),
  projectSlug: z.string().min(1),
  name: z.string().regex(/^[a-z0-9](-?[a-z0-9])*$/),
  capabilities: z.array(z.string().min(1)).min(1),
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

  // Parse every capability shorthand into its stored tuple form.
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
    .select('id, slug')
    .eq('organization_id', guard.orgId)
    .eq('slug', body.projectSlug)
    .maybeSingle<{ id: string; slug: string }>();
  if (!project) return NextResponse.json({ error: 'project not found' }, { status: 404 });
  const p = project;

  // Consult the project's policy (spec §5.1). Default-deny: any capability
  // without an explicit ai-allow rule falls back to human-gated, and we
  // refuse to mint (Phase 4 will open an ApprovalChannel instead).
  const { data: rulesRaw } = await svc
    .from('policy_rules')
    .select('id, project_id, provider, plane, level, action, env_pattern, gate, priority')
    .eq('project_id', p.id);
  const rules = (rulesRaw ?? []) as PolicyRule[];
  const decisions = evaluatePolicy(capabilities, rules);
  const gated = humanGatedDecisions(decisions);
  if (gated.length > 0) {
    return NextResponse.json(
      {
        error: 'one or more requested capabilities require human approval',
        gated: gated.map((d) => ({
          capability: formatCapability(d.capability),
          matchedRule: d.matchedRule
            ? { id: d.matchedRule.id, priority: d.matchedRule.priority }
            : null,
          reason: d.matchedRule
            ? `policy rule ${d.matchedRule.id} sets gate='human'`
            : 'no policy rule matches → default-deny',
        })),
        hint: 'add a more specific policy rule with gate=ai, or use the approval flow (coming soon).',
      },
      { status: 403 },
    );
  }

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
