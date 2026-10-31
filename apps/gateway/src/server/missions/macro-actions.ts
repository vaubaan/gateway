/**
 * The macro-actions of a connection as the creation form ticks them (risk
 * model §4.7; ADR macro-actions-and-trust-crans-prefill-the-policy): the
 * catalog's own, plus "Anything else" holding the fallback, each expanded at
 * a trust cran against the selected resources and the creator's authority.
 *
 * Pure and browser-safe, like `catalog-view.ts`: the form and the server run
 * the same functions. What they write is explicit lines; the mission keeps
 * the crans only to redraw the form.
 */
import {
  ANYTHING_ELSE_BASE_BUDGET,
  ANYTHING_ELSE_MACRO_ACTION,
  CRAN_BUDGET_FACTOR,
  CRAN_GATES,
  DEFAULT_CRAN,
  expandAtCran,
  isFallbackEntry,
  isTrustCran,
  palierOf,
  TRUST_CRANS,
  type CranCandidate,
  type CranLine,
  type Palier,
  type TrustCran,
} from '@vaubaan/policy-engine';
import type { Gate, MacroAction, RiskCatalog, RiskId } from '@vaubaan/shared';

import { isResolvable } from './catalog-view';
import type { CatalogRisk, IssuanceConnection, IssuanceResource } from './model';

/** The cran of each ticked macro-action of one connection, by macro-action id. */
export type MacroActionCrans = Readonly<Record<string, TrustCran>>;

export const CRAN_LABELS: Readonly<Record<TrustCran, string>> = {
  prudent: 'Prudent',
  confiant: 'Confiant',
  autonome: 'Autonome',
};

/** What each cran does, in one line, wherever its chip shows a tooltip. */
export const CRAN_HINTS: Readonly<Record<TrustCran, string>> = {
  prudent:
    'Mild actions run freely; sensitive or costly ones ask first; irreversible ones are left out.',
  confiant:
    'Up to sensitive actions run freely; costly and irreversible ones ask first. Limits ×3.',
  autonome: 'Everything but irreversible actions runs freely; those ask first. Limits ×10.',
};

/**
 * The catalog's macro-actions, then "Anything else" with the catalog's
 * fallback entries when it has any. What `IssuanceConnection.macro_actions`
 * carries.
 */
export function macroActionsOf(catalog: RiskCatalog): MacroAction[] {
  const fallbacks = catalog.risks.filter((entry) => isFallbackEntry(entry, catalog.provider));
  const own = [...(catalog.macro_actions ?? [])];
  if (fallbacks.length === 0) return own;
  return [
    ...own,
    {
      id: ANYTHING_ELSE_MACRO_ACTION,
      label: 'Anything else',
      description: 'Any write no other permission of this service names, which nobody reviewed.',
      entries: fallbacks.map((entry) => ({ risk_id: entry.id, ...ANYTHING_ELSE_BASE_BUDGET })),
    },
  ];
}

/** One macro-action at one cran, on this connection with these resources. */
export interface MacroActionExpansion {
  readonly lines: readonly CranLine[];
  /** Risks the cran leaves out (palier 4 at Prudent). */
  readonly left_out: readonly { readonly risk_id: RiskId; readonly palier: Palier }[];
  /** Rows of the macro-action this creator cannot get here: outside the authority, or no resource carries the environment. */
  readonly unavailable: readonly CatalogRisk[];
}

/** The catalog rows a macro-action stands for: one per explicit id, deprecated ones left out. */
export function rowsOf(
  connection: Pick<IssuanceConnection, 'risks'>,
  action: Pick<MacroAction, 'entries'>,
): CatalogRisk[] {
  const ids = new Set(action.entries.map((entry) => entry.risk_id));
  return connection.risks.filter((risk) => ids.has(risk.base_id) && !risk.deprecated);
}

export function expandMacroAction(
  connection: Pick<IssuanceConnection, 'risks' | 'authority' | 'derives_env'>,
  action: MacroAction,
  cran: TrustCran,
  resources: readonly Pick<IssuanceResource, 'env'>[],
): MacroActionExpansion {
  const held = new Set(connection.authority);
  const base = new Map(action.entries.map((entry) => [entry.risk_id, entry]));
  const candidates: CranCandidate[] = [];
  const unavailable: CatalogRisk[] = [];
  for (const risk of rowsOf(connection, action)) {
    const entry = base.get(risk.base_id);
    if (!entry) continue;
    if (!held.has(risk.risk_id) || !isResolvable(risk, connection, resources)) {
      unavailable.push(risk);
      continue;
    }
    candidates.push({
      risk_id: risk.risk_id,
      vector: risk.vector,
      base: { quota: entry.quota, rate_limit: entry.rate_limit },
      rate_ceiling_per_minute: risk.rate_ceiling_per_minute,
    });
  }
  return { ...expandAtCran(candidates, cran), unavailable };
}

