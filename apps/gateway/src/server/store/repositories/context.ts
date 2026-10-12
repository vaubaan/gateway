/**
 * Shared plumbing for the SQLite repositories: the dependencies every repository
 * receives and the small row-mapping helpers they all use.
 */

import type { CatalogIndex } from '../catalog-index.ts';
import type { Clock } from '../clock.ts';
import { toIso } from '../clock.ts';
import type { StoreDb } from '../db.ts';
import type { Encryptor } from '../encryptor.ts';
import type { IdGenerator } from '../ids.ts';
import type { Iso, Principal, PrincipalKind } from '../types.ts';

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

export function parseJson<T>(text: string | null): T | null {
  if (text === null) return null;
  return JSON.parse(text) as T;
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
  throw new Error(`inconsistent principal columns: ${kind}/${String(userId)}/${String(groupId)}`);
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
