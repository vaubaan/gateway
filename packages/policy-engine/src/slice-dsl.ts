/**
 * Slice DSL — parse + serialize the path-based selector strings used in
 * catalog YAML, audit logs, and (internally) by the matcher.
 *
 * Spec : docs/spec/gateway-risk-model.md §3.
 *
 * Grammar (recap) :
 *   slice    ::= provider '.' segment ('.' segment)* '.' action
 *   provider ::= ident
 *   segment  ::= ident | '[' inner ']'
 *   inner    ::= '*' | '**' | ident (',' ident)*
 *   ident    ::= [a-zA-Z0-9_/-]+
 *   action   ::= 'R' | 'W'
 *
 * The DSL is intentionally minimal — no regex, no predicates, no operators.
 * A bracketed ident may contain `*` (glob, matches `[a-zA-Z0-9_/-]+`) ; the
 * bracket itself is the marker that distinguishes an *entity name* from an
 * *entity identifier value*. Example :
 *
 *   github.repo[sbw-vaubaan/gateway].branch[feature/*].file[**].W
 *   └─prov─┘ └name──┘└ ident value ┘ └name─┘└ glob ─┘ └n─┘ └rec┘ └act
 */

import type { Slice, SliceSegment } from '@vaubaan/shared';

/** Bare segment name chars (entity name like `branch`, `env-var`, repo refs
 *  like `sbw-vaubaan/gateway`). Excludes `.` (separator) and `*` (only
 *  bare wildcard `**`/`*` as full token). */
const BARE_NAME_CHARS = /^[a-zA-Z0-9_/-]+$/;
/** Characters legal inside a bracket identifier (`[owner/repo]`, `[a.ts]`,
 *  `[v1~2]`). The matcher expands the glob `*` over this same class, so a
 *  pattern never accepts less than the parser does. */
export const BRACKET_IDENT_CHAR_CLASS = '[a-zA-Z0-9_./~-]';
/** Inside-bracket ident-or-glob : ident chars plus `*` for glob patterns.
 *  Used for both single ident and list entries. */
const BRACKET_IDENT_OR_GLOB = new RegExp(`^(?:${BRACKET_IDENT_CHAR_CLASS}|\\*)+$`);

export class SliceParseError extends Error {
  constructor(
    public readonly input: string,
    public readonly position: number,
    message: string,
  ) {
    super(`SliceParseError at position ${position} of "${input}": ${message}`);
    this.name = 'SliceParseError';
  }
}

/**
 * Parse a slice string into its structured form.
 * Throws `SliceParseError` on malformed input — the caller (catalog loader,
 * test harness) is expected to surface a useful message.
 *
 * The grammar produces a flat segment list. A `name[inner]` form appears as
 * TWO consecutive segments — a `name` then a bracket-derived one (ident /
 * list / wild). They share no `.` separator (catalog convention).
 *
 *   `github.repo[main].file[a.ts].W`
 *    └──prov──┘ │└name─┘ │└──ident──┘ ... .W
 *               └ident('main')   ↑ no dot between name and bracket
 *
 * Bare `**` (without brackets) is also a recursive wildcard segment, used
 * in catalog fallback patterns like `github.**.W`.
 */
