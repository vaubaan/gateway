/**
 * Notifications over the real composition root (spec §4.2 bis), with a fake push transport:
 * a request opened in the creator's inbox reaches their device after the refusal is
 * answered and without being awaited by it; a request found open notifies nobody again; a
 * `410` drops the device; an act that orphans a mission tells its creator; whatever the
 * arguments of the refused call, no payload carries one of them — on any channel: the push
 * payload, the body posted to each kind of messaging address, the mail. The device routes refuse a
 * bearer and a foreign origin, and the audit names the device, never its subscription.
 */
import fc from 'fast-check';
import { propertyRuns } from '@vaubaan/plugin-sdk/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { budgetMissionOf, type BudgetMission } from '../../../src/server/budget';
import type { GatewayRoot } from '../../../src/server/compose/root';
import type { PushPayload } from '../../../src/server/notifications/notification';
import { DEVICES_MAX } from '../../../src/server/notifications';
import type { UserRecord } from '../../../src/server/store/types';
import {
  buildTestRoot,
  seedInstance,
  sessionHeaders,
  type SeededInstance,
} from '../missions/support';
import {
  browserSubscription,
  fakeMessagingFetch,
  fakeNoticeMailer,
  fakePushTransport,
  fakeResolver,
  WEBHOOKS,
  type FakeMessagingFetch,
  type FakePushTransport,
} from '../../support/notifications/testing';

const TOOL = 'github__merge_pull_request';
const READ = 'github.read-code';
const MERGE = 'github.merge-protected';
const DEVICES = 'https://gateway.example.com/api/notifications/devices';

/**
 * Every string of a posted body with the services' escaping undone (Slack's `&lt;`,
 * Discord's backslashes): an escaped argument must not slip past the check.
 */
