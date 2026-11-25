import { permissionEditSchema, policyKey } from './permission-edit';
/**
 * `MissionService` — preview, issue, duplicate, rotate, revoke, and the gate
 * of a risk edited after issuance (spec §3.1, §3.2, §3.5, §7.4, §7.8; pivot
 * ADR D4).
 *
 * Reads accounts and resources through the store repositories only, asks
 * the `AuthorityService` what the creator may accept, and leaves the decision
 * to the pure `previewDraft`. A mission is persisted as an explicit
 * enumeration: explicit resource ids (even for "all"), explicit policy
 * entries (never a macro-action or trust level), and the creator's own token, whose
 * secret is returned once. Members and the other tokens of a mission are the
 * `MissionTeamService`'s (`team-service.ts`); this service says who may read a
 * mission (`access`) and what a presented token is worth (`verifyToken`).
 *
 * One rule for what a mission reaches on an account, shared with the
 * execution door (`execution/mission-context.ts`): exactly the resource ids
 * stored at issuance that discovery still returns. Scope `all` with an empty
 * list means "none known at issuance", never "everything discovered later";
 * the detail page and the bootstrap kit read it the same way.
 *
 * Store records are translated by `budget/mapping.ts` and
 * `accounts/mapping.ts` only; no record is written into an audit payload.
 */
import type { TokenHolder } from '@vaubaan/gateway-core';
import {
  isGate,
  lineKeyOf,
  parseRiskId,
  policyLineKey,
  type Iso8601,
  type MacroAction,
  type MissionPolicyEntry,
  type PolicyLineKey,
  type RiskId,
  type MissionLogEventDetails,
} from '@vaubaan/shared';

