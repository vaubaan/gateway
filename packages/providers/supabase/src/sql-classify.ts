/**
 * SQL → capability classifier for `supabase__execute_sql`.
 *
 * Spec : docs/spec/gateway-capability-model.md §2.1, §3.
 *
 * `execute_sql` is a generic SQL passthrough. We refuse to filter (any command
 * Supabase exposes, a dev will need someday) but we MUST route each statement
 * to the right ring of the `db` plane so the capability gate matches the
 * blast radius :
 *
 *   rows:read     SELECT, WITH … SELECT, VALUES, TABLE, EXPLAIN, SHOW
 *   rows:write    INSERT, UPDATE, DELETE, MERGE, TRUNCATE, COPY
 *   tables:write  CREATE/DROP/ALTER {TABLE|INDEX|VIEW|MATERIALIZED VIEW|TYPE|
 *                                     DOMAIN|SEQUENCE|FUNCTION|PROCEDURE|TRIGGER}
 *                 REFRESH MATERIALIZED VIEW
 *   rls:write     CREATE/DROP/ALTER {POLICY|ROLE},
 *                 ALTER TABLE … ENABLE|DISABLE|FORCE ROW LEVEL SECURITY,
 *                 GRANT, REVOKE, SECURITY LABEL
 *   project:write CREATE/DROP/ALTER {EXTENSION|DATABASE|SCHEMA|PUBLICATION|
 *                                     SUBSCRIPTION|TABLESPACE},
 *                 ALTER SYSTEM, VACUUM, ANALYZE, REINDEX, SET, RESET, CLUSTER
 *
 * Multi-statement queries take the strictest required capability across
 * statements (max level rank ; write trumps read). Unknown leading verbs
 * default to `project:write` (most defensive — forces human approval).
 */

export type Action = 'read' | 'write';
/** db plane level slugs, in rank order (1 = innermost = blast 1, 4 = outermost). */
export type Level = 'rows' | 'tables' | 'rls' | 'project';

export interface SqlRequirement {
  level: Level;
  action: Action;
}

const LEVEL_RANK: Record<Level, number> = { rows: 1, tables: 2, rls: 3, project: 4 };

/**
 * Strip SQL comments and string/identifier literals from a query so that
 * `;`-splitting and keyword matching aren't fooled by their contents. Returns
 * a sanitized query where every literal/comment is replaced by a same-length
 * run of spaces (preserves offsets if ever needed).
 */
function stripCommentsAndLiterals(sql: string): string {
  const out: string[] = [];
  let i = 0;
  while (i < sql.length) {
    const c = sql[i]!;
    const next = sql[i + 1];
    // Line comment -- … \n
    if (c === '-' && next === '-') {
      while (i < sql.length && sql[i] !== '\n') {
        out.push(' ');
        i++;
      }
      continue;
    }
    // Block comment /* … */ (nested not supported — Postgres allows nesting
    // but execute_sql callers rarely use it ; safe over-approximation).
    if (c === '/' && next === '*') {
      out.push('  ');
      i += 2;
      while (i < sql.length && !(sql[i] === '*' && sql[i + 1] === '/')) {
        out.push(' ');
        i++;
      }
      if (i < sql.length) {
        out.push('  ');
        i += 2;
      }
      continue;
    }
    // Single-quoted string literal '…' with '' as escape
    if (c === "'") {
      out.push(' ');
      i++;
      while (i < sql.length) {
        if (sql[i] === "'" && sql[i + 1] === "'") {
          out.push('  ');
          i += 2;
          continue;
        }
        if (sql[i] === "'") {
          out.push(' ');
          i++;
          break;
        }
        out.push(' ');
        i++;
      }
      continue;
    }
    // Double-quoted identifier "…"
    if (c === '"') {
      out.push(' ');
      i++;
      while (i < sql.length && sql[i] !== '"') {
        out.push(' ');
        i++;
      }
      if (i < sql.length) {
        out.push(' ');
        i++;
      }
      continue;
    }
    // Dollar-quoted string $tag$…$tag$ (Postgres functions, anonymous tag = $$)
    if (c === '$') {
      const tagMatch = sql.slice(i).match(/^\$([A-Za-z_][A-Za-z0-9_]*)?\$/);
      if (tagMatch) {
        const tag = tagMatch[0];
        out.push(' '.repeat(tag.length));
        i += tag.length;
        const end = sql.indexOf(tag, i);
        if (end === -1) {
          // Unterminated — blank to end.
          while (i < sql.length) {
            out.push(' ');
            i++;
          }
        } else {
          while (i < end) {
            out.push(' ');
            i++;
          }
          out.push(' '.repeat(tag.length));
          i += tag.length;
        }
        continue;
      }
    }
    out.push(c);
    i++;
  }
  return out.join('');
}

