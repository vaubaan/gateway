/**
 * A mission is previewed, issued with its creator's own token, drafted again from an
 * existing one and duplicated (spec §3.1, §3.2, §7.4). The mission service delegates
 * these acts here; the shared reads are `MissionLookups`'.
 */
import type { Subject } from '../authority';
import { isStale, policyEntryOf, policyLineInputOf, statedPeriodOf } from '../budget';
import { toIso } from '../store/clock';
import type {
  MissionAccountInput,
  MissionRecord,
  MissionResourceSetInput,
  MissionResourceSetRecord,
} from '../store/types';
import type {
  DraftAccount,
  DraftResourceSet,
  IssuanceAccount,
  MissionDraft,
  MissionPreview,
  ResolvedDraftAccount,
  ResolvedDraftSet,
} from '../../lib/missions/model';
import { previewDraft } from '../../lib/missions/preview';
import { mintMissionToken, type TokenMinter } from './token';
import { issueTokenTo, type IssuedSecret } from './token-issuer';
import type { MissionLookups } from './mission-lookups';
import type {
  MissionServiceDeps,
  PreviewOptions,
  IssueOptions,
  IssueResult,
  MissionIssuedAudit,
} from './mission-views';

const COPY_SUFFIX = ' (copy)';

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

export class MissionIssuance {
  private readonly mint: TokenMinter;

  constructor(
    private readonly deps: MissionServiceDeps,
    private readonly lookups: MissionLookups,
  ) {
    this.mint = deps.mint ?? mintMissionToken;
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
    const accounts = withAssumedEnvs(await this.lookups.issuanceContext(user), options.assumedEnvs);
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
    const context = await this.lookups.issuanceContext(user);
    const preview = previewDraft({ accounts: context, now: this.deps.clock.now() }, draft);
    if (!preview.ok) return { ok: false, reason: 'refused', preview };
    const ceiling = await this.lookups.activeMissionCeiling();
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
      kit: await this.lookups.kitOf(mission, { secret: token.secret }),
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
    const mission = await this.lookups.ownMission(user, missionId);
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
      current.filter((r) => !isStale(r) && !this.lookups.isSelf(service, r)).map((r) => r.id),
    );
    return set.resourceIds.filter((id) => known.has(id));
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
}
