/**
 * The Audit page's filters, parsed from the query string (spec §4.2 "Audit —
 * search by mission, user, account, tool, decision, period"; §7.9 "the
 * audit tells who did what": the agent label; §8 "the token used and its
 * holder": the token holder). Pure: no
 * store, no `next`. A value that cannot be read is dropped and reported in
 * `problems`; it never widens the search.
 */
import type { AuditDecision } from '@vaubaan/gateway-core';

import type { AuditCursor } from '../store';
import { MS_PER_DAY } from '@vaubaan/shared/time';

export const AUDIT_PARAMS = {
  mission: 'mission',
  user: 'user',
  account: 'account',
  tool: 'tool',
  decision: 'decision',
  agent: 'agent',
  holder: 'holder',
  kind: 'kind',
  from: 'from',
  to: 'to',
} as const;

export type AuditParam = keyof typeof AUDIT_PARAMS;

export const AUDIT_DECISIONS = ['allowed', 'refused'] as const satisfies readonly AuditDecision[];
export const AUDIT_KINDS = ['call', 'admin'] as const;
export type AuditKind = (typeof AUDIT_KINDS)[number];

export interface AuditFilters {
  readonly missionId: string | null;
  /** An email address or a user id, as typed. */
  readonly user: string | null;
  readonly accountId: string | null;
  /** Exact tool name. */
  readonly tool: string | null;
  readonly decision: AuditDecision | null;
  /** Exact agent label, as typed: what a caller declared, not an identity. */
  readonly agentLabel: string | null;
  /**
   * The holder of the token a call presented, as typed: a member's email, the
   * name of a named token, or the exact form `member:<user id>` /
   * `named:<name>` the session page links with. Authenticated, unlike the label.
   */
  readonly tokenHolder: string | null;
  readonly kind: AuditKind | null;
  /** Inclusive lower bound (ISO, UTC). */
  readonly since: string | null;
  /** Exclusive upper bound (ISO, UTC). */
  readonly until: string | null;
}

/** The filters only: where a page starts is `paging.ts`'s (`cursor`, `after`, `at`). */
export interface ParsedAuditQuery {
  readonly filters: AuditFilters;
  /** The raw values, for re-filling the form and building the pager's links. */
  readonly raw: Readonly<Partial<Record<AuditParam, string>>>;
  readonly problems: readonly string[];
}

export type RawQuery =
  URLSearchParams | Readonly<Record<string, string | readonly string[] | undefined>>;

const MAX_VALUE_LENGTH = 200;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;

function first(query: RawQuery, name: string): string | null {
  const value: unknown = query instanceof URLSearchParams ? query.get(name) : query[name];
  const text: unknown = Array.isArray(value) ? (value as readonly unknown[])[0] : value;
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function oneOf<T extends string>(allowed: readonly T[], value: string | null): T | null {
  return allowed.find((a) => a === value) ?? null;
}

/**
 * A day (`YYYY-MM-DD`, read as UTC) or a full ISO instant. `endOfDay` turns a
 * day into the instant that follows it, so "to 2026-10-13" includes that day.
 */
export function parseInstant(value: string, endOfDay: boolean): string | null {
  if (DATE_ONLY.test(value)) {
    const ms = Date.parse(`${value}T00:00:00.000Z`);
    if (Number.isNaN(ms)) return null;
    // A day the calendar does not have (2026-02-31) is rolled over by Date; refuse it.
    if (new Date(ms).toISOString().slice(0, 10) !== value) return null;
    return new Date(endOfDay ? ms + MS_PER_DAY : ms).toISOString();
  }
  if (!ISO_INSTANT.test(value)) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

/** Opaque keyset position: base64url of `<ts>|<id>`. */
export function encodeCursor(cursor: AuditCursor): string {
  return Buffer.from(`${cursor.ts}|${cursor.id}`, 'utf8').toString('base64url');
}

export function decodeCursor(text: string): AuditCursor | null {
  if (!/^[A-Za-z0-9_-]+$/.test(text) || text.length > MAX_VALUE_LENGTH) return null;
  const decoded = Buffer.from(text, 'base64url').toString('utf8');
  const separator = decoded.indexOf('|');
  if (separator <= 0) return null;
  const ts = decoded.slice(0, separator);
  const id = decoded.slice(separator + 1);
  if (id.length === 0 || Number.isNaN(Date.parse(ts)) || new Date(ts).toISOString() !== ts) {
    return null;
  }
  return { ts, id };
}

export function parseAuditQuery(query: RawQuery): ParsedAuditQuery {
  const problems: string[] = [];
  const raw: Partial<Record<AuditParam, string>> = {};
  const read = (param: AuditParam): string | null => {
    const value = first(query, AUDIT_PARAMS[param]);
    if (value === null) return null;
    if (value.length > MAX_VALUE_LENGTH) {
      problems.push(`${AUDIT_PARAMS[param]}: value too long, ignored`);
      return null;
    }
    raw[param] = value;
    return value;
  };
  const drop = (param: AuditParam, problem: string): null => {
    delete raw[param];
    problems.push(problem);
    return null;
  };

  const decisionRaw = read('decision');
  const decision =
    oneOf(AUDIT_DECISIONS, decisionRaw) ??
    (decisionRaw === null ? null : drop('decision', 'decision: expected allowed or refused'));
  const kindRaw = read('kind');
  const kind =
    oneOf(AUDIT_KINDS, kindRaw) ??
    (kindRaw === null ? null : drop('kind', 'kind: expected call or admin'));

  const fromRaw = read('from');
  let since = fromRaw === null ? null : parseInstant(fromRaw, false);
  if (fromRaw !== null && since === null) drop('from', 'from: expected a date (YYYY-MM-DD)');
  const toRaw = read('to');
  let until = toRaw === null ? null : parseInstant(toRaw, true);
  if (toRaw !== null && until === null) drop('to', 'to: expected a date (YYYY-MM-DD)');
  if (since !== null && until !== null && since >= until) {
    drop('from', 'period: "from" is after "to"; the period was ignored');
    delete raw.to;
    since = null;
    until = null;
  }

  return {
    filters: {
      missionId: read('mission'),
      user: read('user'),
      accountId: read('account'),
      tool: read('tool'),
      decision,
      agentLabel: read('agent'),
      tokenHolder: read('holder'),
      kind,
      since,
      until,
    },
    raw,
    problems,
  };
}

/** The query string of the same filters, on their first page. */
export function auditQueryString(raw: ParsedAuditQuery['raw']): string {
  const params = new URLSearchParams();
  for (const param of Object.keys(AUDIT_PARAMS) as AuditParam[]) {
    const value = raw[param];
    if (value) params.set(AUDIT_PARAMS[param], value);
  }
  return params.toString();
}
