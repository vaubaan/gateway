/**
 * Shared types + small constants for the token-mint form. Extracted from
 * `mint-form.tsx` so the sub-components don't drag the orchestrator file as
 * a dependency.
 */

import type { Provider, RiskGate, RiskId, RiskVector } from '@vaubaan/shared';

import type { BadgeTone } from '@/components/ui';

// ─── Public shapes (consumed by page.tsx) ───────────────────────────────────

export interface MintFormBinding {
  provider: Provider;
  /** e.g. `sbw-vaubaan/gateway`, `prj_xyz`, `vps-1` (host slug for bash). */
  resource_ref: string;
  /** The env qualifier ; null for account-scope bindings (github / vercel team / bash hosts). */
  env: string | null;
  display_name: string;
}

export interface MintFormCatalogEntry {
  id: RiskId;
  label: string;
  reason: string;
  vector: RiskVector;
  default_gate: RiskGate;
  acceptable_in_envs: readonly string[] | null;
  deprecated: boolean;
}

export interface MintFormCatalog {
  provider: Provider;
  loaded: boolean;
  entries: MintFormCatalogEntry[];
}

// ─── Internal types ─────────────────────────────────────────────────────────

/** Server-side preview row (mirrors `PreviewRiskRow` on the wire). */
export interface PreviewRiskRow {
  id: RiskId;
  base_id: RiskId;
  provider: Provider;
  env: string | null;
  label: string;
  reason: string;
  vector: RiskVector | null;
  effective_gate: RiskGate;
  origin: 'catalog-default' | 'project-policy-env-scoped' | 'project-policy-global';
  blocked_reason?: string;
}

export interface PreviewResponse {
  risks: PreviewRiskRow[];
  all_allowed: boolean;
  needs_approval: RiskId[];
  denied: RiskId[];
}

// ─── Tone tables ────────────────────────────────────────────────────────────

export const GATE_TONE: Record<RiskGate, BadgeTone> = {
  allow: 'success',
  confirm: 'warning',
  deny: 'danger',
};

/** Sort risks within a binding card : allow > confirm > deny so the deniable
 *  rows sink to the bottom. */
export const GATE_ORDER: Record<RiskGate, number> = { allow: 0, confirm: 1, deny: 2 };

// ─── Mint result discriminated union ────────────────────────────────────────

export interface MintSuccessResult {
  kind: 'minted';
  apiKey: string;
  tokenName: string;
  expiresAt: string;
}

export interface MintPendingResult {
  kind: 'pending';
  approvalId: string;
  channel: string;
  expiresAt: string;
}

export interface MintDeniedResult {
  kind: 'denied';
  risks: PreviewRiskRow[];
}

export interface MintErrorResult {
  kind: 'error';
  message: string;
}

export type MintResult = MintSuccessResult | MintPendingResult | MintDeniedResult | MintErrorResult;
