/**
 * A mission closed for good, and who may close it (spec §2.3): `revoke`, and the
 * missions on an account its owner reads — the orphaned ones they may close, and every
 * one that carries it. The mission service delegates these acts here.
 */
import type { MissionLogEventDetails } from '@vaubaan/shared';

import type { Subject } from '../authority';
import { toIso } from '../store/clock';
import { takesFutureResources } from '../store/mission-reach';
import type { AccountRecord, MissionRecord } from '../store/types';
import type { MissionLookups } from './mission-lookups';
import type {
  MissionServiceDeps,
  IssueOptions,
  RevokeResult,
  OrphanedOnAccount,
  MissionOnAccount,
} from './mission-views';

/** Who may close a mission, and on what ground (spec §2.3). */
type Closer =
  { readonly as: 'creator' } | { readonly as: 'account-owner'; readonly accountId: string };

export class MissionClosing {
  constructor(
    private readonly deps: MissionServiceDeps,
    private readonly lookups: MissionLookups,
  ) {}

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
      const state = await this.lookups.stateOf(mission);
      const creator = await this.deps.store.users.getById(mission.creatorUserId);
      const membership = await this.lookups.membershipOf(mission, user.id);
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
}
