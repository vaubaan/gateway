/**
 * The query of `outlook__search_messages` — a small closed grammar the
 * plugin parses itself, then translates to Graph (`execute`). Gmail's
 * `q-parser` idea, closed: a token outside the grammar refuses the call,
 * since the plugin could not translate it and would not know what it reads.
 *
 * Handbook : docs/handbook/providers/outlook.md ("search_messages").
 *
 *   from:<address>     the sender is exactly this address
 *   to:<address>       this address is a To recipient
 *   subject:<word>     the subject contains the word (one word per term)
 *   is:unread          not read yet
 *   has:attachment     carries an attachment
 *   after:<YYYY-MM-DD> received on or after the day (UTC)
 *   before:<YYYY-MM-DD> received before the day (UTC)
 *   <word>             a free word: Graph's full-text search ($search)
 *
 * Terms are a conjunction. No OR, no negation, no quote, no parenthesis, no
 * wildcard: a free word is letters and digits first, then letters, digits
 * and `. _ ' @ -`, and never `AND`, `OR` or `NOT` (KQL's operators), so the
 * `$search` value is a plain list of words inside one pair of quotes.
 */

import { parseAddress } from './address.ts';

export interface ParsedQuery {
  /** The from: addresses, lower-cased, each once. */
  readonly from: readonly string[];
  readonly to: readonly string[];
  /** The subject: words, as written. */
  readonly subjects: readonly string[];
  readonly unread: boolean;
  readonly hasAttachment: boolean;
  /** `YYYY-MM-DD`, at most one of each. */
  readonly after: string | null;
  readonly before: string | null;
  /** The free words, as written. */
  readonly words: readonly string[];
}

export type QueryOutcome = { readonly query: ParsedQuery } | { readonly denied: string };

/** Longest query, and most terms, accepted. */
export const MAX_QUERY_LENGTH = 500;
export const MAX_QUERY_TERMS = 20;

const WORD = /^[\p{L}\p{N}][\p{L}\p{N}._'@-]{0,63}$/u;
const KQL_OPERATORS: ReadonlySet<string> = new Set(['and', 'or', 'not', 'near', 'onear']);
const DAY = /^\d{4}-\d{2}-\d{2}$/;

const GRAMMAR =
  'terms are from:<address>, to:<address>, subject:<word>, is:unread, has:attachment, after:<YYYY-MM-DD>, before:<YYYY-MM-DD> and free words (letters and digits); no OR, negation, quote or parenthesis.';

/** A free word or a subject word, or `null`. */
export function queryWord(value: string): string | null {
  return WORD.test(value) && !KQL_OPERATORS.has(value.toLowerCase()) ? value : null;
}

function day(value: string): string | null {
  return DAY.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) ? value : null;
}

function refuse(token: string): { readonly denied: string } {
  const shown = token.slice(0, 40).replace(/[^\x20-\x7e]/g, '?');
  return { denied: `query: '${shown}' is not a term of the search grammar; ${GRAMMAR}` };
}

/** Parse a query; every token must be a term of the grammar. Pure. */
export function parseQuery(value: unknown): QueryOutcome {
  if (typeof value !== 'string') return { denied: 'query: expected a string.' };
  if (value.length > MAX_QUERY_LENGTH) {
    return { denied: `query: at most ${MAX_QUERY_LENGTH} characters.` };
  }
  const tokens = value.split(/\s+/).filter((t) => t !== '');
  if (tokens.length > MAX_QUERY_TERMS)
    return { denied: `query: at most ${MAX_QUERY_TERMS} terms.` };

  const from: string[] = [];
  const to: string[] = [];
  const subjects: string[] = [];
  const words: string[] = [];
  let unread = false;
  let hasAttachment = false;
  let after: string | null = null;
  let before: string | null = null;

  for (const token of tokens) {
    const colon = token.indexOf(':');
    if (colon < 0) {
      const word = queryWord(token);
      if (word === null) return refuse(token);
      words.push(word);
      continue;
    }
    const key = token.slice(0, colon).toLowerCase();
    const rest = token.slice(colon + 1);
    switch (key) {
      case 'from':
      case 'to': {
        const address = parseAddress(rest);
        if (address === null) return { denied: `query: ${key}: takes exactly one full address.` };
        const list = key === 'from' ? from : to;
        if (!list.includes(address.address)) list.push(address.address);
        break;
      }
      case 'subject': {
        const word = queryWord(rest);
        if (word === null) return refuse(token);
        subjects.push(word);
        break;
      }
      case 'is':
        if (rest.toLowerCase() !== 'unread') return refuse(token);
        unread = true;
        break;
      case 'has':
        if (rest.toLowerCase() !== 'attachment') return refuse(token);
        hasAttachment = true;
        break;
      case 'after':
      case 'before': {
        const parsed = day(rest);
        if (parsed === null) return { denied: `query: ${key}: takes a date, YYYY-MM-DD.` };
        if ((key === 'after' ? after : before) !== null) {
          return { denied: `query: ${key}: at most once.` };
        }
        if (key === 'after') after = parsed;
        else before = parsed;
        break;
      }
      default:
        return refuse(token);
    }
  }
  if (after !== null && before !== null && before <= after) {
    return { denied: 'query: before: must be a later day than after:.' };
  }
  return { query: { from, to, subjects, unread, hasAttachment, after, before, words } };
}
