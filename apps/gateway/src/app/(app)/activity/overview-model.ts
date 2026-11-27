/**
 * The Overview of Activity, made readable (spec §4.2 "Activity"): the use of
 * each action of a mission's account, and the addresses every number links to.
 * Pure, so a unit test holds both.
 *
 * The use per action is the mission page's: the lines of one macro-action of
 * the account's catalog, and the gauge follows the line closest to its limit
 * (`gaugeOf`, the mission cards' own rule) — never an average.
 *
 * Every number leads to the Record or the Timeline filtered on what it counts:
 * the mission, its account or key holder, its decision, and the start of the
 * span (`from`), so that "12 refused" opens those twelve lines.
 */
import type { MacroAction, RiskId } from '@vaubaan/shared';

import type { CatalogRisk } from '@/lib/missions/model';
import { ROUTES } from '@/lib/vocabulary';
import {
  AUDIT_PARAMS,
  holderParam,
  OVERVIEW_PARAMS,
  TIMELINE_PARAMS,
  type OverviewAccount,
  type OverviewHolder,
} from '@/server/audit';

import { gaugeOf, type LineUsage } from '../missions/cards/card-model';

/** A service's catalog as the Overview reads it. */
export interface OverviewCatalog {
  readonly risks: readonly CatalogRisk[];
  readonly macro_actions: readonly MacroAction[];
}

/** One action of an account with its lines' use this period, and the line its gauge follows. */
export interface ActionUsage {
  readonly id: string;
  readonly label: string;
  readonly lines: readonly LineUsage[];
  readonly top: LineUsage;
}

/**
 * The actions of an account that hold a line of the mission, in the catalog's order,
 * each with the use of its lines; `[]` when the mission is not active (no period).
 * A line whose permission the catalog no longer knows is left out: it belongs to no action.
 */
export function actionUsages(
  account: Pick<OverviewAccount, 'lines'>,
  catalog: OverviewCatalog,
): ActionUsage[] {
  const risks = new Map(catalog.risks.map((risk) => [risk.risk_id, risk]));
  const out: ActionUsage[] = [];
  for (const action of catalog.macro_actions) {
    const bases = new Set<RiskId>(action.entries.map((entry) => entry.risk_id));
    const lines: LineUsage[] = account.lines.flatMap((line) => {
      const risk = risks.get(line.risk_id);
      if (!risk || !bases.has(risk.base_id) || line.used === null) return [];
      return [
        {
          riskId: line.risk_id,
          label: risk.label,
          used: line.used,
          quota: line.quota,
          gate: line.gate,
        },
      ];
    });
    const top = gaugeOf(lines);
    if (top) out.push({ id: action.id, label: action.label, lines, top });
  }
  return out;
}

/** What a link of the Overview narrows the Record to. */
export interface RecordFocus {
  readonly mission: string;
  /** The start of the span (ISO). */
  readonly from: string;
  readonly account?: string;
  readonly holder?: OverviewHolder['holder'];
  readonly decision?: 'allowed' | 'refused';
}

/** The Record filtered on one number of the Overview: the calls it counts. */
export function recordHref(focus: RecordFocus): string {
  const params = new URLSearchParams();
  params.set(AUDIT_PARAMS.mission, focus.mission);
  params.set(AUDIT_PARAMS.kind, 'call');
  if (focus.account) params.set(AUDIT_PARAMS.account, focus.account);
  if (focus.holder) params.set(AUDIT_PARAMS.holder, holderParam(focus.holder));
  if (focus.decision) params.set(AUDIT_PARAMS.decision, focus.decision);
  params.set(AUDIT_PARAMS.from, focus.from);
  return `${ROUTES.activityRecord}?${params.toString()}`;
}

/** The Timeline of one mission, and of one of its key holders. */
export function timelineHref(mission: string, holder?: OverviewHolder['holder']): string {
  const params = new URLSearchParams();
  params.set(TIMELINE_PARAMS.mission, mission);
  if (holder) params.set(TIMELINE_PARAMS.holder, holderParam(holder));
  return `${ROUTES.activityTimeline}?${params.toString()}`;
}

/** The Overview over another span. */
export function overviewHref(period: string): string {
  return `${ROUTES.activity}?${new URLSearchParams({ [OVERVIEW_PARAMS.period]: period }).toString()}`;
}
