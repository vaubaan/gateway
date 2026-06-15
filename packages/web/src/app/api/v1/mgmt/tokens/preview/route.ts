/**
 * Risk-mint preview — compute the effective gate for each accepted_risk +
 * binding, **without** minting anything.
 *
 *   POST /api/v1/mgmt/tokens/preview
 *     Authorization: Bearer vbn_mgmt_…
 *     body: {
 *       projectSlug: string,
 *       bindings:    ProjectBinding[],
 *       accepted_risks: RiskId[],
 *       denied_risks?:  RiskId[],
 *     }
 *
 *   200 {
 *     risks: [
 *       { id, label, reason, vector, effective_gate, origin, env?, entry? }
 *     ],
 *     all_allowed: boolean,        // every gate is 'allow'
 *     needs_approval: RiskId[],    // gates that are 'confirm'
 *     denied: RiskId[],            // gates that are 'deny' OR unacceptable env
 *   }
 *
 * Spec : docs/spec/gateway-risk-model.md §9.
 *
 * Notes
 *  - The endpoint is intentionally pure-compute : it consults the YAML
 *    catalog (in-memory cache) + the project's `project_risk_policies`
 *    rows, then returns the gate decisions. No mint, no audit, no
 *    side-effect.
 *  - `bindings` in the body is the *desired* set for this mint. Each
 *    binding carries `provider`, `resource_ref`, and optional `env`. We
 *    resolve risks per-binding so the manager sees `supabase[staging]`
 *    and `supabase[prod]` as distinct rows when both are in scope.
 *  - The catalog stores the **non-env-qualified** `RiskId`
 *    (`supabase.bulk-row-write`). The wire / UI present the qualified
 *    form (`supabase[staging].bulk-row-write`) for env-scoped risks.
 *    `qualifyRiskId` does the conversion based on
 *    `RiskEntry.acceptable_in_envs`.
 */

import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import {
  resolveEffectiveGate,
  checkAcceptableInEnv,
  findRiskEntry,
  type IndexedRiskCatalog,
} from '@vaubaan/policy-engine';
import type { Provider, RiskId, RiskPolicyOverride } from '@vaubaan/shared';
import { getSupabaseServiceClient } from '@/lib/supabase/server';
import { requireManagementKey } from '@/lib/auth/require-management-key';
import { getCatalog, qualifyRiskId, unqualifyRiskId } from '@/lib/risk-catalog/loader';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const BindingSchema = z.object({
  provider: z.enum(['github', 'vercel', 'supabase', 'railway', 'bash']),
  resource_ref: z.string().min(1),
  env: z.string().min(1).optional().nullable(),
});

const BodySchema = z.object({
  projectSlug: z.string().min(1),
  bindings: z.array(BindingSchema).min(1),
  accepted_risks: z.array(z.string().min(1)),
  denied_risks: z.array(z.string().min(1)).optional(),
});

export type PreviewBody = z.infer<typeof BodySchema>;
export type PreviewBinding = z.infer<typeof BindingSchema>;

export interface PreviewRiskRow {
  /** The qualified RiskId presented to the UI / manager. */
  id: RiskId;
  /** The base (non-qualified) id used as the catalog lookup key. */
  base_id: RiskId;
  /** The provider this risk belongs to. */
  provider: Provider;
  /** The binding env this risk is resolved against (null for account-scope). */
  env: string | null;
  /** UI label from catalog entry — empty if entry was missing. */
  label: string;
  /** Human-readable reason from catalog entry — empty if entry was missing. */
  reason: string;
  /** The 6D vector — undefined if entry was missing. */
  vector: unknown;
  /** Effective gate after applying project policy overrides. */
  effective_gate: 'allow' | 'confirm' | 'deny';
  /** Where the gate value came from. */
  origin: 'catalog-default' | 'project-policy-env-scoped' | 'project-policy-global';
  /** Set when the risk was rejected for structural reasons (catalog absent,
   *  acceptable_in_envs mismatch, unknown risk). The gate is then `deny`. */
  blocked_reason?: string;
}

export interface PreviewResponse {
  risks: PreviewRiskRow[];
  all_allowed: boolean;
  needs_approval: RiskId[];
  denied: RiskId[];
}

interface ProjectRow {
  id: string;
  slug: string;
}

/**
 * Resolve the effective gate for ONE accepted_risk in the context of a
 * specific binding. Returns the row to surface to the manager. Pure — no
 * IO inside.
 */
