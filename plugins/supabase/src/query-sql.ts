/**
 * Reading of the SQL of `supabase__execute_sql` : does the query read what
 * Supabase keeps for itself (`auth`, `vault`, `storage`…), or might it ?
 *
 * Spec : docs/spec/gateway-risk-model.md §7.2 #2.
 * Handbook : docs/handbook/providers/supabase.md, "Reading a query".
 *
 * Pure : no IO. That the query cannot write is the provider's guarantee (the
 * read-only endpoint) ; this file decides one thing only : whether the read
 * touches `supabase.read-managed-schemas` on top of `supabase.read-data`.
 * It decides **by what the SQL names**, never by what the database role may
 * read, and it is an allow-list :
 *
 *   managed   a `schema.` qualifier naming a sensitive managed schema, or the
 *             bare name of a sensitive catalog relation (`pg_authid`,
 *             `pg_stat_activity`…) — both lists live in `data-model.ts` ;
 *   unread    anything this reader cannot vouch for : text the tokeniser
 *             refuses (dollar quoting, prefixed strings, a backslash in a
 *             string, a positional parameter), no statement at all, a
 *             statement that is not a plain query (`SET`, `DO`, `CALL`,
 *             `COPY`, `PREPARE`…, which may change how names resolve or run
 *             SQL held in a string), and **any function call outside the
 *             inert list below**. A function is how a query reads a relation
 *             it does not name : `query_to_xml('select …')`,
 *             `set_config('search_path', …)`, `dblink(…)`, or a function
 *             somebody defined in the database.
 *
 * Both answers require the managed-schema risk ; only a query that is
 * neither is an application read.
 *
 * Known limit, by construction : a relation the query names may itself be a
 * view over a managed schema (`public.all_users` defined as `select … from
 * auth.users`), and an operator may be user-defined. Creating either is a
 * migration, priced on its own ; what already exists in the database is the
 * company's.
 */

import { SUPABASE_SENSITIVE_CATALOG_RELATIONS, isSensitiveSchema } from './data-model.ts';
import { isPunct, tokenise, type Statement, type Token } from './sql-tokens.ts';

/** Why a query touches the managed-schema risk ; `null` for an application read. */
export type ManagedReadReason = 'names-managed-schema' | 'unread';

export interface QuerySqlReading {
  /** `true` when the query touches `supabase.read-managed-schemas`. */
  readonly managed: boolean;
  readonly reason: ManagedReadReason | null;
}

const APPLICATION_READ: QuerySqlReading = { managed: false, reason: null };
const NAMES_MANAGED: QuerySqlReading = { managed: true, reason: 'names-managed-schema' };
const UNREAD: QuerySqlReading = { managed: true, reason: 'unread' };

/** Read a query. Never throws ; anything unreadable is `unread`. */
export function readQuerySql(query: string): QuerySqlReading {
  const statements = tokenise(query);
  if (statements === null || statements.length === 0) return UNREAD;
  // A managed name anywhere wins over "unread" : it is the more precise reason.
  if (statements.some(namesManaged)) return NAMES_MANAGED;
  return statements.every(isPlainQuery) ? APPLICATION_READ : UNREAD;
}

// ─── names ──────────────────────────────────────────────────────────────────

const SENSITIVE_RELATIONS: ReadonlySet<string> = new Set(SUPABASE_SENSITIVE_CATALOG_RELATIONS);

/**
 * The identifier a token spells, folded to lower case — bare or quoted alike.
 * PostgreSQL keeps the case of a quoted identifier, so `"AUTH"` is not the
 * `auth` schema ; folding it prices it as if it were, the costly side.
 */
function identifier(token: Token | undefined): string | null {
  return token?.kind === 'word' || token?.kind === 'quoted' ? token.text.toLowerCase() : null;
}

