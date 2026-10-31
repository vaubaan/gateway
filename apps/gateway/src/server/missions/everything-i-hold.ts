/**
 * The built-in "Everything I hold on this account" (ADR
 * preset-everything-i-hold-expands-explicitly; spec §0 "Macro-action", §3.2).
 *
 * It is not a value of any catalog: `everythingIHold(connection, selected)`
 * computes, for one connection and one selection of resources, the explicit
 * lines it stands for — every non-deprecated id of the catalog that the
 * creator's authority covers now and that the selected resources can reach,
 * the fallback included — each with an explicit budget and gate `auto`.
 * Nothing downstream knows it was wide: the stored policy is the list.
 *
 * Pure and browser-safe: the creation form runs it as the server does.
 */
import { budgetAtTrustLevel } from '@vaubaan/policy-engine';
import type { MissionPolicyEntry, RateLimit, RiskId } from '@vaubaan/shared';

import { isResolvable } from './catalog-view';
import { macroActionOfRisk } from './macro-actions';
import type { CatalogRisk, IssuanceConnection, IssuanceResource, SeverityLevel } from './model';

/** The id a draft names it by in `preset`. No catalog may declare a macro-action of that id. */
export const EVERYTHING_I_HOLD = 'everything-i-hold';
export const EVERYTHING_I_HOLD_LABEL = 'Everything I hold on this account';
export const EVERYTHING_I_HOLD_DESCRIPTION =
  'Every permission you may allow on this account that the selected resources can reach, the uncategorized writes included, written out one by one: each at the service’s rate ceiling, with a generous daily limit, running freely.';

const SECONDS_PER_MINUTE = 60;

/**
 * The quota of a line in no macro-action, by the catalog's severity level:
 * sized for a period of one day.
 */
export const QUOTA_BY_LEVEL: Readonly<Record<SeverityLevel, number>> = {
  low: 5000,
  medium: 1000,
  high: 200,
  critical: 50,
};

/** Actions per minute of a line with no catalog ceiling and in no macro-action. */
export const RATE_BY_LEVEL: Readonly<Record<SeverityLevel, number>> = {
  low: 120,
  medium: 60,
  high: 20,
  critical: 5,
};

/** The lines "Everything I hold" wrote on one connection, with what the picker shows. */
export interface EverythingIHold {
  readonly id: typeof EVERYTHING_I_HOLD;
  readonly label: string;
  readonly description: string;
  readonly entries: readonly MissionPolicyEntry[];
}

/**
 * The budget of a line: its macro-action's base budget at Autonome (the
 * widest trust level), the rate then the catalog ceiling per minute when the entry
 * sets one; by level for a risk in no macro-action.
 */
export function budgetFor(
  connection: Pick<IssuanceConnection, 'macro_actions'>,
  risk: Pick<CatalogRisk, 'base_id' | 'rate_ceiling_per_minute' | 'level'>,
): { readonly quota: number; readonly rate_limit: RateLimit } {
  const entry = macroActionOfRisk(connection, risk)?.entries.find(
    (e) => e.risk_id === risk.base_id,
  );
  const ceiling: RateLimit | null =
    risk.rate_ceiling_per_minute === null
      ? null
      : { max: risk.rate_ceiling_per_minute, window_seconds: SECONDS_PER_MINUTE };
  if (!entry) {
    return {
      quota: QUOTA_BY_LEVEL[risk.level],
      rate_limit: ceiling ?? { max: RATE_BY_LEVEL[risk.level], window_seconds: SECONDS_PER_MINUTE },
    };
  }
  const widest = budgetAtTrustLevel(entry, 'autonome', risk.rate_ceiling_per_minute);
  return { quota: widest.quota, rate_limit: ceiling ?? widest.rate_limit };
}

/**
 * "Everything I hold" on this connection with these resources: explicit ids
 * only, catalog order, each with its budget and the gate `auto`.
 */
export function everythingIHold(
  connection: Pick<IssuanceConnection, 'risks' | 'authority' | 'macro_actions' | 'derives_env'>,
  selected: readonly Pick<IssuanceResource, 'env'>[],
): EverythingIHold {
  const held = new Set(connection.authority);
  const entries = connection.risks
    .filter(
      (risk) =>
        held.has(risk.risk_id) && !risk.deprecated && isResolvable(risk, connection, selected),
    )
    .map((risk): MissionPolicyEntry => ({
      risk_id: risk.risk_id,
      ...budgetFor(connection, risk),
      gate: 'auto',
    }));
  return {
    id: EVERYTHING_I_HOLD,
    label: EVERYTHING_I_HOLD_LABEL,
    description: EVERYTHING_I_HOLD_DESCRIPTION,
    entries,
  };
}

/** What the expansion holds, for a person or an agent to read before confirming. */
export interface ExpansionDigest {
  readonly count: number;
  readonly most_severe: {
    readonly risk_id: RiskId;
    readonly label: string;
    readonly level: SeverityLevel;
  } | null;
  /** Lines whose catalog severity is critical and whose gate is `auto`: they run freely. */
  readonly critical_auto: readonly CatalogRisk[];
  /** The catalog's fallback, when it is a line. */
  readonly fallback: readonly CatalogRisk[];
}

/** The digest of explicit lines on a connection's catalog. */
export function expansionDigest(
  lines: readonly { readonly risk_id: RiskId; readonly gate: string }[],
  risks: readonly CatalogRisk[],
): ExpansionDigest {
  const byId = new Map(risks.map((risk) => [risk.risk_id, risk]));
  let mostSevere: CatalogRisk | null = null;
  const criticalAuto: CatalogRisk[] = [];
  const fallback: CatalogRisk[] = [];
  for (const line of lines) {
    const risk = byId.get(line.risk_id);
    if (!risk) continue;
    if (mostSevere === null || risk.severity > mostSevere.severity) mostSevere = risk;
    if (risk.level === 'critical' && line.gate === 'auto') criticalAuto.push(risk);
    if (risk.fallback) fallback.push(risk);
  }
  return {
    count: lines.length,
    most_severe: mostSevere
      ? { risk_id: mostSevere.risk_id, label: mostSevere.label, level: mostSevere.level }
      : null,
    critical_auto: criticalAuto,
    fallback,
  };
}
