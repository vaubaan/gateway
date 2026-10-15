/**
 * Resource stage — which connection and which resource a call targets, and the
 * `resource-not-in-mission` refusal (spec §3.1 "Resource selection": "a call
 * whose arguments cite a resource outside the mission's selection is refused
 * with `resource-not-in-mission`, before any risk is evaluated").
 *
 * The connection: a tool belongs to one plugin (`registry.providerForTool`)
 * and a mission holds at most one connection per provider (handbook missions,
 * "One connection per provider"), so `(mission, provider)` names it.
 *
 * The resource: the host does not know which argument of which tool carries a
 * ref — the plugin's classifier does, and it writes the ref into the slices it
 * emits (`repo[acme/app]`, `project[prj_x]`). So the stage reads the cited
 * refs off the slices, the same convention `resourceEnvResolver` uses for
 * environments, and never guesses from argument names:
 *
 *   1. classify with the resources the mission may touch on the connection
 *      (the selection, minus stale resources). Slices → the cited refs must
 *      all be allowed; the first allowed one is the target resource.
 *   2. when the classifier refuses with that narrow view, classify again with
 *      every resource the connection knows. If the call now resolves to a ref
 *      the mission does not hold — a resource never selected, added after
 *      issuance, or selected but stale since — it is `resource-not-in-mission`
 *      naming that ref.
 *   3. otherwise the stage passes with no resource: the risk stage classifies
 *      again and reports the classifier's own reason (missing argument,
 *      retired tool, a ref the connection has never seen).
 *
 * Limit, by construction: a ref the connection has never discovered cannot be
 * told apart from a malformed argument, so it gets the classifier's reason
 * (step 3), not the typed refusal. Either way nothing is evaluated or executed.
 */
import {
  refuse,
  type CallRequest,
  type MissionConnection,
  type MissionContext,
  type MissionResource,
  type ResourceResolution,
  type ResourceStage,
} from '@vaubaan/gateway-core';
import {
  unavailableToolReason,
  type ClassifyOutcome,
  type PluginRegistry,
  type ProviderPlugin,
} from '@vaubaan/plugin-sdk';
import type { Slice } from '@vaubaan/shared';

import type { ConnectionsRepo } from '../store';
import { missionResourceOf } from './mission-context';

export interface ResourceStageDeps {
  readonly registry: PluginRegistry;
  readonly connections: Pick<ConnectionsRepo, 'listResources'>;
}

/** The refs of `known` that appear as identifiers in the slices, in slice order. */
export function citedRefs(slices: readonly Slice[], known: ReadonlySet<string>): string[] {
  const cited: string[] = [];
  const add = (value: string): void => {
    if (known.has(value) && !cited.includes(value)) cited.push(value);
  };
  for (const slice of slices) {
    for (const segment of slice.path) {
      if (segment.kind === 'ident') add(segment.value);
      else if (segment.kind === 'list') segment.values.forEach(add);
    }
  }
  return cited;
}

