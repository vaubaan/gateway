/**
 * The reads every act on a mission shares: the issuance context and the catalogs, who
 * owns or may read a mission, its state at this instant, the gates opened for a period,
 * the accounts and resources it reaches, and its bootstrap kit. The mission service
 * and its use-case modules (`mission-issuance.ts`, `mission-tokens.ts`,
 * `mission-closing.ts`, `mission-policy-changes.ts`, `mission-reads.ts`,
 * `mission-trust-raises.ts`, `mission-edits.ts`) read them here; this module imports none
 * of them.
 */
import type { Iso8601, MacroAction, PolicyLineKey } from '@vaubaan/shared';

import type { Subject, InspectedMission, LostPart } from '../authority';
import {
  budgetMissionOf,
  currentPeriod,
  GATE_EVENT_KINDS,
  isStale,
  missionUsageReader,
  openedGatesOf,
  policyEntryOf,
  statedPeriodOf,
  type CurrentPeriod,
  type MissionState,
  type MissionLogService,
} from '../budget';
import { isSelfResource } from '../config';
import { accountSummaryOf, lastDiscoveryAt } from '../accounts/mapping';
import { membershipOf, type Membership } from '../store/membership';
import { reachedResourcesBySet, takesFutureResources } from '../store/mission-reach';
import type {
  AccountRecord,
  AccountResourceRecord,
  MissionAccountRecord,
  MissionRecord,
  UserRecord,
} from '../store/types';
import {
  buildBootstrapKit,
  type BootstrapKit,
  type KitGitRemote,
  type KitPolicyLine,
} from './bootstrap-kit';
import { gitRemoteBase } from '../git/paths';
import { enumerateCatalog } from '../../lib/missions/catalog-view';
import { macroActionsOf } from '../../lib/missions/macro-actions';
import { resourceNounOf } from '../../lib/services/resource-noun';
import type { CatalogRisk, IssuanceAccount, IssuanceResource } from '../../lib/missions/model';
import type {
  MissionServiceDeps,
  LimitReachedResult,
  MissionAccess,
  MissionDetailAccount,
} from './mission-views';

/** The reached resources the mission created itself, as `created_resource_ids` (or nothing). */
function createdIdsOf(
  selection: MissionAccountRecord,
  reached: readonly Pick<AccountResourceRecord, 'id'>[],
): { readonly created_resource_ids?: readonly string[] } {
  const sources = new Map(
    selection.resourceSets.flatMap((set) => Object.entries(set.resourceSources ?? {})),
  );
  const ids = reached.filter((r) => sources.get(r.id) === 'created').map((r) => r.id);
  return ids.length > 0 ? { created_resource_ids: ids } : {};
}

function toIssuanceResource(r: AccountResourceRecord, self: boolean): IssuanceResource {
  return {
    id: r.id,
    ref: r.ref,
    display_name: r.displayName,
    env: r.env,
    hidden: r.hidden,
    stale: isStale(r),
    self,
  };
}

export class MissionLookups {
  /** Catalog rows per service. The catalogs are immutable for the life of the registry. */
  private readonly catalogRows = new Map<string, readonly CatalogRisk[]>();
  /** Macro-actions per service, "Anything else" included; immutable like the catalogs. */
  private readonly catalogActions = new Map<string, readonly MacroAction[]>();

  private readonly budget: Pick<MissionLogService, 'stateOf'>;

