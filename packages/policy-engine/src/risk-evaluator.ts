/**
 * Risk evaluator — intersect a runtime slice with a provider catalog to
 * derive the set of `RiskId` "touched" by the call.
 *
 * Spec : docs/spec/gateway-risk-model.md §1 (the runtime panel) + §4.
 * ADR  : docs/decisions/fallback-risk-only-when-uncategorized.md.
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
 *  - The **fallback** entry (`<provider>.uncategorized-write`, flagged
 *    `fallback: true` or detected by its catch-all pattern `<provider>.**.W`
 *    / its `uncategorized-` id) is touched **only when no other entry of
 *    the catalog matches the slice**. A write covered by a dedicated entry
 *    touches that entry alone ; a write covered by none touches the
 *    fallback ; a slice covered by nothing at all yields an empty result,
 *    which the runtime refuses. This keeps the "no silent passthrough"
 *    guarantee while letting a mission leave the fallback out : accepting
 *    it means accepting *uncategorized* writes, not every write.
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
    /** True for the catalog's catch-all entry — see `isFallbackEntry`. */
    readonly fallback: boolean;
  }>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Fallback detection
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Id prefix of the catch-all entry every catalog declares :
 * `<provider>.uncategorized-`, dash included — `github.uncategorized-write`
 * carries it, `github.uncategorizedfoo` does not.
 */
export function fallbackRiskPrefix(provider: string): string {
  return `${provider}.uncategorized-`;
}

/** True iff the parsed pattern is the catch-all write `<provider>.**.W` (one `[**]` segment, action W). */
export function isCatchAllWritePattern(pattern: Slice): boolean {
  return (
    pattern.action === 'W' && pattern.path.length === 1 && pattern.path[0]!.kind === 'wild-rec'
  );
}

/**
 * Whether a catalog entry is the provider's fallback. The explicit
 * `fallback: true` flag wins ; without it the entry is recognised by a
 * catch-all write pattern or by the `<provider>.uncategorized-` id
 * convention (every catalog written before the flag existed uses it).
 * `patterns` are the entry's parsed `matches` when the caller already has
 * them ; otherwise they are parsed here and an unparseable pattern simply
 * does not count (the loader reports it on its own).
 */
export function isFallbackEntry(
  entry: RiskEntry,
  provider: string,
  patterns?: readonly Slice[],
): boolean {
  if (entry.fallback !== undefined) return entry.fallback;
  if (entry.id.startsWith(fallbackRiskPrefix(provider))) return true;
  const parsed = patterns ?? parsePatternsLeniently(entry);
  return parsed.some(isCatchAllWritePattern);
}

/**
 * True iff one of the entry's `matches` patterns is the catch-all write
 * `<provider>.**.W`. An unparseable pattern does not count. The SDK loader
 * requires it of the fallback entry : the fallback is left out of the
 * touched risks whenever another entry matches, which is only sound for the
 * entry that covers every write.
 */
export function hasCatchAllWritePattern(entry: RiskEntry): boolean {
  return parsePatternsLeniently(entry).some(isCatchAllWritePattern);
}

/** The fallback entries of a catalog — exactly one in a valid catalog. */
export function fallbackEntriesOf(catalog: RiskCatalog): RiskEntry[] {
  return catalog.risks.filter((entry) => isFallbackEntry(entry, catalog.provider));
}

/** True iff the catalog declares at least one fallback entry. */
export function hasFallbackRisk(catalog: RiskCatalog): boolean {
  return fallbackEntriesOf(catalog).length > 0;
}

function parsePatternsLeniently(entry: RiskEntry): Slice[] {
  const raw = typeof entry.matches === 'string' ? [entry.matches] : entry.matches;
  const out: Slice[] = [];
  for (const pattern of raw) {
    try {
      out.push(parseSlice(pattern));
    } catch {
      // Reported by indexCatalog / the loader ; not this helper's concern.
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Indexing
// ─────────────────────────────────────────────────────────────────────────────

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
          { cause: e },
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
    return { entry, patterns, fallback: isFallbackEntry(entry, catalog.provider, patterns) };
  });
  return { provider: catalog.provider, entries };
}

// ─────────────────────────────────────────────────────────────────────────────
// Evaluation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute the `risks_touched` set for one concrete slice against one
 * provider's catalog. Returns the matched `RiskId`s in catalog declaration
 * order (deterministic). The fallback entry is included **only** when no
 * other entry matched (ADR fallback-risk-only-when-uncategorized). Empty
 * array iff the slice matches no catalog entry at all, fallback included
 * — in which case the catalog is incomplete and the caller treats this
 * as a hard error.
 *
 * Uses `intersects` (not `matches`) so that **either** side may contain
 * wildcards — a classifier emitting `service-var[*].W` (touches all vars,
 * specific set unknown) correctly co-fires with a catalog pattern
 * `service-var[**].W`. Concrete-only inputs behave identically to the
 * narrower `matches` predicate.
 */
export function risksTouchedBy(slice: Slice, catalog: IndexedRiskCatalog): RiskId[] {
  if (slice.provider !== catalog.provider) return [];
  const specific: RiskId[] = [];
  const fallbacks: RiskId[] = [];
  for (const { entry, patterns, fallback } of catalog.entries) {
    if (patterns.some((pattern) => intersects(pattern, slice))) {
      (fallback ? fallbacks : specific).push(entry.id);
    }
  }
  return specific.length > 0 ? specific : fallbacks;
}

/**
 * Compute the `risks_touched` set for a multi-slice call (some tools
 * touch more than one entity — see `railway-agent` or
 * `supabase__apply_migration` with mixed DDL+DML). The union of touched
 * risks across all slices is returned, deduplicated, in stable order
 * (catalog order, then arrival order across slices). The fallback rule
 * applies per slice : a call with one categorized and one uncategorized
 * write touches the dedicated entry *and* the fallback.
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
