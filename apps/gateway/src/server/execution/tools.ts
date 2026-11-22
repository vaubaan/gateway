/**
 * Tool discovery and the catalog document (spec §4.1 "Discovery", "Catalog").
 *
 * `tools/list` shows the tools a mission can potentially call: every tool of
 * a plugin for which the mission holds an account AND accepts at
 * least one risk. The filter is per service, not per tool: a plugin does not
 * declare which risks a tool can touch (that depends on the arguments —
 * the branch, the path, the environment), so a finer static filter would
 * either hide callable tools or need a contract the plugins do not have. A
 * listed tool can therefore still be refused `risk-not-accepted` at call time.
 * Every registered plugin lists its tools (docs/handbook/plugin-sdk.md). An
 * account whose part of the mission is lost (`MissionAccount.lost`) lists
 * nothing either: every call through it is refused `account-revoked`.
 *
 * `GET /mcp/catalog` is the agent's source of discovery for upstream refs: the
 * whole tool surface of the instance with a `callable` flag, the accounts
 * and resources the mission may touch with their environment labels, what
 * is left of the budget per accepted risk in the current period, and whose
 * token the caller is using (`token`): an agent can then say "I am using
 * Xavier's token on mission X" (spec §0 "Mission token": the holder is
 * authenticated).
 */
import { tokenHolderLabel, type AccountLoss, type MissionContext } from '@vaubaan/gateway-core';
import type { PluginRegistry } from '@vaubaan/plugin-sdk';

import { unavailableReason } from './resource-stage';
import type {
  AccountStatus,
  Gate,
  McpToolDeclaration,
  MissionTokenKind,
  RiskId,
} from '@vaubaan/shared';
import { lineKeyOf } from '@vaubaan/shared/domain';
import { parseRiskId } from '@vaubaan/shared/risk-id';

import type { CurrentPeriod, MissionState } from '../budget';
import { gitRemoteUrl } from '../git/paths';

/**
 * Services for which the mission holds an account that still serves it (not lost:
 * revoked, or the creator's access withdrawn) and accepts at least one risk.
 */
export function callableServices(ctx: MissionContext): Set<string> {
  const accepted = new Set<string>();
  for (const entry of ctx.policy) {
    const parsed = parseRiskId(entry.risk_id);
    if (parsed) accepted.add(parsed.service);
  }
  return new Set(
    ctx.accounts
      .filter((c) => !c.lost)
      .map((c) => c.service)
      .filter((p) => accepted.has(p)),
  );
}

/** What `tools/list` returns for the mission. */
export function callableTools(ctx: MissionContext, registry: PluginRegistry): McpToolDeclaration[] {
  const services = callableServices(ctx);
  const tools: McpToolDeclaration[] = [];
  for (const { plugin } of registry.all()) {
    if (!services.has(plugin.id)) continue;
    // Listed once per service, whatever the number of its accounts (spec §4.1):
    // a tool is listed when one account of the service that still serves the
    // mission can run it (the resource stage refuses it on the others).
    const accounts = ctx.accounts.filter((c) => c.service === plugin.id && !c.lost);
    tools.push(
      ...plugin.tools.filter((t) =>
        accounts.some((account) => unavailableReason(plugin, account, t.name) === null),
      ),
    );
  }
  return tools;
}

export interface CatalogTool {
  readonly name: string;
  readonly service: string;
  readonly description: string;
  /** True when `tools/list` shows it to this mission. */
  readonly callable: boolean;
}

export interface CatalogResource {
  readonly ref: string;
  readonly env: string | null;
  readonly display_name: string;
  /**
   * The repository's remote on this instance (spec §4.1 ter), for a resource
   * of the service whose git remote the instance is: `git clone` it with the
   * mission key as the password. Absent otherwise.
   */
  readonly git_remote?: string;
  /**
   * "resource set 2": the set of the account the resource is in, when the mission
   * gives the account several (risk model §4.7). Absent with one set.
   */
  readonly resource_set?: string;
}

/**
 * Where the instance's git remotes live: under `<public_url>/git/<service>/`
 * for every service whose plugin declares one.
 */
export interface GitRemoteView {
  readonly publicUrl: URL;
}

export interface CatalogAccount {
  readonly id: string;
  readonly service: string;
  readonly name: string;
  readonly status: AccountStatus;
  /**
   * Set when the account no longer serves this mission: `account-revoked` (for
   * good) or `access-withdrawn` (the creator's access; it may come back). Its tools
   * are not callable. Absent: it serves.
   */
  readonly lost?: AccountLoss;
  readonly resources: readonly CatalogResource[];
}

