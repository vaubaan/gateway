/**
 * Shared mint-preview computation — used by the unified
 * `/api/v1/tokens/preview` route and the user-session preview route.
 *
 * Wraps the pure `computePreview` (lib/mint/risk-preview.ts) with the DB
 * plumbing : load project policy overrides + per-provider catalogs.
 *
 * Spec : docs/spec/gateway-risk-model.md §9.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { IndexedRiskCatalog } from '@vaubaan/policy-engine';
import type { Provider, RiskPolicyOverride } from '@vaubaan/shared';

import { getCatalog } from '@/lib/risk-catalog/loader';
import { computePreview, type PreviewBinding, type PreviewResponse } from '@/lib/mint/risk-preview';

export interface MintPreviewBody {
  readonly bindings: readonly PreviewBinding[];
  readonly accepted_risks: readonly string[];
  readonly denied_risks?: readonly string[];
}

export async function computeMintPreview(
  svc: SupabaseClient,
  projectId: string,
  body: MintPreviewBody,
): Promise<PreviewResponse> {
  const { data: rulesRaw } = await svc
    .from('project_risk_policies')
    .select('id, project_id, risk_id, env_scope, gate, created_at')
    .eq('project_id', projectId);
  const overrides: RiskPolicyOverride[] = rulesRaw ?? [];

  const providers = new Set<Provider>(body.bindings.map((b) => b.provider));
  const catalogs: Partial<Record<Provider, IndexedRiskCatalog>> = {};
  for (const p of providers) {
    const c = getCatalog(p);
    if (c) catalogs[p] = c;
  }

  return computePreview({
    bindings: body.bindings,
    accepted_risks: body.accepted_risks,
    denied_risks: body.denied_risks ?? [],
    catalogs,
    overrides,
  });
}
