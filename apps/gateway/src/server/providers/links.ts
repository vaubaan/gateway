/**
 * Where the provider reference lives and how other pages point into it
 * (spec §4.2 "Providers"). Every risk id shown in the interface links to its
 * catalog entry, every preset to its expansion; the anchors are built here and
 * nowhere else, so a link and its target cannot drift.
 *
 * Pure and browser-safe: values come from `@vaubaan/shared/risk-id`.
 */
import type { RiskId } from '@vaubaan/shared';
import { formatRiskId, parseRiskId } from '@vaubaan/shared/risk-id';

export const PROVIDERS_PATH = '/providers';

/** `/providers/<id>`: the reference of one plugin. */
export function providerPath(providerId: string): string {
  return `${PROVIDERS_PATH}/${encodeURIComponent(providerId)}`;
}

/** The sections of a provider's reference, as fragment ids. */
export const REFERENCE_SECTIONS = {
  legend: 'legend',
  dataModel: 'data-model',
  risks: 'risks',
  presets: 'presets',
  tools: 'tools',
} as const;

/** Fragment id of a catalog entry, from its unqualified id (`risk-github.read-code`). */
export function riskAnchor(baseId: RiskId): string {
  return `risk-${baseId}`;
}

/** Fragment id of a preset (`preset-developer`). */
export function presetAnchor(presetId: string): string {
  return `preset-${presetId}`;
}

/**
 * The catalog entry of a risk id, qualified or not:
 * `supabase[staging].bulk-row-write` → `/providers/supabase#risk-supabase.bulk-row-write`.
 * `null` when the string is not a risk id; the caller then shows it as text.
 */
export function riskReferencePath(riskId: RiskId): string | null {
  const parsed = parseRiskId(riskId);
  if (!parsed) return null;
  const baseId = formatRiskId({ provider: parsed.provider, name: parsed.name });
  return `${providerPath(parsed.provider)}#${riskAnchor(baseId)}`;
}

export function presetReferencePath(providerId: string, presetId: string): string {
  return `${providerPath(providerId)}#${presetAnchor(presetId)}`;
}

export function sectionPath(
  providerId: string,
  section: (typeof REFERENCE_SECTIONS)[keyof typeof REFERENCE_SECTIONS],
): string {
  return `${providerPath(providerId)}#${section}`;
}
