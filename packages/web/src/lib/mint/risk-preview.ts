/**
 * Pure-compute risk-preview layer — moved here from the deleted
 * `/api/v1/mgmt/tokens/preview/route.ts` so the new
 * `/api/v1/tokens/preview` endpoint + `lib/mint/preview.ts` can both import
 * it without depending on a route module.
 *
 * Spec : docs/spec/gateway-risk-model.md §9.
 */

import {
  resolveEffectiveGate,
  checkAcceptableInEnv,
  findRiskEntry,
  type IndexedRiskCatalog,
} from '@vaubaan/policy-engine';
import type { Provider, RiskId, RiskPolicyOverride } from '@vaubaan/shared';
import { qualifyRiskId, unqualifyRiskId } from '@/lib/risk-catalog/loader';
import { z } from 'zod';

export const PreviewBindingSchema = z.object({
  provider: z.enum(['github', 'vercel', 'supabase', 'railway', 'bash']),
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
  vector: unknown;
  effective_gate: 'allow' | 'confirm' | 'deny';
  origin: 'catalog-default' | 'project-policy-env-scoped' | 'project-policy-global';
  blocked_reason?: string;
}

export interface PreviewResponse {
  risks: PreviewRiskRow[];
  all_allowed: boolean;
  needs_approval: RiskId[];
  denied: RiskId[];
}

/** Resolve the effective gate for ONE accepted_risk against a binding. */
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

/** Compute the full preview for a token mint request. */
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