/** Split a sanitized query on `;`. Empty fragments are dropped. */
function splitStatements(sanitized: string): string[] {
  return sanitized
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Pick the first contiguous run of SQL keywords (uppercase ASCII letters). */
function leadingTokens(stmt: string, max = 8): string[] {
  const upper = stmt.toUpperCase();
  const tokens: string[] = [];
  const re = /[A-Z]+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(upper)) !== null && tokens.length < max) {
    tokens.push(m[0]);
  }
  return tokens;
}

const ROWS_READ_HEAD = new Set(['SELECT', 'WITH', 'VALUES', 'TABLE', 'EXPLAIN', 'SHOW']);
const ROWS_WRITE_HEAD = new Set(['INSERT', 'UPDATE', 'DELETE', 'MERGE', 'TRUNCATE', 'COPY']);
const TABLES_DDL_SECOND = new Set([
  'TABLE',
  'INDEX',
  'VIEW',
  'MATERIALIZED',
  'TYPE',
  'DOMAIN',
  'SEQUENCE',
  'FUNCTION',
  'PROCEDURE',
  'TRIGGER',
  'AGGREGATE',
  'OPERATOR',
  'COLLATION',
]);
const RLS_DDL_SECOND = new Set(['POLICY', 'ROLE', 'USER', 'GROUP']);
const PROJECT_DDL_SECOND = new Set([
  'EXTENSION',
  'DATABASE',
  'SCHEMA',
  'PUBLICATION',
  'SUBSCRIPTION',
  'TABLESPACE',
  'SERVER',
  'FOREIGN',
  'EVENT',
]);
const PROJECT_HEAD = new Set([
  'VACUUM',
  'ANALYZE',
  'REINDEX',
  'SET',
  'RESET',
  'CLUSTER',
  'CHECKPOINT',
  'LOAD',
  'LISTEN',
  'NOTIFY',
  'UNLISTEN',
  'LOCK',
  'DISCARD',
  'PREPARE',
  'EXECUTE',
  'DEALLOCATE',
  'BEGIN',
  'COMMIT',
  'ROLLBACK',
  'SAVEPOINT',
  'RELEASE',
  'START',
  'END',
]);

