/**
 * Gmail `q` query parser — a minimal extractor of the few operators the
 * classifier zones on.
 *
 * Handbook : docs/handbook/providers/gmail.md.
 *
 * Deliberately small surface :
 *
 *   - four operators : `from:`, `to:`, `label:`, `newer_than:` (suffix `d` /
 *     `m` / `y`, converted to days) ;
 *   - the implicit conjunction between terms, and an explicit `AND` ;
 *   - one negation, `-label:<name>`, collected apart (the classifier uses it
 *     to prove a sensitive label is excluded).
 *
 * Everything else is **reported, never interpreted** — the parser says what
 * it cannot bound and the classifier takes the worst case :
 *
 *   - `hasDisjunction` : an `OR` (any case), a grouping character
 *     (`(` `)` `{` `}` `|`) or a double quote anywhere in the query. A union
 *     reads more than any of its terms and a quoted phrase turns operators
 *     into plain words, so nothing extracted from such a query bounds it. A
 *     token carrying a grouping character yields no extraction at all.
 *   - `hasNegation` : any `-term` other than `-label:<name>`. A negated
 *     `from:` is never a sender bound : `-from:a@x.com` reads every thread
 *     *not* from that address.
 *   - `hasUnknownOps` : any other token (`is:unread`, `has:attachment`, a
 *     bare keyword, a malformed `newer_than:`).
 *
 * This is NOT a full Gmail query parser and it authorises nothing : it only
 * extracts the signal the zone classification needs. Values are returned as
 * written ; the classifier validates them (a `from:` value that is not one
 * full address bounds nothing).
 */

/** Structured extraction of a Gmail `q` string. */
export interface QParsed {
  /** Values of the positive `from:` clauses (deduped, as written). */
  readonly fromAddresses: readonly string[];
  /** Values of the positive `to:` clauses (deduped, as written). */
  readonly toAddresses: readonly string[];
  /** Values of the positive `label:` clauses (deduped, as written). */
  readonly labels: readonly string[];
  /** Values of the `-label:` clauses (deduped, as written). */
  readonly negatedLabels: readonly string[];
  /** Duration extracted from `newer_than:Nd` / `Nm` / `Ny`, expressed in
   *  days. `undefined` if the operator was not present. */
  readonly newerThanDays?: number;
  /** True iff the query holds an `OR`, a grouping character or a quote : it
   *  is not a pure conjunction of whole terms, so no extracted clause bounds
   *  what it reads. */
  readonly hasDisjunction: boolean;
  /** True iff the query holds a negated term other than `-label:<name>`. */
  readonly hasNegation: boolean;
  /** True iff at least one token matched no modelled operator. The
   *  classifier adds `from-zone[unknown]` — the worst-case default. */
  readonly hasUnknownOps: boolean;
}

const FROM_RE = /^from:(.+)$/i;
const TO_RE = /^to:(.+)$/i;
const LABEL_RE = /^label:(.+)$/i;
const NEGATED_LABEL_RE = /^-label:(.+)$/i;
const NEWER_THAN_RE = /^newer_than:(\d+)([dmy])$/i;
/** Characters Gmail uses to group terms or to write a union without `OR`. */
const GROUPING_RE = /[(){}|]/;

function tokenise(q: string): string[] {
  return q
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

/** Parse a Gmail `q` filter into the modelled extractions. Pure ; never
 *  throws — what is not modelled is reported through the three flags. */
export function parseQ(q: string): QParsed {
  const fromAddresses = new Set<string>();
  const toAddresses = new Set<string>();
  const labels = new Set<string>();
  const negatedLabels = new Set<string>();
  let newerThanDays: number | undefined;
  // A quoted phrase spans tokens : `subject:"x from:a@b.co y"` holds no sender clause.
  let hasDisjunction = q.includes('"');
  let hasNegation = false;
  let hasUnknownOps = false;

  for (const tok of tokenise(q)) {
    if (tok === 'AND') continue;
    if (tok.toUpperCase() === 'OR' || GROUPING_RE.test(tok)) {
      hasDisjunction = true;
      continue;
    }

    let m: RegExpMatchArray | null;
    if ((m = tok.match(NEGATED_LABEL_RE))) {
      negatedLabels.add(m[1]!.trim());
      continue;
    }
    if (tok.startsWith('-')) {
      hasNegation = true;
      continue;
    }
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

    hasUnknownOps = true;
  }

  return {
    fromAddresses: [...fromAddresses],
    toAddresses: [...toAddresses],
    labels: [...labels],
    negatedLabels: [...negatedLabels],
    newerThanDays,
    hasDisjunction,
    hasNegation,
    hasUnknownOps,
  };
}