export function resolveRiskRow(
  riskId: RiskId,
  binding: PreviewBinding,
  catalog: IndexedRiskCatalog | undefined,
  overrides: readonly RiskPolicyOverride[],
): PreviewRiskRow {
  const baseId = unqualifyRiskId(riskId);
  const env = binding.env ?? null;

  if (!catalog) {
    return {
      id: riskId,
      base_id: baseId,
      provider: binding.provider,
      env,
      label: '',
      reason: '',
      vector: undefined,
      effective_gate: 'deny',
      origin: 'catalog-default',
      blocked_reason:
        `risk catalog for provider '${binding.provider}' is not loaded — ` +
        `the provider's YAML may not have been committed yet`,
    };
  }

  const entry = findRiskEntry(catalog, baseId);
  if (!entry) {
    return {
      id: riskId,
      base_id: baseId,
      provider: binding.provider,
      env,
      label: '',
      reason: '',
      vector: undefined,
      effective_gate: 'deny',
      origin: 'catalog-default',
      blocked_reason: `unknown risk '${baseId}' in provider '${binding.provider}' catalog`,
    };
  }

  // D5 — acceptable_in_envs structural guard. Even if policy allows it, we
  // refuse to accept a risk on an env outside `acceptable_in_envs`.
  const envCheckMsg = checkAcceptableInEnv(entry, env);
  if (envCheckMsg !== null) {
    return {
      id: qualifyRiskId(baseId, env, entry),
      base_id: baseId,
      provider: binding.provider,
      env,
      label: entry.label,
      reason: entry.reason,
      vector: entry.vector,
      effective_gate: 'deny',
      origin: 'catalog-default',
      blocked_reason: envCheckMsg,
    };
  }

  const decision = resolveEffectiveGate(baseId, env, catalog, overrides);
  return {
    id: qualifyRiskId(baseId, env, entry),
    base_id: baseId,
    provider: binding.provider,
    env,
    label: entry.label,
    reason: entry.reason,
    vector: entry.vector,
    effective_gate: decision.gate,
    origin: decision.origin,
  };
}

/**
 * Compute the full preview for a token mint request. Pure — caller is
 * responsible for fetching the catalog + policy overrides.
 *
 * Each accepted_risk is resolved against each binding belonging to the
 * risk's provider. When `risk_id` has no provider prefix that matches any
 * binding, we surface it as a structural denial.
 */
export function computePreview(input: {
  bindings: readonly PreviewBinding[];
  accepted_risks: readonly RiskId[];
  denied_risks: readonly RiskId[];
  catalogs: Partial<Record<Provider, IndexedRiskCatalog>>;
  overrides: readonly RiskPolicyOverride[];
}): PreviewResponse {
  const rows: PreviewRiskRow[] = [];

  for (const riskId of input.accepted_risks) {
    const baseId = unqualifyRiskId(riskId);
    const provider = baseId.split('.')[0] as Provider;

    const relevantBindings = input.bindings.filter((b) => b.provider === provider);
    if (relevantBindings.length === 0) {
      rows.push({
        id: riskId,
        base_id: baseId,
        provider,
        env: null,
        label: '',
        reason: '',
        vector: undefined,
        effective_gate: 'deny',
        origin: 'catalog-default',
        blocked_reason: `no binding for provider '${provider}' — cannot accept '${riskId}'`,
      });
      continue;
    }
    for (const binding of relevantBindings) {
      const row = resolveRiskRow(riskId, binding, input.catalogs[provider], input.overrides);
      // An explicit deny on the wire short-circuits to deny regardless of
      // policy. Surface it so the UI can grey-out / explain.
      if (input.denied_risks.includes(riskId) || input.denied_risks.includes(row.id)) {
        rows.push({
          ...row,
          effective_gate: 'deny',
          blocked_reason: row.blocked_reason ?? 'explicitly denied on the wire',
        });
      } else {
        rows.push(row);
      }
    }
  }

  const denied = rows.filter((r) => r.effective_gate === 'deny').map((r) => r.id);
  const needs_approval = rows.filter((r) => r.effective_gate === 'confirm').map((r) => r.id);
  const all_allowed = denied.length === 0 && needs_approval.length === 0;

  return {
    risks: rows,
    all_allowed,
    needs_approval: [...new Set(needs_approval)],
    denied: [...new Set(denied)],
  };
}

export async function POST(req: NextRequest) {
  const guard = await requireManagementKey(req.headers.get('authorization'));
  if (!guard.ok) return guard.response;

  let body: PreviewBody;
  try {
    body = BodySchema.parse(await req.json());
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'invalid body' },
      { status: 400 },
    );
  }

  const svc = getSupabaseServiceClient();
  const { data: project } = await svc
    .from('projects')
    .select('id, slug')
    .eq('organization_id', guard.orgId)
    .eq('slug', body.projectSlug)
    .maybeSingle<ProjectRow>();
  if (!project) {
    return NextResponse.json({ error: 'project not found in this org' }, { status: 404 });
  }

  const { data: rulesRaw } = await svc
    .from('project_risk_policies')
    .select('id, project_id, risk_id, env_scope, gate, created_at')
    .eq('project_id', project.id);
  const overrides: RiskPolicyOverride[] = rulesRaw ?? [];

  // Build the per-provider catalog map from the in-memory cache.
  const providers = new Set<Provider>(body.bindings.map((b) => b.provider));
  const catalogs: Partial<Record<Provider, IndexedRiskCatalog>> = {};
  for (const p of providers) {
    const c = getCatalog(p);
    if (c) catalogs[p] = c;
  }

  const preview = computePreview({
    bindings: body.bindings,
    accepted_risks: body.accepted_risks,
    denied_risks: body.denied_risks ?? [],
    catalogs,
    overrides,
  });

  return NextResponse.json(preview, { status: 200 });
}
