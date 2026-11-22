/**
 * Resource stage — which account and which resource a call targets, and the
 * `resource-not-in-mission` refusal (spec §3.1 "Resource selection": "a call
 * whose arguments cite a resource outside the mission's selection is refused
 * with `resource-not-in-mission`, before any risk is evaluated").
 *
 * The account: a tool belongs to one plugin (`registry.serviceForTool`). With
 * one account of that service in the mission, `(mission, service)` names it.
 * With several (spec §3.1, risk model §4.7 "The account of a call"), each is
 * tried as below, and the call runs with the one whose resources it names; a
 * call naming none, or resources of two accounts, is `account-ambiguous`: the
 * gateway never picks an account for the agent. The agent may name it
 * (`ACCOUNT_ARGUMENT`, taken out of the arguments by the door): a list, a
 * search or a creation names no resource and needs it; a call that names a
 * resource of another account than the one named is refused.
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
  ACCOUNT_ARGUMENT,
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

/** What a classifier is shown of an account: the resources the mission reaches, and all it knows. */
interface Pool {
  readonly allowed: readonly MissionResource[];
  readonly known: readonly MissionResource[];
}

/** What one account makes of a call, before an account is chosen. */
type AccountReading =
  /** The call names resources the mission reaches on this account. */
  | { readonly kind: 'named'; readonly resource: MissionResource | null }
  /** The call names a resource this account holds that the mission does not reach. */
  | { readonly kind: 'foreign'; readonly ref: string }
  /** The call names nothing of this account; `resource` is its only one, if so. */
  | { readonly kind: 'none'; readonly resource: MissionResource | null };

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
        allowed_resources: allowed.map(resourceView),
      }),
    };
  }

  /** The resources the mission may touch on an account, and every one the account knows. */
  async function poolOf(account: MissionAccount, ctx: MissionContext): Promise<Pool> {
    const known = (await deps.accounts.listResources(account.id)).map((record) =>
      missionResourceOf(account, record),
    );
    return { allowed: allowedOn(ctx, account), known };
  }

  /**
   * How the call reads against one account: the reading of steps 1 and 2 above.
   * The classifier is shown `shown` — the account's own pool, or, when the mission
   * carries several accounts of the service, theirs together: a classifier that
   * defaults to "the only resource" must then be told which one, so a call that
   * names none is never read as naming each account's. Only this account's refs
   * are read off its slices.
   */
  function read(
    plugin: ServicePlugin,
    call: CallRequest,
    account: MissionAccount,
    own: Pool,
    shown: Pool,
  ): AccountReading {
    const allowedRefs = new Set(own.allowed.map((r) => r.ref));
    const knownRefs = new Set(own.known.map((r) => r.ref));
    const only = own === shown && own.allowed.length === 1 ? (own.allowed[0] ?? null) : null;

    const narrow = classifySafely(plugin, call, shown.allowed, account);
    if ('slices' in narrow) {
      const cited = citedRefs(narrow.slices, knownRefs);
      const foreign = cited.find((ref) => !allowedRefs.has(ref));
      if (foreign !== undefined) return { kind: 'foreign', ref: foreign };
      const resource = own.allowed.find((r) => cited.includes(r.ref));
      return resource === undefined
        ? { kind: 'none', resource: only }
        : { kind: 'named', resource };
    }

    if (shown.known.some((r) => !shown.allowed.some((a) => a.ref === r.ref))) {
      const wide = classifySafely(plugin, call, shown.known, account);
      if ('slices' in wide) {
        const foreign = citedRefs(wide.slices, knownRefs).find((ref) => !allowedRefs.has(ref));
        if (foreign !== undefined) return { kind: 'foreign', ref: foreign };
      }
    }
    return { kind: 'none', resource: null };
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
      const candidates = ctx.accounts.filter((c) => c.service === plugin.id);
      const first = candidates[0];
      if (first === undefined) {
        return {
          ok: false,
          reason: `tool '${call.tool}' belongs to ${plugin.displayName}, and this mission holds no ${plugin.displayName} account.`,
        };
      }

      // A tool the account's way of connecting cannot run (a token where the
      // tool needs the company's app) is refused here, before any budget is touched.
      const within = (
        account: MissionAccount,
        resource: MissionResource | null,
      ): ResourceResolution => {
        const unavailable = toolUnavailableOn(plugin, account, call.tool);
        return unavailable
          ? { ok: false, reason: unavailable }
          : { ok: true, target: { account, resource } };
      };

      /** The call on one account, read against that account's resources alone. */
      const on = async (account: MissionAccount): Promise<ResourceResolution> => {
        const unavailable = toolUnavailableOn(plugin, account, call.tool);
        if (unavailable) return { ok: false, reason: unavailable };
        const pool = await poolOf(account, ctx);
        const reading = read(plugin, call, account, pool, pool);
        if (reading.kind === 'foreign') {
          return notInMission(reading.ref, account, allowedOn(ctx, account));
        }
        return { ok: true, target: { account, resource: reading.resource } };
      };

      // The account the agent named (`vaubaan_account`) is taken as named, once
      // sure that the call names no resource of another account of the service.
      const picked =
        call.account === undefined
          ? undefined
          : pickAccount(candidates, call.account, plugin.displayName);
      if (picked !== undefined && !picked.ok) return { ok: false, reason: picked.reason };
      const asked = picked?.ok === true ? picked.account : undefined;
      if (candidates.length === 1) return on(asked ?? first);

      const pools = await Promise.all(candidates.map((account) => poolOf(account, ctx)));
      const shown: Pool = {
        allowed: pools.flatMap((p) => p.allowed),
        known: pools.flatMap((p) => p.known),
      };
      const readings = candidates.map((account, index) => ({
        account,
        reading: read(plugin, call, account, pools[index] ?? { allowed: [], known: [] }, shown),
      }));
      if (asked !== undefined) {
        const elsewhere = readings.find(
          ({ account, reading }) => account.id !== asked.id && reading.kind !== 'none',
        );
        if (elsewhere === undefined) return on(asked);
        const ref =
          elsewhere.reading.kind === 'foreign'
            ? elsewhere.reading.ref
            : elsewhere.reading.kind === 'named'
              ? (elsewhere.reading.resource?.ref ?? '')
              : '';
        return {
          ok: false,
          reason: `the call names '${ref}', held by the ${plugin.displayName} account '${elsewhere.account.display_name}', while ${ACCOUNT_ARGUMENT} names '${asked.display_name}'. One call runs with one account: drop ${ACCOUNT_ARGUMENT}, or name the account that holds the resource.`,
        };
      }
      const named = readings.flatMap(({ account, reading }) =>
        reading.kind === 'named' ? [{ account, resource: reading.resource }] : [],
      );
      const foreign = readings.flatMap(({ account, reading }) =>
        reading.kind === 'foreign' ? [{ account, ref: reading.ref }] : [],
      );
      const [chosen] = named;
      if (chosen !== undefined && named.length === 1 && foreign.length === 0) {
        return within(chosen.account, chosen.resource);
      }
      const [outside] = foreign;
      if (outside !== undefined && named.length === 0) {
        // Every resource the mission reaches on the service, whichever account holds it.
        const allowed = candidates.flatMap((account) => allowedOn(ctx, account));
        return notInMission(outside.ref, outside.account, allowed);
      }
      // A call naming nothing goes to the only account that still serves the
      // mission, a lost one being refused by the pipeline anyway.
      const serving = readings.filter(({ account }) => account.lost === undefined);
      const [alone] = serving;
      if (alone !== undefined && named.length === 0 && serving.length === 1) {
        return within(alone.account, alone.reading.kind === 'none' ? alone.reading.resource : null);
      }
      return {
        ok: false,
        refusal: refuse.accountAmbiguous({
          service: plugin.id,
          service_label: plugin.displayName,
          names_several: named.length + foreign.length > 1,
          accounts: (serving.length > 0 ? serving.map((r) => r.account) : candidates).map(
            (account) => ({
              id: account.id,
              name: account.display_name,
              resources: allowedOn(ctx, account).map(resourceView),
            }),
          ),
        }),
      };
    },
  };
}

