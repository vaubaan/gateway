/**
 * Who each event reaches (spec §4.2 bis "each to the one person concerned"), with the store's
 * reads faked: the creator, the owner or each member of the owning group, every
 * administrator; never a deactivated person; never the creator who revoked their own mission.
 */
import { describe, expect, it } from 'vitest';

import { createLogger } from '../logging';
import type { AccountRecord, MissionRecord, UserRecord } from '../store/types';
import { createBackgroundRunner } from './background';
import { createNotificationDispatch } from './dispatch';
import type { Notification } from './notification';

const logger = createLogger({ level: 'error', redact: (text) => text, write: () => undefined });

function user(id: string, status: UserRecord['status'] = 'active'): UserRecord {
  return {
    id,
    issuer: 'http://idp.test',
    subject: id,
    email: `${id}@example.com`,
    displayName: id,
    status,
    createdAt: '2026-11-01T00:00:00.000Z',
    lastLoginAt: null,
  } as UserRecord;
}

function setup() {
  const sent: Array<{ userId: string; notification: Notification }> = [];
  const users = new Map(
    ['ada', 'bob', 'cyd', 'gone'].map((id) => [id, user(id, id === 'gone' ? 'removed' : 'active')]),
  );
  const missions = new Map<string, Pick<MissionRecord, 'id' | 'name' | 'creatorUserId'>>([
    ['m1', { id: 'm1', name: 'Release train', creatorUserId: 'ada' }],
    ['m2', { id: 'm2', name: 'Old one', creatorUserId: 'gone' }],
  ]);
  const accounts = new Map<string, Pick<AccountRecord, 'id' | 'displayName' | 'owner'>>([
    ['c1', { id: 'c1', displayName: 'acme-org', owner: { kind: 'user', id: 'ada' } }],
    ['c2', { id: 'c2', displayName: 'team account', owner: { kind: 'group', id: 'g1' } }],
  ]);
  const runner = createBackgroundRunner(logger);
  const events = createNotificationDispatch({
    notifier: {
      async notify(userId, notification) {
        sent.push({ userId, notification });
      },
    },
    runner,
    missions: { getById: async (id) => (missions.get(id) as MissionRecord | undefined) ?? null },
    accounts: {
      getById: async (id) => (accounts.get(id) as AccountRecord | undefined) ?? null,
    },
    users: { getById: async (id) => users.get(id) ?? null },
    groups: { listMembers: async () => [user('bob'), user('cyd'), user('gone', 'removed')] },
    administrators: async () => ['cyd', 'gone'],
    instanceName: async () => 'Acme',
    toolTitle: (tool) => (tool === 'github__merge_pull_request' ? 'Merge a pull request' : null),
    logger,
  });
  const recipients = async () => {
    await runner.idle();
    return sent.map((s) => s.userId).sort();
  };
  return { events, sent, recipients, runner };
}

describe('notification dispatch', () => {
  it('tells the creator of a request, naming the tool by its title', async () => {
    const { events, sent, recipients } = setup();
    events.requestOpened({
      requestId: 'r1',
      missionId: 'm1',
      request: 'approval',
      tool: 'github__merge_pull_request',
    });
    expect(sent).toEqual([]); // nothing in the caller's turn
    expect(await recipients()).toEqual(['ada']);
    expect(sent[0]?.notification).toEqual({
      kind: 'request-opened',
      instance: 'Acme',
      request: 'approval',
      mission: 'Release train',
      tool: 'Merge a pull request',
      path: '/r/r1',
    });
  });

  it('tells the owner of an account, or each active member of the owning group', async () => {
    const { events, recipients, sent } = setup();
    events.accountNeedsReconnecting('c1');
    expect(await recipients()).toEqual(['ada']);
    sent.length = 0;
    events.accountNeedsReconnecting('c2');
    expect(await recipients()).toEqual(['bob', 'cyd']);
    expect(sent[0]?.notification.path).toBe('/accounts/c2');
  });

  it('tells the creator of a mission revoked or orphaned by someone else, never by themselves', async () => {
    const { events, recipients, sent } = setup();
    events.missionRevoked('m1', 'ada');
    expect(await recipients()).toEqual([]);
    events.missionRevoked('m1', 'bob');
    expect(await recipients()).toEqual(['ada']);
    sent.length = 0;
    events.missionOrphaned('m1', 'ada');
    expect(await recipients()).toEqual([]);
    events.missionOrphaned('m1', 'bob');
    expect(await recipients()).toEqual(['ada']);
  });

  it('tells the creator of a mission that lost an account through someone else, never through themselves', async () => {
    const { events, recipients, sent } = setup();
    events.missionAccountLost('m1', 'ada');
    expect(await recipients()).toEqual([]);
    events.missionAccountLost('m1', 'bob');
    expect(await recipients()).toEqual(['ada']);
    expect(sent[0]?.notification).toMatchObject({
      kind: 'mission-account-lost',
      path: '/missions/m1',
    });
  });

  it('tells every active administrator of a failed backup and of a recovery', async () => {
    const { events, recipients, sent } = setup();
    events.backupFailed();
    events.masterKeyRecovered();
    expect(await recipients()).toEqual(['cyd', 'cyd']);
    expect(sent.map((s) => s.notification.kind).sort()).toEqual([
      'backup-failed',
      'master-key-recovery',
    ]);
  });

  it('tells a deactivated person nothing, and survives what is not there', async () => {
    const { events, recipients } = setup();
    events.missionOrphaned('m2', 'bob');
    events.missionOrphaned('no-such-mission', 'bob');
    events.accountNeedsReconnecting('no-such-account');
    expect(await recipients()).toEqual([]);
  });
});