function plainStrings(value: unknown): string[] {
  if (typeof value === 'string') {
    return [
      value
        .replace(/\\([\\*_~`|>[\]()#<@-])/g, '$1')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&'),
    ];
  }
  if (Array.isArray(value)) return value.flatMap(plainStrings);
  if (typeof value === 'object' && value !== null)
    return Object.values(value).flatMap(plainStrings);
  return [];
}

describe('notifications', () => {
  let root: GatewayRoot;
  let seeded: SeededInstance;
  let push: FakePushTransport;
  let web: FakeMessagingFetch;
  let mailer: ReturnType<typeof fakeNoticeMailer>;
  let mission: BudgetMission;

  beforeEach(async () => {
    push = fakePushTransport();
    web = fakeMessagingFetch();
    mailer = fakeNoticeMailer();
    root = await buildTestRoot({
      deps: {
        notificationTransport: push,
        notificationFetch: web.fetch,
        notificationResolve: fakeResolver(),
        notificationMailer: mailer,
      },
    });
    seeded = await seedInstance(root);
    const record = await root.store.missions.create({
      name: 'Release train',
      creatorUserId: seeded.ada.id,
      periodAnchor: '2026-11-01T00:00:00.000Z',
      periodSeconds: 86_400,
      expiresAt: null,
      connections: [{ connectionId: seeded.github.connection.id, resourceIds: [] }],
      policy: [
        { riskId: READ, quota: 10, rateLimit: 50, rateWindowSeconds: 60, gate: 'auto' },
        { riskId: MERGE, quota: 1000, rateLimit: 1000, rateWindowSeconds: 60, gate: 'approval' },
      ],
    });
    mission = budgetMissionOf(record);
  });
  afterEach(async () => {
    await root.close();
  });

  async function addDevice(user: UserRecord, token = 'device-1') {
    const result = await root.notifications.devices.add(user, {
      subscription: browserSubscription(token),
      label: 'Phone',
    });
    if (!result.ok) throw new Error(result.problem);
    return result.device;
  }

  const refusedMerge = (args: unknown) =>
    root.budget.recordCall({
      mission,
      tool: TOOL,
      args,
      risks_touched: [MERGE],
      agent_label: 'builder',
      now: new Date(),
    });

  const payloads = (): PushPayload[] => push.sent.map((s) => JSON.parse(s.payload) as PushPayload);

  it('tells the creator of an approval request, once, after the refusal returned', async () => {
    await addDevice(seeded.ada);
    let release = (): void => undefined;
    push.hold = new Promise((resolve) => (release = resolve));

    const result = await refusedMerge({ owner: 'acme', repo: 'app', pull_number: 1 });
    // The refusal is answered while the push service has not answered.
    expect(result.outcome).toBe('refused');
    expect(push.sent).toEqual([]);
    release();
    await root.notifications.idle();

    const requestId = result.outcome === 'refused' ? result.request_id : null;
    expect(payloads()).toEqual([
      {
        title: 'gateway.example.com',
        body: expect.stringContaining('Release train asks for your approval to') as string,
        url: `/r/${requestId}`,
        tag: `/r/${requestId}`,
      },
    ]);

    // The same call again finds its request open: nobody is told twice.
    await refusedMerge({ owner: 'acme', repo: 'app', pull_number: 1 });
    await root.notifications.idle();
    expect(push.sent).toHaveLength(1);
    const [device] = await root.notifications.devices.list(seeded.ada);
    expect(device?.last_delivered_at).not.toBeNull();
  });

  it('drops a device its push service no longer knows, and sends nothing to it after', async () => {
    await addDevice(seeded.ada);
    push.answer = { kind: 'gone', status: 410 };
    await refusedMerge({ pull_number: 2 });
    await root.notifications.idle();
    const [device] = await root.notifications.devices.list(seeded.ada);
    expect(device?.dropped_reason).toBe('gone');

    push.answer = { kind: 'delivered' };
    await refusedMerge({ pull_number: 3 });
    await root.notifications.idle();
    expect(push.sent).toHaveLength(1);
  });

  it('reaches nobody but the creator', async () => {
    await addDevice(seeded.bob, 'bob-phone');
    await refusedMerge({ pull_number: 4 });
    await root.notifications.idle();
    expect(push.sent).toEqual([]);
  });

  it('tells the creator whose mission another person orphaned, not the one who did it', async () => {
    // Bob creates a mission on Ada's account through a share; Ada's own mission is on it too.
    await root.shares.service.share({ user: seeded.ada, groups: [] }, seeded.github.connection.id, {
      target: { kind: 'user', email: seeded.bob.email },
      riskIds: [READ, MERGE],
    });
    const bobs = await root.store.missions.create({
      name: 'Bob reads',
      creatorUserId: seeded.bob.id,
      periodAnchor: '2026-11-01T00:00:00.000Z',
      periodSeconds: 86_400,
      expiresAt: null,
      connections: [{ connectionId: seeded.github.connection.id, resourceIds: [] }],
      policy: [{ riskId: READ, quota: 10, rateLimit: 50, rateWindowSeconds: 60, gate: 'auto' }],
    });
    await addDevice(seeded.ada, 'ada-phone');
    await addDevice(seeded.bob, 'bob-phone');
    await root.connections.service.revoke(
      { user: seeded.ada, groups: [] },
      seeded.github.connection.id,
    );
    await root.notifications.idle();
    expect(push.sent.map((s) => s.endpoint)).toEqual([
      'https://fcm.googleapis.com/fcm/send/bob-phone',
    ]);
    expect(payloads().map((p) => p.url)).toEqual([`/missions/${bobs.id}`]);
  });

  it('never carries an argument of the call, on any channel, whatever the arguments', async () => {
    await addDevice(seeded.ada);
    for (const kind of ['slack', 'teams', 'discord', 'ntfy', 'generic'] as const) {
      const added = await root.notifications.addresses.add(seeded.ada, {
        kind,
        label: kind,
        url: WEBHOOKS[kind],
      });
      expect(added.ok).toBe(true);
    }
    await root.notifications.mail.set(seeded.ada, true);
    // Every value is marked: the mark appears in no word of a notification.
    const marked = fc.string({ minLength: 1, maxLength: 40 }).map((s) => `ARG-${s}`);
    await fc.assert(
      fc.asyncProperty(
        fc.dictionary(fc.string({ minLength: 1, maxLength: 12 }), marked, {
          minKeys: 1,
          maxKeys: 5,
        }),
        async (args) => {
          push.sent.length = 0;
          web.sent.length = 0;
          mailer.sent.length = 0;
          await refusedMerge(args);
          await root.notifications.idle();
          expect(push.sent).toHaveLength(1);
          expect(web.sent).toHaveLength(5);
          expect(mailer.sent).toHaveLength(1);
          const outgoing = [
            ...push.sent.map((s) => s.payload),
            ...web.sent.flatMap((s) => plainStrings(s.json)),
            ...mailer.sent.map((m) => `${m.subject}\n${m.text}`),
          ];
          for (const text of outgoing) {
            expect(text).not.toContain('ARG-');
            for (const value of Object.values(args)) expect(text).not.toContain(value);
          }
        },
      ),
      // Each run goes through the store and the background runner: a few dozen suffice.
      { ...propertyRuns(), numRuns: Math.min(propertyRuns().numRuns, 25) },
    );
  });

  describe('the device routes', () => {
    it('add, rename and remove a device of the signed-in person, audited without the subscription', async () => {
      const subscription = browserSubscription('route-token-5be1');
      const added = await root.notifications.handlers.add(
        new Request(DEVICES, {
          method: 'POST',
          headers: await sessionHeaders(root, seeded.ada),
          body: JSON.stringify({ subscription, label: 'Pixel' }),
        }),
      );
      expect(added.status).toBe(201);
      const { device } = (await added.json()) as { device: { id: string } };

      const form = async (act: string, body: Record<string, string>) =>
        root.notifications.handlers[act === 'rename' ? 'rename' : 'remove'](
          new Request(`${DEVICES}/${device.id}/${act}`, {
            method: 'POST',
            headers: await sessionHeaders(root, seeded.ada, {
              'content-type': 'application/x-www-form-urlencoded',
            }),
            body: new URLSearchParams(body),
          }),
          device.id,
        );
      const renamed = await form('rename', { label: 'Work phone' });
      expect(renamed.headers.get('location')).toBe('/settings/notifications?done=renamed');
      expect((await root.notifications.devices.list(seeded.ada))[0]?.label).toBe('Work phone');
      const removed = await form('remove', {});
      expect(removed.headers.get('location')).toBe('/settings/notifications?done=removed');
      expect(await root.notifications.devices.list(seeded.ada)).toEqual([]);

      const trail = JSON.stringify(
        root.store.db
          .prepare("SELECT * FROM audit WHERE act IN ('device-added', 'device-removed')")
          .all(),
      );
      expect(trail).toContain('device-added');
      expect(trail).toContain('device-removed');
      expect(trail).not.toContain('route-token-5be1');
      expect(trail).not.toContain(subscription.keys.p256dh);
    });

    it('caps the devices of a person, and says a taken-over device in its former person’s trail', async () => {
      for (let i = 0; i < DEVICES_MAX; i += 1) await addDevice(seeded.ada, `ada-${i}`);
      const more = await root.notifications.devices.add(seeded.ada, {
        subscription: browserSubscription('ada-one-more'),
        label: 'Phone',
      });
      expect(more).toEqual({ ok: false, problem: 'too-many-devices' });

      await addDevice(seeded.bob, 'ada-0');
      expect(await root.notifications.devices.list(seeded.ada)).toHaveLength(DEVICES_MAX - 1);
      const evicted = root.store.db
        .prepare<[string], { user_id: string; after_json: string }>(
          "SELECT user_id, after_json FROM audit WHERE act = 'device-removed' AND object_id = ?",
        )
        .all(seeded.ada.id);
      expect(evicted).toHaveLength(1);
      expect(evicted[0]?.user_id).toBe(seeded.bob.id);
    });

    it('refuse a bearer, a foreign origin, nobody, and an endpoint that is no push service', async () => {
      const body = JSON.stringify({ subscription: browserSubscription(), label: 'Phone' });
      const headers = await sessionHeaders(root, seeded.ada);
      const post = (h: Headers, b = body) =>
        root.notifications.handlers.add(
          new Request(DEVICES, { method: 'POST', headers: h, body: b }),
        );

      const withBearer = new Headers(headers);
      withBearer.set('authorization', 'Bearer vbn_mission_token');
      expect((await post(withBearer)).status).toBe(403);
      const foreign = new Headers(headers);
      foreign.set('origin', 'https://evil.example');
      expect((await post(foreign)).status).toBe(403);
      const anonymous = new Headers({ origin: root.config.publicUrl.origin });
      expect((await post(anonymous)).status).toBe(401);

      const internal = { ...browserSubscription(), endpoint: 'https://169.254.169.254/latest' };
      const refused = await post(
        headers,
        JSON.stringify({ subscription: internal, label: 'Phone' }),
      );
      expect(refused.status).toBe(400);
      expect(await refused.json()).toMatchObject({ error: 'unsupported-push-service' });
      expect(await root.notifications.devices.list(seeded.ada)).toEqual([]);
    });
  });
});
