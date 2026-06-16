/**
 * Shared types + small constants for the token-mint form. Extracted from
 * `mint-form.tsx` so the sub-components don't drag the orchestrator file as
 * a dependency.
 *
 * Post drop-confirm : risks are a flat single-checklist with two flags per
 * row — `acceptable` (catalog env restriction) and `inherited` (parent
 * subset). A row is mintable iff both are true.
 */

import type { Provider, RiskId, RiskVector } from '@vaubaan/shared';

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
  acceptable_in_envs: readonly string[] | null;
  deprecated: boolean;
}

export interface MintFormCatalog {
  provider: Provider;
  loaded: boolean;
  entries: MintFormCatalogEntry[];
}

// ─── Preview wire shape (mirrors `PreviewRiskRow` from lib/mint/risk-preview.ts) ───

export interface PreviewRiskRow {
  id: RiskId;
  base_id: RiskId;
  provider: Provider;
  env: string | null;
  label: string;
  reason: string;
  vector: RiskVector | null;
  acceptable: boolean;
  inherited: boolean;
  blocked_reason?: string;
}

export interface PreviewResponse {
  risks: PreviewRiskRow[];
  not_acceptable: RiskId[];
  not_inherited: RiskId[];
  ok: boolean;
}

// ─── Mint result discriminated union ────────────────────────────────────────

export interface MintSuccessResult {
  kind: 'minted';
  apiKey: string;
  tokenName: string;
  expiresAt: string;
}

export interface MintDeniedResult {
  kind: 'denied';
  risks: PreviewRiskRow[];
  notAcceptable: RiskId[];
  notInherited: RiskId[];
}

export interface MintErrorResult {
  kind: 'error';
  message: string;
}

export type MintResult = MintSuccessResult | MintDeniedResult | MintErrorResult;
