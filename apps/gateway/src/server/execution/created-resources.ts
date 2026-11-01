/**
 * What a mission creates, it reaches (ADR created-resources-join-the-mission).
 *
 * The execution door hands every allowed call it answered to its after-call step,
 * before the answer leaves. For a call that succeeded (not an `isError` result) of
 * a tool its plugin lists in `resourceCreatingTools`, this step, on the request
 * path:
 *
 *   read      the plugin reads the resource(s) the call created from its answer
 *             (`createdResources`, pure); a resource of another provider, without
 *             a ref, or one of the instance's own (`isSelfResource`) is left out
 *   record    `ConnectionsRepo.upsertDiscoveredResources`: the row is inserted (it
 *             reads the connection's default environment) or its stale flag cleared,
 *             owner edits kept, no other row touched
 *   join      `MissionsRepo.addResources(…, 'created')`: added to the selection of
 *             the resource set the call was judged against (the first set of the
 *             connection when it was judged against several, risk model §4.7) when
 *             that set's scope is an explicit list; a no-op under scope
 *             `connection`, which reaches the row already
 *   audit     one `mission-resources-added` entry, cause `created-by-the-mission`,
 *             with the mission, the connection, the tool and the refs; the actor is
 *             the human behind the call's key
 *
 * It returns the refs it recorded, for the discovery after the call (which looks
 * again while the provider does not list them). A failure is logged — connection,
 * tool, mission, never the arguments — and never changes the call's outcome: the
 * step returns `[]` and the discovery after the call runs as before.
 */
import type { AuditWriter, MissionContext } from '@vaubaan/gateway-core';
import type { McpToolResult, PluginRegistry } from '@vaubaan/plugin-sdk';

import { isSelfResource, type SelfResource } from '../config';
import { callerUserId, type AnsweredCall } from '../connections/discovery-after-call';
import { usableResourcesOf } from '../connections/input';
import type { Logger } from '../logging';
import type { Store } from '../store';
import { toIso, type Clock } from '../store/clock';

/** `after.cause` of a `mission-resources-added` entry written by this step. */
export const CREATED_BY_THE_MISSION = 'created-by-the-mission';

export interface CreatedResourcesDeps {
  readonly registry: Pick<PluginRegistry, 'providerForTool'>;
  readonly store: Pick<Store, 'connections' | 'missions'>;
  readonly audit: AuditWriter;
  readonly selfResources: readonly Pick<SelfResource, 'provider' | 'ref'>[];
  readonly logger: Logger;
  readonly clock: Clock;
}

export class CreatedResources {
  constructor(private readonly deps: CreatedResourcesDeps) {}

  /**
   * Records what an answered call created and adds it to the mission. Returns the
   * refs recorded on the connection (`[]` when the call created nothing the plugin
   * could read, or on a failure). Never throws.
   */
  async record(ctx: MissionContext, call: AnsweredCall): Promise<readonly string[]> {
    const { connectionId } = call;
    if (connectionId === null || !isToolResult(call.result) || call.result.isError === true) {
      return [];
    }
    const registered = this.deps.registry.providerForTool(call.tool);
    const plugin = registered?.plugin;
    if (!plugin?.resourceCreatingTools?.includes(call.tool) || !plugin.createdResources) return [];
    const connection = ctx.connections.find((c) => c.id === connectionId);
    if (!connection || connection.provider !== plugin.id) return [];
    const context = { connection_id: connectionId, tool: call.tool, mission_id: ctx.mission.id };
    try {
      const { usable, unusable } = usableResourcesOf(
        plugin.id,
        plugin.createdResources(call.tool, call.args ?? {}, call.result),
      );
      const created = usable.filter(
        (r) => !isSelfResource(this.deps.selfResources, plugin.id, r.ref),
      );
      if (unusable > 0 || created.length < usable.length) {
        this.deps.logger.warn('created resources left out', {
          ...context,
          unusable,
          self: usable.length - created.length,
        });
      }
      if (created.length === 0) return [];
      const rows = await this.deps.store.connections.upsertDiscoveredResources(
        connectionId,
        created,
      );
      // The set the creating call was judged against; with several candidate sets, the
      // first set of the connection (risk model §4.7), which the store also falls back on.
      const judged = call.resourceSetIds ?? [];
      const joined = await this.deps.store.missions.addResources(
        ctx.mission.id,
        connectionId,
        rows.map((r) => r.id),
        'created',
        { tool: call.tool, actorUserId: callerUserId(ctx) },
        judged.length === 1 ? judged[0] : undefined,
      );
      const refs = rows.map((r) => r.ref);
      await this.deps.audit.write({
        kind: 'admin',
        ts: toIso(this.deps.clock.now()),
        user_id: callerUserId(ctx),
        act: 'mission-resources-added',
        object: { type: 'mission', id: ctx.mission.id },
        before: null,
        after: {
          cause: CREATED_BY_THE_MISSION,
          connection_id: connectionId,
          tool: call.tool,
          refs,
          resource_set_id: joined.resourceSetId,
          resource_scope: joined.scope,
          added_to_selection: rows.filter((r) => joined.added.includes(r.id)).map((r) => r.ref),
        },
        delegated_client_id: null,
      });
      this.deps.logger.info('created resources reached by the mission', {
        ...context,
        refs: refs.length,
        added_to_selection: joined.added.length,
      });
      return refs;
    } catch (error) {
      this.deps.logger.warn('created resources not recorded', {
        ...context,
        error_class: error instanceof Error ? error.name : typeof error,
      });
      return [];
    }
  }
}

function isToolResult(result: unknown): result is McpToolResult {
  return (
    typeof result === 'object' &&
    result !== null &&
    Array.isArray((result as { content?: unknown }).content)
  );
}
