/**
 * The macro-actions of an account as the creation form ticks them (risk
 * model §4.6; ADR macro-actions-and-trust-levels-prefill-the-policy): the
 * catalog's own, plus "Anything else" holding the fallback, each expanded at
 * a trust level against the selected resources and the creator's authority.
 *
 * Pure and browser-safe, like `catalog-view.ts`: the form and the server run
 * the same functions. What they write is explicit lines; the mission keeps
 * the trust levels only to redraw the form.
 */
import {
  TRUST_LEVEL_BUDGET_FACTOR,
  TRUST_LEVEL_GATES,
  DEFAULT_TRUST_LEVEL,
  expandAtTrustLevel,
  isTrustLevel,
  rowOf,
  TRUST_LEVELS,
  type TrustLevelCandidate,
  type TrustLevelLine,
  type Row,
  type TrustLevel,
} from '@vaubaan/policy-engine';
import type { Gate, MacroAction, RiskId } from '@vaubaan/shared';

import { isResolvable } from './catalog-view';
import type { CatalogRisk, IssuanceAccount, IssuanceResource, LeftOutEntry } from './model';

/** The trust level of each ticked macro-action of one account, by macro-action id. */
export type MacroActionTrustLevels = Readonly<Record<string, TrustLevel>>;

/**
 * The catalog's macro-actions, then "Anything else" with the catalog's
 * fallback entries: the policy engine's `macroActionsOf`, which the public
 * site lists too. What `IssuanceAccount.macro_actions` carries.
 */
export { macroActionsOf } from '@vaubaan/policy-engine';

/** One macro-action at one trust level, on this account with these resources. */
export interface MacroActionExpansion {
  readonly lines: readonly TrustLevelLine[];
  /** Risks the trust level leaves out (row 4 at Careful). */
  readonly left_out: readonly { readonly risk_id: RiskId; readonly row: Row }[];
  /** Rows of the macro-action this creator cannot get here: outside the authority, or no resource carries the environment. */
  readonly unavailable: readonly CatalogRisk[];
}

/** The catalog rows a macro-action stands for: one per explicit id, deprecated ones left out. */
export function rowsOf(
  account: Pick<IssuanceAccount, 'risks'>,
  action: Pick<MacroAction, 'entries'>,
): CatalogRisk[] {
  const ids = new Set(action.entries.map((entry) => entry.risk_id));
  return account.risks.filter((risk) => ids.has(risk.base_id) && !risk.deprecated);
}

/** A row as `expandAtTrustLevel` reads it, from its macro-action entry's base budget. */
function candidateOf(
  risk: Pick<CatalogRisk, 'base_id' | 'risk_id' | 'vector' | 'rate_ceiling_per_minute'>,
  entry: MacroAction['entries'][number],
): TrustLevelCandidate {
  return {
    risk_id: risk.risk_id,
    vector: risk.vector,
    base: { quota: entry.quota, rate_limit: entry.rate_limit },
    rate_ceiling_per_minute: risk.rate_ceiling_per_minute,
  };
}

export function expandMacroAction(
  account: Pick<IssuanceAccount, 'risks' | 'authority' | 'derives_env'>,
  action: MacroAction,
  trustLevel: TrustLevel,
  resources: readonly Pick<IssuanceResource, 'env'>[],
): MacroActionExpansion {
  const held = new Set(account.authority);
  const base = new Map(action.entries.map((entry) => [entry.risk_id, entry]));
  const candidates: TrustLevelCandidate[] = [];
  const unavailable: CatalogRisk[] = [];
  for (const risk of rowsOf(account, action)) {
    const entry = base.get(risk.base_id);
    if (!entry) continue;
    if (!held.has(risk.risk_id) || !isResolvable(risk, account, resources)) {
      unavailable.push(risk);
      continue;
    }
    candidates.push(candidateOf(risk, entry));
  }
  return { ...expandAtTrustLevel(candidates, trustLevel), unavailable };
}

type TrustLevelsAccount = Pick<
  IssuanceAccount,
  'risks' | 'authority' | 'derives_env' | 'macro_actions'
>;

/**
 * What the trust levels write on an account: the lines of every ticked
 * macro-action, catalog order, and what they leave out, with why.
 */
