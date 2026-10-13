/**
 * Shared plumbing for the SQLite repositories: the dependencies every repository
 * receives and the small row-mapping helpers they all use.
 */

import type { CatalogIndex } from '../catalog-index.ts';
import type { Clock } from '../clock.ts';
import { toIso } from '../clock.ts';
import type { StoreDb } from '../db.ts';
import type { Encryptor } from '../encryptor.ts';
import { InvariantError, NotFoundError } from '../errors.ts';
import type { IdGenerator } from '../ids.ts';
import type { Iso, Principal, PrincipalKind } from '../types.ts';

/** Rows returned by a list when the caller gives no limit. */
export const DEFAULT_LIST_LIMIT = 1000;
export const MS_PER_DAY = 86_400_000;

export interface RepoContext {
  readonly db: StoreDb;
  readonly clock: Clock;
  readonly newId: IdGenerator;
  readonly encryptor: Encryptor;
  readonly catalog: CatalogIndex;
}

export function nowIso(ctx: RepoContext): Iso {
  return toIso(ctx.clock.now());
}

/** A JSON column, or `null`. The caller narrows the `unknown`. */
export function parseJson(text: string | null): unknown {
  if (text === null) return null;
  return JSON.parse(text) as unknown;
}

/** A JSON column that must hold an object (`metadata_json`, `details_json`, …). */
export function parseJsonObject(
  text: string | null,
  column: string,
): Record<string, unknown> | null {
  const value = parseJson(text);
  if (value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new InvariantError(`${column}: expected a JSON object`);
  }
  return value as Record<string, unknown>;
}

/** A column constrained to a closed set, checked against the set that defines the type. */
export function parseEnum<T extends string>(allowed: readonly T[], raw: string, column: string): T {
  if ((allowed as readonly string[]).includes(raw)) return raw as T;
  throw new InvariantError(`${column}: unexpected value '${raw}'`);
}

/** A column the schema declares NOT NULL for this row kind; `null` means a corrupt row. */
export function requireColumn<T>(value: T | null, column: string): T {
  if (value === null) throw new InvariantError(`${column}: unexpectedly null`);
  return value;
}

/** The row just written (or looked up) must exist; otherwise the store is inconsistent. */
export function requireRow<R>(row: R | undefined, entity: string, id: string): R {
  if (row === undefined) throw new NotFoundError(entity, id);
  return row;
}

export function toJson(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return JSON.stringify(value);
}

export interface PrincipalColumns {
  readonly kind: PrincipalKind;
  readonly userId: string | null;
  readonly groupId: string | null;
}

export function principalColumns(principal: Principal): PrincipalColumns {
  return principal.kind === 'user'
    ? { kind: 'user', userId: principal.id, groupId: null }
    : { kind: 'group', userId: null, groupId: principal.id };
}

export function principalFromColumns(
  kind: string,
  userId: string | null,
  groupId: string | null,
): Principal {
  if (kind === 'user' && userId !== null) return { kind: 'user', id: userId };
  if (kind === 'group' && groupId !== null) return { kind: 'group', id: groupId };
  throw new InvariantError(
    `inconsistent principal columns: ${kind}/${String(userId)}/${String(groupId)}`,
  );
}

/** `(?, ?, …)` with one placeholder per value — SQL stays positional and portable. */
export function placeholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(', ');
}

/**
 * Splits a list of principals into the `(kind, id)` predicate used by owner and target
 * lookups. Returns an always-false predicate for an empty list.
 */
export function principalPredicate(
  principals: readonly Principal[],
  userColumn: string,
  groupColumn: string,
): { sql: string; params: string[] } {
  const userIds = principals.filter((p) => p.kind === 'user').map((p) => p.id);
  const groupIds = principals.filter((p) => p.kind === 'group').map((p) => p.id);
  const clauses: string[] = [];
  if (userIds.length) clauses.push(`${userColumn} IN (${placeholders(userIds.length)})`);
  if (groupIds.length) clauses.push(`${groupColumn} IN (${placeholders(groupIds.length)})`);
  if (!clauses.length) return { sql: '1 = 0', params: [] };
  return { sql: `(${clauses.join(' OR ')})`, params: [...userIds, ...groupIds] };
}
