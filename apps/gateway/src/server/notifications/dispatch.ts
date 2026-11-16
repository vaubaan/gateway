/**
 * From an event to the people it concerns (spec §4.2 bis "What notifies, each to the one
 * person concerned"): who, and what to say, read from the store when the event happened.
 * Every method returns at once; the reads and the deliveries run in the background
 * runner, and nothing they do reaches the caller.
 *
 *   request opened                → the mission's creator
 *   account needs reconnecting    → its owner (each member of an owning group)
 *   mission orphaned by another   → its creator
 *   account lost by another       → the mission's creator
 *   mission revoked by another    → its creator
 *   backup failed                 → every administrator
 *   master-key recovery           → every administrator
 *
 * A person who was deactivated is told nothing.
 */
import type { Logger } from '../logging';
import { requestPath } from '../requests/url';
import type { AccountRecord, MissionRecord, Principal, UserRecord } from '../store/types';
import type { BackgroundRunner } from './background';
import type { NotificationEvents } from './events';
import type { Notification, NotificationBody } from './notification';
import type { Notifier } from './notifier';

/** Where a notification leads, other than a request: the pages of the interface. */
export const NOTIFICATION_PATHS = {
  mission: (id: string) => `/missions/${encodeURIComponent(id)}`,
  account: (id: string) => `/accounts/${encodeURIComponent(id)}`,
  backup: '/admin/encryption',
  administrators: '/admin/users',
} as const;

export interface DispatchDeps {
  readonly notifier: Notifier;
  readonly runner: BackgroundRunner;
  readonly missions: { getById(id: string): Promise<MissionRecord | null> };
  readonly accounts: { getById(id: string): Promise<AccountRecord | null> };
  readonly users: { getById(id: string): Promise<UserRecord | null> };
  readonly groups: { listMembers(groupId: string): Promise<UserRecord[]> };
  /** Every administrator's user id. */
  readonly administrators: () => Promise<readonly string[]>;
  /** The instance's name, or the host of its public URL. */
  readonly instanceName: () => Promise<string>;
  /** The tool's title from its plugin, `null` when it gives none. */
  readonly toolTitle: (tool: string) => string | null;
  readonly logger: Logger;
}

export function createNotificationDispatch(deps: DispatchDeps): NotificationEvents {
  const { runner } = deps;

  async function active(userIds: readonly string[]): Promise<string[]> {
    const out: string[] = [];
    for (const id of new Set(userIds)) {
      if ((await deps.users.getById(id))?.status === 'active') out.push(id);
    }
    return out;
  }

  async function membersOf(owner: Principal): Promise<string[]> {
    if (owner.kind === 'user') return [owner.id];
    return (await deps.groups.listMembers(owner.id)).map((member) => member.id);
  }

  /** Resolves who and what in the background, then one delivery per person. */
  function send(
    name: string,
    resolve: () => Promise<{ to: string[]; draft: NotificationBody } | null>,
  ): void {
    runner.run(name, async () => {
      const resolved = await resolve();
      if (!resolved) return;
      const recipients = await active(resolved.to);
      if (recipients.length === 0) return;
      const notification: Notification = {
        ...resolved.draft,
        instance: await deps.instanceName(),
      };
      for (const userId of recipients) {
        runner.run(`${name}:deliver`, () => deps.notifier.notify(userId, notification));
      }
    });
  }

  /** The creator of the mission, unless the act was theirs: they know it already. */
  async function missionNotice(
    missionId: string,
    kind: 'mission-orphaned' | 'mission-account-lost' | 'mission-revoked',
    actorId: string,
  ): Promise<{ to: string[]; draft: NotificationBody } | null> {
    const mission = await deps.missions.getById(missionId);
    if (!mission || mission.creatorUserId === actorId) return null;
    return {
      to: [mission.creatorUserId],
      draft: { kind, mission: mission.name, path: NOTIFICATION_PATHS.mission(mission.id) },
    };
  }

  return {
    requestOpened(event) {
      send('request-opened', async () => {
        const mission = await deps.missions.getById(event.missionId);
        if (!mission) return null;
        const tool = event.tool === null ? null : (deps.toolTitle(event.tool) ?? event.tool);
        return {
          to: [mission.creatorUserId],
          draft: {
            kind: 'request-opened',
            request: event.request,
            mission: mission.name,
            tool,
            path: requestPath(event.requestId),
          },
        };
      });
    },
    accountNeedsReconnecting(accountId) {
      send('account-needs-reconnecting', async () => {
        const account = await deps.accounts.getById(accountId);
        if (!account) return null;
        return {
          to: await membersOf(account.owner),
          draft: {
            kind: 'account-needs-reconnecting',
            account: account.displayName,
            path: NOTIFICATION_PATHS.account(account.id),
          },
        };
      });
    },
    missionOrphaned(missionId, actorId) {
      send('mission-orphaned', () => missionNotice(missionId, 'mission-orphaned', actorId));
    },
    missionAccountLost(missionId, actorId) {
      send('mission-account-lost', () => missionNotice(missionId, 'mission-account-lost', actorId));
    },
    missionRevoked(missionId, actorId) {
      send('mission-revoked', () => missionNotice(missionId, 'mission-revoked', actorId));
    },
    backupFailed() {
      send('backup-failed', async () => ({
        to: [...(await deps.administrators())],
        draft: { kind: 'backup-failed', path: NOTIFICATION_PATHS.backup },
      }));
    },
    masterKeyRecovered() {
      send('master-key-recovery', async () => ({
        to: [...(await deps.administrators())],
        draft: { kind: 'master-key-recovery', path: NOTIFICATION_PATHS.administrators },
      }));
    },
  };
}
