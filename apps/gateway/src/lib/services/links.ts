/**
 * Where the service reference lives and how other pages point into it
 * (spec §4.2 "Services"). Every risk id shown in the interface links to its
 * catalog entry, every macro-action to its place; the anchors are built here and
 * nowhere else, so a link and its target cannot drift.
 *
 * Pure and browser-safe: values come from `@vaubaan/shared/risk-id`.
 */
import type { RiskId } from '@vaubaan/shared';
import { formatRiskId, parseRiskId } from '@vaubaan/shared/risk-id';

export const SERVICES_PATH = '/reference';

/** `/reference/<id>`: the reference of one plugin. */
export function servicePath(serviceId: string): string {
  return `${SERVICES_PATH}/${encodeURIComponent(serviceId)}`;
}

/** The sections of a service's reference, as fragment ids. */
export const REFERENCE_SECTIONS = {
  legend: 'legend',
  dataModel: 'data-model',
  risks: 'risks',
  macroActions: 'macro-actions',
  tools: 'tools',
} as const;

/** Fragment id of a catalog entry, from its unqualified id (`risk-github.read-code`). */
export function riskAnchor(baseId: RiskId): string {
  return `risk-${baseId}`;
}

/** Fragment id of a macro-action (`macro-read`). */
export function macroActionAnchor(actionId: string): string {
  return `macro-${actionId}`;
}

/**
 * The catalog entry of a risk id, qualified or not:
 * `supabase[staging].bulk-row-write` → `/reference/supabase#risk-supabase.bulk-row-write`.
 * `null` when the string is not a risk id; the caller then shows it as text.
 */
export function riskReferencePath(riskId: RiskId): string | null {
  const parsed = parseRiskId(riskId);
  if (!parsed) return null;
  const baseId = formatRiskId({ service: parsed.service, name: parsed.name });
  return `${servicePath(parsed.service)}#${riskAnchor(baseId)}`;
}

export function macroActionReferencePath(serviceId: string, actionId: string): string {
  return `${servicePath(serviceId)}#${macroActionAnchor(actionId)}`;
}

export function sectionPath(
  serviceId: string,
  section: (typeof REFERENCE_SECTIONS)[keyof typeof REFERENCE_SECTIONS],
): string {
  return `${servicePath(serviceId)}#${section}`;
}
