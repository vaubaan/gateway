/**
 * Reading of the SQL body of `supabase__apply_migration` : which write
 * classes does it take, on top of the schema write every migration is ?
 *
 * Handbook : docs/handbook/services/supabase.md, "Reading a migration".
 *
 * Pure : no IO. This is not a SQL parser and does not try to be one. It is
 * an allow-list : a statement is *recognised* only when its leading keywords
 * name one of the shapes below and nothing in it can embed another command.
 * Everything else — `DO` blocks, function, trigger, view and rule
 * definitions, CTEs, bare `SELECT`s (they call functions), `COPY`, `SET`,
 * commands this file does not list, text it cannot tokenise — makes the
 * whole migration `recognised: false`, and the classifier then requires
 * every write class. A keyword filter over an opaque language only protects
 * against the honest caller ; an allow-list fails closed.
 *
 *   schema only   CREATE TABLE (not `AS`), ALTER TABLE ADD / ALTER / RENAME /
 *                 VALIDATE / DROP CONSTRAINT, CREATE / DROP INDEX, CREATE
 *                 SCHEMA, CREATE SEQUENCE, CREATE TYPE … AS, COMMENT ON,
 *                 BEGIN, COMMIT
 *   bulk-row      INSERT, UPDATE, DELETE, TRUNCATE, DROP TABLE,
 *                 ALTER TABLE … DROP [COLUMN], DROP SEQUENCE / TYPE … CASCADE
 *   policy        CREATE / ALTER / DROP POLICY, ALTER TABLE … ENABLE /
 *                 DISABLE / FORCE ROW LEVEL SECURITY
 *   db-role       GRANT, REVOKE, CREATE / ALTER / DROP ROLE | USER | GROUP,
 *                 ALTER DEFAULT PRIVILEGES
 *   extension     CREATE / ALTER / DROP EXTENSION
 *
 * A table-level statement (DDL or DML, policies excepted) whose target sits
 * in a schema Supabase manages (`auth`, `storage`, `vault`, `cron`, …) is not
 * recognised either : writing `auth.users` is not an application row write.
 *
 * Known limit, by construction : a recognised statement may still evaluate
 * an expression (`DEFAULT f()`, `CHECK (…)`, `SET a = f()`), hence run a
 * function that already exists in the database. Creating such a function is
 * never a recognised statement.
 */

import { isManagedSchema } from './data-model.ts';
import { isPunct, name, tokenise, word, type Statement, type Token } from './sql-tokens.ts';

/** A write class a migration may take on top of the schema write. */
export type MigrationWriteClass = 'bulk-row' | 'policy' | 'db-role' | 'extension';

/** Every class, in the order the classifier emits them. */
export const MIGRATION_WRITE_CLASSES: readonly MigrationWriteClass[] = [
  'bulk-row',
  'policy',
  'db-role',
  'extension',
];

export interface MigrationSqlReading {
  /** `false` when at least one statement is not on the allow-list. */
  readonly recognised: boolean;
  /** The classes taken ; every class when `recognised` is `false`. */
  readonly classes: readonly MigrationWriteClass[];
}

/** Read a migration body. Never throws ; anything unreadable is `recognised: false`. */
export function readMigrationSql(query: string): MigrationSqlReading {
  const statements = tokenise(query);
  if (statements === null) return UNRECOGNISED;
  const taken = new Set<MigrationWriteClass>();
  for (const statement of statements) {
    const classes = classesOf(statement);
    if (classes === null) return UNRECOGNISED;
    for (const c of classes) taken.add(c);
  }
  return { recognised: true, classes: MIGRATION_WRITE_CLASSES.filter((c) => taken.has(c)) };
}

const UNRECOGNISED: MigrationSqlReading = { recognised: false, classes: MIGRATION_WRITE_CLASSES };

// ─── token helpers ──────────────────────────────────────────────────────────

