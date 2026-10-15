/**
 * v4 `accepted_risks` → the explicit policy of a v5 mission, one id at a
 * time (ADR import-from-v4-one-shot-importer D6). Pure.
 *
 * The rule, for each v4 id of the connection's provider:
 *
 *   1. The same id is an explicit id of the v5 catalog → kept.
 *   2. An account-scoped v4 id whose v5 entry became env-scoped (Supabase,
 *      Stripe, Upstash) → the env-qualified ids the mission can reach: one per
 *      environment of the entry carried by a selected resource (or every one,
 *      when the plugin derives the environment from the call). v4 accepted it
 *      on every environment, so this is the same permission, written out.
 *   3. An env-qualified v4 id with no exact v5 counterpart, an id the v5
 *      catalog does not know, a deprecated entry, an id outside the creator's
 *      authority → dropped and reported. Never replaced by a wider id.
 *
 * v4 denials trump acceptance (v4's risk runtime refuses a denied risk even
 * when it is accepted): an accepted v4 id that is itself denied, and every
 * target whose id or base id a v4 denial names, are dropped and reported
 * (`denied-in-v4`).
 *
 * Each kept id takes its budget and gate from a preset line: the plugin's
 * developer preset first, then its other presets in catalog order (the
 * interface's rule for a hand-ticked risk, `defaultEntryFor`). An id no
 * preset carries — every catalog's fallback among them — has no budget to
 * take: dropped and reported, since a quota is never invented — unless the
 * operator asks for it with `carryUnbudgeted` (`--carry-unbudgeted <quota>`,
 * ADR import-from-v4-one-shot-importer, amendment of 2026-10-15): the id is
 * then kept with that quota, a rate limit that adds nothing to it, and the
 * `approval` gate, always — every use waits for the owner's grant. Only that
 * reason is lifted; every other drop stays a drop.
 */
import { SECONDS_PER_MINUTE } from '@vaubaan/policy-engine';
import {
  formatRiskId,
  parseRiskId,
  type PresetEntry,
  type RateLimit,
  type RiskId,
} from '@vaubaan/shared';

import { isResolvable } from '../missions/catalog-view';
import type { CatalogRisk, IssuanceConnection, IssuanceResource } from '../missions/model';

export type DropReason =
  | 'denied-in-v4'
  | 'unknown-in-v5'
  | 'deprecated-in-v5'
  | 'no-exact-env-counterpart'
  | 'env-unresolvable'
  | 'no-preset-budget'
  | 'outside-authority';

export interface DroppedRisk {
  readonly v4RiskId: string;
  readonly reason: DropReason;
  /** v5 ids the reason is about (the env rows of an unresolvable entry, …). */
  readonly v5RiskIds: readonly RiskId[];
}

/** One line of the translated policy: explicit id, numeric budget, gate — nothing left to resolve. */
export interface TranslatedEntry extends PresetEntry {
  /** The v4 id it comes from. */
  readonly from: string;
  /** The preset whose line gave the budget; `null` for a line carried under approval. */
  readonly presetId: string | null;
}

/**
 * `--carry-unbudgeted <quota>`: a risk dropped only because no preset gives
 * it a budget is kept with this quota per period, under approval.
 */
export interface CarryUnbudgeted {
  /** A positive integer, actions per period (the mission's period). */
  readonly quota: number;
}

/** A risk kept under approval by `CarryUnbudgeted` instead of being dropped. */
export interface CarriedRisk {
  readonly v4RiskId: string;
  readonly v5RiskId: RiskId;
}

export interface Translation {
  readonly entries: readonly TranslatedEntry[];
  readonly dropped: readonly DroppedRisk[];
  /** Ids no preset budgets, kept under approval (`CarryUnbudgeted`); also in `entries`. */
  readonly carried: readonly CarriedRisk[];
  /** Account-scoped v4 ids written out per environment (rule 2), for the report. */
  readonly expanded: readonly {
    readonly v4RiskId: string;
    readonly v5RiskIds: readonly RiskId[];
  }[];
}

export type TranslatableConnection = Pick<
  IssuanceConnection,
  'risks' | 'derives_env' | 'presets' | 'authority'
>;

/** The provider a v4 risk id belongs to, or `null` when it is not a risk id. */
export function providerOfV4Risk(v4RiskId: string): string | null {
  return parseRiskId(v4RiskId)?.provider ?? null;
}

/** A developer-like preset: `developer`, or a qualified one such as `test-mode-developer`. */
export function isDeveloperLike(presetId: string): boolean {
  return presetId === 'developer' || presetId.endsWith('-developer');
}

