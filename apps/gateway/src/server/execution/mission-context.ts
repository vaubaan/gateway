/**
 * Mission context — the pipeline's read-only view of an authenticated mission
 * (`@vaubaan/gateway-core` `MissionContext`), loaded from the store on every
 * request.
 *
 * Spec §3.1 "Resource selection": a mission names, per connection, the
 * resources it may touch; a resource discovered later is not covered. The
 * store keeps explicit resource ids, so the selection is exactly the rows
 * whose id the mission stored — scope `all` with an empty list means "none
 * known at issuance" and is never hydrated from the connection's live list
 * (handbook missions, "Issuance" step 3).
 *
 * Of the selected resources, a *stale* one (the last discovery no longer
 * returned it) is left out of `resources`: the mission may not touch it any
 * more, and the resource stage refuses a call that cites it with
 * `resource-not-in-mission`. A *hidden* one stays: hiding is a listing
 * preference of the owner, not a withdrawal.
 *
 * A *self* resource (one of the instance's own hosting, `config.selfResources`,
 * SEC 2026-10-15 H1) is left out too, whatever the mission stored: a policy
 * issued before the instance knew it, or written by hand, still cannot reach
 * it. The plugin then binds no call to it, and the resource stage refuses a
 * call that cites it with `resource-not-in-mission`.
 *
 * Nothing here is cached: the reads are local (SQLite) and a revocation, an
 * expired connection or a stale resource must be seen by the next call.
 */
import type {
  AuthenticatedToken,
  ConnectionOwner,
  MissionConnection,
  MissionContext,
  MissionResource,
} from '@vaubaan/gateway-core';

import { isStale, periodOf, policyEntryOf } from '../budget';
import { isSelfResource, type SelfResource } from '../config';
import {
  connectionCredentialKind,
  connectionOwnerOf,
  connectionSummaryOf,
} from '../connections/mapping';
import type { Store } from '../store';
import type { ConnectionRecord, ConnectionResourceRecord, MissionRecord } from '../store/types';

export type MissionContextStore = Pick<Store, 'connections' | 'users' | 'groups' | 'sessions'>;

/** The shared `ConnectionResource` of a stored row — what `classify` and `execute` receive. */
export function missionResourceOf(
  connection: Pick<ConnectionRecord, 'id' | 'provider'>,
  record: ConnectionResourceRecord,
): MissionResource {
  return {
    id: record.id,
    connection_id: connection.id,
    provider: connection.provider,
    ref: record.ref,
    env: record.env,
    displayName: record.displayName,
    discovered_at: record.discoveredAt,
    ...(record.metadata ? { metadata: record.metadata } : {}),
  };
}

/** What a refusal shows so a human can be contacted: the user's email or the group's name. */
async function ownerOf(
  store: Pick<Store, 'users' | 'groups'>,
  connection: ConnectionRecord,
): Promise<ConnectionOwner> {
  const { kind, id, name } = await connectionOwnerOf(store, connection);
  return { kind, id, display: name ?? `a ${kind} that no longer exists` };
}

/** The pipeline's period of a stored mission; the mapping lives in `budget/mapping.ts`. */
export { periodOf };

export async function loadMissionContext(
  store: MissionContextStore,
  mission: MissionRecord,
  /** The verified token and its holder (`MissionService.verifyToken`): who is calling. */
  token: AuthenticatedToken,
  /** The instance's own resources: never part of a mission's context. */
  selfResources: readonly SelfResource[],
): Promise<MissionContext> {
  const connections: MissionConnection[] = [];
  const resources: MissionResource[] = [];

  for (const selection of mission.connections) {
    const connection = await store.connections.getById(selection.connectionId);
    // Connections are never deleted (revocation keeps the row); a missing one
    // simply gives the mission nothing to call.
    if (!connection) continue;
    connections.push({
      ...connectionSummaryOf(connection),
      owner: await ownerOf(store, connection),
      credential_kind: connectionCredentialKind(connection, null),
    });
    const selected = new Set(selection.resourceIds);
    if (selected.size === 0) continue;
    for (const record of await store.connections.listResources(connection.id)) {
      if (!selected.has(record.id) || isStale(record)) continue;
      if (isSelfResource(selfResources, connection.provider, record.ref)) continue;
      resources.push(missionResourceOf(connection, record));
    }
  }

  const session = await store.sessions.getByMission(mission.id);
  return {
    mission: {
      id: mission.id,
      name: mission.name,
      status: mission.status,
      creator_id: mission.creatorUserId,
      expires_at: mission.expiresAt,
      period: periodOf(mission),
    },
    token: { id: token.id, prefix: token.prefix, holder: token.holder },
    connections,
    resources,
    policy: mission.policy.map(policyEntryOf),
    session: session ? { id: session.id, started_at: session.createdAt } : null,
  };
}