/** Classify a single SQL statement. */
function classifyStatement(stmt: string): SqlRequirement {
  const tokens = leadingTokens(stmt);
  const t0 = tokens[0] ?? '';
  const t1 = tokens[1] ?? '';
  const t2 = tokens[2] ?? '';

  if (ROWS_READ_HEAD.has(t0)) return { level: 'rows', action: 'read' };
  if (ROWS_WRITE_HEAD.has(t0)) return { level: 'rows', action: 'write' };

  // GRANT / REVOKE / SECURITY LABEL → rls (privileges + RLS labels).
  if (t0 === 'GRANT' || t0 === 'REVOKE') return { level: 'rls', action: 'write' };
  if (t0 === 'SECURITY' && t1 === 'LABEL') return { level: 'rls', action: 'write' };

  // REFRESH MATERIALIZED VIEW → tables:write (re-materialization of a structure).
  if (t0 === 'REFRESH' && t1 === 'MATERIALIZED') return { level: 'tables', action: 'write' };

  // ALTER SYSTEM / ALTER DATABASE / ALTER TABLESPACE … → project:write
  // ALTER ROLE / ALTER USER / ALTER GROUP / ALTER POLICY → rls:write
  // ALTER TABLE … (ENABLE|DISABLE|FORCE|NO FORCE) ROW LEVEL SECURITY → rls:write
  // ALTER TABLE … (anything else) → tables:write
  // ALTER {EXTENSION|SCHEMA|PUBLICATION|…} → project:write
  // ALTER {INDEX|VIEW|TYPE|DOMAIN|SEQUENCE|FUNCTION|PROCEDURE|TRIGGER|…} → tables:write
  if (t0 === 'ALTER') {
    if (t1 === 'SYSTEM') return { level: 'project', action: 'write' };
    if (PROJECT_DDL_SECOND.has(t1)) return { level: 'project', action: 'write' };
    if (RLS_DDL_SECOND.has(t1)) return { level: 'rls', action: 'write' };
    if (t1 === 'TABLE') {
      const upperStmt = stmt.toUpperCase();
      if (/\bROW\s+LEVEL\s+SECURITY\b/.test(upperStmt)) {
        return { level: 'rls', action: 'write' };
      }
      return { level: 'tables', action: 'write' };
    }
    if (TABLES_DDL_SECOND.has(t1)) return { level: 'tables', action: 'write' };
    // Unknown ALTER target → defensive project:write.
    return { level: 'project', action: 'write' };
  }

  // CREATE / DROP — same dispatch by the object kind in t1.
  if (t0 === 'CREATE' || t0 === 'DROP') {
    // CREATE OR REPLACE {FUNCTION|VIEW|…} → look at t3 (REPLACE shifts the keyword).
    let kind = t1;
    if (t0 === 'CREATE' && t1 === 'OR' && t2 === 'REPLACE') {
      kind = tokens[3] ?? '';
    }
    if (PROJECT_DDL_SECOND.has(kind)) return { level: 'project', action: 'write' };
    if (RLS_DDL_SECOND.has(kind)) return { level: 'rls', action: 'write' };
    if (TABLES_DDL_SECOND.has(kind)) return { level: 'tables', action: 'write' };
    // CREATE/DROP UNIQUE INDEX / TEMPORARY TABLE / etc. — look one deeper.
    if (TABLES_DDL_SECOND.has(t2)) return { level: 'tables', action: 'write' };
    return { level: 'project', action: 'write' };
  }

  if (PROJECT_HEAD.has(t0)) return { level: 'project', action: 'write' };

  // CALL <proc>(...) → side-effects unknown ; conservative rows:write since
  // procedures most often mutate data.
  if (t0 === 'CALL' || t0 === 'DO') return { level: 'rows', action: 'write' };

  // Unknown leading verb : strictest default. Forces human gate by seed policy.
  return { level: 'project', action: 'write' };
}

/** Pick the strictest of two requirements (max level rank ; write > read). */
function joinReq(a: SqlRequirement, b: SqlRequirement): SqlRequirement {
  const level = LEVEL_RANK[a.level] >= LEVEL_RANK[b.level] ? a.level : b.level;
  const action: Action = a.action === 'write' || b.action === 'write' ? 'write' : 'read';
  return { level, action };
}

/**
 * Classify a raw SQL query into the single (level, action) it requires on the
 * supabase `db` plane. Empty / whitespace-only / comment-only queries default
 * to `rows:read` (no-op semantics).
 */
export function classifySql(query: string): SqlRequirement {
  const sanitized = stripCommentsAndLiterals(query);
  const statements = splitStatements(sanitized);
  if (statements.length === 0) return { level: 'rows', action: 'read' };
  let req = classifyStatement(statements[0]!);
  for (let i = 1; i < statements.length; i++) {
    req = joinReq(req, classifyStatement(statements[i]!));
  }
  return req;
}