/** Index after the optional keyword sequence `words` at `k`. */
function skip(s: Statement, k: number, ...words: readonly string[]): number {
  return words.every((w, j) => word(s, k + j) === w) ? k + words.length : k;
}

/**
 * The `[schema.]table` name at `k` when it is an application table :
 * `{ next }` is the index after it. `null` when there is no name there, when
 * it has three parts, or when its schema is managed by Supabase.
 */
function applicationTable(s: Statement, k: number): { next: number } | null {
  if (name(s, k) === null) return null;
  if (!isPunct(s, k + 1, '.')) return { next: k + 1 };
  if (name(s, k + 2) === null || isPunct(s, k + 3, '.')) return null;
  return isManagedSchema(name(s, k)!) ? null : { next: k + 3 };
}

/** Does any `schema.` qualifier from `from` on name a managed schema ? */
function namesManagedSchema(s: Statement, from: number): boolean {
  for (let k = from; k < s.length; k += 1) {
    const schema = name(s, k);
    if (schema !== null && isPunct(s, k + 1, '.') && isManagedSchema(schema)) return true;
  }
  return false;
}

// ─── embedded commands ──────────────────────────────────────────────────────

/** Words that start a command of their own wherever they appear. */
const ALWAYS_A_COMMAND = new Set([
  'execute',
  'call',
  'copy',
  'truncate',
  'merge',
  'grant',
  'revoke',
  'prepare',
]);

interface EmbeddingRule {
  /** Sub-selects allowed (policies and DML read ; DDL does not). */
  readonly select: boolean;
  /** `<previous word> <dml word>` pairs that are syntax, not a command. */
  readonly benignPairs: ReadonlySet<string>;
  /** `ON CONFLICT … DO NOTHING | UPDATE` allowed. */
  readonly onConflict: boolean;
}

/** Foreign-key actions : `ON DELETE CASCADE`, `ON UPDATE SET NULL`. */
const IN_DDL: EmbeddingRule = {
  select: false,
  benignPairs: new Set(['on delete', 'on update']),
  onConflict: false,
};
/** `FOR SELECT | INSERT | UPDATE | DELETE` names the command a policy applies to. */
const IN_POLICY: EmbeddingRule = {
  select: true,
  benignPairs: new Set(['for insert', 'for update', 'for delete']),
  onConflict: false,
};
/** `ON CONFLICT DO UPDATE`, `SELECT … FOR UPDATE`. */
const IN_DML: EmbeddingRule = {
  select: true,
  benignPairs: new Set(['do update', 'for update']),
  onConflict: true,
};

/** Could the tokens from `from` on carry a command other than the statement's own ? */
function embedsCommand(s: Statement, from: number, rule: EmbeddingRule): boolean {
  for (let k = from; k < s.length; k += 1) {
    const w = word(s, k);
    if (w === null) continue;
    if (ALWAYS_A_COMMAND.has(w)) return true;
    if (w === 'select' && !rule.select) return true;
    if (w === 'do') {
      const then = word(s, k + 1);
      if (!rule.onConflict || (then !== 'nothing' && then !== 'update')) return true;
    }
    if (w === 'insert' || w === 'update' || w === 'delete') {
      if (!rule.benignPairs.has(`${word(s, k - 1) ?? ''} ${w}`)) return true;
    }
  }
  return false;
}

// ─── statements ─────────────────────────────────────────────────────────────

type Classes = readonly MigrationWriteClass[];

const SCHEMA_ONLY: Classes = [];
const ROLE_KEYWORDS = new Set(['role', 'user', 'group']);

