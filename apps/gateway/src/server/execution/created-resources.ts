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
 *   record    `AccountsRepo.upsertDiscoveredResources`: the row is inserted (it
 *             reads the account's default environment) or its stale flag cleared,
 *             owner edits kept, no other row touched
 *   join      `MissionsRepo.addResources(…, 'created')`: added to the list of the
 *             resource set the call was judged against (judged against several: the
 *             candidate with future on in its environment, else one in its
 *             environment, else the first of them, risk model §4.7)
 *   audit     one `mission-resources-added` entry, cause `created-by-the-mission`,
 *             with the mission, the account, the tool and the refs; the actor is
 *             the human behind the call's key
 *   future    the other running missions' sets with future on in the new resource's
 *             environment take it (`FutureResources.settle`, ADR
 *             resource-set-is-one-environment-with-optional-future-resources)
 *
 * It returns the refs it recorded, for the discovery after the call (which looks
 * again while the provider does not list them). A failure is logged — account,
 * tool, mission, never the arguments — and never changes the call's outcome: the
 * step returns `[]` and the discovery after the call runs as before.
 */
import type { AuditWriter, MissionContext } from '@vaubaan/gateway-core';
import type { McpToolResult, PluginRegistry } from '@vaubaan/plugin-sdk';

import { isSelfResource, type SelfResource } from '../config';
import { callerUserId, type AnsweredCall } from '../accounts/discovery-after-call';
import type { FutureResources } from '../accounts/future-resources';
import { usableResourcesOf } from '../accounts/input';
import type { Logger } from '../logging';
import type { Store } from '../store';
import { toIso, type Clock } from '../store/clock';

/** `after.cause` of a `mission-resources-added` entry written by this step. */
export const CREATED_BY_THE_MISSION = 'created-by-the-mission';

export interface CreatedResourcesDeps {
  readonly registry: Pick<PluginRegistry, 'providerForTool'>;
  readonly store: Pick<Store, 'accounts' | 'missions'>;
  readonly audit: AuditWriter;
  readonly selfResources: readonly Pick<SelfResource, 'provider' | 'ref'>[];
  readonly logger: Logger;
  readonly clock: Clock;
  /** The other missions' future resources; absent, only the creating mission reaches it. */
  readonly futureResources?: Pick<FutureResources, 'snapshot' | 'settle'>;
}

export class CreatedResources {
  constructor(private readonly deps: CreatedResourcesDeps) {}

  /**
   * Records what an answered call created and adds it to the mission. Returns the
   * refs recorded on the account (`[]` when the call created nothing the plugin
   * could read, or on a failure). Never throws.
   */
  async record(ctx: MissionContext, call: AnsweredCall): Promise<readonly string[]> {
    const { accountId } = call;
    if (accountId === null || !isToolResult(call.result) || call.result.isError === true) {
      return [];
    }
    const registered = this.deps.registry.providerForTool(call.tool);
    const plugin = registered?.plugin;
    if (!plugin?.resourceCreatingTools?.includes(call.tool) || !plugin.createdResources) return [];
    const account = ctx.accounts.find((c) => c.id === accountId);
    if (!account || account.provider !== plugin.id) return [];
    const context = { account_id: accountId, tool: call.tool, mission_id: ctx.mission.id };
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
      const before = await this.deps.futureResources?.snapshot(accountId);
      const rows = await this.deps.store.accounts.upsertDiscoveredResources(accountId, created);
      // The sets the creating call was judged against: the store places the resource in
      // the one set, else the candidate in its environment (future first), else the
      // first candidate (risk model §4.7).
      const joined = await this.deps.store.missions.addResources(
        ctx.mission.id,
        accountId,
        rows.map((r) => r.id),
        'created',
        { tool: call.tool, actorUserId: callerUserId(ctx) },
        call.resourceSetIds,
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
          account_id: accountId,
          tool: call.tool,
          refs,
          resource_set_ids: [...new Set(joined.placed.map((p) => p.resourceSetId))],
          added_to_selection: rows.filter((r) => joined.added.includes(r.id)).map((r) => r.ref),
        },
      });
      if (before) {
        await this.deps.futureResources?.settle(accountId, before, callerUserId(ctx));
      }
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
