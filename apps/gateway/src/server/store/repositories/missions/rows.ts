import { InvariantError } from '../../errors.ts';
import { MISSION_TOKEN_KINDS } from '@vaubaan/shared';

import {
  MISSION_RESOURCE_SOURCES,
  MISSION_TOKEN_STATUSES,
  type MissionMemberRecord,
  type MissionPolicyEntry,
  type MissionRecord,
  type MissionResourceSetRecord,
  type MissionResourceSource,
  type MissionTokenRecord,
  type RiskId,
  type TokenHolderRecord,
} from '../../types.ts';
import { parseEnum } from '../context.ts';
import { GATES } from '../enums.ts';

export interface MissionRow {
  id: string;
  name: string;
  creator_user_id: string;
  status: string;
  period_anchor: string;
  period_seconds: number | null;
  expires_at: string | null;
  issued_by_mission_id: string | null;
  issued_via_client_name: string | null;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
}

export interface IssuerRow {
  mission_id: string;
  issued_by_mission_id: string | null;
  issuer_name: string | null;
  issued_via_client_name: string | null;
}

export interface PolicyRow {
  resource_set_id: string;
  risk_id: string;
  quota: number;
  rate_limit: number;
  rate_window_seconds: number;
  gate: string;
}

export interface AccountRow {
  account_id: string;
}

export interface SetRow {
  id: string;
  account_id: string;
  position: number;
  future: number;
  env: string | null;
  mixed_env: number;
  trust_levels_json: string | null;
}

export const SET_COLUMNS = 'id, account_id, position, future, env, mixed_env, trust_levels_json';

export interface SelectedRow {
  resource_id: string;
  resource_set_id: string;
  source: string;
}

export interface TokenRow {
  id: string;
  mission_id: string;
  prefix: string;
  hash: string;
  hash_alg: string;
  status: string;
  kind: string;
  holder_user_id: string | null;
  name: string | null;
  created_by: string;
  created_at: string;
  retired_at: string | null;
  last_used_at: string | null;
}

export interface MemberRow {
  mission_id: string;
  user_id: string;
  added_by: string;
  added_at: string;
  removed_at: string | null;
}

export const MS_PER_SECOND = 1000;

export const COLUMNS = `id, name, creator_user_id, status, period_anchor, period_seconds, expires_at,
  issued_by_mission_id, issued_via_client_name, created_at, updated_at, closed_at`;
export const TOKEN_COLUMNS = `id, mission_id, prefix, hash, hash_alg, status, kind, holder_user_id, name,
  created_by, created_at, retired_at, last_used_at`;
export const MEMBER_COLUMNS = 'mission_id, user_id, added_by, added_at, removed_at';

/** The holder of a row. The schema's CHECK guarantees the pairing; a row that breaks it is corrupt. */
function holderOf(row: TokenRow): TokenHolderRecord {
  const kind = parseEnum(MISSION_TOKEN_KINDS, row.kind, 'mission_tokens.kind');
  if (kind === 'member') {
    if (row.holder_user_id === null) {
      throw new InvariantError(`mission_tokens ${row.id}: a member token without a holder`);
    }
    return { kind, userId: row.holder_user_id };
  }
  if (row.name === null) {
    throw new InvariantError(`mission_tokens ${row.id}: a named token without a name`);
  }
  return { kind, name: row.name };
}

export function tokenToRecord(row: TokenRow): MissionTokenRecord {
  const holder = holderOf(row);
  return {
    id: row.id,
    missionId: row.mission_id,
    prefix: row.prefix,
    hash: row.hash,
    hashAlg: row.hash_alg,
    status: parseEnum(MISSION_TOKEN_STATUSES, row.status, 'mission_tokens.status'),
    kind: holder.kind,
    holder,
    createdBy: row.created_by,
    createdAt: row.created_at,
    retiredAt: row.retired_at,
    lastUsedAt: row.last_used_at,
  };
}

export function memberToRecord(row: MemberRow): MissionMemberRecord {
  return {
    missionId: row.mission_id,
    userId: row.user_id,
    addedBy: row.added_by,
    addedAt: row.added_at,
    removedAt: row.removed_at,
  };
}

export function policyToRecord(row: PolicyRow): MissionPolicyEntry {
  return {
    resourceSetId: row.resource_set_id,
    riskId: row.risk_id,
    quota: row.quota,
    rateLimit: row.rate_limit,
    rateWindowSeconds: row.rate_window_seconds,
    gate: parseEnum(GATES, row.gate, 'mission_policy.gate'),
  };
}

export function setToRecord(
  row: SetRow,
  selected: readonly SelectedRow[],
): MissionResourceSetRecord {
  const sources: Record<string, MissionResourceSource> = {};
  for (const r of selected) {
    const source = parseEnum(MISSION_RESOURCE_SOURCES, r.source, 'mission_resources.source');
    if (source !== 'issuance') sources[r.resource_id] = source;
  }
  return {
    id: row.id,
    position: row.position,
    resourceIds: selected.map((r) => r.resource_id),
    future: row.future === 1,
    env: row.env,
    mixedEnv: row.mixed_env === 1,
    ...(Object.keys(sources).length > 0 ? { resourceSources: sources } : {}),
    ...(row.trust_levels_json === null
      ? {}
      : { trustLevels: trustLevelsOf(row.trust_levels_json) }),
  };
}

/** `trust_levels_json` as stored: an object of strings; anything else is corrupt. */
function trustLevelsOf(json: string): Record<string, string> {
  const parsed: unknown = JSON.parse(json);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new InvariantError('mission_resource_sets.trust_levels_json is not an object');
  }
  const trustLevels: Record<string, string> = {};
  for (const [id, trustLevel] of Object.entries(parsed)) {
    if (typeof trustLevel !== 'string') {
      throw new InvariantError(`mission_resource_sets.trust_levels_json: '${id}' is not a string`);
    }
    trustLevels[id] = trustLevel;
  }
  return trustLevels;
}

/** What `trust_levels_json` stores: NULL for no trust level, so an empty record reads back absent. */
export function trustLevelsJsonOf(c: {
  readonly trustLevels?: Readonly<Record<string, string>>;
}): string | null {
  return c.trustLevels && Object.keys(c.trustLevels).length > 0
    ? JSON.stringify(c.trustLevels)
    : null;
}

/** True for a risk id of this service: its first segment, before `.` or `[`. */
export function isRiskOfService(riskId: RiskId, service: string): boolean {
  return riskId.startsWith(`${service}.`) || riskId.startsWith(`${service}[`);
}

/** The ids of every set of a mission. */
export function setIdsOf(mission: MissionRecord): Set<string> {
  return new Set(mission.accounts.flatMap((c) => c.resourceSets.map((set) => set.id)));
}

/** The one key of a line, for maps: its set and its risk. */
export function lineKey(line: { readonly resourceSetId: string; readonly riskId: RiskId }): string {
  return `${line.resourceSetId}\n${line.riskId}`;
}

/**
 * The set a resource joins among `candidates` (by position): the one with future on in
 * the resource's environment, else one in its environment, else the first (risk model
 * §4.7). `candidates` is never empty.
 */
export function placementOf(candidates: readonly SetRow[], env: string | null): SetRow {
  const sameEnv = candidates.filter((set) => set.mixed_env === 0 && set.env === env);
  const [first] = candidates;
  const chosen = sameEnv.find((set) => set.future === 1) ?? sameEnv[0] ?? first;
  if (!chosen) throw new InvariantError('a mission account carries at least one resource set');
  return chosen;
}