/** The classes one statement takes, `[]` for a schema-only one, `null` when not recognised. */
function classesOf(s: Statement): Classes | null {
  const head = word(s, 0);
  const second = word(s, 1);
  switch (head) {
    case 'begin':
    case 'commit':
      return s.length === 1 ? SCHEMA_ONLY : null;
    case 'comment':
      return second === 'on' ? SCHEMA_ONLY : null;
    case 'create':
      return classesOfCreate(s);
    case 'alter':
      return classesOfAlter(s);
    case 'drop':
      return classesOfDrop(s);
    case 'insert':
      return second === 'into' ? classesOfDml(s, 2) : null;
    case 'delete':
      return second === 'from' ? classesOfDml(s, 2) : null;
    case 'update':
      return classesOfDml(s, 1);
    case 'truncate':
      // No expression in a TRUNCATE : only its targets need a look.
      return namesManagedSchema(s, 1) || embedsCommand(s, 1, IN_DDL) ? null : ['bulk-row'];
    case 'grant':
    case 'revoke':
      return ['db-role'];
    default:
      return null;
  }
}

function classesOfDml(s: Statement, targetAt: number): Classes | null {
  const target = applicationTable(s, skip(s, targetAt, 'only'));
  if (target === null || embedsCommand(s, target.next, IN_DML)) return null;
  return ['bulk-row'];
}

function classesOfCreate(s: Statement): Classes | null {
  const kind = word(s, 1);
  if (kind === 'table') {
    const target = applicationTable(s, skip(s, 2, 'if', 'not', 'exists'));
    if (target === null || embedsCommand(s, target.next, IN_DDL)) return null;
    for (let k = target.next; k < s.length; k += 1) {
      const w = word(s, k);
      // `CREATE TABLE … AS <query>` copies rows ; `GENERATED ALWAYS AS (…)` and
      // `GENERATED … AS IDENTITY` are column definitions.
      const columnClause = word(s, k - 1) === 'always' || word(s, k + 1) === 'identity';
      if (w === 'as' && !columnClause) return null;
      // `PARTITION OF`, `OF <type>`, `INHERITS` bind the table to another relation.
      if (w === 'of' || w === 'inherits') return null;
    }
    return SCHEMA_ONLY;
  }
  if (kind === 'index' || (kind === 'unique' && word(s, 2) === 'index')) {
    const on = s.findIndex((t) => t.kind === 'word' && t.text === 'on');
    if (on === -1) return null;
    const target = applicationTable(s, skip(s, on + 1, 'only'));
    return target === null || embedsCommand(s, target.next, IN_DDL) ? null : SCHEMA_ONLY;
  }
  if (kind === 'schema') {
    // Nothing after the name : `CREATE SCHEMA x CREATE TABLE … GRANT …` embeds commands.
    const at = skip(s, 2, 'if', 'not', 'exists');
    return name(s, at) !== null && s.length === at + 1 ? SCHEMA_ONLY : null;
  }
  if (kind === 'sequence') return namesManagedSchema(s, 2) ? null : SCHEMA_ONLY;
  if (kind === 'type') {
    // Enum and composite types only ; base and range types name support functions.
    const as = s.findIndex((t) => t.kind === 'word' && t.text === 'as');
    if (as === -1) return null;
    return word(s, as + 1) === 'enum' || isPunct(s, as + 1, '(') ? SCHEMA_ONLY : null;
  }
  if (kind === 'policy') return embedsCommand(s, 2, IN_POLICY) ? null : ['policy'];
  if (kind === 'extension') return ['extension'];
  if (kind !== null && ROLE_KEYWORDS.has(kind) && word(s, 2) !== 'mapping') return ['db-role'];
  return null;
}

function classesOfAlter(s: Statement): Classes | null {
  const kind = word(s, 1);
  if (kind === 'table') return classesOfAlterTable(s);
  if (kind === 'policy') return embedsCommand(s, 2, IN_POLICY) ? null : ['policy'];
  if (kind === 'extension') return ['extension'];
  if (kind === 'default' && word(s, 2) === 'privileges') return ['db-role'];
  if (kind !== null && ROLE_KEYWORDS.has(kind) && word(s, 2) !== 'mapping') return ['db-role'];
  return null;
}

const ROW_LEVEL_SECURITY = ['row', 'level', 'security'] as const;

