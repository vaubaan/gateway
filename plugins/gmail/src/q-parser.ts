/**
 * Gmail `q` query parser — minimal, ~50 LoC of cardinal opérators only.
 *
 * Research : .vaubaan/research/providers/gmail.md §6.ter Q8 (tranché 2026-06-18).
 *
 * Surface intentionnellement réduite :
 *
 *   - 4 opérateurs cardinaux : `from:`, `to:`, `label:`, `newer_than:` (with
 *     suffix `d` / `m` / `y` interpreted on days).
 *   - Booléens : `OR` explicite (case-sensitive), `AND` implicite (default
 *     between terms), `-` prefix négation.
 *   - Any token not matching one of the cardinal operators is *silently*
 *     fall-through : the classifier will treat the call as `from-zone[unknown]`
 *     (worst-case). Cf. research §5.2.
 *
 * This is NOT a full Gmail query parser. It's a minimal extractor of the
 * fields the classifier cares about for risk zoning. Inspired by the
 * `sql-classification-syntactic-only` post-pivot philosophy : we don't try
 * to authorise/deny based on the parsed structure, we only *extract* signal
 * to inform zone classification.
 */

/** Structured extraction of a Gmail `q` string. */
export interface QParsed {
  /** Addresses extracted from `from:` clauses (deduped). */
  readonly fromAddresses: readonly string[];
  /** Addresses extracted from `to:` clauses (deduped). */
  readonly toAddresses: readonly string[];
  /** Labels extracted from `label:` clauses (deduped). */
  readonly labels: readonly string[];
  /** Duration extracted from `newer_than:Nd` / `Nm` / `Ny`, expressed in
   *  days. `undefined` if the operator was not present. */
  readonly newerThanDays?: number;
  /** True iff at least one token in `q` did not match any cardinal
   *  operator. The classifier treats this as fall-through to
   *  `from-zone[unknown]` — preserving the "worst-case unknown" default. */
  readonly hasUnknownOps: boolean;
}

const FROM_RE = /^-?from:(.+)$/i;
const TO_RE = /^-?to:(.+)$/i;
const LABEL_RE = /^-?label:(.+)$/i;
const NEWER_THAN_RE = /^-?newer_than:(\d+)([dmy])$/i;

/** Tokenise on whitespace, but keep `OR` as a soft separator (no special
 *  treatment beyond that — `OR` is consumed silently, every token between
 *  them is parsed independently). */
function tokenise(q: string): string[] {
  return q
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

/** Parse a Gmail `q` filter into the cardinal extractions. Pure ; never
 *  throws — unknown tokens fall through silently with `hasUnknownOps:
 *  true`. */
export function parseQ(q: string): QParsed {
  const fromAddresses = new Set<string>();
  const toAddresses = new Set<string>();
  const labels = new Set<string>();
  let newerThanDays: number | undefined;
  let hasUnknownOps = false;

  for (const tok of tokenise(q)) {
    if (tok === 'OR' || tok === 'AND') continue;

    let m: RegExpMatchArray | null;
    if ((m = tok.match(FROM_RE))) {
      fromAddresses.add(m[1]!.trim());
      continue;
    }
    if ((m = tok.match(TO_RE))) {
      toAddresses.add(m[1]!.trim());
      continue;
    }
    if ((m = tok.match(LABEL_RE))) {
      labels.add(m[1]!.trim());
      continue;
    }
    if ((m = tok.match(NEWER_THAN_RE))) {
      const n = Number.parseInt(m[1]!, 10);
      const unit = m[2]!.toLowerCase();
      const days = unit === 'd' ? n : unit === 'm' ? n * 30 : n * 365;
      newerThanDays = newerThanDays === undefined ? days : Math.min(newerThanDays, days);
      continue;
    }

    // Anything else — fall-through. The classifier treats this as worst-case
    // `from-zone[unknown]` per research Q8.
    hasUnknownOps = true;
  }

  return {
    fromAddresses: [...fromAddresses],
    toAddresses: [...toAddresses],
    labels: [...labels],
    newerThanDays,
    hasUnknownOps,
  };
}