/**
 * The account `ACCOUNT_ARGUMENT` names among the service's: by id, else by name
 * (case aside). A name two accounts share names neither.
 */
function pickAccount(
  candidates: readonly MissionAccount[],
  named: string,
  serviceLabel: string,
): { ok: true; account: MissionAccount } | { ok: false; reason: string } {
  const byId = candidates.find((a) => a.id === named);
  if (byId !== undefined) return { ok: true, account: byId };
  const lower = named.toLowerCase();
  const byName = candidates.filter((a) => a.display_name.toLowerCase() === lower);
  const [one] = byName;
  if (one !== undefined && byName.length === 1) return { ok: true, account: one };
  const listed = candidates.map((a) => `'${a.display_name}' (${a.id})`).join(', ');
  return {
    ok: false,
    reason:
      byName.length > 1
        ? `${ACCOUNT_ARGUMENT} '${named}' names several ${serviceLabel} accounts of this mission; name one by its id: ${listed}.`
        : `${ACCOUNT_ARGUMENT} '${named}' names no ${serviceLabel} account of this mission; its ${serviceLabel} accounts: ${listed}.`,
  };
}

/** The resources the mission may touch on one account. */
function allowedOn(ctx: MissionContext, account: MissionAccount): MissionResource[] {
  return ctx.resources.filter((r) => r.account_id === account.id);
}

function resourceView(r: MissionResource): {
  ref: string;
  env: string | null;
  display_name: string | null;
} {
  return { ref: r.ref, env: r.env ?? null, display_name: r.displayName };
}
