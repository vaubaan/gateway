/**
 * The built-in "Everything I hold on this account" (ADR
 * preset-everything-i-hold-expands-explicitly; spec §0 "Macro-action", §3.2).
 *
 * It is not a value of any catalog: `everythingIHold(account, selected)`
 * computes, for one account and one selection of resources, the explicit
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
import type { CatalogRisk, IssuanceAccount, IssuanceResource, Row } from './model';
import { SECONDS_PER_MINUTE } from '@vaubaan/shared/time';

/** Its id where the gateway names it (a notice, the reference). No catalog may declare a macro-action of that id. */
export const EVERYTHING_I_HOLD = 'everything-i-hold';
export const EVERYTHING_I_HOLD_LABEL = 'Everything I hold on this account';
export const EVERYTHING_I_HOLD_DESCRIPTION =
  'Every permission you may allow on this account that the selected resources can reach, the uncategorized writes included, written out one by one: each at the service’s rate ceiling, with a generous daily limit, running freely.';

/**
 * The quota of a line in no macro-action, by its row (risk model §4.6):
 * sized for a period of one day.
 */
export const QUOTA_BY_ROW: Readonly<Record<Row, number>> = {
  1: 5000,
  2: 1000,
  3: 200,
  4: 50,
};

/** Actions per minute of a line with no catalog ceiling and in no macro-action, by its row. */
export const RATE_BY_ROW: Readonly<Record<Row, number>> = {
  1: 120,
  2: 60,
  3: 20,
  4: 5,
};

/** The lines "Everything I hold" wrote on one account, with what the picker shows. */
export interface EverythingIHold {
  readonly id: typeof EVERYTHING_I_HOLD;
  readonly label: string;
  readonly description: string;
  readonly entries: readonly MissionPolicyEntry[];
}

/**
 * The budget of a line: its macro-action's base budget at Autonomous (the
 * widest trust level), the rate then the catalog ceiling per minute when the entry
 * sets one; by row for a risk in no macro-action.
 */
export function budgetFor(
  account: Pick<IssuanceAccount, 'macro_actions'>,
  risk: Pick<CatalogRisk, 'base_id' | 'rate_ceiling_per_minute' | 'row'>,
): { readonly quota: number; readonly rate_limit: RateLimit } {
  const entry = macroActionOfRisk(account, risk)?.entries.find((e) => e.risk_id === risk.base_id);
  const ceiling: RateLimit | null =
    risk.rate_ceiling_per_minute === null
      ? null
      : { max: risk.rate_ceiling_per_minute, window_seconds: SECONDS_PER_MINUTE };
  if (!entry) {
    return {
      quota: QUOTA_BY_ROW[risk.row],
      rate_limit: ceiling ?? { max: RATE_BY_ROW[risk.row], window_seconds: SECONDS_PER_MINUTE },
    };
  }
  const widest = budgetAtTrustLevel(entry, 'autonomous', risk.rate_ceiling_per_minute);
  return { quota: widest.quota, rate_limit: ceiling ?? widest.rate_limit };
}

/**
 * "Everything I hold" on this account with these resources: explicit ids
 * only, catalog order, each with its budget and the gate `auto`.
 */
export function everythingIHold(
  account: Pick<IssuanceAccount, 'risks' | 'authority' | 'macro_actions' | 'derives_env'>,
  selected: readonly Pick<IssuanceResource, 'env'>[],
): EverythingIHold {
  const held = new Set(account.authority);
  const entries = account.risks
    .filter(
      (risk) => held.has(risk.risk_id) && !risk.deprecated && isResolvable(risk, account, selected),
    )
    .map((risk): MissionPolicyEntry => ({
      risk_id: risk.risk_id,
      ...budgetFor(account, risk),
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
  /** The line in the hardest row to repair, the first in catalog order on a tie. */
  readonly hardest: {
    readonly risk_id: RiskId;
    readonly label: string;
    readonly row: Row;
  } | null;
  /** Lines in row 4 ("Cannot be repaired") whose gate is `auto`: they run freely. */
  readonly irreparable_auto: readonly CatalogRisk[];
  /** The catalog's fallback, when it is a line. */
  readonly fallback: readonly CatalogRisk[];
}

/** The digest of explicit lines on an account's catalog. */
export function expansionDigest(
  lines: readonly { readonly risk_id: RiskId; readonly gate: string }[],
  risks: readonly CatalogRisk[],
): ExpansionDigest {
  const byId = new Map(risks.map((risk) => [risk.risk_id, risk]));
  let hardest: CatalogRisk | null = null;
  const irreparableAuto: CatalogRisk[] = [];
  const fallback: CatalogRisk[] = [];
  for (const line of lines) {
    const risk = byId.get(line.risk_id);
    if (!risk) continue;
    if (hardest === null || risk.row > hardest.row) hardest = risk;
    if (risk.row === 4 && line.gate === 'auto') irreparableAuto.push(risk);
    if (risk.fallback) fallback.push(risk);
  }
  return {
    count: lines.length,
    hardest: hardest ? { risk_id: hardest.risk_id, label: hardest.label, row: hardest.row } : null,
    irreparable_auto: irreparableAuto,
    fallback,
  };
}