  constructor(private readonly deps: MissionServiceDeps) {
    this.budget = deps.budget ?? missionUsageReader(deps.store.missionLogs);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Issuance context and catalogs
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * The accounts the user may build a mission from: every non-revoked
   * account on which they hold a non-empty authority, with its resources,
   * its catalog as explicit ids and its macro-actions.
   */
  async issuanceContext(user: Subject): Promise<IssuanceAccount[]> {
    const candidates = await this.deps.authority.accountsOf(user);
    const context: IssuanceAccount[] = [];
    for (const account of candidates) {
      if (account.status === 'revoked') continue;
      const built = await this.issuanceAccount(user, account);
      if (built) context.push(built);
    }
    return context;
  }

  async issuanceAccount(user: Subject, account: AccountRecord): Promise<IssuanceAccount | null> {
    const registered = this.deps.registry.get(account.service);
    if (!registered) return null;
    const authority = await this.deps.authority.authorityOf(user, account);
    if (authority.basis === 'none' || authority.riskIds.length === 0) return null;
    const resources = await this.deps.store.accounts.listResources(account.id);
    const { plugin } = registered;
    return {
      ...accountSummaryOf(account),
      service_label: plugin.displayName,
      resource_noun: resourceNounOf(plugin),
      derives_env: typeof plugin.envOf === 'function',
      default_env: account.defaultEnv,
      basis: authority.basis,
      resources: resources.map((r) => toIssuanceResource(r, this.isSelf(account.service, r))),
      risks: this.risksOf(account.service),
      authority: authority.riskIds,
      macro_actions: this.macroActionsOf(account.service),
    };
  }

  macroActionsOf(service: string): readonly MacroAction[] {
    const cached = this.catalogActions.get(service);
    if (cached) return cached;
    const registered = this.deps.registry.get(service);
    const actions = registered ? macroActionsOf(registered.plugin.catalog) : [];
    this.catalogActions.set(service, actions);
    return actions;
  }

  risksOf(service: string): readonly CatalogRisk[] {
    const cached = this.catalogRows.get(service);
    if (cached) return cached;
    const registered = this.deps.registry.get(service);
    const rows = registered ? enumerateCatalog(registered.plugin.catalog) : [];
    this.catalogRows.set(service, rows);
    return rows;
  }

  /** True when the resource is one of this instance's own (`selfResources`). */
  isSelf(service: string, resource: Pick<AccountResourceRecord, 'ref'>): boolean {
    return isSelfResource(this.deps.selfResources, service, resource.ref);
  }

  /** The refusal of one more active mission, or `null` while one more fits. */
  async activeMissionCeiling(): Promise<LimitReachedResult | null> {
    const reached = await this.deps.ceilings?.refusal('active-missions');
    if (!reached) return null;
    this.deps.logger.warn('mission refused at the ceiling of active missions', {
      count: reached.count,
      ceiling: reached.limit,
    });
    return { ok: false, reason: 'limit-reached', message: reached.message, limit: reached };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // State and periods
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * The state to report when the store refused a token insert because the mission
   * stopped serving between the check and the write: what it reads now, `revoked`
   * if it somehow reads active again (the refusal itself is the fact).
   */
  async stateAfterRefusal(missionId: string): Promise<Exclude<MissionState['kind'], 'active'>> {
    const mission = await this.deps.store.missions.getById(missionId);
    if (!mission) return 'revoked';
    const state = await this.stateOf((await this.deps.grounds.inspect(mission)).mission);
    return state.kind === 'active' ? 'revoked' : state.kind;
  }

  /** The mission's state at this instant (the budget's single derivation). */
  stateOf(mission: MissionRecord): Promise<MissionState> {
    return this.budget.stateOf(budgetMissionOf(mission), this.deps.clock.now());
  }

  /** The period that runs at this instant, whatever the mission's state. */
  periodNow(mission: MissionRecord): CurrentPeriod {
    return currentPeriod(budgetMissionOf(mission).period, this.deps.clock.now());
  }

  /** The gates opened for `period`, read from the mission log's gate events since it started. */
  async openGatesIn(
    mission: MissionRecord,
    period: CurrentPeriod,
  ): Promise<Map<PolicyLineKey, Iso8601>> {
    const open = new Map<PolicyLineKey, Iso8601>();
    // A one-off mission has no period end: a gate is never opened "for the period" on it.
    if (period.end === null) return open;
    if (!mission.policy.some((entry) => entry.gate === 'approval')) return open;
    const missionLog = await this.deps.store.missionLogs.getByMission(mission.id);
    if (!missionLog) return open;
    const events = await this.deps.store.missionLogs.listEvents(missionLog.id, {
      kinds: GATE_EVENT_KINDS,
      since: period.start,
    });
    for (const line of openedGatesOf(events, period)) open.set(line, period.end);
    return open;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Who may read or change a mission
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Who may READ a mission, and as what: its creator, or a current member who
   * is an active user. One answer (`null`) for "does not exist", "not yours"
   * and "no longer shared with you". Every mutation of the mission itself goes
   * through `ownMission` instead, which knows the creator only.
   */
  async access(user: Subject, missionId: string): Promise<MissionAccess | null> {
    const mission = await this.deps.store.missions.getById(missionId);
    if (!mission) return null;
    const membership = await this.membershipOf(mission, user.id);
    if (membership !== 'creator' && membership !== 'member') return null;
    return { ...(await this.deps.grounds.inspect(mission)), role: membership };
  }

  /**
   * What `userId` is to the mission right now (`membershipOf`, the store's one
   * statement of the rule). The creator costs no read; anyone else costs their
   * user row (unless the caller already holds it) and their member row.
   */
  async membershipOf(
    mission: MissionRecord,
    userId: string,
    known?: UserRecord | null,
  ): Promise<Membership> {
    if (mission.creatorUserId === userId) return membershipOf(mission, userId, null, null);
    const user = known === undefined ? await this.deps.store.users.getById(userId) : known;
    const row = await this.deps.store.missions.getMember(mission.id, userId);
    return membershipOf(mission, userId, user, row);
  }

  /**
   * One answer for "does not exist" and "not yours". The mission is returned as
   * it stands now: `orphaned` when the creator's authority is missing.
   */
  async ownMission(user: Subject, missionId: string): Promise<MissionRecord | null> {
    return (await this.ownInspected(user, missionId))?.mission ?? null;
  }

  async ownInspected(user: Subject, missionId: string): Promise<InspectedMission | null> {
    const mission = await this.deps.store.missions.getById(missionId);
    if (!mission || mission.creatorUserId !== user.id) return null;
    return this.deps.grounds.inspect(mission);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // What a mission reaches, and its kit
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * The accounts of a mission with the resources it reaches — the rule of
   * `loadMissionContext`, the same function (`reachedResources`): the ids its
   * resource sets store, never the ones discovery no longer returns nor the
   * instance's own.
   */
  async detailAccounts(
    mission: MissionRecord,
    lost: readonly LostPart[] = [],
  ): Promise<MissionDetailAccount[]> {
    const details: MissionDetailAccount[] = [];
    for (const c of mission.accounts) {
      const account = await this.deps.store.accounts.getById(c.accountId);
      if (!account) continue;
      const discovered = await this.deps.store.accounts.listResources(c.accountId);
      const bySet = reachedResourcesBySet(c, discovered, (r) => this.isSelf(account.service, r));
      const reachedIds = new Set([...bySet.values()].flat().map((r) => r.id));
      const reached = discovered.filter((r) => reachedIds.has(r.id));
      details.push({
        ...accountSummaryOf(account),
        service_label:
          this.deps.registry.get(account.service)?.plugin.displayName ?? account.service,
        resource_noun: resourceNounOf(this.deps.registry.get(account.service)?.plugin ?? null),
        resources: reached.map((r) => toIssuanceResource(r, false)),
        future: takesFutureResources(c),
        last_checked_at: lastDiscoveryAt(account),
        resource_sets: c.resourceSets.map((set) => ({
          id: set.id,
          position: set.position,
          resources: (bySet.get(set.id) ?? []).map((r) => toIssuanceResource(r, false)),
          future: set.future,
          env: set.env,
          mixed_env: set.mixedEnv,
          ...(set.trustLevels ? { trust_levels: set.trustLevels } : {}),
        })),
        lost: lost.find((part) => part.accountId === c.accountId)?.cause ?? null,
        ...createdIdsOf(c, reached),
      });
    }
    return details;
  }

  catalogRowsOf(
    accounts: readonly Pick<MissionDetailAccount, 'service'>[],
  ): Map<string, CatalogRisk> {
    return new Map(
      accounts.flatMap((c) => this.risksOf(c.service).map((r) => [r.risk_id, r] as const)),
    );
  }

  /**
   * The bootstrap kit of the mission around one token: its secret (shown once,
   * to the holder who just generated it) or its masked prefix. The same kit
   * for every holder but for that token: same resources, same policy, same
   * budget (spec §0 "Mission member").
   */
  async kitOf(
    mission: MissionRecord,
    token: { secret: string } | { prefix: string },
    known?: readonly MissionDetailAccount[],
  ): Promise<BootstrapKit> {
    // An account that no longer serves the mission is not handed to its agents.
    const accounts = (
      known ?? (await this.detailAccounts(mission, (await this.deps.grounds.inspect(mission)).lost))
    ).filter((account) => account.lost === null);
    const rows = this.catalogRowsOf(accounts);
    const setLabel = new Map(
      accounts.flatMap((c) =>
        c.resource_sets.length > 1
          ? c.resource_sets.map((set) => [set.id, `resource set ${set.position}`] as const)
          : [],
      ),
    );
    const policy: KitPolicyLine[] = mission.policy.map(policyEntryOf).map((entry) => {
      const label = setLabel.get(entry.resource_set_id ?? '');
      return {
        ...entry,
        label: rows.get(entry.risk_id)?.label ?? entry.risk_id,
        ...(label ? { resource_set: label } : {}),
      };
    });
    return buildBootstrapKit({
      instanceUrl: this.deps.publicUrl.href,
      mission: {
        id: mission.id,
        name: mission.name,
        period: statedPeriodOf(mission),
        expires_at: mission.expiresAt,
      },
      accounts: accounts.map((c) => ({
        service_label: c.service_label,
        display_name: c.display_name,
        resources: c.resources.map((r) => ({ ref: r.ref, env: r.env })),
        future: c.future,
        ...(c.resource_sets.length > 1
          ? {
              resource_sets: c.resource_sets.map((set) => ({
                label: `Resource set ${set.position}`,
                resources: set.resources.map((r) => ({ ref: r.ref, env: r.env })),
                future: set.future,
              })),
            }
          : {}),
      })),
      policy,
      token,
      git: this.gitRemotesOf(accounts),
    });
  }

  /** The git remotes of the kit: per service whose plugin declares one, the mission's repositories there. */
  private gitRemotesOf(accounts: readonly MissionDetailAccount[]): readonly KitGitRemote[] {
    const services = [...new Set(accounts.map((c) => c.service))];
    return services.flatMap((serviceId) => {
      const remote = this.deps.registry.gitRemoteOf(serviceId)?.plugin.gitRemote;
      if (!remote) return [];
      const repositories = accounts
        .filter((c) => c.service === serviceId)
        .flatMap((c) => c.resources.map((r) => r.ref));
      if (repositories.length === 0) return [];
      return [
        {
          base: gitRemoteBase(this.deps.publicUrl, serviceId),
          insteadOf: remote.insteadOf ?? null,
          repositories: [...new Set(repositories)],
        },
      ];
    });
  }
}