function classifySafely(
  plugin: ProviderPlugin,
  call: CallRequest,
  resources: readonly MissionResource[],
): ClassifyOutcome {
  try {
    return plugin.classify(call.tool, call.args, resources);
  } catch (err) {
    // A classifier is pure and total by contract; one that throws is refused, not trusted.
    return { denied: `the classifier failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * Why this connection cannot run the tool, or `null`: the plugin's
 * `unavailableTools` for the way the connection was made (ADR
 * token-connections-beside-the-integration-app). The sentence names the tool
 * and the account, then the plugin's reason ("needs the GitHub App: …").
 */
export function toolUnavailableOn(
  plugin: ProviderPlugin,
  connection: Pick<MissionConnection, 'display_name' | 'credential_kind' | 'hosts_instance'>,
  tool: string,
): string | null {
  const reason = unavailableReason(plugin, connection, tool);
  return reason === null
    ? null
    : `tool '${tool}' is not available on the ${plugin.displayName} account '${connection.display_name}': ${reason}`;
}

/**
 * Why the tool cannot run on this connection, or `null`: the way the connection
 * was made (`unavailableTools`), or a connection that reaches a resource hosting
 * this gateway and a tool that cannot be bound to one resource (`unboundTools`,
 * SEC 2026-10-15 re-check M-1). One rule for the resource stage and `tools/list`.
 */
export function unavailableReason(
  plugin: ProviderPlugin,
  connection: Pick<MissionConnection, 'credential_kind' | 'hosts_instance'> | undefined,
  tool: string,
): string | null {
  const kind = connection?.credential_kind ?? plugin.credential.kind;
  const byWay = unavailableToolReason(plugin, kind, tool);
  if (byWay !== null) return byWay;
  const unbound = plugin.unboundTools?.[tool];
  if (connection?.hosts_instance === true && unbound !== undefined) {
    return `this account can reach the resource that hosts this gateway. ${unbound}`;
  }
  return null;
}

/**
 * A tool belongs to one door (spec §4.1 ter): the two tools of a plugin's git
 * remote are decided only for calls that came through `/git/`, whose
 * arguments the host built from the push itself; every other tool only for
 * calls that came over MCP. The reason of the mismatch, or `null`.
 */
export function doorMismatch(plugin: ProviderPlugin, call: CallRequest): string | null {
  const remote = plugin.gitRemote;
  const isGitTool =
    remote !== undefined && (call.tool === remote.fetchTool || call.tool === remote.pushTool);
  const channel = call.channel ?? 'mcp';
  if (isGitTool && channel !== 'git') {
    return `tool '${call.tool}' is how the gateway records git itself; it cannot be called over MCP. Use git with the mission's remote (the catalog gives its URL).`;
  }
  if (!isGitTool && channel === 'git') {
    return `tool '${call.tool}' cannot be reached through the git remote.`;
  }
  return null;
}

export function createResourceStage(deps: ResourceStageDeps): ResourceStage {
  function notInMission(
    citedRef: string,
    connection: MissionConnection,
    allowed: readonly MissionResource[],
  ): ResourceResolution {
    return {
      ok: false,
      refusal: refuse.resourceNotInMission({
        cited_ref: citedRef,
        connection: { id: connection.id, name: connection.display_name },
        allowed_resources: allowed.map((r) => ({
          ref: r.ref,
          env: r.env ?? null,
          display_name: r.displayName,
        })),
      }),
    };
  }

  return {
    async resolve(ctx: MissionContext, call: CallRequest): Promise<ResourceResolution> {
      const registered = deps.registry.providerForTool(call.tool);
      if (!registered) {
        return {
          ok: false,
          reason: `unknown tool '${call.tool}': no provider of this instance declares it.`,
        };
      }
      const { plugin } = registered;
      const wrongDoor = doorMismatch(plugin, call);
      if (wrongDoor) return { ok: false, reason: wrongDoor };
      const connection = ctx.connections.find((c) => c.provider === plugin.id);
      if (!connection) {
        return {
          ok: false,
          reason: `tool '${call.tool}' belongs to ${plugin.displayName}, and this mission holds no ${plugin.displayName} connection.`,
        };
      }

      // A tool the connection's way of connecting cannot run (a token where the
      // tool needs the company's app) is refused here, before any budget is touched.
      const unavailable = toolUnavailableOn(plugin, connection, call.tool);
      if (unavailable) return { ok: false, reason: unavailable };

      const allowed = ctx.resources.filter((r) => r.connection_id === connection.id);
      const allowedRefs = new Set(allowed.map((r) => r.ref));
      const known = (await deps.connections.listResources(connection.id)).map((record) =>
        missionResourceOf(connection, record),
      );
      const knownRefs = new Set(known.map((r) => r.ref));

      const narrow = classifySafely(plugin, call, allowed);
      if ('slices' in narrow) {
        const cited = citedRefs(narrow.slices, knownRefs);
        const foreign = cited.find((ref) => !allowedRefs.has(ref));
        if (foreign !== undefined) return notInMission(foreign, connection, allowed);
        const resource =
          allowed.find((r) => cited.includes(r.ref)) ?? (allowed.length === 1 ? allowed[0] : null);
        return { ok: true, target: { connection, resource: resource ?? null } };
      }

      if (known.some((r) => !allowedRefs.has(r.ref))) {
        const wide = classifySafely(plugin, call, known);
        if ('slices' in wide) {
          const foreign = citedRefs(wide.slices, knownRefs).find((ref) => !allowedRefs.has(ref));
          if (foreign !== undefined) return notInMission(foreign, connection, allowed);
        }
      }
      return { ok: true, target: { connection, resource: null } };
    },
  };
}