export interface CatalogBudgetLine {
  readonly risk_id: RiskId;
  /** The set of the line, when its account has several (as `CatalogResource`). */
  readonly resource_set?: string;
  readonly quota: number;
  readonly consumed: number;
  readonly remaining: number;
  readonly rate_limit: { readonly max: number; readonly window_seconds: number };
  readonly gate: Gate;
}

/** Whose token authenticated the request. */
export interface CatalogToken {
  /** `member`: a person who generated it for themselves; `named`: a machine the creator named. */
  readonly kind: MissionTokenKind;
  /** The member's email, or the token's name. */
  readonly holder: string;
  /** Public prefix of the token, as the session and the audit show it. */
  readonly prefix: string;
}

export interface MissionCatalog {
  readonly mission: {
    readonly id: string;
    readonly name: string;
    /** Email of the mission's creator: the one who answers its requests. `null` if unknown. */
    readonly creator: string | null;
    /** `active`, or why calls are refused. */
    readonly state: MissionState['kind'];
    readonly expires_at: string | null;
    /** Current period; `end` is when the budget reloads, `null` for a one-off mission. */
    readonly period: { readonly start: string; readonly end: string | null } | null;
  };
  /** The token this request presented, and who it belongs to. */
  readonly token: CatalogToken;
  readonly tools: readonly CatalogTool[];
  readonly callable_tools: readonly string[];
  readonly accounts: readonly CatalogAccount[];
  readonly budget: readonly CatalogBudgetLine[];
}

export function buildCatalog(
  ctx: MissionContext,
  registry: PluginRegistry,
  state: MissionState,
  people: { readonly creator: string | null } = { creator: null },
  gitRemote: GitRemoteView | null = null,
): MissionCatalog {
  const callable = new Set(callableTools(ctx, registry).map((t) => t.name));
  const tools: CatalogTool[] = [];
  for (const { plugin } of registry.all()) {
    for (const tool of plugin.tools) {
      tools.push({
        name: tool.name,
        service: plugin.id,
        description: tool.description,
        callable: callable.has(tool.name),
      });
    }
  }

  const period: CurrentPeriod | null = state.kind === 'active' ? state.period : null;
  const remaining = state.kind === 'active' ? state.remaining : null;
  return {
    mission: {
      id: ctx.mission.id,
      name: ctx.mission.name,
      creator: people.creator,
      state: state.kind,
      expires_at: ctx.mission.expires_at,
      period: period ? { start: period.start, end: period.end } : null,
    },
    token: {
      kind: ctx.token.holder.kind,
      holder: tokenHolderLabel(ctx.token.holder),
      prefix: ctx.token.prefix,
    },
    tools,
    callable_tools: [...callable],
    accounts: ctx.accounts.map((account) => ({
      id: account.id,
      service: account.service,
      name: account.display_name,
      status: account.status,
      ...(account.lost ? { lost: account.lost } : {}),
      resources: ctx.resources
        .filter((r) => r.account_id === account.id)
        .map((r) => ({
          ref: r.ref,
          env: r.env ?? null,
          display_name: r.displayName,
          ...(gitRemote && registry.gitRemoteOf(account.service)
            ? { git_remote: gitRemoteUrl(gitRemote.publicUrl, account.service, r.ref) }
            : {}),
          ...setLabelOfResource(ctx, r.id),
        })),
    })),
    budget: ctx.policy.map((entry) => {
      // An inactive mission has nothing left to spend.
      const left = remaining ? (remaining[lineKeyOf(entry)] ?? entry.quota) : 0;
      return {
        risk_id: entry.risk_id,
        ...setLabelOf(ctx, entry.resource_set_id),
        quota: entry.quota,
        consumed: Math.max(0, entry.quota - left),
        remaining: left,
        rate_limit: entry.rate_limit,
        gate: entry.gate,
      };
    }),
  };
}

/** `{ resource_set: "resource set 2" }` when the set's account has several sets. */
export function setLabelOf(
  ctx: Pick<MissionContext, 'resource_sets'>,
  resourceSetId: string | undefined,
): { readonly resource_set?: string } {
  const set = ctx.resource_sets.find((s) => s.id === resourceSetId);
  if (!set) return {};
  const several = ctx.resource_sets.filter((s) => s.account_id === set.account_id).length > 1;
  return several ? { resource_set: `resource set ${set.position}` } : {};
}

function setLabelOfResource(
  ctx: Pick<MissionContext, 'resource_sets'>,
  resourceId: string,
): { readonly resource_set?: string } {
  const set = ctx.resource_sets.find((s) => s.resource_ids.includes(resourceId));
  return setLabelOf(ctx, set?.id);
}
