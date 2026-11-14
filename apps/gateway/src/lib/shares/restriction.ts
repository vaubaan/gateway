/**
 * A restriction as the Share dialog shows it (spec §0 "Restriction", §3.1
 * "Enumeration", §4.2).
 *
 * Pure and browser-safe: the dialog and the server run the same functions, so
 * what the owner reads is what is checked. A restriction is always a list of
 * explicit `RiskId`s; "select all" is `selectAllIds`, resolved when the owner
 * clicks, and a risk the catalog gains later is not part of it.
 */
import type { RiskId } from '@vaubaan/shared';

import { ROW_WORDS } from '@vaubaan/policy-engine';

import { hardestToRepair } from '../missions/catalog-view';
import type { CatalogRisk, Row } from '../missions/model';

/** The hardest to repair first: the order of the checklist's groups (risk model §4.6). */
export const ROW_ORDER: readonly Row[] = [4, 3, 2, 1];

export interface RowGroup {
  readonly row: Row;
  readonly risks: readonly CatalogRisk[];
}

/** The catalog rows grouped by row, empty groups left out, catalog order inside. */
export function groupByRow(risks: readonly CatalogRisk[]): RowGroup[] {
  return ROW_ORDER.map((row) => ({
    row,
    risks: risks.filter((risk) => risk.row === row),
  })).filter((group) => group.risks.length > 0);
}

/**
 * "Select all" as an enumerated list. Deprecated entries and the
 * uncategorized-write fallback are left out, as at mission creation: the
 * first should not enter a new share, the second pre-accepts writes nobody
 * reviewed — the owner ticks it knowingly.
 */
export function selectAllIds(risks: readonly CatalogRisk[]): RiskId[] {
  return risks.filter((risk) => !risk.deprecated && !risk.fallback).map((risk) => risk.risk_id);
}

/** One line for what is ticked (spec §4.2: the checklist stays folded behind it). */
export function summarizeRestriction(
  risks: readonly CatalogRisk[],
  selected: ReadonlySet<RiskId>,
): string {
  const chosen = risks.filter((risk) => selected.has(risk.risk_id));
  const hardest = hardestToRepair(chosen);
  if (hardest === null) return 'Nothing ticked: this access would allow nothing.';
  const perRow = ROW_ORDER.map((row) => ({
    row,
    count: chosen.filter((risk) => risk.row === row).length,
  }))
    .filter((entry) => entry.count > 0)
    .map((entry) => `${entry.count} ${ROW_WORDS[entry.row].toLowerCase()}`);
  return [
    `${chosen.length} of ${risks.length} ${risks.length === 1 ? 'permission' : 'permissions'}`,
    perRow.join(', '),
    `hardest to repair: ${hardest.label} (${ROW_WORDS[hardest.row].toLowerCase()})`,
  ].join(' · ');
}

export interface EnvLabelling {
  /** The plugin derives the environment from the call itself: no label is needed. */
  readonly derivesEnv: boolean;
  /** Environments carried by at least one reachable resource of the account. */
  readonly labelledEnvs: readonly string[];
  /** Reachable resources that carry no environment label. */
  readonly unlabelledResources: number;
}

/**
 * What the owner must know before sharing env-qualified risks: such a risk is
 * only ever matched on a resource labelled with that environment, and a call
 * on an unlabelled resource is refused. One sentence per situation, none when
 * nothing ticked is concerned.
 */
export function envNotes(
  risks: readonly CatalogRisk[],
  selected: ReadonlySet<RiskId>,
  labelling: EnvLabelling,
): string[] {
  if (labelling.derivesEnv) return [];
  const envs = [
    ...new Set(
      risks.flatMap((risk) => (risk.env !== null && selected.has(risk.risk_id) ? [risk.env] : [])),
    ),
  ];
  if (envs.length === 0) return [];
  const notes: string[] = [];
  const unreachable = envs.filter((env) => !labelling.labelledEnvs.includes(env));
  if (unreachable.length > 0) {
    notes.push(
      `No resource of this account is labelled ${listOf(unreachable)}: the permissions tied to ${
        unreachable.length === 1 ? 'that environment' : 'those environments'
      } cannot be used until a resource carries the label.`,
    );
  }
  if (labelling.unlabelledResources > 0) {
    notes.push(
      `${labelling.unlabelledResources} ${
        labelling.unlabelledResources === 1 ? 'resource has' : 'resources have'
      } no environment label: permissions tied to an environment are refused on ${
        labelling.unlabelledResources === 1 ? 'it' : 'them'
      } until you label ${labelling.unlabelledResources === 1 ? 'it' : 'them'} or give the account a default environment.`,
    );
  }
  return notes;
}

function listOf(values: readonly string[]): string {
  return values.map((value) => `"${value}"`).join(', ');
}
