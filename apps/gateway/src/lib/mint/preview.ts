/**
 * Shared mint-preview computation — used by the unified
 * `/api/v1/tokens/preview` route and the mint endpoint.
 *
 * Wraps the pure `computePreview` (lib/mint/risk-preview.ts) with the
 * provider-catalog plumbing. No DB read post drop-confirm — project-level
 * overrides have been removed (see ADR unified-gates-drop-confirm).
 *
 * Spec : docs/spec/gateway-risk-model.md §9.
 */

import type { IndexedRiskCatalog } from '@vaubaan/policy-engine';
import type { Provider, RiskId } from '@vaubaan/shared';

import { getCatalog } from '@/lib/risk-catalog/loader';
import { computePreview, type PreviewBinding, type PreviewResponse } from '@/lib/mint/risk-preview';

export interface MintPreviewBody {
  readonly bindings: readonly PreviewBinding[];
  readonly accepted_risks: readonly string[];
}

export function computeMintPreview(
  body: MintPreviewBody,
  parentAcceptedRisks: readonly RiskId[] | null,
): PreviewResponse {
  const providers = new Set<Provider>(body.bindings.map((b) => b.provider));
  const catalogs: Partial<Record<Provider, IndexedRiskCatalog>> = {};
  for (const p of providers) {
    const c = getCatalog(p);
    if (c) catalogs[p] = c;
  }
  return computePreview({
    bindings: body.bindings,
    accepted_risks: body.accepted_risks,
    catalogs,
    parent_accepted_risks: parentAcceptedRisks,
  });
}