/** Does the statement name a sensitive managed schema or a sensitive catalog relation ? */
function namesManaged(s: Statement): boolean {
  for (let k = 0; k < s.length; k += 1) {
    const ident = identifier(s[k]);
    if (ident === null) continue;
    if (SENSITIVE_RELATIONS.has(ident)) return true;
    if (isPunct(s, k + 1, '.') && isSensitiveSchema(ident)) return true;
  }
  return false;
}

// ─── statements ─────────────────────────────────────────────────────────────

/** The words a plain query starts with. `EXPLAIN` and `SHOW` read too. */
const QUERY_HEADS: ReadonlySet<string> = new Set([
  'select',
  'with',
  'values',
  'table',
  'explain',
  'show',
]);

/** A plain query : it starts like one, and every call in it is to an inert function. */
function isPlainQuery(s: Statement): boolean {
  const head = s[0];
  if (head?.kind !== 'word' || !QUERY_HEADS.has(head.text)) return false;
  for (let k = 0; k < s.length; k += 1) {
    if (isPunct(s, k + 1, '(') && !mayPrecedeParenthesis(s, k)) return false;
  }
  return true;
}

/**
 * May the token at `k` stand right before an opening parenthesis ? Punctuation
 * and literals may (`= (`, `, (`, `'a' || (`). A word may when it is a keyword
 * of the query grammar or an inert function, called bare or as
 * `pg_catalog.<name>`. A quoted name, a name under any other qualifier and
 * every other word are calls this reader does not vouch for — or a column
 * list (`with c (a, b)`, `as t (a, b)`), which it does not try to tell apart.
 */
function mayPrecedeParenthesis(s: Statement, k: number): boolean {
  const token = s[k]!;
  if (token.kind === 'punct' || token.kind === 'string') return true;
  if (token.kind === 'quoted') return false;
  if (isPunct(s, k - 1, '.')) {
    const qualifier = s[k - 2];
    if (qualifier?.kind !== 'word' || qualifier.text !== 'pg_catalog') return false;
    return INERT_FUNCTIONS.has(token.text);
  }
  return KEYWORDS_BEFORE_PARENTHESIS.has(token.text) || INERT_FUNCTIONS.has(token.text);
}

/** Keywords of a query after which a parenthesis opens a sub-query, a list or an expression. */
const KEYWORDS_BEFORE_PARENTHESIS: ReadonlySet<string> = new Set([
  'select',
  'from',
  'where',
  'having',
  'on',
  'using',
  'join',
  'lateral',
  'as',
  'materialized',
  'by',
  'over',
  'filter',
  'group',
  'sets',
  'rollup',
  'cube',
  'and',
  'or',
  'not',
  'in',
  'any',
  'some',
  'all',
  'exists',
  'between',
  'like',
  'ilike',
  'when',
  'then',
  'else',
  'case',
  'union',
  'intersect',
  'except',
  'distinct',
  'limit',
  'offset',
  'values',
  'explain',
]);

/**
 * Built-in functions and function-like syntax that compute from their
 * arguments alone : they run no SQL held in a string, change no setting,
 * resolve no relation by name, read no file, no large object and no other
 * session. A function absent from this list is not refused : the query is
 * priced as a read of the managed schemas.
 *
 * Deliberately absent : `set_config` and `current_setting`, the
 * `query_to_xml`, `table_to_xml`, `schema_to_xml` and `cursor_to_xml`
 * families, `ts_stat` and the three-argument `ts_rewrite` (they execute a
 * query given as text), `dblink`, `pg_read_file` and its kin, `lo_get`,
 * `pg_sleep`, `nextval` and `setval`, the `pg_get_…def` family.
 */