function classesOfAlterTable(s: Statement): Classes | null {
  const targetAt = skip(s, skip(s, 2, 'if', 'exists'), 'only');
  const classes = new Set<MigrationWriteClass>();
  for (const action of topLevelItems(s, targetAt)) {
    const rls = classesOfRlsAction(action);
    if (rls !== null) {
      // Row level security may be switched on any table, managed ones included.
      classes.add(rls);
      continue;
    }
    const verb = word(action, 0);
    if (applicationTable(s, targetAt) === null || embedsCommand(action, 0, IN_DDL)) return null;
    if (verb === 'drop') {
      // Dropping a column destroys its values in every row.
      if (word(action, 1) !== 'constraint') classes.add('bulk-row');
    } else if (verb === 'alter') {
      // `ALTER [COLUMN] c [SET DATA] TYPE t [USING expr]` rewrites the column in every
      // row, and `USING` overwrites the values with any expression: the same loss as
      // dropping the column. The keyword is looked for after the column name, bare: a
      // column called "type" is quoted, hence never a keyword.
      if (changesColumnType(action)) classes.add('bulk-row');
    } else if (verb !== 'add' && verb !== 'rename' && verb !== 'validate') {
      return null;
    }
  }
  return [...classes];
}

/**
 * Is this `ALTER [COLUMN] <name> …` action a type change ? `TYPE` or `USING` as a
 * bare word anywhere after the column name : `alter column c type t`, `alter c set
 * data type t`, with or without `USING`. Anything else that happens to carry the
 * word is priced as one too (the costly side).
 */
function changesColumnType(action: Statement): boolean {
  const nameAt = skip(action, 1, 'column');
  for (let k = nameAt + 1; k < action.length; k += 1) {
    const w = word(action, k);
    if (w === 'type' || w === 'using') return true;
  }
  return false;
}

/** `ENABLE | DISABLE | FORCE | NO FORCE ROW LEVEL SECURITY`, exactly. */
function classesOfRlsAction(action: Statement): MigrationWriteClass | null {
  const from = skip(action, 0, 'no');
  const verb = word(action, from);
  if (verb !== 'enable' && verb !== 'disable' && verb !== 'force') return null;
  if (from === 1 && verb !== 'force') return null;
  const rest = ROW_LEVEL_SECURITY.every((w, j) => word(action, from + 1 + j) === w);
  return rest && action.length === from + 4 ? 'policy' : null;
}

/**
 * The comma-separated actions of an `ALTER TABLE`, after the table name at
 * `targetAt`. A missing name yields one empty action, which no rule accepts.
 */
function topLevelItems(s: Statement, targetAt: number): Statement[] {
  const start = isPunct(s, targetAt + 1, '.') ? targetAt + 3 : targetAt + 1;
  const items: Token[][] = [[]];
  let depth = 0;
  for (const t of s.slice(start)) {
    if (t.kind === 'punct' && t.text === '(') depth += 1;
    if (t.kind === 'punct' && t.text === ')') depth -= 1;
    if (t.kind === 'punct' && t.text === ',' && depth === 0) items.push([]);
    else items[items.length - 1]!.push(t);
  }
  return items;
}

function classesOfDrop(s: Statement): Classes | null {
  const kind = word(s, 1);
  switch (kind) {
    case 'table':
      return namesManagedSchema(s, 2) ? null : ['bulk-row'];
    case 'index':
      return namesManagedSchema(s, 2) ? null : SCHEMA_ONLY;
    case 'sequence':
    case 'type':
      // CASCADE reaches the columns that use the sequence or the type.
      if (namesManagedSchema(s, 2)) return null;
      return s.some((t) => t.kind === 'word' && t.text === 'cascade') ? ['bulk-row'] : SCHEMA_ONLY;
    case 'policy':
      return ['policy'];
    case 'extension':
      return ['extension'];
    case 'role':
    case 'group':
      return ['db-role'];
    case 'user':
      return word(s, 2) === 'mapping' ? null : ['db-role'];
    default:
      return null;
  }
}