export function translateRisks(
  v4RiskIds: readonly string[],
  connection: TranslatableConnection,
  selected: readonly Pick<IssuanceResource, 'env'>[],
  v4Denied: readonly string[] = [],
  carry: CarryUnbudgeted | null = null,
): Translation {
  const denied = new Set(v4Denied);
  const byId = new Map(connection.risks.map((risk) => [risk.risk_id, risk]));
  const held = new Set(connection.authority);
  const entries = new Map<RiskId, TranslatedEntry>();
  const dropped: DroppedRisk[] = [];
  const carried: CarriedRisk[] = [];
  const expanded: { v4RiskId: string; v5RiskIds: RiskId[] }[] = [];

  for (const v4RiskId of new Set(v4RiskIds)) {
    if (denied.has(v4RiskId)) {
      dropped.push({ v4RiskId, reason: 'denied-in-v4', v5RiskIds: [] });
      continue;
    }
    const targets = targetsOf(v4RiskId, connection, byId, selected);
    if ('reason' in targets) {
      dropped.push({ v4RiskId, reason: targets.reason, v5RiskIds: targets.v5RiskIds });
      continue;
    }
    if (targets.expanded)
      expanded.push({ v4RiskId, v5RiskIds: targets.risks.map((r) => r.risk_id) });
    for (const risk of targets.risks) {
      if (entries.has(risk.risk_id)) continue;
      if (denied.has(risk.risk_id) || denied.has(risk.base_id)) {
        dropped.push({ v4RiskId, reason: 'denied-in-v4', v5RiskIds: [risk.risk_id] });
        continue;
      }
      if (!held.has(risk.risk_id)) {
        dropped.push({ v4RiskId, reason: 'outside-authority', v5RiskIds: [risk.risk_id] });
        continue;
      }
      const line = presetLineFor(connection, risk);
      if (!line && carry !== null) {
        entries.set(risk.risk_id, {
          risk_id: risk.risk_id,
          quota: carry.quota,
          rate_limit: unbindingRateLimit(carry.quota, risk),
          gate: 'approval',
          from: v4RiskId,
          presetId: null,
        });
        carried.push({ v4RiskId, v5RiskId: risk.risk_id });
        continue;
      }
      if (!line) {
        dropped.push({ v4RiskId, reason: 'no-preset-budget', v5RiskIds: [risk.risk_id] });
        continue;
      }
      entries.set(risk.risk_id, {
        risk_id: risk.risk_id,
        quota: line.entry.quota,
        rate_limit: line.entry.rate_limit,
        gate: line.entry.gate,
        from: v4RiskId,
        presetId: line.presetId,
      });
    }
  }
  return { entries: [...entries.values()], dropped, carried, expanded };
}

/**
 * The rate limit of a carried line: as many per minute as the quota allows
 * per period, so only the quota binds — a budget always has a rate limit
 * (spec §3.2), this one adds nothing to the quota. Held under the catalog's
 * ceiling when it has one.
 */
export function unbindingRateLimit(
  quota: number,
  risk: Pick<CatalogRisk, 'rate_ceiling_per_minute'>,
): RateLimit {
  const ceiling = risk.rate_ceiling_per_minute;
  return {
    max: ceiling === null ? quota : Math.min(quota, ceiling),
    window_seconds: SECONDS_PER_MINUTE,
  };
}

type Targets =
  | { readonly risks: readonly CatalogRisk[]; readonly expanded: boolean }
  | { readonly reason: DropReason; readonly v5RiskIds: readonly RiskId[] };

function targetsOf(
  v4RiskId: string,
  connection: TranslatableConnection,
  byId: ReadonlyMap<RiskId, CatalogRisk>,
  selected: readonly Pick<IssuanceResource, 'env'>[],
): Targets {
  const exact = byId.get(v4RiskId);
  if (exact) {
    if (exact.deprecated) return { reason: 'deprecated-in-v5', v5RiskIds: [exact.risk_id] };
    if (!isResolvable(exact, connection, selected)) {
      return { reason: 'env-unresolvable', v5RiskIds: [exact.risk_id] };
    }
    return { risks: [exact], expanded: false };
  }
  const parsed = parseRiskId(v4RiskId);
  if (!parsed) return { reason: 'unknown-in-v5', v5RiskIds: [] };
  if (parsed.env !== null) {
    // `github[feature].x` → `github.x` would cover more than v4 did: never.
    const base = formatRiskId({ provider: parsed.provider, name: parsed.name });
    const counterparts = connection.risks.filter((r) => r.risk_id === base || r.base_id === base);
    return counterparts.length > 0
      ? { reason: 'no-exact-env-counterpart', v5RiskIds: counterparts.map((r) => r.risk_id) }
      : { reason: 'unknown-in-v5', v5RiskIds: [] };
  }
  const perEnv = connection.risks.filter((r) => r.base_id === v4RiskId && r.env !== null);
  if (perEnv.length === 0) return { reason: 'unknown-in-v5', v5RiskIds: [] };
  const live = perEnv.filter((r) => !r.deprecated);
  if (live.length === 0)
    return { reason: 'deprecated-in-v5', v5RiskIds: perEnv.map((r) => r.risk_id) };
  const reachable = live.filter((r) => isResolvable(r, connection, selected));
  if (reachable.length === 0) {
    return { reason: 'env-unresolvable', v5RiskIds: live.map((r) => r.risk_id) };
  }
  return { risks: reachable, expanded: true };
}

/** The budget line of a risk: the developer-like presets first, then the others, in catalog order. */
function presetLineFor(
  connection: Pick<IssuanceConnection, 'presets'>,
  risk: Pick<CatalogRisk, 'risk_id' | 'base_id'>,
): { readonly presetId: string; readonly entry: PresetEntry } | null {
  const ordered = [
    ...connection.presets.filter((p) => isDeveloperLike(p.id)),
    ...connection.presets.filter((p) => !isDeveloperLike(p.id)),
  ];
  for (const preset of ordered) {
    const entry =
      preset.entries.find((e) => e.risk_id === risk.risk_id) ??
      preset.entries.find((e) => e.risk_id === risk.base_id);
    if (entry) return { presetId: preset.id, entry };
  }
  return null;
}
