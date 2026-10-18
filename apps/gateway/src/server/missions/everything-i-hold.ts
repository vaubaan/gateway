/**
 * The built-in preset "Everything I hold on this account" (ADR
 * preset-everything-i-hold-expands-explicitly; spec §0 "Preset", §3.2).
 *
 * It is not a value of any catalog: `everythingIHold(connection, selected)`
 * computes, for one connection and one selection of resources, the explicit
 * lines it stands for — every non-deprecated id of the catalog that the
 * creator's authority covers now and that the selected resources can reach,
 * the fallback included — each with an explicit budget and gate. The result
 * is an ordinary `Preset`, handed to the same preview path as a plugin's, so
 * nothing downstream knows it was wide: the stored policy is the list.
 *
 * Pure and browser-safe: the creation form runs it as the server does.
 */
import type { Preset, PresetEntry, RateLimit, RiskId } from '@vaubaan/shared';

import { isResolvable } from './catalog-view';
import type { CatalogRisk, IssuanceConnection, IssuanceResource, SeverityLevel } from './model';

/** The id a draft names it by, next to the plugin's preset ids. No plugin may ship it. */
export const EVERYTHING_I_HOLD = 'everything-i-hold';
export const EVERYTHING_I_HOLD_LABEL = 'Everything I hold on this account';
export const EVERYTHING_I_HOLD_DESCRIPTION =
  'Every permission you may allow on this account that the selected resources can reach, the uncategorized writes included, written out one by one: each at the service’s rate ceiling, with a generous daily limit, running freely.';

const SECONDS_PER_MINUTE = 60;

/**
 * The quota of a line no preset of the plugin speaks for, by the catalog's
 * severity level: sized for a period of one day.
 */
export const QUOTA_BY_LEVEL: Readonly<Record<SeverityLevel, number>> = {
  low: 5000,
  medium: 1000,
  high: 200,
  critical: 50,
};

/** Actions per minute of a line with no catalog ceiling and no preset rate. */
export const RATE_BY_LEVEL: Readonly<Record<SeverityLevel, number>> = {
  low: 120,
  medium: 60,
  high: 20,
  critical: 5,
};

/** The preset entries of the plugin that speak for this id: by itself, or by its base id. */
function presetEntriesFor(
  presets: readonly Pick<Preset, 'entries'>[],
  risk: Pick<CatalogRisk, 'risk_id' | 'base_id'>,
): PresetEntry[] {
  return presets.flatMap((preset) =>
    preset.entries.filter((e) => e.risk_id === risk.risk_id || e.risk_id === risk.base_id),
  );
}

function perMinute(rate: RateLimit): number {
  return (rate.max * SECONDS_PER_MINUTE) / rate.window_seconds;
}

/**
 * The rate of a line: the catalog ceiling per minute when the entry sets one,
 * else the largest rate a preset gives it (compared per minute), else by level.
 */
export function rateFor(
  risk: Pick<CatalogRisk, 'rate_ceiling_per_minute' | 'level'>,
  fromPresets: readonly PresetEntry[],
): RateLimit {
  if (risk.rate_ceiling_per_minute !== null) {
    return { max: risk.rate_ceiling_per_minute, window_seconds: SECONDS_PER_MINUTE };
  }
  let best: RateLimit | null = null;
  for (const entry of fromPresets) {
    if (best === null || perMinute(entry.rate_limit) > perMinute(best)) best = entry.rate_limit;
  }
  return best
    ? { max: best.max, window_seconds: best.window_seconds }
    : { max: RATE_BY_LEVEL[risk.level], window_seconds: SECONDS_PER_MINUTE };
}

/** The quota of a line: the largest a preset gives it, else by level. */
export function quotaFor(
  risk: Pick<CatalogRisk, 'level'>,
  fromPresets: readonly PresetEntry[],
): number {
  const largest = Math.max(0, ...fromPresets.map((entry) => entry.quota));
  return largest > 0 ? largest : QUOTA_BY_LEVEL[risk.level];
}

/**
 * The built-in preset on this connection with these resources: explicit ids
 * only, catalog order, each with its budget and the gate `auto`.
 */
export function everythingIHold(
  connection: Pick<IssuanceConnection, 'risks' | 'authority' | 'presets' | 'derives_env'>,
  selected: readonly Pick<IssuanceResource, 'env'>[],
): Preset {
  const held = new Set(connection.authority);
  const entries = connection.risks
    .filter(
      (risk) =>
        held.has(risk.risk_id) && !risk.deprecated && isResolvable(risk, connection, selected),
    )
    .map((risk): PresetEntry => {
      const fromPresets = presetEntriesFor(connection.presets, risk);
      return {
        risk_id: risk.risk_id,
        quota: quotaFor(risk, fromPresets),
        rate_limit: rateFor(risk, fromPresets),
        gate: 'auto',
      };
    });
  return {
    id: EVERYTHING_I_HOLD,
    label: EVERYTHING_I_HOLD_LABEL,
    description: EVERYTHING_I_HOLD_DESCRIPTION,
    entries,
  };
}

/** The preset a draft names on a connection: the built-in one, or one of the plugin's. */
export function findPreset(
  connection: Pick<IssuanceConnection, 'risks' | 'authority' | 'presets' | 'derives_env'>,
  presetId: string,
  selected: readonly Pick<IssuanceResource, 'env'>[],
): Preset | undefined {
  if (presetId === EVERYTHING_I_HOLD) return everythingIHold(connection, selected);
  return connection.presets.find((p) => p.id === presetId);
}

/** Every preset id a creator may pick on a connection: the plugin's, then the built-in one. */
export function presetIdsOf(connection: Pick<IssuanceConnection, 'presets'>): string[] {
  return [...connection.presets.map((p) => p.id), EVERYTHING_I_HOLD];
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