import type { Subject, InspectedMission, LostPart } from '../authority';
import { isFinalLoss } from '../authority';
import {
  budgetMissionOf,
  currentPeriod,
  GATE_EVENT_KINDS,
  isStale,
  missionUsageReader,
  openedGatesOf,
  policyEntryOf,
  policyEntryRecordOf,
  policyLineInputOf,
  statedPeriodOf,
  type CurrentPeriod,
  type MissionState,
  type MissionLogService,
} from '../budget';
import { isSelfResource } from '../config';
import { accountSummaryOf, lastDiscoveryAt } from '../accounts/mapping';
import { TokenNotIssuableError } from '../store/errors';
import { isOnMission, membershipOf, type Membership } from '../store/membership';
import { reachedResourcesBySet, takesFutureResources } from '../store/mission-reach';
import { toIso } from '../store/clock';
import type {
  AccountRecord,
  AccountResourceRecord,
  MissionAccountInput,
  MissionAccountRecord,
  MissionRecord,
  MissionResourceSetInput,
  MissionResourceSetRecord,
  MissionTokenRecord,
  RequestLine,
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
import type {
  CatalogRisk,
  DraftAccount,
  DraftResourceSet,
  IssuanceAccount,
  IssuanceResource,
  MissionDraft,
  MissionIssuer,
  MissionPreview,
  PreviewIssue,
  ResolvedDraftAccount,
  ResolvedDraftSet,
  Row,
} from '../../lib/missions/model';
import { checkPolicyLines, previewDraft } from '../../lib/missions/preview';
import { type MissionHistoryView, type RestoreResult } from './history';
import { bearerMatches, mintMissionToken, prefixOfBearer, type TokenMinter } from './token';
import { reissueMemberToken } from './member-token';
import { issueTokenTo, type IssuedSecret } from './token-issuer';
import { trustRaiseOffers, type TrustRaiseOffer } from './trust-raise';

import { gateEditBlockedBy } from './gate-edit';
import { MissionEdits } from './mission-edits';
export { gateEditBlockedBy } from './gate-edit';
export type {
  MissionServiceDeps,
  PreviewOptions,
  IssueOptions,
  RevealedToken,
  IssueResult,
  LimitReachedResult,
  RotateResult,
  RevokeResult,
  OrphanedOnAccount,
  MissionOnAccount,
  SetGateResult,
  LimitEdit,
  LimitChangeView,
  SetLimitsResult,
  MissionEditView,
  EditPreviewResult,
  EditResult,
  VerifiedToken,
  TokenRetirement,
  TokenVerification,
  MissionRole,
  MissionAccess,
  MissionLostAccount,
  MissionOrphanReason,
  MissionOverview,
  MissionDetailSet,
  MissionDetailAccount,
  MissionDetailRisk,
  MissionDetail,
  MissionIssuedAudit,
} from './mission-views';
import type {
  MissionServiceDeps,
  PreviewOptions,
  IssueOptions,
  IssueResult,
  LimitReachedResult,
  RotateResult,
  RevokeResult,
  OrphanedOnAccount,
  MissionOnAccount,
  SetGateResult,
  LimitEdit,
  LimitChangeView,
  SetLimitsResult,
  MissionEditView,
  EditPreviewResult,
  EditResult,
  VerifiedToken,
  TokenVerification,
  MissionAccess,
  MissionOverview,
  MissionDetailAccount,
  MissionDetailRisk,
  MissionDetail,
  MissionIssuedAudit,
} from './mission-views';

const COPY_SUFFIX = ' (copy)';

/** The default of `trust_raise.after_approvals`. */
const DEFAULT_TRUST_RAISE_AFTER_APPROVALS = 10;

/** The issuance context with some resources read under the labels a dry run would set. */
export function withAssumedEnvs(
  accounts: IssuanceAccount[],
  assumed: ReadonlyMap<string, string> | undefined,
): IssuanceAccount[] {
  if (!assumed || assumed.size === 0) return accounts;
  return accounts.map((account) => ({
    ...account,
    resources: account.resources.map((resource) => {
      const env = assumed.get(resource.id);
      return env === undefined ? resource : { ...resource, env };
    }),
  }));
}

/** Who may close a mission, and on what ground (spec §2.3). */
type Closer =
  { readonly as: 'creator' } | { readonly as: 'account-owner'; readonly accountId: string };

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

/** What a mission stores per resource set: its explicit list, `future` and environment. */
function setInputOf(resolved: ResolvedDraftSet): MissionResourceSetInput {
  return {
    resourceIds: resolved.resources.resource_ids,
    future: resolved.future,
    env: resolved.env,
    ...(Object.keys(resolved.trust_levels).length > 0
      ? { trustLevels: resolved.trust_levels }
      : {}),
    policy: resolved.policy.map(policyLineInputOf),
  };
}

/** What a mission stores per account: its sets, each with its lines. */
function accountInputOf(resolved: ResolvedDraftAccount): MissionAccountInput {
  return {
    accountId: resolved.account_id,
    resourceSets: resolved.resource_sets.map(setInputOf),
  };
}

function issuedAuditOf(mission: MissionRecord, tokenPrefix: string): MissionIssuedAudit {
  return {
    name: mission.name,
    accounts: mission.accounts.map((c) => ({
      account_id: c.accountId,
      resource_ids: c.resourceSets.flatMap((set) => [...set.resourceIds]),
      resource_sets: c.resourceSets.map((set) => ({
        resource_set_id: set.id,
        position: set.position,
        future: set.future,
        env: set.env,
        resource_ids: [...set.resourceIds],
      })),
    })),
    policy: mission.policy.map(policyEntryOf),
    period: statedPeriodOf(mission),
    expires_at: mission.expiresAt,
    token_prefix: tokenPrefix,
  };
}

export class MissionService {
  private readonly mint: TokenMinter;
  /** Catalog rows per service. The catalogs are immutable for the life of the registry. */
  private readonly catalogRows = new Map<string, readonly CatalogRisk[]>();
  /** Macro-actions per service, "Anything else" included; immutable like the catalogs. */
  private readonly catalogActions = new Map<string, readonly MacroAction[]>();

  private readonly budget: Pick<MissionLogService, 'stateOf'>;
  /** Edits, versions and restores (`mission-edits.ts`). */
  readonly #edits: MissionEdits;

  constructor(private readonly deps: MissionServiceDeps) {
    this.mint = deps.mint ?? mintMissionToken;
    this.budget = deps.budget ?? missionUsageReader(deps.store.missionLogs);
    this.#edits = new MissionEdits(deps, this);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Edits and versions: mission-edits.ts
  // ───────────────────────────────────────────────────────────────────────────

  /** What the creator's edit form starts from; `null` when not the creator's. */
  editView(user: Subject, missionId: string): Promise<MissionEditView | null> {
    return this.#edits.editView(user, missionId);
  }

  /** What an edit would change, judged as an issuance would be, nothing written. */
  previewEdit(user: Subject, missionId: string, raw: unknown): Promise<EditPreviewResult> {
    return this.#edits.previewEdit(user, missionId, raw);
  }

  /** The creator's edit: a new version of the mission, or why it is refused. */
  edit(
    user: Subject,
    missionId: string,
    raw: unknown,
    options: IssueOptions = {},
  ): Promise<EditResult> {
    return this.#edits.edit(user, missionId, raw, options);
  }

  /** The mission's versions, newest first; `null` when the user cannot read the mission. */
  history(user: Subject, missionId: string): Promise<MissionHistoryView | null> {
    return this.#edits.history(user, missionId);
  }

  /** A former version made current again, as an edit. */
  restore(user: Subject, missionId: string, number: number): Promise<RestoreResult> {
    return this.#edits.restore(user, missionId, number);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Issuance context and preview
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

  private async issuanceAccount(
    user: Subject,
    account: AccountRecord,
  ): Promise<IssuanceAccount | null> {
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

  private macroActionsOf(service: string): readonly MacroAction[] {
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

  /**
   * What passes, what exceeds the authority, what becomes callable. Writes
   * nothing. `assumedEnvs` reads some resources as if they carried another
   * environment label — a dry run that would set those labels first (the v4
   * importer) — so that the preview and the later issuance agree.
   */
  async preview(
    user: Subject,
    draft: MissionDraft,
    options: PreviewOptions = {},
  ): Promise<MissionPreview> {
    const accounts = withAssumedEnvs(await this.issuanceContext(user), options.assumedEnvs);
    return previewDraft({ accounts, now: this.deps.clock.now() }, draft);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Issue, duplicate
  // ───────────────────────────────────────────────────────────────────────────

  async issue(
    user: Subject,
    draft: MissionDraft,
    options: IssueOptions = {},
  ): Promise<IssueResult> {
    const context = await this.issuanceContext(user);
    const preview = previewDraft({ accounts: context, now: this.deps.clock.now() }, draft);
    if (!preview.ok) return { ok: false, reason: 'refused', preview };
    const ceiling = await this.activeMissionCeiling();
    if (ceiling) return ceiling;

    const mission = await this.deps.store.missions.create({
      name: preview.name,
      creatorUserId: user.id,
      periodSeconds: draft.period.kind === 'recurring' ? draft.period.length_seconds : null,
      expiresAt: draft.expires_at === null ? null : new Date(draft.expires_at).toISOString(),
      issuedByMissionId: options.issuedBy?.missionId ?? null,
      accounts: preview.resolved.map(accountInputOf),
    });
    // The creator is a member by construction: the mission is born with their own token.
    const token = await this.issueCreatorToken(mission);

    await this.deps.store.auditWriter.write({
      kind: 'admin',
      ts: toIso(this.deps.clock.now()),
      user_id: user.id,
      act: 'mission-issued',
      object: { type: 'mission', id: mission.id },
      before: null,
      after: issuedAuditOf(mission, token.prefix),
      via_mission_id: options.issuedBy?.missionId ?? null,
    });
    this.deps.logger.info('mission issued', {
      mission_id: mission.id,
      creator_id: user.id,
      accounts: mission.accounts.length,
      risks: mission.policy.length,
      token_prefix: token.prefix,
      issued_by_mission_id: options.issuedBy?.missionId ?? null,
    });

    return {
      ok: true,
      mission,
      token: { secret: token.secret, prefix: token.prefix },
      kit: await this.kitOf(mission, { secret: token.secret }),
      preview,
    };
  }

  /**
   * The draft that re-issues an existing mission of the user: same
   * accounts, resources still present, same explicit policy, same period;
   * no expiry carried over (a past date would refuse the copy). `null` when
   * the mission is not theirs.
   *
   * Each set is drafted as a set: its surviving resources, `future` and, when
   * it lists none, its environment; a set that lists none and takes nothing later
   * is drafted `{ scope: 'all' }`, resolved against the resources known at the copy. A legacy set mixing environments (migration
   * 0033) is drafted the legacy way — `{ scope: 'account' }` when it took future
   * resources, its resources otherwise — so that the copy is split by environment
   * (or refused as mixed, inside `resource_sets`): never wider than its source.
   */
  async draftFrom(user: Subject, missionId: string): Promise<MissionDraft | null> {
    const mission = await this.ownMission(user, missionId);
    if (!mission) return null;
    const accounts: DraftAccount[] = [];
    const policy = mission.policy.map(policyEntryOf);
    for (const c of mission.accounts) {
      const account = await this.deps.store.accounts.getById(c.accountId);
      if (!account) continue;
      const service = account.service;
      const sets: DraftResourceSet[] = [];
      for (const set of c.resourceSets) {
        const ids = await this.survivingResources(c.accountId, set, service);
        const legacyWhole = set.mixedEnv && set.future;
        // A set that holds nothing and takes nothing later: "all", resolved at the copy.
        const nothing = ids.length === 0 && !set.future;
        sets.push({
          resources: legacyWhole
            ? { scope: 'account' }
            : nothing
              ? { scope: 'all' }
              : { scope: 'selected', resource_ids: ids },
          ...(set.mixedEnv ? {} : { future: set.future }),
          ...(!set.mixedEnv && ids.length === 0 ? { env: set.env } : {}),
          everything_i_hold: false,
          policy: policy
            .filter((entry) => entry.resource_set_id === set.id)
            .map(({ resource_set_id: _set, ...line }) => line),
          ...(set.trustLevels ? { trust_levels: set.trustLevels } : {}),
        });
      }
      const [only] = sets;
      // A legacy mixed set alone is drafted flat, so that it is split by environment.
      const flat = c.resourceSets.length === 1 && c.resourceSets[0]?.mixedEnv === true && only;
      if (flat) {
        const { future: _future, env: _env, ...fields } = only;
        accounts.push({ account_id: c.accountId, ...fields });
      } else {
        accounts.push({ account_id: c.accountId, resource_sets: sets });
      }
    }
    return {
      name: `${mission.name}${COPY_SUFFIX}`,
      accounts,
      period: statedPeriodOf(mission),
      expires_at: null,
    };
  }

  private async survivingResources(
    accountId: string,
    set: MissionResourceSetRecord,
    service: string,
  ): Promise<string[]> {
    const current = await this.deps.store.accounts.listResources(accountId);
    // A stale resource would refuse the copy: it is dropped like a vanished one.
    // So is one of the instance's own resources, which no mission may reach.
    const known = new Set(
      current.filter((r) => !isStale(r) && !this.isSelf(service, r)).map((r) => r.id),
    );
    return set.resourceIds.filter((id) => known.has(id));
  }

  /** True when the resource is one of this instance's own (`selfResources`). */
  private isSelf(service: string, resource: Pick<AccountResourceRecord, 'ref'>): boolean {
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

  /**
   * "Duplicate mission": re-issues the source's draft under the creator's
   * *current* authority (a risk they no longer hold refuses the copy) and
   * returns a new mission with its own token and its own budget.
   */
  async duplicate(
    user: Subject,
    missionId: string,
    overrides: Partial<Pick<MissionDraft, 'name' | 'period' | 'expires_at'>> = {},
    options: IssueOptions = {},
  ): Promise<IssueResult> {
    const draft = await this.draftFrom(user, missionId);
    if (!draft) return { ok: false, reason: 'not-found' };
    return this.issue(user, { ...draft, ...overrides }, options);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Token: mint, rotate, revoke, verify
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Mints and stores the creator's own member token; their previous active one,
   * if any, becomes `rotated`. The tokens of the other holders are untouched.
   */
  private issueCreatorToken(mission: MissionRecord): Promise<IssuedSecret> {
    return issueTokenTo(
      { missions: this.deps.store.missions, mint: this.mint },
      {
        missionId: mission.id,
        holder: { kind: 'member', userId: mission.creatorUserId },
        createdBy: mission.creatorUserId,
      },
    );
  }

  /**
   * A new token for the creator, same mission, same mission log, same budget
   * (spec §7.8): the creator's previous token stops working; every other
   * holder's token is untouched. A member rotates their own token through
   * `MissionTeamService.generateToken`, which the creator may use as well.
   *
   * Through the `vaubaan` plugin (`options.issuedBy`) only a mission that very
   * mission issued is rotated: the new token is handed to the caller, so
   * rotating a mission the human issued — wider, perhaps with a gate they
   * opened — would hand an agent an authority nobody issued to it
   * (docs/spec/vaubaan-gateway.md §6). The human rotates any of their missions
   * in the interface.
   */
  async rotate(
    user: Subject,
    missionId: string,
    options: IssueOptions = {},
  ): Promise<RotateResult> {
    const mission = await this.ownMission(user, missionId);
    if (!mission) return { ok: false, reason: 'not-found' };
    if (options.issuedBy && mission.issuedByMissionId !== options.issuedBy.missionId) {
      return { ok: false, reason: 'not-issued-by-mission' };
    }
    const state = await this.stateOf(mission);
    if (state.kind !== 'active') return { ok: false, reason: 'inactive', state: state.kind };

    let token: IssuedSecret;
    try {
      // The one implementation of "a member's own token, issued or replaced"
      // (`member-token.ts`), shared with `MissionTeamService.generateToken`.
      token = await reissueMemberToken(
        { store: this.deps.store, mint: this.mint, clock: this.deps.clock },
        {
          missionId: mission.id,
          userId: user.id,
          viaMissionId: options.issuedBy?.missionId ?? null,
        },
      );
    } catch (err) {
      // Revoked while the hash was computed: the store refused the insert.
      if (!(err instanceof TokenNotIssuableError)) throw err;
      return { ok: false, reason: 'inactive', state: await this.stateAfterRefusal(mission.id) };
    }
    this.deps.logger.info('mission token rotated', {
      mission_id: mission.id,
      token_prefix: token.prefix,
      issued_by_mission_id: options.issuedBy?.missionId ?? null,
    });
    return {
      ok: true,
      mission,
      token: { secret: token.secret, prefix: token.prefix },
      kit: await this.kitOf(mission, { secret: token.secret }),
    };
  }

  /**
   * The orphaned missions that carry an account, for someone who owns that
   * account now (spec §2.3: "the creator, or an owner of the account, may close
   * it"). Anyone else reads none. Derived at this instant, like every reading of
   * `orphaned`.
   */
  async orphanedOn(user: Subject, accountId: string): Promise<OrphanedOnAccount[]> {
    const account = await this.deps.store.accounts.getById(accountId);
    if (!account || !(await this.owns(user, account))) return [];
    const orphaned: OrphanedOnAccount[] = [];
    for (const mission of await this.deps.store.missions.listForAccount(accountId)) {
      const { orphan } = await this.deps.grounds.inspect(mission);
      if (!orphan) continue;
      const creator = await this.deps.store.users.getById(mission.creatorUserId);
      orphaned.push({
        id: mission.id,
        name: mission.name,
        creator_label: creator?.email ?? 'unknown user',
        cause: orphan.cause,
      });
    }
    return orphaned;
  }

  /**
   * Every mission that carries an account, newest first, for someone who owns that
   * account now. Anyone else reads none, like `orphanedOn`. Read-only: the page of
   * the account lists them, so that its owner knows what removing an access or
   * disconnecting would stop.
   */
  async onAccount(user: Subject, accountId: string): Promise<MissionOnAccount[]> {
    const account = await this.deps.store.accounts.getById(accountId);
    if (!account || !(await this.owns(user, account))) return [];
    const listed: MissionOnAccount[] = [];
    for (const stored of await this.deps.store.missions.listForAccount(accountId)) {
      const { mission, orphan, lost } = await this.deps.grounds.inspect(stored);
      const state = await this.stateOf(mission);
      const creator = await this.deps.store.users.getById(mission.creatorUserId);
      const membership = await this.membershipOf(mission, user.id);
      const selection = mission.accounts.find((c) => c.accountId === accountId);
      // The lines of this account's sets: another account of its service has its own.
      const sets = new Set(selection?.resourceSets.map((set) => set.id) ?? []);
      const accepted = mission.policy.filter((entry) => sets.has(entry.resourceSetId));
      listed.push({
        id: mission.id,
        name: mission.name,
        creator: { id: mission.creatorUserId, label: creator?.email ?? 'unknown user' },
        state: state.kind,
        exhausted: state.kind === 'active' ? state.exhausted.length : 0,
        expires_at: mission.expiresAt,
        orphan_cause: orphan?.cause ?? null,
        part_lost: lost.find((part) => part.accountId === accountId)?.cause ?? null,
        resource_ids: selection?.resourceSets.flatMap((set) => [...set.resourceIds]) ?? [],
        future: selection ? takesFutureResources(selection) : false,
        permissions: accepted.length,
        asks_first: accepted.filter((entry) => entry.gate === 'approval').length,
        readable: membership === 'creator' || membership === 'member',
        created_at: mission.createdAt,
      });
    }
    return listed.sort((a, b) =>
      a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0,
    );
  }

  /**
   * The mission refuses everything from now on; every token of every holder is revoked.
   * Idempotent. An orphaned mission is revoked like any other: this is how it is
   * closed for good (the stored status goes `active` → `revoked`).
   *
   * Who may (spec §2.3): the creator, always; and, **only while the mission is
   * orphaned**, an owner of one of its accounts — the authority that grounded it is
   * gone, and it would serve again, with the token its agent holds, the day a share is
   * made again. A mission that serves is its creator's alone. A mission acting through
   * the `vaubaan` plugin acts for its creator only.
   */
  async revoke(
    user: Subject,
    missionId: string,
    options: IssueOptions = {},
  ): Promise<RevokeResult> {
    const closing = await this.closableBy(user, missionId, options);
    if (!closing) return { ok: false, reason: 'not-found' };
    const { mission, closer } = closing;
    if (mission.status === 'revoked') return { ok: true, mission, tokensRevoked: 0 };

    const revoked = await this.deps.store.missions.setStatus(mission.id, 'revoked');
    const tokensRevoked = await this.deps.store.missions.revokeTokens(mission.id);
    await this.deps.store.auditWriter.write({
      kind: 'admin',
      ts: toIso(this.deps.clock.now()),
      user_id: user.id,
      act: 'mission-revoked',
      object: { type: 'mission', id: mission.id },
      before: { status: mission.status },
      after: {
        status: revoked.status,
        tokens_revoked: tokensRevoked,
        // Named only when it is not the creator: the entry says on what ground they acted.
        ...(closer.as === 'account-owner'
          ? { closed_as: closer.as, account_id: closer.accountId }
          : {}),
      },
      via_mission_id: options.issuedBy?.missionId ?? null,
    });
    await this.recordEvent(mission.id, user.id, {
      kind: 'revocation',
      details: { tokens_revoked: tokensRevoked },
    });
    this.deps.logger.info('mission revoked', {
      mission_id: mission.id,
      closed_as: closer.as,
      via_mission_id: options.issuedBy?.missionId ?? null,
    });
    this.deps.notifications?.missionRevoked(mission.id, user.id);
    return { ok: true, mission: revoked, tokensRevoked };
  }

  /**
   * The mission as derived now, when `user` may close it, and on what ground.
   * `null` — "not found" — for everyone else, so that an owner learns nothing about
   * the missions of their account that serve.
   */
  private async closableBy(
    user: Subject,
    missionId: string,
    options: IssueOptions,
  ): Promise<{ mission: MissionRecord; closer: Closer } | null> {
    const stored = await this.deps.store.missions.getById(missionId);
    if (!stored) return null;
    const { mission } = await this.deps.grounds.inspect(stored);
    if (stored.creatorUserId === user.id) return { mission, closer: { as: 'creator' } };
    // A mission acts for its creator through the `vaubaan` plugin, never as an owner.
    if (options.issuedBy) return null;
    // Orphaned now; or already closed, which is answered the same to who could close it.
    if (mission.status !== 'orphaned' && mission.status !== 'revoked') return null;
    for (const { accountId } of stored.accounts) {
      const account = await this.deps.store.accounts.getById(accountId);
      if (account && (await this.owns(user, account))) {
        return { mission, closer: { as: 'account-owner', accountId } };
      }
    }
    return null;
  }

  /** The one definition of "owns the account now": the authority's (`basis: 'owner'`). */
  private async owns(user: Subject, account: AccountRecord): Promise<boolean> {
    return (await this.deps.authority.authorityOf(user, account)).basis === 'owner';
  }

  /**
   * The creator edits the gate of one accepted risk after issuance (spec §3.5 "at
   * issuance, or later"): `auto` ⇄ `approval`. Only the gate moves — the accepted
   * risks, quotas and rate limits are the mission's as issued, and a gate is not part
   * of what a share restricts, so no authority is re-checked. The edit applies to the
   * next call, ends an opening "for the rest of the period" granted earlier on that
   * risk, and leaves the open requests where they are.
   */
  async setGate(
    user: Subject,
    missionId: string,
    riskId: RiskId,
    gate: string,
    /** The set of the line; absent when exactly one set of the mission accepts the risk. */
    resourceSetId?: string,
  ): Promise<SetGateResult> {
    const mission = await this.ownMission(user, missionId);
    if (!mission) return { ok: false, reason: 'not-found' };
    if (!isGate(gate)) return { ok: false, reason: 'invalid-gate' };
    const blocked = gateEditBlockedBy(mission);
    if (blocked) return { ok: false, reason: 'inactive', state: blocked };
    // "Ask me again" on a risk that is gated but open for the period must end the
    // opening: the stored gate would not move, so the store is told what was found.
    // The opening is looked for in the period that runs NOW, whether or not the mission
    // serves at this instant: an expired mission whose expiry is then extended in the
    // same period would otherwise come back with the opening the creator just closed.
    //
    // single-process only: the read and the write are two store calls, so an opening
    // granted between them is missed. Not reachable while every store call is
    // synchronous in one process; with a second process, decide inside
    // `MissionsRepo.setGate`'s transaction (it owns the mission log's events).
    const line = lineOfRisk(mission, riskId, resourceSetId);
    if (!line) return { ok: false, reason: 'risk-not-in-policy' };
    const openNow =
      gate === 'approval' &&
      (await this.openGatesIn(mission, this.periodNow(mission))).has(
        policyLineKey(line.resourceSetId, riskId),
      );
    const changed = await this.deps.store.missions.setGate(mission.id, line, gate, user.id, {
      closeOpening: openNow,
    });
    if (!changed) return { ok: false, reason: 'risk-not-in-policy' };
    const { previous, openingClosed } = changed;
    if (previous !== gate || openingClosed) {
      await this.deps.store.auditWriter.write({
        kind: 'admin',
        ts: toIso(this.deps.clock.now()),
        user_id: user.id,
        act: 'gate-changed',
        object: { type: 'mission', id: mission.id },
        before: {
          risk_id: riskId,
          resource_set_id: line.resourceSetId,
          gate: previous,
          ...(openingClosed ? { open_for_period: true } : {}),
        },
        after: {
          risk_id: riskId,
          resource_set_id: line.resourceSetId,
          gate,
          ...(openingClosed ? { open_for_period: false } : {}),
        },
      });
      this.deps.logger.info('mission gate changed', {
        mission_id: mission.id,
        risk_id: riskId,
        gate,
        opening_closed: openingClosed,
      });
    }
    return {
      ok: true,
      mission: changed.mission,
      risk_id: riskId,
      gate,
      previous,
      opening_closed: openingClosed,
    };
  }

  /**
   * The creator changes the limits of accepted risks after issuance (spec §3.2): per
   * risk already in the mission, its quota per period and its calls per rate window, up
   * or down. Never a risk added or removed, never the period nor the rate window, never
   * the gate (that is `setGate`). Creator only, like every mutation of a mission; there
   * is no delegated variant: the management door is not handed this method.
   *
   * A value that moves is judged by issuance's own check of a policy line
   * (`checkPolicyLines`): inside the creator's authority on the account NOW, a whole
   * number of at least one, a rate under the catalog's ceiling. Whatever caps a creation
   * caps the change; a value that does not move is not judged again.
   *
   * The change applies to the current period at once: what was used stays used, and a
   * quota lowered under it leaves the risk exhausted until the reset. The budget reads
   * the stored limits inside its decision transaction (`DecideContext.limits`), so no
   * call decided after the write commits passes above the new limit. One
   * `limits-changed` audit entry carries every risk that moved, before and after.
   *
   * Between the authority check and the write, the creator's authority may go: the
   * mission then reads `orphaned` and serves nothing, as an issuance racing the same
   * revocation would.
   */
  async setLimits(
    user: Subject,
    missionId: string,
    edits: readonly LimitEdit[],
  ): Promise<SetLimitsResult> {
    const mission = await this.ownMission(user, missionId);
    if (!mission) return { ok: false, reason: 'not-found' };
    const blocked = gateEditBlockedBy(mission);
    if (blocked) return { ok: false, reason: 'inactive', state: blocked };
    if (edits.length === 0) {
      return { ok: false, reason: 'invalid-limits', problem: 'No permission is listed.' };
    }
    const ids = edits.map((edit) => edit.risk_id);
    const placed = edits.map((edit) => lineOfRisk(mission, edit.risk_id, edit.resource_set_id));
    const outside = edits.filter((_, i) => placed[i] === null).map((edit) => edit.risk_id);
    if (outside.length > 0) return { ok: false, reason: 'risk-not-in-policy', risk_ids: outside };
    const keys = placed.map((line) =>
      line ? policyLineKey(line.resourceSetId, line.riskId) : null,
    );
    const twice = [
      ...new Set(edits.filter((_, i) => keys.indexOf(keys[i] ?? null) !== i).map((e) => e.risk_id)),
    ];
    if (twice.length > 0) {
      return {
        ok: false,
        reason: 'invalid-limits',
        problem: `Listed more than once: ${twice.join(', ')}.`,
      };
    }
    const stored = new Map(
      mission.policy.map(
        (entry) => [policyLineKey(entry.resourceSetId, entry.riskId), entry] as const,
      ),
    );

    // The lines that move, as issuance would read them: same gate, same window.
    const moving: MissionPolicyEntry[] = [];
    edits.forEach((edit, i) => {
      const key = keys[i];
      const entry = key ? stored.get(key) : undefined;
      if (!entry || (entry.quota === edit.quota && entry.rateLimit === edit.rate_limit_max)) {
        return;
      }
      moving.push({
        resource_set_id: entry.resourceSetId,
        risk_id: edit.risk_id,
        quota: edit.quota,
        rate_limit: { max: edit.rate_limit_max, window_seconds: entry.rateWindowSeconds },
        gate: entry.gate,
      });
    });
    const issues = await this.limitIssues(user, mission, moving);
    if (issues.length > 0) return { ok: false, reason: 'refused', issues };

    const written = await this.deps.store.missions.setLimits(
      mission.id,
      edits.map((edit, i) => ({
        ...(placed[i] ? { resourceSetId: placed[i].resourceSetId } : {}),
        riskId: edit.risk_id,
        quota: edit.quota,
        rateLimit: edit.rate_limit_max,
      })),
      user.id,
    );
    if (!written) return { ok: false, reason: 'risk-not-in-policy', risk_ids: ids };
    const changed: LimitChangeView[] = written.changes
      .filter((change) => change.changed)
      .map((change) => ({
        risk_id: change.riskId,
        resource_set_id: change.resourceSetId,
        before: {
          quota: change.before.quota,
          rate_limit: { max: change.before.rateLimit, window_seconds: change.rateWindowSeconds },
        },
        after: {
          quota: change.after.quota,
          rate_limit: { max: change.after.rateLimit, window_seconds: change.rateWindowSeconds },
        },
      }));
    if (changed.length > 0) {
      await this.deps.store.auditWriter.write({
        kind: 'admin',
        ts: toIso(this.deps.clock.now()),
        user_id: user.id,
        act: 'limits-changed',
        object: { type: 'mission', id: mission.id },
        before: { limits: changed.map((c) => ({ risk_id: c.risk_id, ...c.before })) },
        after: { limits: changed.map((c) => ({ risk_id: c.risk_id, ...c.after })) },
      });
      this.deps.logger.info('mission limits changed', {
        mission_id: mission.id,
        risks: changed.length,
      });
    }
    return { ok: true, mission: written.mission, changed };
  }

  async permissionOptions(user: Subject, missionId: string) {
    const mission = await this.ownMission(user, missionId);
    if (!mission || gateEditBlockedBy(mission)) return null;
    const reached = await this.detailAccounts(mission);
    const candidates: {
      risk_id: string;
      /** The set the line would join (risk model §4.7). */
      resource_set_id: string;
      /** "Resource set 2" when the account has several; `null` otherwise. */
      resource_set_label: string | null;
      label: string;
      row: Row;
      reason: string;
      available: boolean;
      ceiling: number | null;
    }[] = [];
    for (const selected of mission.accounts) {
      const account = await this.deps.store.accounts.getById(selected.accountId);
      // A revoked account serves the mission no more: nothing is added on it.
      if (!account || account.status === 'revoked') continue;
      const context = await this.issuanceAccount(user, account);
      if (!context) continue;
      const sets = reached.find((r) => r.id === account.id)?.resource_sets ?? [];
      for (const set of sets) {
        for (const risk of context.risks) {
          const line: MissionPolicyEntry = {
            risk_id: risk.risk_id,
            quota: 1,
            rate_limit: { max: 1, window_seconds: 60 },
            gate: 'approval',
          };
          const issues = checkPolicyLines(context, set.resources, [line], 0).issues;
          candidates.push({
            risk_id: risk.risk_id,
            resource_set_id: set.id,
            resource_set_label: sets.length > 1 ? `Resource set ${set.position}` : null,
            label: risk.label,
            row: risk.row,
            reason: issues.map((i) => i.message).join(' '),
            available: issues.length === 0,
            ceiling: risk.rate_ceiling_per_minute,
          });
        }
      }
    }
    return {
      missionId: mission.id,
      missionName: mission.name,
      policy: budgetMissionOf(mission).policy,
      periodSeconds: mission.periodSeconds,
      candidates,
    };
  }

  /** Shared by a direct edit and the creator's answer to a permission request. */
  async changePermissions(user: Subject, missionId: string, raw: unknown) {
    const mission = await this.ownMission(user, missionId);
    if (!mission) return { ok: false as const, reason: 'not-found' };
    const parsed = permissionEditSchema.safeParse(raw);
    if (!parsed.success) return { ok: false as const, reason: 'invalid-edit' };
    const edit = parsed.data;
    const blocked = gateEditBlockedBy(mission);
    if (blocked) return { ok: false as const, reason: 'inactive', state: blocked };
    const before = budgetMissionOf(mission).policy;
    const asked = edit.request_id
      ? ((await this.deps.store.requests.getById(edit.request_id))?.lines ?? [])
      : [];
    const firstSets = new Map<string, string>();
    for (const c of mission.accounts) {
      const account = await this.deps.store.accounts.getById(c.accountId);
      const first = c.resourceSets[0];
      if (account && first) firstSets.set(account.service, first.id);
    }
    const expected = placeLines(mission, edit.expected_policy, asked, firstSets);
    const policy = placeLines(mission, edit.policy, asked, firstSets);
    if (!expected || !policy) return { ok: false as const, reason: 'invalid-edit' };
    if (policyKey(before) !== policyKey(expected))
      return { ok: false as const, reason: 'conflict' };
    if (new Set(policy.map(lineKeyOf)).size !== policy.length)
      return { ok: false as const, reason: 'invalid-edit' };
    // Existing lines use the dedicated limits and gate controls; this edit adds/removes.
    const previous = new Map(before.map((p) => [lineKeyOf(p), p]));
    if (
      policy.some((p) => {
        const was = previous.get(lineKeyOf(p));
        return was !== undefined && policyKey([p]) !== policyKey([was]);
      })
    ) {
      return { ok: false as const, reason: 'invalid-edit' };
    }
    const additions = policy.filter((p) => !previous.has(lineKeyOf(p)));
    const issues = await this.limitIssues(user, mission, additions);
    if (issues.length) return { ok: false as const, reason: 'refused', issues };
    const asStored = (lines: readonly MissionPolicyEntry[]) =>
      lines.map((p) => policyEntryRecordOf({ ...p, resource_set_id: p.resource_set_id ?? '' }));
    if (policyKey(before) === policyKey(policy) && !edit.request_id)
      return { ok: true as const, mission };
    const written = await this.deps.store.missions.changePermissions(
      mission.id,
      asStored(policy),
      asStored(before),
      user.id,
      edit.request_id,
    );
    if (!written) return { ok: false as const, reason: 'conflict' };
    await this.deps.store.auditWriter.write({
      kind: 'admin',
      ts: toIso(this.deps.clock.now()),
      user_id: user.id,
      act: 'permissions-changed',
      object: { type: 'mission', id: mission.id },
      before: { policy: before },
      after: { policy, request_id: edit.request_id ?? null },
    });
    return { ok: true as const, mission: written };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Edit after issuance (ADR mission-editable-after-issuance)
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Why issuance would refuse these lines on the mission's accounts now: each line
   * checked against the creator's authority on the account of its service, on the
   * resources the mission reaches there. Empty when every line passes.
   */
  private async limitIssues(
    user: Subject,
    mission: MissionRecord,
    lines: readonly MissionPolicyEntry[],
  ): Promise<PreviewIssue[]> {
    if (lines.length === 0) return [];
    const issues: PreviewIssue[] = [];
    const judged = new Set<RiskId>();
    const reached = await this.detailAccounts(mission);
    for (const [index, c] of mission.accounts.entries()) {
      const account = await this.deps.store.accounts.getById(c.accountId);
      if (!account) continue;
      const sets = reached.find((r) => r.id === account.id)?.resource_sets ?? [];
      // A line placed in a set belongs to that set's account; an unplaced one to
      // every account of its service (several may be in the mission).
      const own = lines.filter(
        (line) =>
          parseRiskId(line.risk_id)?.service === account.service &&
          (line.resource_set_id === undefined ||
            sets.some((set) => set.id === line.resource_set_id)),
      );
      if (own.length === 0) continue;
      for (const line of own) judged.add(line.risk_id);
      // A revoked account's part of the mission is lost for good: nothing widens on it.
      const context =
        account.status === 'revoked' ? null : await this.issuanceAccount(user, account);
      if (!context) {
        issues.push({
          code: 'exceeds-authority',
          message: `Outside your authority on "${account.displayName}": ${own
            .map((line) => line.risk_id)
            .join(', ')}.`,
          risk_ids: own.map((line) => line.risk_id),
          account_index: index,
          account_id: account.id,
        });
        continue;
      }
      for (const set of sets) {
        const ofSet = own.filter((line) => (line.resource_set_id ?? set.id) === set.id);
        if (ofSet.length === 0) continue;
        issues.push(...checkPolicyLines(context, set.resources, ofSet, index).issues);
      }
    }
    const unplaced = lines.filter((line) => !judged.has(line.risk_id)).map((l) => l.risk_id);
    if (unplaced.length > 0) {
      // A risk of a service none of the mission's accounts is for: nothing grounds it.
      issues.push({
        code: 'exceeds-authority',
        message: `No account of this mission carries ${unplaced.join(', ')}.`,
        risk_ids: unplaced,
      });
    }
    return issues;
  }

  /** Mission log events exist only once the mission log does (born on the first call). */
  private async recordEvent(
    missionId: string,
    actorUserId: string,
    event: Extract<MissionLogEventDetails, { kind: 'rotation' | 'revocation' }>,
  ): Promise<void> {
    const missionLog = await this.deps.store.missionLogs.getByMission(missionId);
    if (!missionLog) return;
    await this.deps.store.missionLogs.recordEvent(missionLog.id, { ...event, actorUserId });
  }

  /**
   * Resolves a presented Bearer: prefix lookup, the comparison with the stored
   * SHA-256 digest, then what the token is worth at this instant
   * (`standingOf`). A malformed Bearer, an unknown prefix and a wrong secret
   * are the same answer (`unknown`).
   */
  async verifyToken(bearer: string): Promise<TokenVerification> {
    const prefix = prefixOfBearer(bearer);
    if (!prefix) return { outcome: 'unknown' };
    const found = await this.deps.store.missions.findTokenByPrefix(prefix);
    if (!found) return { outcome: 'unknown' };
    if (!bearerMatches(found.token, bearer)) return { outcome: 'unknown' };
    return this.standingOf(found);
  }

  /**
   * The one place that says whether a token whose secret matched authenticates
   * (spec §0 "Mission token"), read from the store on every call:
   *
   *   - a member token must belong to someone who is, right now, an active user
   *     and a current member of the mission. Nothing is cached and nothing needs
   *     to have been written: a member removed, or a user deactivated, a
   *     millisecond ago is refused;
   *   - the row must be `active` (a holder's rotation and any revocation retire it).
   *
   * The creator is a member by construction and has no row. Their deactivation
   * is not judged here: the mission then reads `orphaned` (derived by
   * `MissionGrounds`), every holder is refused `mission-inactive`, and the
   * same tokens serve again if the creator is reactivated.
   *
   * The record (and its hash) stops here: the door gets the id, the prefix and
   * the holder.
   */
  private async standingOf(found: {
    readonly token: MissionTokenRecord;
    readonly mission: MissionRecord;
  }): Promise<TokenVerification> {
    const { mission } = found;
    const record = found.token;
    const user =
      record.holder.kind === 'member'
        ? await this.deps.store.users.getById(record.holder.userId)
        : null;
    const token: VerifiedToken = {
      id: record.id,
      prefix: record.prefix,
      holder: tokenHolderOf(record, user),
    };
    // The holder is judged first: a member who was removed is told so whatever
    // became of their token or of the mission since (they are no longer told the
    // mission's state). The membership rule is the one `access` reads.
    if (record.holder.kind === 'member') {
      const membership = await this.membershipOf(mission, record.holder.userId, user);
      if (membership === 'deactivated') {
        return { outcome: 'retired', reason: 'holder-deactivated', mission, token };
      }
      if (!isOnMission(membership)) {
        return { outcome: 'retired', reason: 'holder-removed', mission, token };
      }
    }
    if (record.status !== 'active') {
      return { outcome: 'retired', reason: record.status, mission, token };
    }
    return { outcome: 'verified', mission, token };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Reads for the Missions pages
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * The missions the user can read, newest first: the ones they created
   * (`role: 'creator'`) and the ones shared with them as a member
   * (`role: 'member'`, spec §4.2 "Missions").
   */
  async list(user: Subject): Promise<MissionOverview[]> {
    const created = await this.deps.store.missions.listForCreator(user.id);
    const shared = (await this.isActiveUser(user.id))
      ? await this.deps.store.missions.listForMember(user.id)
      : [];
    const issuers = await this.issuersOf(created);
    const overviews: MissionOverview[] = [];
    for (const [role, missions] of [
      ['creator', created],
      ['member', shared],
    ] as const) {
      for (const mission of missions) {
        // The listing's SQL selects the current member rows; the rule has the last word.
        if (role === 'member' && (await this.membershipOf(mission, user.id)) !== 'member') {
          continue;
        }
        overviews.push(
          await this.overviewOf(
            { ...(await this.deps.grounds.inspect(mission)), role },
            user,
            issuers.get(mission.id) ?? null,
          ),
        );
      }
    }
    // Newest first: the mission just issued is the one the creator looks for.
    return overviews.sort((a, b) =>
      a.mission.createdAt < b.mission.createdAt
        ? 1
        : a.mission.createdAt > b.mission.createdAt
          ? -1
          : 0,
    );
  }

  /**
   * One mission, for its creator or for a current member (spec §0: a member
   * "can read it"). A member reads the same policy, resources and counters,
   * and the kit with their own token's prefix; they edit nothing
   * (`gates_editable: false`, and every mutation of this service answers
   * `not-found` to anyone but the creator).
   */
  async get(user: Subject, missionId: string): Promise<MissionDetail | null> {
    const inspected = await this.access(user, missionId);
    if (!inspected) return null;
    const { mission } = inspected;
    const issuers = await this.issuersOf([mission]);
    const overview = await this.overviewOf(inspected, user, issuers.get(mission.id) ?? null);
    const accounts = await this.detailAccounts(mission, inspected.lost);
    const remaining = overview.state.kind === 'active' ? overview.state.remaining : null;
    const rows = this.catalogRowsOf(accounts);
    const openUntil = await this.openGatesOf(mission, overview.state);
    const policy: MissionDetailRisk[] = mission.policy.map(policyEntryOf).map((entry) => {
      const row = rows.get(entry.risk_id);
      return {
        ...entry,
        label: row?.label ?? entry.risk_id,
        row: row?.row ?? null,
        remaining: remaining ? (remaining[lineKeyOf(entry)] ?? null) : null,
        gate_open_until: openUntil.get(lineKeyOf(entry)) ?? null,
      };
    });
    const editable = inspected.role === 'creator' && gateEditBlockedBy(overview.mission) === null;
    return {
      ...overview,
      gates_editable: editable,
      limits_editable: editable,
      accounts,
      policy,
      period: statedPeriodOf(mission),
      kit: overview.token
        ? await this.kitOf(mission, { prefix: overview.token.prefix }, accounts)
        : null,
      trust_raises:
        inspected.role === 'creator' && overview.state.kind === 'active'
          ? await this.trustRaisesOf(mission)
          : [],
    };
  }

  /**
   * The trust-raise proposals of every running mission the user created (risk model
   * §4.7), for the Now page: each with its mission's id and name.
   */
  async trustRaisesFor(user: Subject): Promise<
    {
      readonly mission_id: string;
      readonly mission_name: string;
      readonly offers: readonly TrustRaiseOffer[];
    }[]
  > {
    const out: { mission_id: string; mission_name: string; offers: readonly TrustRaiseOffer[] }[] =
      [];
    for (const created of await this.deps.store.missions.listForCreator(user.id)) {
      const { mission, orphan } = await this.deps.grounds.inspect(created);
      if (orphan || (await this.stateOf(mission)).kind !== 'active') continue;
      const offers = await this.trustRaisesOf(mission);
      if (offers.length > 0)
        out.push({ mission_id: mission.id, mission_name: mission.name, offers });
    }
    return out;
  }

  /**
   * "Not now" on a trust-raise proposal (risk model §4.7): the offer is hidden until as
   * many approvals again. The creator only; `null` is "not found" for anyone else, or a
   * set that is not the mission's. Not an edit of the mission: nothing it allows moves.
   */
  async snoozeTrustRaise(
    user: Subject,
    missionId: string,
    target: { readonly resource_set_id: string; readonly macro_action_id: string },
  ): Promise<{ readonly ok: true } | null> {
    const mission = await this.ownMission(user, missionId);
    if (!mission) return null;
    const done = await this.deps.store.missions.snoozeTrustRaise(
      mission.id,
      target.resource_set_id,
      target.macro_action_id,
    );
    return done ? { ok: true } : null;
  }

  /**
   * The one trust-raise proposal "Raise" opens the edit with: offered now on that
   * macro-action of that set of a running mission the user created; `null` otherwise
   * (the edit then opens as usual).
   */
  async trustRaiseOffer(
    user: Subject,
    missionId: string,
    target: { readonly resource_set_id: string; readonly macro_action_id: string },
  ): Promise<TrustRaiseOffer | null> {
    const inspected = await this.ownInspected(user, missionId);
    if (!inspected || inspected.orphan) return null;
    if ((await this.stateOf(inspected.mission)).kind !== 'active') return null;
    const offers = await this.trustRaisesOf(inspected.mission);
    return (
      offers.find(
        (o) =>
          o.resource_set_id === target.resource_set_id &&
          o.macro_action_id === target.macro_action_id,
      ) ?? null
    );
  }

  private async trustRaisesOf(mission: MissionRecord): Promise<TrustRaiseOffer[]> {
    const accounts = new Map<string, { name: string; macroActions: readonly MacroAction[] }>();
    for (const c of mission.accounts) {
      const account = await this.deps.store.accounts.getById(c.accountId);
      if (!account || !this.deps.registry.get(account.service)) continue;
      accounts.set(c.accountId, {
        name: account.displayName,
        macroActions: this.macroActionsOf(account.service),
      });
    }
    return trustRaiseOffers({
      mission,
      accountOf: (accountId) => accounts.get(accountId) ?? null,
      requests: await this.deps.store.requests.listForMission(mission.id),
      marks: await this.deps.store.missions.trustMarks(mission.id),
      threshold: this.deps.trustRaiseAfterApprovals ?? DEFAULT_TRUST_RAISE_AFTER_APPROVALS,
    });
  }

  /**
   * The gated risks the creator opened for the current period, with the instant the
   * gate closes again — the budget's own derivation (`openedGatesOf`) over the mission log's
   * gate events, so this page and `decide()` cannot disagree.
   */
  private async openGatesOf(
    mission: MissionRecord,
    state: MissionState,
  ): Promise<Map<PolicyLineKey, Iso8601>> {
    // What the page shows: a mission that serves no call has no gate "open" to show.
    return state.kind === 'active' ? this.openGatesIn(mission, state.period) : new Map();
  }

  /** The period that runs at this instant, whatever the mission's state. */
  private periodNow(mission: MissionRecord): CurrentPeriod {
    return currentPeriod(budgetMissionOf(mission).period, this.deps.clock.now());
  }

  /** The gates opened for `period`, read from the mission log's gate events since it started. */
  private async openGatesIn(
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

  private async overviewOf(
    { mission, orphan, lost, role }: MissionAccess,
    reader: Subject,
    issuedVia: MissionIssuer | null,
  ): Promise<MissionOverview> {
    const token = await this.ownToken(mission.id, reader.id);
    const creator = await this.deps.store.users.getById(mission.creatorUserId);
    return {
      mission,
      role,
      creator: { id: mission.creatorUserId, email: creator?.email ?? null },
      state: await this.stateOf(mission),
      orphan: orphan && {
        cause: orphan.cause,
        account_id: orphan.accountId,
        uncovered: [...orphan.uncovered],
      },
      lost: lost.map((part) => ({
        account_id: part.accountId,
        cause: part.cause,
        final: isFinalLoss(part.cause),
      })),
      token: token ? { prefix: token.prefix, created_at: token.createdAt } : null,
      issued_via: issuedVia,
    };
  }

  /**
   * Who prepared the missions of the list: the issuing mission (its name read
   * now) or, for a mission issued before migration 0035, the app. One read, and
   * none at all when every mission of the list was issued by a person.
   */
  private async issuersOf(missions: readonly MissionRecord[]): Promise<Map<string, MissionIssuer>> {
    const prepared = missions
      .filter((m) => m.issuedByMissionId !== null || m.issuedViaClientName !== null)
      .map((m) => m.id);
    const issuers = new Map<string, MissionIssuer>();
    if (prepared.length === 0) return issuers;
    for (const [missionId, issuer] of await this.deps.store.missions.issuersOf(prepared)) {
      issuers.set(missionId, {
        mission_id: issuer.issuedByMissionId,
        mission_name: issuer.issuedByMissionName,
        client_name: issuer.clientName,
      });
    }
    return issuers;
  }

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

  /**
   * A stored mission as it stands now, for a reader the caller already scoped (the
   * Overview of Activity reads the missions of the Timeline's scope): its derived status
   * (`orphaned` while its authority is missing) and its state with the period's
   * remaining budget. Reads only; no authority check of the reader here.
   */
  async standing(
    stored: MissionRecord,
  ): Promise<{ readonly mission: MissionRecord; readonly state: MissionState }> {
    const { mission } = await this.deps.grounds.inspect(stored);
    return { mission, state: await this.stateOf(mission) };
  }

  /** The active member token this user holds on the mission, if any. */
  private async ownToken(missionId: string, userId: string): Promise<MissionTokenRecord | null> {
    const tokens = await this.deps.store.missions.listTokens(missionId);
    return (
      tokens.find(
        (t) => t.status === 'active' && t.holder.kind === 'member' && t.holder.userId === userId,
      ) ?? null
    );
  }

  private async isActiveUser(userId: string): Promise<boolean> {
    return (await this.deps.store.users.getById(userId))?.status === 'active';
  }

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
  private async membershipOf(
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

  /**
   * The accounts of a mission with the resources it reaches — the rule of
   * `loadMissionContext`, the same function (`reachedResources`): the ids its
   * resource sets store, never the ones discovery no longer returns nor the
   * instance's own.
   */
  private async detailAccounts(
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

  private catalogRowsOf(
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

/**
 * The holder of a token as the door and the audit name it. A member is shown
 * by their email; a member whose user row is gone keeps their id.
 */
export function tokenHolderOf(
  token: Pick<MissionTokenRecord, 'holder'>,
  user: Pick<UserRecord, 'email'> | null,
): TokenHolder {
  if (token.holder.kind === 'named') return { kind: 'named', name: token.holder.name };
  return {
    kind: 'member',
    user_id: token.holder.userId,
    display: user?.email ?? token.holder.userId,
  };
}

/**
 * The line of a risk in the mission: in `resourceSetId` when given, else the one set
 * that accepts the risk. `null` when absent, or when the risk alone names several lines.
 */
function lineOfRisk(
  mission: Pick<MissionRecord, 'policy'>,
  riskId: RiskId,
  resourceSetId: string | undefined,
): RequestLine | null {
  const lines = mission.policy.filter(
    (entry) =>
      entry.riskId === riskId &&
      (resourceSetId === undefined || entry.resourceSetId === resourceSetId),
  );
  const [only] = lines;
  return lines.length === 1 && only ? { resourceSetId: only.resourceSetId, riskId } : null;
}

/**
 * The lines of a permission edit, each in its set: the one it names, else the set of the
 * mission's line of that risk (when only one set accepts it), else the set the answered
 * request names for it, else the first set of the account of its service. `null` when
 * a line cannot be placed (several sets accept the risk, or no account is for it).
 */
function placeLines(
  mission: Pick<MissionRecord, 'policy'>,
  lines: readonly MissionPolicyEntry[],
  asked: readonly RequestLine[],
  /** The first set of the account of each service of the mission. */
  firstSets: ReadonlyMap<string, string>,
): MissionPolicyEntry[] | null {
  const placed: MissionPolicyEntry[] = [];
  for (const line of lines) {
    if (line.resource_set_id !== undefined) {
      placed.push(line);
      continue;
    }
    const held = mission.policy.filter((entry) => entry.riskId === line.risk_id);
    const [only] = held;
    if (held.length > 1) return null;
    const setId =
      only?.resourceSetId ??
      asked.find((a) => a.riskId === line.risk_id)?.resourceSetId ??
      firstSets.get(parseRiskId(line.risk_id)?.service ?? '');
    if (setId === undefined) return null;
    placed.push({ ...line, resource_set_id: setId });
  }
  return placed;
}
