/**
 * A mission's creator edits it, previews the edit, reads its versions and restores one
 * (spec §4.3, versions: ADR mission-versions-kept-with-the-mission). The mission service
 * delegates these five acts here; the lookups they share are `MissionLookups` (`MissionEditHost`).
 */
import { parseRiskId, type RiskId } from '@vaubaan/shared';
import type { Subject } from '../authority';
import { isFinalLoss } from '../authority';
import { policyEntryOf, policyLineInputOf, statedPeriodOf } from '../budget';
import { revivesEndedMission } from '../limits';
import { toIso } from '../store/clock';
import type { MissionRecord, MissionVersionRecord } from '../store/types';
import {
  auditOfChanges,
  changeSummaryOf,
  draftOfSnapshot,
  hasChanges,
  judgeEdit,
  type EditJudgement,
  type MissionSnapshot,
  type MissionSnapshotAccount,
} from '../../lib/missions/mission-edit';
import { judgeRestore, type RestoreDropped } from '../../lib/missions/versions';
import {
  historyViewOf,
  type HistoryWords,
  type MissionHistoryView,
  type RestoreResult,
} from './history';
import type {
  IssueOptions,
  MissionEditView,
  EditPreviewResult,
  EditResult,
  MissionServiceDeps,
} from './mission-views';
import { parseMissionDraft } from './draft-schema';
import type { MissionDraft } from '../../lib/missions/model';
import { revisionOf } from '../../lib/missions/mission-edit';
import { gateEditBlockedBy } from './gate-edit';
import type { MissionLookups } from './mission-lookups';

/** The body of an edit: the edited draft and the revision it was made from. */
function parseEditBody(
  raw: unknown,
):
  | { readonly ok: true; readonly draft: MissionDraft; readonly revision: string }
  | { readonly ok: false; readonly problems: readonly string[] } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, problems: ['The edit is an object { draft, revision }.'] };
  }
  const body = raw as Record<string, unknown>;
  const extra = Object.keys(body).filter((key) => key !== 'draft' && key !== 'revision');
  if (extra.length > 0) {
    return { ok: false, problems: [`Unexpected field(s): ${extra.join(', ')}.`] };
  }
  if (
    typeof body.revision !== 'string' ||
    body.revision.length === 0 ||
    body.revision.length > 64
  ) {
    return { ok: false, problems: ['revision: the revision the edit was made from.'] };
  }
  const parsed = parseMissionDraft(body.draft);
  if (!parsed.ok) return { ok: false, problems: parsed.problems.map((p) => `draft.${p}`) };
  return { ok: true, draft: parsed.draft, revision: body.revision };
}

/** The revision of a stored mission, computed without IO (inside a store transaction too). */
function revisionOfRecord(mission: MissionRecord): string {
  return revisionOf({
    name: mission.name,
    expires_at: mission.expiresAt,
    period: statedPeriodOf(mission),
    accounts: mission.accounts.map((c) => ({
      account_id: c.accountId,
      resource_sets: c.resourceSets.map((set) => ({
        id: set.id,
        position: set.position,
        future: set.future,
        env: set.env,
        resource_ids: set.resourceIds,
      })),
    })),
    policy: mission.policy.map(policyEntryOf),
  });
}

/** What the edits read of the mission lookups: the lookups every act of a creator shares. */
export type MissionEditHost = Pick<
  MissionLookups,
  'issuanceContext' | 'ownMission' | 'ownInspected' | 'access' | 'activeMissionCeiling' | 'risksOf'
>;

export class MissionEdits {
  constructor(
    private readonly deps: MissionServiceDeps,
    private readonly host: MissionEditHost,
  ) {}

  /** The mission as everything an edit may move, its policy partitioned per account. */
  private async snapshotOf(mission: MissionRecord): Promise<MissionSnapshot> {
    const policy = mission.policy.map(policyEntryOf);
    const accounts: MissionSnapshotAccount[] = [];
    for (const c of mission.accounts) {
      const account = await this.deps.store.accounts.getById(c.accountId);
      accounts.push({
        account_id: c.accountId,
        service: account?.service ?? '',
        display_name: account?.displayName ?? c.accountId,
        resource_sets: c.resourceSets.map((set) => ({
          key: set.id,
          id: set.id,
          position: set.position,
          future: set.future,
          env: set.env,
          resource_ids: [...set.resourceIds],
          policy: policy.filter((entry) => entry.resource_set_id === set.id),
          ...(set.trustLevels ? { trust_levels: set.trustLevels } : {}),
        })),
      });
    }
    return {
      name: mission.name,
      expires_at: mission.expiresAt,
      period: statedPeriodOf(mission),
      accounts,
    };
  }