export function parseSlice(input: string): Slice {
  const dot = input.indexOf('.');
  if (dot <= 0) {
    throw new SliceParseError(input, 0, "expected '<provider>.<segments>.<action>'");
  }
  const provider = input.slice(0, dot);
  if (!BARE_NAME_CHARS.test(provider) || provider.includes('/')) {
    throw new SliceParseError(input, 0, `invalid provider name '${provider}'`);
  }

  const rest = input.slice(dot + 1);
  const segments: SliceSegment[] = [];
  const pos = dot + 1;
  let i = 0;

  while (i < rest.length) {
    // Read one segment.
    if (rest[i] === '[') {
      // Bracketed segment.
      const close = rest.indexOf(']', i);
      if (close < 0) {
        throw new SliceParseError(input, pos + i, "unterminated '['");
      }
      const inner = rest.slice(i + 1, close);
      if (inner.length === 0) {
        throw new SliceParseError(input, pos + i, 'empty bracket');
      }
      segments.push(parseBracket(inner, input, pos + i + 1));
      i = close + 1;
    } else {
      // Bare name segment OR bare '**' wildcard OR final action letter.
      // We greedily consume until '.' or '['.
      let j = i;
      while (j < rest.length && rest[j] !== '.' && rest[j] !== '[') j++;
      const tok = rest.slice(i, j);
      if (tok.length === 0) {
        throw new SliceParseError(input, pos + i, "empty segment ('..')");
      }
      // Final action token : only valid when terminal.
      if ((tok === 'R' || tok === 'W') && j === rest.length) {
        return { provider, path: segments, action: tok };
      }
      // Bare '**' = recursive wildcard segment (catalog fallback pattern).
      if (tok === '**') {
        segments.push({ kind: 'wild-rec' });
      } else if (tok === '*') {
        segments.push({ kind: 'wild-one' });
      } else if (BARE_NAME_CHARS.test(tok)) {
        segments.push({ kind: 'name', value: tok });
      } else {
        throw new SliceParseError(input, pos + i, `invalid segment name '${tok}'`);
      }
      i = j;
    }
    // Skip the '.' separator if present — but NOT mandatory between a name
    // and the immediately following '[' (entity-then-identifier convention).
    if (i < rest.length) {
      if (rest[i] === '.') {
        i++;
      } else if (rest[i] === '[') {
        // Continue : the bracket is the next segment, no separator needed.
      } else {
        throw new SliceParseError(
          input,
          pos + i,
          `expected '.' or '[' after segment, got '${rest[i]}'`,
        );
      }
    }
  }

  throw new SliceParseError(input, input.length, "missing terminal action ('.R' or '.W')");
}

function parseBracket(inner: string, input: string, position: number): SliceSegment {
  if (inner === '*') return { kind: 'wild-one' };
  if (inner === '**') return { kind: 'wild-rec' };
  if (inner.includes(',')) {
    const values = inner.split(',').map((s) => s.trim());
    for (const v of values) {
      // List entries may contain globs (`*`) — e.g. [feature/*, fix/*].
      if (v.length === 0 || !BRACKET_IDENT_OR_GLOB.test(v)) {
        throw new SliceParseError(input, position, `invalid list entry '${v}'`);
      }
    }
    return { kind: 'list', values };
  }
  if (!BRACKET_IDENT_OR_GLOB.test(inner)) {
    throw new SliceParseError(input, position, `invalid bracket content '${inner}'`);
  }
  return { kind: 'ident', value: inner };
}

/**
 * Serialize a structured slice back to its string form.
 *
 * Convention : when a `name` segment is immediately followed by a bracket
 * segment (`ident` / `list` / wildcard), no `.` is inserted between them
 * (`repo[main]`, not `repo.[main]`). Between two `name` segments, or
 * between two bracket segments, a `.` IS inserted.
 *
 * Note : bare wildcards (`**`, `*`) parsed from input are normalized to
 * `[**]` / `[*]` on output. The roundtrip is not bitwise-identical for
 * those rare inputs ; the canonical form has brackets.
 */
export function serializeSlice(slice: Slice): string {
  if (slice.path.length === 0) {
    return `${slice.provider}.${slice.action}`;
  }
  let out = slice.provider;
  for (let i = 0; i < slice.path.length; i++) {
    const seg = slice.path[i]!;
    const prev = i === 0 ? null : slice.path[i - 1]!;
    // Insert '.' separator EXCEPT when current seg is a bracket and prev is a name.
    const isBracket = seg.kind !== 'name';
    const prevIsName = prev?.kind === 'name';
    if (i === 0 || !(isBracket && prevIsName)) {
      out += '.';
    }
    out += serializeSegment(seg);
  }
  out += `.${slice.action}`;
  return out;
}

function serializeSegment(seg: SliceSegment): string {
  switch (seg.kind) {
    case 'name':
      return seg.value;
    case 'ident':
      return `[${seg.value}]`;
    case 'list':
      return `[${seg.values.join(',')}]`;
    case 'wild-one':
      return '[*]';
    case 'wild-rec':
      return '[**]';
  }
}