export function prefillOfTrustLevels(
  account: TrustLevelsAccount,
  trustLevels: MacroActionTrustLevels,
  resources: readonly Pick<IssuanceResource, 'env'>[],
): { readonly lines: TrustLevelLine[]; readonly left_out: LeftOutEntry[] } {
  const byId = new Map<RiskId, TrustLevelLine>();
  const leftOut = new Map<RiskId, LeftOutEntry>();
  const held = new Set(account.authority);
  const envOf = new Map(account.risks.map((risk) => [risk.risk_id, risk.env]));
  for (const action of account.macro_actions) {
    const trustLevel = trustLevels[action.id];
    if (!trustLevel) continue;
    const expansion = expandMacroAction(account, action, trustLevel, resources);
    for (const line of expansion.lines) byId.set(line.risk_id, line);
    for (const { risk_id } of expansion.left_out) {
      leftOut.set(risk_id, { risk_id, reason: 'trust-level', env: envOf.get(risk_id) ?? null });
    }
    for (const risk of expansion.unavailable) {
      const reason = held.has(risk.risk_id) ? 'unresolvable-env' : 'outside-authority';
      leftOut.set(risk.risk_id, { risk_id: risk.risk_id, reason, env: risk.env });
    }
  }
  const inCatalogOrder = <T>(byRisk: ReadonlyMap<RiskId, T>): T[] =>
    account.risks.flatMap((risk) => {
      const found = byRisk.get(risk.risk_id);
      return found ? [found] : [];
    });
  return { lines: inCatalogOrder(byId), left_out: inCatalogOrder(leftOut) };
}

/** The explicit lines of every ticked macro-action, catalog order. */
export function linesOfTrustLevels(
  account: TrustLevelsAccount,
  trustLevels: MacroActionTrustLevels,
  resources: readonly Pick<IssuanceResource, 'env'>[],
): TrustLevelLine[] {
  return prefillOfTrustLevels(account, trustLevels, resources).lines;
}

/** The macro-action a catalog row belongs to, or `undefined` (a deprecated entry). */
export function macroActionOfRisk(
  account: Pick<IssuanceAccount, 'macro_actions'>,
  risk: Pick<CatalogRisk, 'base_id'>,
): MacroAction | undefined {
  return account.macro_actions.find((action) =>
    action.entries.some((entry) => entry.risk_id === risk.base_id),
  );
}

/**
 * The line a risk ticked by hand starts with: its macro-action's base budget
 * at the trust level that macro-action has (Careful when it is not ticked), and the
 * gate that trust level gives its row; a risk the trust level leaves out asks first.
 * `null` for a risk in no macro-action.
 */
export function defaultLineOf(
  account: Pick<IssuanceAccount, 'macro_actions'>,
  trustLevels: MacroActionTrustLevels,
  risk: Pick<CatalogRisk, 'base_id' | 'risk_id' | 'vector' | 'rate_ceiling_per_minute'>,
): {
  readonly quota: number;
  readonly rate_limit: TrustLevelLine['rate_limit'];
  readonly gate: Gate;
} | null {
  const action = macroActionOfRisk(account, risk);
  const entry = action?.entries.find((e) => e.risk_id === risk.base_id);
  if (!action || !entry) return null;
  const trustLevel = trustLevels[action.id] ?? DEFAULT_TRUST_LEVEL;
  const [line] = expandAtTrustLevel([candidateOf(risk, entry)], trustLevel).lines;
  if (line) return { quota: line.quota, rate_limit: line.rate_limit, gate: line.gate };
  // Left out at this trust level: ticked by hand, it asks first, at the base budget.
  return { quota: entry.quota, rate_limit: entry.rate_limit, gate: 'approval' };
}

/**
 * The trust levels of a draft that name a macro-action of this account: anything
 * else is dropped (`unknownMacroActions` names it).
 */
export function knownTrustLevels(
  account: Pick<IssuanceAccount, 'macro_actions'>,
  raw: Readonly<Record<string, unknown>> | undefined,
): MacroActionTrustLevels {
  const ids = new Set(account.macro_actions.map((action) => action.id));
  return Object.fromEntries(Object.entries(trustLevelsOf(raw)).filter(([id]) => ids.has(id)));
}

/** The ids a draft gives a trust level that are not macro-actions of this account. */
export function unknownMacroActions(
  account: Pick<IssuanceAccount, 'macro_actions'>,
  raw: Readonly<Record<string, unknown>> | undefined,
): string[] {
  const ids = new Set(account.macro_actions.map((action) => action.id));
  return Object.keys(raw ?? {}).filter((id) => !ids.has(id));
}

/** The entries of a stored or posted record that are trust levels, whatever their macro-action. */
export function trustLevelsOf(
  raw: Readonly<Record<string, unknown>> | undefined,
): MacroActionTrustLevels {
  if (!raw) return {};
  return Object.fromEntries(
    Object.entries(raw).filter((pair): pair is [string, TrustLevel] => isTrustLevel(pair[1])),
  );
}

/** The highest row among lines, or `null` for none. */
export function highestRow(lines: readonly Pick<CatalogRisk, 'row'>[]): Row | null {
  let highest: Row | null = null;
  for (const line of lines) if (highest === null || line.row > highest) highest = line.row;
  return highest;
}

export { TRUST_LEVEL_BUDGET_FACTOR, TRUST_LEVEL_GATES, DEFAULT_TRUST_LEVEL, rowOf, TRUST_LEVELS };
export type { Row, TrustLevel };