  /**
   * What the creator's edit form starts from: the mission as a snapshot and as a
   * draft, and its revision. `null` ("not found") for anyone but the creator.
   */
  async editView(user: Subject, missionId: string): Promise<MissionEditView | null> {
    const inspected = await this.host.ownInspected(user, missionId);
    if (!inspected) return null;
    const { mission, lost } = inspected;
    const snapshot = await this.snapshotOf(mission);
    return {
      mission,
      snapshot,
      draft: draftOfSnapshot(snapshot),
      revision: revisionOfRecord(mission),
      blocked: gateEditBlockedBy(mission),
      lost: lost.map((part) => ({
        account_id: part.accountId,
        cause: part.cause,
        final: isFinalLoss(part.cause),
      })),
    };
  }

  /** The judgement of an edit against the mission as it stands. */
  private async judged(user: Subject, missionId: string, raw: unknown) {
    const mission = await this.host.ownMission(user, missionId);
    if (!mission) return { ok: false as const, reason: 'not-found' as const };
    const blocked = gateEditBlockedBy(mission);
    if (blocked) return { ok: false as const, reason: 'inactive' as const, state: blocked };
    const body = parseEditBody(raw);
    if (!body.ok) {
      return { ok: false as const, reason: 'invalid-edit' as const, problems: body.problems };
    }
    const snapshot = await this.snapshotOf(mission);
    const accounts = await this.host.issuanceContext(user);
    const judgement = judgeEdit({ accounts, now: this.deps.clock.now() }, snapshot, body.draft);
    return {
      ok: true as const,
      mission,
      snapshot,
      judgement,
      asked: body.revision,
      revision: revisionOfRecord(mission),
    };
  }

  /** What an edit would change, or why it would be refused. Writes nothing. */
  async previewEdit(user: Subject, missionId: string, raw: unknown): Promise<EditPreviewResult> {
    const judged = await this.judged(user, missionId, raw);
    if (!judged.ok) return judged;
    const { judgement } = judged;
    return {
      ok: judgement.ok,
      issues: judgement.issues,
      notices: judgement.notices,
      changes: judgement.changes,
      revision: judged.revision,
    };
  }

  /**
   * The creator edits the mission after issuance, without limit on what moves but its
   * period (ADR mission-editable-after-issuance): `{ draft, revision }`, the edited
   * draft and the revision of the mission it was made from. Creator only — anyone
   * else is "not found". Through the `vaubaan` plugin (`options.issuedBy`) the
   * calling mission acts for its creator: the version it leaves names that mission
   * as its author and the audit entry carries `via_mission_id` (ADR
   * platform-management-is-a-plugin-on-the-execution-door, amendment 2026-11-16).
   * Revoked and orphaned missions are not edited; an expired one is.
   *
   * Judged by issuance's own check on what moves (`judgeEdit`): the creation's preview
   * under the creator's authority now, its issues kept when they are about something
   * the edit moves. Applied at once, in one store transaction (`MissionsRepo.edit`),
   * to the same token, session and counters; requests a removal makes moot are closed.
   * One `mission-changed` audit entry; an edit that moves nothing writes nothing.
   *
   * Between the authority check and the write, the creator's authority may go: the
   * mission then reads `orphaned` and serves nothing, as an issuance racing the same
   * revocation would.
   */
  async edit(
    user: Subject,
    missionId: string,
    raw: unknown,
    options: IssueOptions = {},
  ): Promise<EditResult> {
    const judged = await this.judged(user, missionId, raw);
    if (!judged.ok) return judged;
    const { mission, snapshot, judgement, revision } = judged;
    if (judged.asked !== revision) return { ok: false, reason: 'conflict' };
    if (!judgement.ok) {
      return { ok: false, reason: 'refused', issues: judgement.issues, changes: judgement.changes };
    }
    return this.writeEdit(user, mission, snapshot, judgement, revision, {
      ...(options.issuedBy ? { viaMissionId: options.issuedBy.missionId } : {}),
    });
  }

