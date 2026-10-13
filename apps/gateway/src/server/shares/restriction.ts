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

import type { CatalogRisk, SeverityLevel } from '../missions/model';

/** Most severe first: the order of the checklist's groups. */
export const SEVERITY_ORDER: readonly SeverityLevel[] = ['critical', 'high', 'medium', 'low'];

export interface SeverityGroup {
  readonly level: SeverityLevel;
  readonly risks: readonly CatalogRisk[];
}

/** The catalog rows grouped by severity level, empty groups left out, catalog order inside. */
export function groupBySeverity(risks: readonly CatalogRisk[]): SeverityGroup[] {
  return SEVERITY_ORDER.map((level) => ({
    level,
    risks: risks.filter((risk) => risk.level === level),
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
  if (chosen.length === 0) return 'No risk selected: the share would authorize nothing.';
  const mostSevere = chosen.reduce((worst, risk) =>
    risk.severity > worst.severity ? risk : worst,
  );
  const perLevel = SEVERITY_ORDER.map((level) => ({
    level,
    count: chosen.filter((risk) => risk.level === level).length,
  }))
    .filter((entry) => entry.count > 0)
    .map((entry) => `${entry.count} ${entry.level}`);
  return [
    `${chosen.length} of ${risks.length} ${risks.length === 1 ? 'risk' : 'risks'}`,
    perLevel.join(', '),
    `most severe: ${mostSevere.label} (${mostSevere.level})`,
  ].join(' · ');
}

export interface EnvLabelling {
  /** The plugin derives the environment from the call itself: no label is needed. */
  readonly derivesEnv: boolean;
  /** Environments carried by at least one reachable resource of the connection. */
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
      risks
        .filter((risk) => risk.env !== null && selected.has(risk.risk_id))
        .map((risk) => risk.env as string),
    ),
  ];
  if (envs.length === 0) return [];
  const notes: string[] = [];
  const unreachable = envs.filter((env) => !labelling.labelledEnvs.includes(env));
  if (unreachable.length > 0) {
    notes.push(
      `No resource of this connection is labelled ${listOf(unreachable)}: the risks qualified with ${
        unreachable.length === 1 ? 'that environment' : 'those environments'
      } cannot be used until a resource carries the label.`,
    );
  }
  if (labelling.unlabelledResources > 0) {
    notes.push(
      `${labelling.unlabelledResources} ${
        labelling.unlabelledResources === 1 ? 'resource has' : 'resources have'
      } no environment label: environment-qualified risks are refused on ${
        labelling.unlabelledResources === 1 ? 'it' : 'them'
      } until you label ${labelling.unlabelledResources === 1 ? 'it' : 'them'}.`,
    );
  }
  return notes;
}

function listOf(values: readonly string[]): string {
  return values.map((value) => `"${value}"`).join(', ');
}
