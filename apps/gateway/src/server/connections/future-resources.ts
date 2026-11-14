/**
 * Future resources (spec §3.1 "Resource selection"; ADR
 * resource-set-is-one-environment-with-optional-future-resources): after any write that
 * may add resources to a connection or change their effective environment — a
 * discovery (connect, refresh, after a creating call, hourly, "check now"), a resource
 * a call created, an owner's relabel, a change of the connection's default — the
 * running missions with a set on that connection are brought in line:
 *
 *   diff     the connection's rows before and after the write: new ids are
 *            `discovered`, ids whose effective environment moved are `relabelled`;
 *   apply    `MissionsRepo.applyResourceChanges`, one transaction: a relabelled
 *            resource leaves the set of another environment, and a resource joins the
 *            set with future on in its environment unless the mission holds it, it is
 *            hidden, or it is one of the instance's own;
 *   audit    one `mission-resource-joined` / `mission-resource-left` entry per mission,
 *            set, change and reason, with the refs.
 *
 * Never throws: a failure is logged (connection, error class) and the write that caused
 * it stands. Nothing here reads a provider.
 */
import type { AuditWriter } from '@vaubaan/gateway-core';

import { isSelfResource, type SelfResource } from '../config';
import type { Logger } from '../logging';
import type { ResourceChange, ResourceMove, Store } from '../store';
import { toIso, type Clock } from '../store/clock';

/** The effective environment of each resource of a connection, by id: what a later diff reads. */
export type ResourceSnapshot = ReadonlyMap<string, string | null>;

export interface FutureResourcesDeps {
  readonly store: Pick<Store, 'connections' | 'missions'>;
  readonly audit: AuditWriter;
  readonly selfResources: readonly Pick<SelfResource, 'provider' | 'ref'>[];
  readonly logger: Logger;
  readonly clock: Clock;
}

export class FutureResources {
  constructor(private readonly deps: FutureResourcesDeps) {}

  /** The connection's resources and their effective environment now. */
  async snapshot(connectionId: string): Promise<ResourceSnapshot> {
    const rows = await this.deps.store.connections.listResources(connectionId);
    return new Map(rows.map((r) => [r.id, r.env]));
  }

  /**
   * Compares the connection with `before`, writes the joins and leaves it calls for and
   * audits them in the name of `actorId`. Returns the moves (empty on a failure).
   */
  async settle(
    connectionId: string,
    before: ResourceSnapshot,
    actorId: string,
  ): Promise<readonly ResourceMove[]> {
    try {
      const connection = await this.deps.store.connections.getById(connectionId);
      if (!connection) return [];
      const rows = await this.deps.store.connections.listResources(connectionId);
      const changes: ResourceChange[] = [];
      for (const row of rows) {
        if (!before.has(row.id)) changes.push({ resourceId: row.id, reason: 'discovered' });
        else if (before.get(row.id) !== row.env) {
          changes.push({ resourceId: row.id, reason: 'relabelled' });
        }
      }
      if (changes.length === 0) return [];
      const neverJoin = rows
        .filter((r) => isSelfResource(this.deps.selfResources, connection.provider, r.ref))
        .map((r) => r.id);
      const moves = await this.deps.store.missions.applyResourceChanges(
        connectionId,
        changes,
        neverJoin,
      );
      await this.audit(moves, actorId);
      if (moves.length > 0) {
        this.deps.logger.info('future resources settled on missions', {
          connection_id: connectionId,
          joined: moves.filter((m) => m.change === 'joined').length,
          left: moves.filter((m) => m.change === 'left').length,
        });
      }
      return moves;
    } catch (error) {
      this.deps.logger.warn('future resources not settled', {
        connection_id: connectionId,
        error_class: error instanceof Error ? error.name : typeof error,
      });
      return [];
    }
  }

  /** One entry per mission, set, change and reason, in the order the moves were written. */
  private async audit(moves: readonly ResourceMove[], actorId: string): Promise<void> {
    const groups = new Map<string, ResourceMove[]>();
    for (const move of moves) {
      const key = [move.missionId, move.resourceSetId, move.change, move.reason].join('\n');
      groups.set(key, [...(groups.get(key) ?? []), move]);
    }
    const ts = toIso(this.deps.clock.now());
    for (const group of groups.values()) {
      const [first] = group;
      if (!first) continue;
      await this.deps.audit.write({
        kind: 'admin',
        ts,
        user_id: actorId,
        act: first.change === 'joined' ? 'mission-resource-joined' : 'mission-resource-left',
        object: { type: 'mission', id: first.missionId },
        before: null,
        after: {
          connection_id: first.connectionId,
          resource_set_id: first.resourceSetId,
          refs: group.map((m) => m.ref),
          reason: first.reason,
        },
      });
    }
  }
}