/** The explicit lines of every ticked macro-action, catalog order. */
export function linesOfCrans(
  connection: Pick<IssuanceConnection, 'risks' | 'authority' | 'derives_env' | 'macro_actions'>,
  crans: MacroActionCrans,
  resources: readonly Pick<IssuanceResource, 'env'>[],
): CranLine[] {
  const byId = new Map<RiskId, CranLine>();
  for (const action of connection.macro_actions) {
    const cran = crans[action.id];
    if (!cran) continue;
    for (const line of expandMacroAction(connection, action, cran, resources).lines) {
      byId.set(line.risk_id, line);
    }
  }
  return connection.risks.flatMap((risk) => {
    const line = byId.get(risk.risk_id);
    return line ? [line] : [];
  });
}

/** The macro-action a catalog row belongs to, or `undefined` (a deprecated entry). */
export function macroActionOfRisk(
  connection: Pick<IssuanceConnection, 'macro_actions'>,
  risk: Pick<CatalogRisk, 'base_id'>,
): MacroAction | undefined {
  return connection.macro_actions.find((action) =>
    action.entries.some((entry) => entry.risk_id === risk.base_id),
  );
}

/**
 * The line a risk ticked by hand starts with: its macro-action's base budget
 * at the cran that macro-action has (Prudent when it is not ticked), and the
 * gate that cran gives its palier; a risk the cran leaves out asks first.
 * `null` for a risk in no macro-action.
 */
export function defaultLineOf(
  connection: Pick<IssuanceConnection, 'macro_actions'>,
  crans: MacroActionCrans,
  risk: Pick<CatalogRisk, 'base_id' | 'risk_id' | 'vector' | 'rate_ceiling_per_minute'>,
): {
  readonly quota: number;
  readonly rate_limit: CranLine['rate_limit'];
  readonly gate: Gate;
} | null {
  const action = macroActionOfRisk(connection, risk);
  const entry = action?.entries.find((e) => e.risk_id === risk.base_id);
  if (!action || !entry) return null;
  const cran = crans[action.id] ?? DEFAULT_CRAN;
  const [line] = expandAtCran(
    [
      {
        risk_id: risk.risk_id,
        vector: risk.vector,
        base: { quota: entry.quota, rate_limit: entry.rate_limit },
        rate_ceiling_per_minute: risk.rate_ceiling_per_minute,
      },
    ],
    cran,
  ).lines;
  if (line) return { quota: line.quota, rate_limit: line.rate_limit, gate: line.gate };
  // Left out at this cran: ticked by hand, it asks first, at the base budget.
  return { quota: entry.quota, rate_limit: entry.rate_limit, gate: 'approval' };
}

/**
 * The crans of a draft that name a macro-action of this connection: anything
 * else is dropped (the crans redraw a form, they never decide).
 */
export function knownCrans(
  connection: Pick<IssuanceConnection, 'macro_actions'>,
  raw: Readonly<Record<string, unknown>> | undefined,
): MacroActionCrans {
  const ids = new Set(connection.macro_actions.map((action) => action.id));
  return Object.fromEntries(Object.entries(cransOf(raw)).filter(([id]) => ids.has(id)));
}

/** The entries of a stored or posted record that are crans, whatever their macro-action. */
export function cransOf(raw: Readonly<Record<string, unknown>> | undefined): MacroActionCrans {
  if (!raw) return {};
  return Object.fromEntries(
    Object.entries(raw).filter((pair): pair is [string, TrustCran] => isTrustCran(pair[1])),
  );
}

/** The highest palier among lines, or `null` for none. */
export function highestPalier(lines: readonly Pick<CatalogRisk, 'vector'>[]): Palier | null {
  let highest: Palier | null = null;
  for (const line of lines) {
    const palier = palierOf(line.vector);
    if (highest === null || palier > highest) highest = palier;
  }
  return highest;
}

export { CRAN_BUDGET_FACTOR, CRAN_GATES, DEFAULT_CRAN, palierOf, TRUST_CRANS };
export type { Palier, TrustCran };
