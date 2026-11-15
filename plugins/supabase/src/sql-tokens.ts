/**
 * The SQL tokeniser of the `supabase` plugin, shared by the two readers of
 * free-form SQL : `migration-sql.ts` (`apply_migration`) and `query-sql.ts`
 * (`execute_sql`).
 *
 * Handbook : docs/handbook/services/supabase.md, "Reading a migration" and
 * "Reading a query".
 *
 * Pure : no IO. Not a SQL parser : it removes comments and literals and
 * splits the text into statements of words, quoted identifiers, strings and
 * punctuation. It refuses (`null`) any construct whose extent it does not
 * want to guess, so both readers fail closed on the same texts.
 */

export type Token =
  /** A bare word, lowercased : keyword, identifier or number. */
  | { readonly kind: 'word'; readonly text: string }
  /** A double-quoted identifier, verbatim : never a keyword. */
  | { readonly kind: 'quoted'; readonly text: string }
  /** A single-quoted string literal ; its content is irrelevant. */
  | { readonly kind: 'string' }
  | { readonly kind: 'punct'; readonly text: string };

export type Statement = readonly Token[];

const WHITESPACE = new Set([' ', '\t', '\n', '\r', '\f', '\v']);
const WORD_CHAR = /[A-Za-z0-9_\u0080-￿]/;

/**
 * Split into statements of tokens, comments and literals removed. `null`
 * when the text uses a construct whose extent this reader does not want to
 * guess : dollar quoting (function and `DO` bodies), prefixed strings
 * (`E'…'`, `U&'…'`, `B'…'`), a backslash inside a string (its meaning
 * depends on a server setting), a control character, anything unterminated.
 */
export function tokenise(sql: string): Statement[] | null {
  const statements: Token[][] = [];
  let current: Token[] = [];
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i]!;
    const next = sql[i + 1];
    if (WHITESPACE.has(ch)) {
      i += 1;
    } else if (ch < ' ' || ch === '\u007f' || ch === '$') {
      return null;
    } else if (ch === '-' && next === '-') {
      // PostgreSQL ends a line comment at `\n` OR `\r` (scan.l: `non_newline [^\n\r]`).
      // Waiting for `\n` alone would hide from this reader everything after a bare `\r`,
      // which the server executes.
      i += 2;
      while (i < sql.length && sql[i] !== '\n' && sql[i] !== '\r') i += 1;
    } else if (ch === '/' && next === '*') {
      const end = endOfBlockComment(sql, i);
      if (end === null) return null;
      i = end;
    } else if (ch === "'" || ch === '"') {
      // A quote glued to a word or to `&` is a prefixed literal (E'', U&"").
      const before = i > 0 ? sql[i - 1]! : ' ';
      if (WORD_CHAR.test(before) || before === '&') return null;
      const literal = readQuoted(sql, i, ch);
      if (literal === null) return null;
      current.push(ch === "'" ? { kind: 'string' } : { kind: 'quoted', text: literal.text });
      i = literal.end;
    } else if (WORD_CHAR.test(ch)) {
      let end = i + 1;
      while (end < sql.length && WORD_CHAR.test(sql[end]!)) end += 1;
      current.push({ kind: 'word', text: sql.slice(i, end).toLowerCase() });
      i = end;
    } else if (ch === ';') {
      if (current.length > 0) statements.push(current);
      current = [];
      i += 1;
    } else {
      current.push({ kind: 'punct', text: ch });
      i += 1;
    }
  }
  if (current.length > 0) statements.push(current);
  return statements;
}

/** Index after the end of the (nestable) block comment opened at `start`, or `null`. */
function endOfBlockComment(sql: string, start: number): number | null {
  let depth = 0;
  let i = start;
  while (i < sql.length) {
    if (sql[i] === '/' && sql[i + 1] === '*') {
      depth += 1;
      i += 2;
    } else if (sql[i] === '*' && sql[i + 1] === '/') {
      depth -= 1;
      i += 2;
      if (depth === 0) return i;
    } else {
      i += 1;
    }
  }
  return null;
}

/** The literal opened at `start` by `quote` (doubled quote = escaped quote), or `null`. */
function readQuoted(
  sql: string,
  start: number,
  quote: string,
): { text: string; end: number } | null {
  let text = '';
  let i = start + 1;
  while (i < sql.length) {
    const ch = sql[i]!;
    if (ch === '\\' && quote === "'") return null;
    if (ch !== quote) {
      text += ch;
      i += 1;
    } else if (sql[i + 1] === quote) {
      text += quote;
      i += 2;
    } else {
      return { text, end: i + 1 };
    }
  }
  return null;
}

// ─── token helpers ──────────────────────────────────────────────────────────

/** The bare word at `k`, or `null` (quoted identifiers are never keywords). */
export function word(s: Statement, k: number): string | null {
  const t = s[k];
  return t?.kind === 'word' ? t.text : null;
}

/** The identifier at `k`, bare or quoted, or `null`. */
export function name(s: Statement, k: number): string | null {
  const t = s[k];
  return t?.kind === 'word' || t?.kind === 'quoted' ? t.text : null;
}

export function isPunct(s: Statement, k: number, text: string): boolean {
  const t = s[k];
  return t?.kind === 'punct' && t.text === text;
}
