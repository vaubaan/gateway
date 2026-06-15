/**
 * Shared mint-preview computation — used by both the mgmt-key and the
 * user-session mint routes.
 *
 * Wraps the pure `computePreview` (`/api/v1/mgmt/tokens/preview/route.ts`)
 * with the DB plumbing : load project policy overrides for the given
 * project_id, build the per-provider catalog map from the in-memory cache,
 * and forward to the pure function.
 *
 *   - The body shape (`MintPreviewBody`) is shared between both routes so
 *     the UI can call either endpoint with the same payload.
 *   - The pure compute layer lives next to the mgmt route to avoid an
 *     import cycle and because that file owns the response type
 *     (`PreviewResponse`). This wrapper is a thin adapter, not a refactor.
 *
 * Spec : docs/spec/gateway-risk-model.md §9.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { IndexedRiskCatalog } from '@vaubaan/policy-engine';
import type { Provider, RiskPolicyOverride } from '@vaubaan/shared';

import { getCatalog } from '@/lib/risk-catalog/loader';
import {
  computePreview,
  type PreviewBinding,
  type PreviewResponse,
} from '@/app/api/v1/mgmt/tokens/preview/route';

/** Body shape accepted by both `/mgmt/tokens/preview` and
 *  `/projects/:id/mint/preview`. The user-auth variant resolves the
 *  project from the URL path so it doesn't need `projectSlug`. */
export interface MintPreviewBody {
  readonly bindings: readonly PreviewBinding[];
  readonly accepted_risks: readonly string[];
  readonly denied_risks?: readonly string[];
}

/** Load project policy overrides + provider catalogs, then run the pure
 *  `computePreview`. Returns the same shape as the mgmt route. */
export async function computeMintPreview(
  svc: SupabaseClient,
  projectId: string,
  body: MintPreviewBody,
): Promise<PreviewResponse> {
  // 1. Project policy overrides — null env_scope means "applies to every binding env".
  const { data: rulesRaw } = await svc
    .from('project_risk_policies')
    .select('id, project_id, risk_id, env_scope, gate, created_at')
    .eq('project_id', projectId);
  const overrides: RiskPolicyOverride[] = rulesRaw ?? [];

  // 2. Per-provider catalogs — only those needed by the bindings.
  const providers = new Set<Provider>(body.bindings.map((b) => b.provider));
  const catalogs: Partial<Record<Provider, IndexedRiskCatalog>> = {};
  for (const p of providers) {
    const c = getCatalog(p);
    if (c) catalogs[p] = c;
  }

  // 3. Pure compute.
  return computePreview({
    bindings: body.bindings,
    accepted_risks: body.accepted_risks,
    denied_risks: body.denied_risks ?? [],
    catalogs,
    overrides,
  });
}
