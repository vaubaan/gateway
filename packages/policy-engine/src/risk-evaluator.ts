/**
 * Risk evaluator — intersect a runtime slice with a provider catalog to
 * derive the set of `RiskId` "touched" by the call.
 *
 * Spec : docs/spec/gateway-risk-model.md §1 (the runtime panel) + §4.
 *
 * Conceptually trivial : for each `RiskEntry` in the provider's catalog,
 * check whether the entry's `matches` slice pattern *matches* the
 * concrete slice the plugin emitted. If it does, the risk is touched.
 *
 * Subtleties :
 *  - A single concrete slice may touch *multiple* risks (the catalog is
 *    not partitioned ; entries can overlap, and that's intentional — a
 *    `cat /etc/shadow` SSH call touches both `ssh.exec-read` and the
 *    co-touched `ssh.exec-read-secret-files`). All matched risks are
 *    returned. The caller (runtime) enforces `risks_touched ⊆ accepted`.
 *  - Deprecated entries (`deprecated: true`) are kept in the matching
 *    pass : tokens that historically accepted them still authorize. The
 *    UI / mint UX surfaces the deprecation warning separately.
 *  - The fallback entry (typically `<provider>.uncategorized-write` with
 *    pattern `<provider>.**.W`) catches any concrete slice not covered by
 *    a more specific entry. It is NOT removed from the result — it ALWAYS
 *    appears in `risks_touched` when applicable. Tokens that did not
 *    accept the fallback (the safe default) will be denied. This is the
 *    explicit "no silent passthrough" guarantee.
 */

import type { RiskCatalog, RiskEntry, RiskId, Slice } from '@vaubaan/shared';

import { parseSlice } from './slice-dsl.ts';
import { intersects } from './slice-matcher.ts';

/**
 * Pre-indexed catalog : the `matches` patterns are parsed once at load
 * time and cached, so the hot-path intersect is O(N) where N is the
 * number of entries (typically 10-20 per provider).
 *
 * A risk entry may declare ONE pattern (string) or MULTIPLE disjoint
 * patterns (string[]). All patterns are stored — `risksTouchedBy` fires
 * the risk when ANY of its patterns intersects with the executed slice.
 */
export interface IndexedRiskCatalog {
  readonly provider: string;
  readonly entries: ReadonlyArray<{
    readonly entry: RiskEntry;
    /** One or more parsed patterns. The risk is touched when at least
     *  one pattern intersects with the executed slice (OR semantics). */
    readonly patterns: readonly Slice[];
  }>;
}

/** Parse every `matches` pattern in the catalog. Throws on malformed
 *  patterns — catalog YAMLs are reviewed in PRs, this is a CI gate.
 *
 *  Also enforces id uniqueness here (the only call site every consumer
 *  goes through). `prepareCatalog` (risk-policy.ts) re-checks ids against
 *  the canonical regex on top of this. */
export function indexCatalog(catalog: RiskCatalog): IndexedRiskCatalog {
  const seen = new Set<string>();
  const entries = catalog.risks.map((entry) => {
    if (seen.has(entry.id)) {
      throw new Error(`Duplicate risk id '${entry.id}' in catalog '${catalog.provider}'`);
    }
    seen.add(entry.id);
    const rawPatterns: readonly string[] =
      typeof entry.matches === 'string' ? [entry.matches] : entry.matches;
    const patterns = rawPatterns.map((raw) => {
      let pattern: Slice;
      try {
        pattern = parseSlice(raw);
      } catch (e) {
        throw new Error(
          `Invalid 'matches' pattern in risk '${entry.id}' of provider '${catalog.provider}': ${
            e instanceof Error ? e.message : String(e)
          }`,
        );
      }
      if (pattern.provider !== catalog.provider) {
        throw new Error(
          `Risk '${entry.id}' declares pattern for provider '${pattern.provider}' ` +
            `but is in '${catalog.provider}'s catalog`,
        );
      }
      return pattern;
    });
    return { entry, patterns };
  });
  return { provider: catalog.provider, entries };
}

/**
 * Compute the `risks_touched` set for one concrete slice against one
 * provider's catalog. Returns the matched `RiskId`s in catalog declaration
 * order (deterministic). Empty array iff the slice matches no catalog
 * entry — in which case the catalog is incomplete (no fallback) and the
 * caller should treat this as a hard error.
 *
 * Uses `intersects` (not `matches`) so that **either** side may contain
 * wildcards — a classifier emitting `service-var[*].W` (touches all vars,
 * specific set unknown) correctly co-fires with a catalog pattern
 * `service-var[**].W`. Concrete-only inputs behave identically to the
 * narrower `matches` predicate.
 */
export function risksTouchedBy(slice: Slice, catalog: IndexedRiskCatalog): RiskId[] {
  if (slice.provider !== catalog.provider) return [];
  const touched: RiskId[] = [];
  for (const { entry, patterns } of catalog.entries) {
    for (const pattern of patterns) {
      if (intersects(pattern, slice)) {
        touched.push(entry.id);
        break;
      }
    }
  }
  return touched;
}

/**
 * Compute the `risks_touched` set for a multi-slice call (some tools
 * touch more than one entity — see `railway-agent` or
 * `supabase__apply_migration` with mixed DDL+DML). The union of touched
 * risks across all slices is returned, deduplicated, in stable order
 * (catalog order, then arrival order across slices).
 */
export function risksTouchedByAll(slices: readonly Slice[], catalog: IndexedRiskCatalog): RiskId[] {
  const seen = new Set<RiskId>();
  const out: RiskId[] = [];
  for (const slice of slices) {
    for (const id of risksTouchedBy(slice, catalog)) {
      if (!seen.has(id)) {
        seen.add(id);
        out.push(id);
      }
    }
  }
  return out;
}

/** Lookup helper : find a catalog entry by id. O(N) — acceptable, N is small. */
export function findRiskEntry(catalog: IndexedRiskCatalog, riskId: RiskId): RiskEntry | undefined {
  return catalog.entries.find((e) => e.entry.id === riskId)?.entry;
}
