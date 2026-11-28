/**
 * The reads of the Missions pages (spec §4.2 "Missions"): the missions a user can read,
 * one mission's detail, and a stored mission as it stands now. The mission service
 * delegates these reads here.
 */
import { lineKeyOf, type Iso8601, type PolicyLineKey } from '@vaubaan/shared';

import type { Subject } from '../authority';
import { isFinalLoss } from '../authority';
import { policyEntryOf, statedPeriodOf, type MissionState } from '../budget';
import type { MissionRecord, MissionTokenRecord } from '../store/types';
import type { MissionIssuer } from '../../lib/missions/model';
import { gateEditBlockedBy } from './gate-edit';
import type { MissionLookups } from './mission-lookups';
import type { MissionTrustRaises } from './mission-trust-raises';
import type {
  MissionServiceDeps,
  MissionAccess,
  MissionOverview,
  MissionDetailRisk,
  MissionDetail,
} from './mission-views';

export class MissionReads {
  constructor(
    private readonly deps: MissionServiceDeps,
    private readonly lookups: MissionLookups,
    private readonly trustRaises: Pick<MissionTrustRaises, 'trustRaisesOf'>,
  ) {}

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
        if (role === 'member' && (await this.lookups.membershipOf(mission, user.id)) !== 'member') {
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
    const inspected = await this.lookups.access(user, missionId);
    if (!inspected) return null;
    const { mission } = inspected;
    const issuers = await this.issuersOf([mission]);
    const overview = await this.overviewOf(inspected, user, issuers.get(mission.id) ?? null);
    const accounts = await this.lookups.detailAccounts(mission, inspected.lost);
    const remaining = overview.state.kind === 'active' ? overview.state.remaining : null;
    const rows = this.lookups.catalogRowsOf(accounts);
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
        ? await this.lookups.kitOf(mission, { prefix: overview.token.prefix }, accounts)
        : null,
      trust_raises:
        inspected.role === 'creator' && overview.state.kind === 'active'
          ? await this.trustRaises.trustRaisesOf(mission)
          : [],
    };
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
    return state.kind === 'active' ? this.lookups.openGatesIn(mission, state.period) : new Map();
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
      state: await this.lookups.stateOf(mission),
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
   * A stored mission as it stands now, for a reader the caller already scoped (the
   * Overview of Activity reads the missions of the Timeline's scope): its derived status
   * (`orphaned` while its authority is missing) and its state with the period's
   * remaining budget. Reads only; no authority check of the reader here.
   */
  async standing(
    stored: MissionRecord,
  ): Promise<{ readonly mission: MissionRecord; readonly state: MissionState }> {
    const { mission } = await this.deps.grounds.inspect(stored);
    return { mission, state: await this.lookups.stateOf(mission) };
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
}