const INERT_FUNCTIONS: ReadonlySet<string> = new Set([
  // syntax that reads as a call
  'cast',
  'extract',
  'position',
  'substring',
  'trim',
  'overlay',
  'coalesce',
  'nullif',
  'greatest',
  'least',
  'row',
  'array',
  'unnest',
  'varchar',
  'char',
  'character',
  'numeric',
  'decimal',
  'float',
  'timestamp',
  'timestamptz',
  'time',
  'interval',
  'bit',
  // aggregates and window functions
  'count',
  'sum',
  'avg',
  'min',
  'max',
  'bool_and',
  'bool_or',
  'every',
  'array_agg',
  'string_agg',
  'json_agg',
  'jsonb_agg',
  'json_object_agg',
  'jsonb_object_agg',
  'stddev',
  'stddev_pop',
  'stddev_samp',
  'variance',
  'var_pop',
  'var_samp',
  'corr',
  'percentile_cont',
  'percentile_disc',
  'mode',
  'row_number',
  'rank',
  'dense_rank',
  'percent_rank',
  'cume_dist',
  'ntile',
  'lag',
  'lead',
  'first_value',
  'last_value',
  'nth_value',
  // numbers
  'abs',
  'ceil',
  'ceiling',
  'floor',
  'round',
  'trunc',
  'mod',
  'power',
  'sqrt',
  'exp',
  'ln',
  'log',
  'sign',
  'div',
  'width_bucket',
  'random',
  'generate_series',
  // text
  'lower',
  'upper',
  'initcap',
  'length',
  'char_length',
  'character_length',
  'octet_length',
  'bit_length',
  'left',
  'right',
  'lpad',
  'rpad',
  'ltrim',
  'rtrim',
  'btrim',
  'replace',
  'translate',
  'reverse',
  'repeat',
  'concat',
  'concat_ws',
  'format',
  'substr',
  'strpos',
  'split_part',
  'starts_with',
  'string_to_array',
  'array_to_string',
  'regexp_replace',
  'regexp_match',
  'regexp_matches',
  'regexp_split_to_array',
  'regexp_split_to_table',
  'quote_ident',
  'quote_literal',
  'quote_nullable',
  'md5',
  'encode',
  'decode',
  'to_hex',
  'ascii',
  'chr',
  // dates
  'now',
  'clock_timestamp',
  'statement_timestamp',
  'transaction_timestamp',
  'timeofday',
  'date_trunc',
  'date_part',
  'date_bin',
  'age',
  'make_date',
  'make_time',
  'make_timestamp',
  'make_timestamptz',
  'make_interval',
  'justify_days',
  'justify_hours',
  'justify_interval',
  'isfinite',
  'to_char',
  'to_date',
  'to_timestamp',
  'to_number',
  // arrays
  'array_length',
  'array_position',
  'array_positions',
  'array_append',
  'array_prepend',
  'array_cat',
  'array_remove',
  'array_replace',
  'array_dims',
  'array_ndims',
  'array_lower',
  'array_upper',
  'cardinality',
  // JSON
  'to_json',
  'to_jsonb',
  'row_to_json',
  'array_to_json',
  'json_build_object',
  'jsonb_build_object',
  'json_build_array',
  'jsonb_build_array',
  'json_object',
  'jsonb_object',
  'json_array_length',
  'jsonb_array_length',
  'json_array_elements',
  'jsonb_array_elements',
  'json_array_elements_text',
  'jsonb_array_elements_text',
  'json_each',
  'jsonb_each',
  'json_each_text',
  'jsonb_each_text',
  'json_object_keys',
  'jsonb_object_keys',
  'json_extract_path',
  'jsonb_extract_path',
  'json_extract_path_text',
  'jsonb_extract_path_text',
  'json_typeof',
  'jsonb_typeof',
  'json_strip_nulls',
  'jsonb_strip_nulls',
  'jsonb_set',
  'jsonb_insert',
  'jsonb_pretty',
  'jsonb_path_query',
  'jsonb_path_query_array',
  'jsonb_path_query_first',
  'jsonb_path_exists',
  'jsonb_path_match',
  // misc
  'gen_random_uuid',
  'pg_typeof',
  'num_nulls',
  'num_nonnulls',
]);
