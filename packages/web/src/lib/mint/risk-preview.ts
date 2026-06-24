/**
 * Pure-compute risk-preview layer for the post drop-confirm model.
 *
 * Spec : docs/spec/gateway-risk-model.md §9.
 * ADR  : docs/decisions/unified-gates-drop-confirm.md.
 *
 * For each requested `accepted_risks` × matching binding we compute :
 *   - `acceptable` : true iff the catalog entry has no `acceptable_in_envs`
 *     restriction, OR the binding env is in the list.
 *   - `inherited`  : true iff the risk_id is in the caller's parent
 *     `accepted_risks` (when known at preview-time). When the caller
 *     does not pass a parent context (e.g. UI initial render before the
 *     parent is identified) we default to `true` ; the consumer is
 *     responsible for refining once the parent is known.
 *
 * The mint endpoint then rejects with 403 when ANY row has
 * `!acceptable || !inherited`.
 */

import {
  checkAcceptableInEnv,
  findRiskEntry,
  type IndexedRiskCatalog,
} from '@vaubaan/policy-engine';
import type { Provider, RiskId, RiskVector } from '@vaubaan/shared';
import { qualifyRiskId, unqualifyRiskId } from '@/lib/risk-catalog/loader';
import { z } from 'zod';

export const PreviewBindingSchema = z.object({
  provider: z.enum(['github', 'vercel', 'supabase', 'railway', 'bash', 'stripe', 'resend']),
  resource_ref: z.string().min(1),
  env: z.string().min(1).optional().nullable(),
});

export type PreviewBinding = z.infer<typeof PreviewBindingSchema>;

export interface PreviewRiskRow {
  id: RiskId;
  base_id: RiskId;
  provider: Provider;
  env: string | null;
  label: string;
  reason: string;
  /** Catalog vector when the entry was resolved ; `null` when the entry is
   *  missing (catalog unloaded, unknown risk id, no binding for provider). */
  vector: RiskVector | null;
  /** Structural restriction : catalog `acceptable_in_envs` is satisfied. */
  acceptable: boolean;
  /** Caller has this risk in `parent.accepted_risks` (subset check at mint). */
  inherited: boolean;
  /** Non-empty when the row is unsuitable for mint (acceptable=false or
   *  inherited=false or catalog/entry missing). UI tooltip + audit detail. */
  blocked_reason?: string;
}

export interface PreviewResponse {
  risks: PreviewRiskRow[];
  /** Subset of accepted_risks that violate `acceptable_in_envs`. Mint will 403 these. */
  not_acceptable: RiskId[];
  /** Subset of accepted_risks not in parent.accepted_risks. Mint will 403 these. */
  not_inherited: RiskId[];
  /** True iff `not_acceptable.length === 0 && not_inherited.length === 0`. */
  ok: boolean;
}

/** Resolve the preview row for ONE accepted_risk against a binding. */
export function resolveRiskRow(
  riskId: RiskId,
  binding: PreviewBinding,
  catalog: IndexedRiskCatalog | undefined,
  parentAcceptedRisks: ReadonlySet<RiskId> | null,
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
      vector: null,
      acceptable: false,
      inherited: parentAcceptedRisks === null ? true : parentAcceptedRisks.has(riskId),
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
      vector: null,
      acceptable: false,
      inherited: parentAcceptedRisks === null ? true : parentAcceptedRisks.has(riskId),
      blocked_reason: `unknown risk '${baseId}' in provider '${binding.provider}' catalog`,
    };
  }

  const qualifiedId = qualifyRiskId(baseId, env, entry);
  const envCheckMsg = checkAcceptableInEnv(entry, env);
  const acceptable = envCheckMsg === null;
  const inherited =
    parentAcceptedRisks === null
      ? true
      : parentAcceptedRisks.has(qualifiedId) || parentAcceptedRisks.has(baseId);

  return {
    id: qualifiedId,
    base_id: baseId,
    provider: binding.provider,
    env,
    label: entry.label,
    reason: entry.reason,
    vector: entry.vector,
    acceptable,
    inherited,
    blocked_reason: acceptable
      ? inherited
        ? undefined
        : `risk '${qualifiedId}' is not in your parent token's accepted_risks — request escalation`
      : (envCheckMsg ?? undefined),
  };
}

export interface ComputePreviewInput {
  bindings: readonly PreviewBinding[];
  accepted_risks: readonly RiskId[];
  catalogs: Partial<Record<Provider, IndexedRiskCatalog>>;
  /**
   * Caller's parent token `accepted_risks`. Pass `null` when no parent is
   * known yet (initial UI render). Pass `[]` when the caller is a
   * carte-blanche root (we still want to render the rows for display).
   */
  parent_accepted_risks: readonly RiskId[] | null;
}

/** Compute the full preview for a token mint request. */
export function computePreview(input: ComputePreviewInput): PreviewResponse {
  const rows: PreviewRiskRow[] = [];
  const parentSet: ReadonlySet<RiskId> | null =
    input.parent_accepted_risks === null ? null : new Set(input.parent_accepted_risks);

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
        vector: null,
        acceptable: false,
        inherited: parentSet === null ? true : parentSet.has(riskId),
        blocked_reason: `no binding for provider '${provider}' — cannot accept '${riskId}'`,
      });
      continue;
    }
    for (const binding of relevantBindings) {
      rows.push(resolveRiskRow(riskId, binding, input.catalogs[provider], parentSet));
    }
  }

  const not_acceptable = [...new Set(rows.filter((r) => !r.acceptable).map((r) => r.id))];
  const not_inherited = [
    ...new Set(rows.filter((r) => r.acceptable && !r.inherited).map((r) => r.id)),
  ];
  const ok = not_acceptable.length === 0 && not_inherited.length === 0;

  return {
    risks: rows,
    not_acceptable,
    not_inherited,
    ok,
  };
}
