/**
 * Resource stage — which account and which resource a call targets, and the
 * `resource-not-in-mission` refusal (spec §3.1 "Resource selection": "a call
 * whose arguments cite a resource outside the mission's selection is refused
 * with `resource-not-in-mission`, before any risk is evaluated").
 *
 * The account: a tool belongs to one plugin (`registry.serviceForTool`)
 * and a mission holds at most one account per service (handbook missions,
 * "One account per service"), so `(mission, service)` names it.
 *
 * The resource: the host does not know which argument of which tool carries a
 * ref — the plugin's classifier does, and it writes the ref into the slices it
 * emits (`repo[acme/app]`, `project[prj_x]`). So the stage reads the cited
 * refs off the slices, the same convention `resourceEnvResolver` uses for
 * environments, and never guesses from argument names:
 *
 *   1. classify with the resources the mission may touch on the account
 *      (the selection, minus stale resources). Slices → the cited refs must
 *      all be allowed; the first allowed one is the target resource.
 *   2. when the classifier refuses with that narrow view, classify again with
 *      every resource the account knows. If the call now resolves to a ref
 *      the mission does not hold — a resource never selected, added after
 *      issuance, or selected but stale since — it is `resource-not-in-mission`
 *      naming that ref.
 *   3. otherwise the stage passes with no resource: the risk stage classifies
 *      again and reports the classifier's own reason (missing argument,
 *      retired tool, a ref the account has never seen).
 *
 * Limit, by construction: a ref the account has never discovered cannot be
 * told apart from a malformed argument, so it gets the classifier's reason
 * (step 3), not the typed refusal. Either way nothing is evaluated or executed.
 */
import {
  refuse,
  type CallRequest,
  type MissionAccount,
  type MissionContext,
  type MissionResource,
  type ResourceResolution,
  type ResourceStage,
} from '@vaubaan/gateway-core';
import {
  type ClassifyAccount,
  type ClassifyOutcome,
  type PluginRegistry,
  type ServicePlugin,
} from '@vaubaan/plugin-sdk';
import type { Slice } from '@vaubaan/shared';

import { isRetiredWay, retiredWayReason } from '../accounts/mapping';
import type { AccountsRepo } from '../store';
import { missionResourceOf } from './mission-context';

export interface ResourceStageDeps {
  readonly registry: PluginRegistry;
  readonly accounts: Pick<AccountsRepo, 'listResources'>;
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

/** What the classifier is shown of an account: its public form fields, nothing else. */
export function classifyAccountOf(account: Pick<MissionAccount, 'public_fields'>): ClassifyAccount {
  return { fields: account.public_fields ?? {} };
}

function classifySafely(
  plugin: ServicePlugin,
  call: CallRequest,
  resources: readonly MissionResource[],
  account: MissionAccount,
): ClassifyOutcome {
  try {
    return plugin.classify(call.tool, call.args, resources, classifyAccountOf(account));
  } catch (err) {
    // A classifier is pure and total by contract; one that throws is refused, not trusted.
    return { denied: `the classifier failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * Why this account cannot run the tool, or `null`: the plugin's
 * `unavailableTools` for the way the account was made (ADR
 * one-place-to-authorize-services-token-first). The sentence names the tool
 * and the account, then the plugin's reason ("needs the GitHub App: …").
 */
export function toolUnavailableOn(
  plugin: ServicePlugin,
  account: Pick<MissionAccount, 'display_name' | 'credential_kind' | 'hosts_instance'>,
  tool: string,
): string | null {
  const reason = unavailableReason(plugin, account, tool);
  return reason === null
    ? null
    : `tool '${tool}' is not available on the ${plugin.displayName} account '${account.display_name}': ${reason}`;
}

/**
 * Why the tool cannot run on this account, or `null`: the way the account
 * was made (`unavailableTools`), or an account that reaches a resource hosting
 * this gateway and a tool that cannot be bound to one resource (`unboundTools`,
 * SEC 2026-10-15 re-check M-1). One rule for the resource stage and `tools/list`.
 */
export function unavailableReason(
  plugin: ServicePlugin,
  account: Pick<MissionAccount, 'credential_kind' | 'hosts_instance'> | undefined,
  tool: string,
): string | null {
  const kind = account?.credential_kind ?? plugin.credential.kind;
  // An account connected a way the plugin no longer declares (the GitHub App
  // of catalog v8, an OAuth app of Supabase or Railway) runs nothing until it
  // is reconnected the way the service now offers.
  if (isRetiredWay(kind, plugin.credential.kind)) return retiredWayReason(plugin.displayName, kind);
  const unbound = plugin.unboundTools?.[tool];
  if (account?.hosts_instance === true && unbound !== undefined) {
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
export function doorMismatch(plugin: ServicePlugin, call: CallRequest): string | null {
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
    account: MissionAccount,
    allowed: readonly MissionResource[],
  ): ResourceResolution {
    return {
      ok: false,
      refusal: refuse.resourceNotInMission({
        cited_ref: citedRef,
        account: { id: account.id, name: account.display_name },
        ...(account.takes_future_resources === true ? { takes_future_resources: true } : {}),
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
      const registered = deps.registry.serviceForTool(call.tool);
      if (!registered) {
        return {
          ok: false,
          reason: `unknown tool '${call.tool}': no service of this instance declares it.`,
        };
      }
      const { plugin } = registered;
      const wrongDoor = doorMismatch(plugin, call);
      if (wrongDoor) return { ok: false, reason: wrongDoor };
      const account = ctx.accounts.find((c) => c.service === plugin.id);
      if (!account) {
        return {
          ok: false,
          reason: `tool '${call.tool}' belongs to ${plugin.displayName}, and this mission holds no ${plugin.displayName} account.`,
        };
      }

      // A tool the account's way of connecting cannot run (a token where the
      // tool needs the company's app) is refused here, before any budget is touched.
      const unavailable = toolUnavailableOn(plugin, account, call.tool);
      if (unavailable) return { ok: false, reason: unavailable };

      const allowed = ctx.resources.filter((r) => r.account_id === account.id);
      const allowedRefs = new Set(allowed.map((r) => r.ref));
      const known = (await deps.accounts.listResources(account.id)).map((record) =>
        missionResourceOf(account, record),
      );
      const knownRefs = new Set(known.map((r) => r.ref));

      const narrow = classifySafely(plugin, call, allowed, account);
      if ('slices' in narrow) {
        const cited = citedRefs(narrow.slices, knownRefs);
        const foreign = cited.find((ref) => !allowedRefs.has(ref));
        if (foreign !== undefined) return notInMission(foreign, account, allowed);
        const resource =
          allowed.find((r) => cited.includes(r.ref)) ?? (allowed.length === 1 ? allowed[0] : null);
        return { ok: true, target: { account, resource: resource ?? null } };
      }

      if (known.some((r) => !allowedRefs.has(r.ref))) {
        const wide = classifySafely(plugin, call, known, account);
        if ('slices' in wide) {
          const foreign = citedRefs(wide.slices, knownRefs).find((ref) => !allowedRefs.has(ref));
          if (foreign !== undefined) return notInMission(foreign, account, allowed);
        }
      }
      return { ok: true, target: { account, resource: null } };
    },
  };
}