  /**
   * Writes a judged edit (an ordinary one, or a rollback's with `restoredFrom`): one
   * store transaction, which leaves one version of the mission when something moved,
   * then one `mission-changed` audit entry. An edit that moves nothing writes nothing.
   */
  private async writeEdit(
    user: Subject,
    mission: MissionRecord,
    snapshot: MissionSnapshot,
    judgement: EditJudgement,
    revision: string,
    stamp: { readonly restoredFrom?: number; readonly viaMissionId?: string } = {},
  ): Promise<EditResult> {
    const { restoredFrom, viaMissionId } = stamp;
    const { after, changes } = judgement;
    if (!hasChanges(changes)) return { ok: true, mission, changes, requests_closed: [] };
    if (revivesEndedMission(mission, after.expires_at, this.deps.clock.now())) {
      const ceiling = await this.host.activeMissionCeiling();
      if (ceiling) return ceiling;
    }

    const written = await this.deps.store.missions.edit(mission.id, {
      actorUserId: user.id,
      ...(restoredFrom !== undefined ? { restoredFrom } : {}),
      ...(viaMissionId !== undefined ? { viaMissionId } : {}),
      unchanged: (current) => revisionOfRecord(current) === revision,
      name: after.name,
      expiresAt: after.expires_at,
      accounts: after.accounts.map((c) => ({
        accountId: c.account_id,
        resourceSets: c.resource_sets.map((set) => ({
          ...(set.id !== null ? { id: set.id } : {}),
          resourceIds: [...set.resource_ids],
          future: set.future,
          env: set.env,
          ...(set.trust_levels && Object.keys(set.trust_levels).length > 0
            ? { trustLevels: set.trust_levels }
            : {}),
          policy: set.policy.map(policyLineInputOf),
        })),
      })),
      summary: (closed) => ({
        kind: 'mission-changed',
        actorUserId: user.id,
        details: changeSummaryOf(changes, closed),
      }),
    });
    if (!written) return { ok: false, reason: 'conflict' };
    const closed = written.closedRequests.map((r) => r.id);
    const audit = auditOfChanges(snapshot, after, changes);
    await this.deps.store.auditWriter.write({
      kind: 'admin',
      ts: toIso(this.deps.clock.now()),
      user_id: user.id,
      act: 'mission-changed',
      object: { type: 'mission', id: mission.id },
      before: audit.before,
      after: {
        ...audit.after,
        requests_closed: closed,
        ...(restoredFrom !== undefined ? { restored_from: restoredFrom } : {}),
      },
      via_mission_id: viaMissionId ?? null,
    });
    this.deps.logger.info(restoredFrom === undefined ? 'mission edited' : 'mission restored', {
      mission_id: mission.id,
      ...(viaMissionId !== undefined ? { via_mission_id: viaMissionId } : {}),
      ...(restoredFrom !== undefined ? { restored_from: restoredFrom } : {}),
      accounts_added: changes.accounts_added.length,
      accounts_removed: changes.accounts_removed.length,
      permissions_added: changes.permissions_added.length,
      permissions_removed: changes.permissions_removed.length,
      permissions_changed: changes.permissions_changed.length,
      requests_closed: closed.length,
    });
    return { ok: true, mission: written.mission, changes, requests_closed: closed };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // History and rollback (spec §4.2 "History")
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * The versions of the mission's configuration, newest first, worded: to its creator
   * and its current members (`access`); `null` ("not found") to anyone else.
   * `restorable` says whether this reader may restore a past version now — the rule of
   * an edit: the creator, on a mission neither revoked nor orphaned.
   */
  async history(user: Subject, missionId: string): Promise<MissionHistoryView | null> {
    const access = await this.host.access(user, missionId);
    if (!access) return null;
    const records = await this.deps.store.missionVersions.list(missionId);
    const words = await this.historyWords(records);
    return historyViewOf(records, words, {
      restorable: access.role === 'creator' && gateEditBlockedBy(access.mission) === null,
    });
  }

  /**
   * "Restore this version": the creator brings a past version of the configuration
   * back, as an edit judged against the mission now (`judgeRestore`, `judgeEdit`):
   * bounded by their authority today — an account, a resource or a permission they can
   * no longer give is left out, and said in `dropped`; an end already past keeps the
   * current one. Written as an edit, which leaves a NEW version (cause `rollback`,
   * restored from `number`): history is never rewritten. Keys, teammates and counters
   * are untouched. A version that is already the configuration writes nothing
   * (`version: null`).
   */
  async restore(user: Subject, missionId: string, number: number): Promise<RestoreResult> {
    const mission = await this.host.ownMission(user, missionId);
    if (!mission) return { ok: false, reason: 'not-found' };
    const blocked = gateEditBlockedBy(mission);
    if (blocked) return { ok: false, reason: 'inactive', state: blocked };
    const version = await this.deps.store.missionVersions.get(missionId, number);
    if (!version) return { ok: false, reason: 'not-found' };
    const snapshot = await this.snapshotOf(mission);
    const accounts = await this.host.issuanceContext(user);
    const restored = judgeRestore(
      { accounts, now: this.deps.clock.now() },
      snapshot,
      version.config,
    );
    const dropped = await this.droppedWords(restored.dropped, number);
    if (!restored.judgement.ok) {
      return { ok: false, reason: 'refused', issues: restored.judgement.issues, dropped };
    }
    const written = await this.writeEdit(
      user,
      mission,
      snapshot,
      restored.judgement,
      revisionOfRecord(mission),
      { restoredFrom: number },
    );
    if (!written.ok) return written.reason === 'refused' ? { ...written, dropped } : written;
    if (!hasChanges(written.changes)) {
      return { ok: true, mission: written.mission, version: null, restored_from: number, dropped };
    }
    const [latest] = await this.deps.store.missionVersions.list(missionId);
    return {
      ok: true,
      mission: written.mission,
      version: latest?.number ?? null,
      restored_from: number,
      dropped,
    };
  }

  /** The names the history is worded with: people, missions, accounts, resources, risks. */
  private async historyWords(records: readonly MissionVersionRecord[]): Promise<HistoryWords> {
    const people = new Map<string, string>();
    const missions = new Map<string, string>();
    const accounts = new Map<string, { service: string; display_name: string }>();
    const resources = new Map<string, string>();
    for (const record of records) {
      const author = record.author;
      if (author.kind !== 'gateway' && author.userId && !people.has(author.userId)) {
        const person = await this.deps.store.users.getById(author.userId);
        people.set(author.userId, person?.email ?? 'a former user');
      }
      if (author.kind === 'mission' && !missions.has(author.missionId)) {
        const issuer = await this.deps.store.missions.getById(author.missionId);
        missions.set(author.missionId, issuer?.name ?? 'a mission');
      }
      for (const c of record.config.accounts) {
        if (accounts.has(c.account_id)) continue;
        const account = await this.deps.store.accounts.getById(c.account_id);
        if (!account) continue;
        accounts.set(c.account_id, {
          service: account.service,
          display_name: account.displayName,
        });
        for (const r of await this.deps.store.accounts.listResources(c.account_id)) {
          resources.set(r.id, r.displayName);
        }
      }
    }
    return {
      personOf: (userId) => people.get(userId) ?? 'a former user',
      missionOf: (missionId) => missions.get(missionId) ?? 'a mission',
      accountOf: (accountId) => accounts.get(accountId),
      resourceName: (_accountId, resourceId) => resources.get(resourceId) ?? 'a former resource',
      riskLabel: (riskId) => this.riskLabelOf(riskId),
    };
  }

  /** A permission's label in its service's catalog; its id when the catalog no longer knows it. */
  private riskLabelOf(riskId: RiskId): string {
    const service = parseRiskId(riskId)?.service;
    if (!service) return riskId;
    return this.host.risksOf(service).find((r) => r.risk_id === riskId)?.label ?? riskId;
  }

  /** What a restore left out, in sentences. */
  private async droppedWords(dropped: RestoreDropped, number: number): Promise<string[]> {
    const lines: string[] = [];
    const accountName = async (id: string) =>
      (await this.deps.store.accounts.getById(id))?.displayName ?? 'an account removed since';
    for (const id of dropped.accounts) {
      lines.push(`${await accountName(id)} is left out: you no longer hold it, or it was revoked.`);
    }
    for (const r of dropped.resources) {
      const resource = (await this.deps.store.accounts.listResources(r.account_id)).find(
        (row) => row.id === r.resource_id,
      );
      lines.push(
        `${resource?.displayName ?? 'A resource'} on ${await accountName(r.account_id)} is left out: it no longer exists.`,
      );
    }
    for (const p of dropped.permissions) {
      lines.push(
        `${this.riskLabelOf(p.risk_id)} on ${await accountName(p.account_id)} is left out: you no longer hold it there.`,
      );
    }
    if (dropped.expiry_kept) {
      lines.push(`The end of version ${number} has passed: the current end is kept.`);
    }
    return lines;
  }
}
