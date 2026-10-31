/**
 * The parsing context of the catalog loader and the small readers every
 * field parser shares : where the parser is in the document, where it
 * reports, and the guards of a YAML value.
 */

import { isList } from './guards.ts';

export type Rec = Record<string, unknown>;

/**
 * Where a parser is in the document and where it reports. Every field
 * parser takes one : it returns the typed value, or `undefined` after
 * pushing the reason at its path.
 */
export interface ParseContext {
  /** Path of the node being read (`risks[3]`, `macro_actions[0].entries[2]`) ; empty at the root. */
  readonly at: string;
  readonly issues: string[];
}

/** The context of a member of the current node — same issue list, longer path. */
export function child(ctx: ParseContext, key: string): ParseContext {
  return { at: ctx.at ? `${ctx.at}.${key}` : key, issues: ctx.issues };
}

/**
 * A context that collects into its own list, so a parser can tell whether
 * the node it assembles raised anything ; `commit` hands the findings to
 * the parent and answers that question.
 */
export function scoped(ctx: ParseContext): ParseContext & { commit(): boolean } {
  const own: string[] = [];
  return {
    at: ctx.at,
    issues: own,
    commit: () => {
      ctx.issues.push(...own);
      return own.length === 0;
    },
  };
}

export function notAMapping(ctx: ParseContext): undefined {
  ctx.issues.push(`${ctx.at}: expected a mapping`);
  return undefined;
}

export function unknownKeys(rec: Rec, allowed: ReadonlySet<string>, ctx: ParseContext): void {
  for (const key of Object.keys(rec)) {
    if (!allowed.has(key)) ctx.issues.push(`${child(ctx, key).at}: unknown key`);
  }
}

export function isPositiveInt(x: unknown): x is number {
  return typeof x === 'number' && Number.isInteger(x) && x > 0;
}

export function isNonEmptyStringList(x: unknown): x is string[] {
  return isList(x) && x.length > 0 && x.every((m) => typeof m === 'string' && m.length > 0);
}

export function normalizeDate(x: unknown): string | undefined {
  if (x === undefined) return undefined;
  if (x instanceof Date && !Number.isNaN(x.getTime())) return x.toISOString().slice(0, 10);
  if (typeof x === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(x)) return x;
  return undefined;
}

export function requireString(rec: Rec, key: string, ctx: ParseContext): string | undefined {
  const v = rec[key];
  if (typeof v !== 'string' || v.trim().length === 0) {
    ctx.issues.push(`${ctx.at}.${key}: expected a non-empty string`);
    return undefined;
  }
  return v;
}
