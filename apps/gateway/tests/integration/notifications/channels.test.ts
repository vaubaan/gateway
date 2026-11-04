/**
 * Messaging addresses and mail as channels, over the real composition root (spec §4.2 bis),
 * with a fake `fetch`, a fake resolver and a fake mailer: an address is kept only when its
 * test message is taken, stored sealed and never shown back, capped and deduplicated per
 * person, reached by the next notification with its delivery or failure recorded; mail goes
 * to the person's address only once they switched it on, and only on an instance that
 * delivers mail. The routes refuse a bearer and a foreign origin, and send the person back
 * with a status, never the URL.
 */
import { afterEach, describe, expect, it } from 'vitest';

import type { GatewayRoot } from '../../../src/server/compose/root';
import { ADDRESSES_MAX } from '../../../src/server/notifications';
import type { UserRecord } from '../../../src/server/store/types';
import {
  buildTestRoot,
  seedInstance,
  sessionHeaders,
  type SeededInstance,
} from '../missions/support';
import {
  fakeMessagingFetch,
  fakeNoticeMailer,
  fakePushTransport,
  fakeResolver,
  WEBHOOKS,
  type FakeMessagingFetch,
} from '../../support/notifications/testing';

const ADDRESSES = 'https://gateway.example.com/api/notifications/addresses';
const MAIL = 'https://gateway.example.com/api/notifications/mail';

interface Rig {
  readonly root: GatewayRoot;
  readonly seeded: SeededInstance;
  readonly web: FakeMessagingFetch;
  readonly mailer: ReturnType<typeof fakeNoticeMailer>;
}

let opened: GatewayRoot[] = [];
afterEach(async () => {
  for (const root of opened) await root.close();
  opened = [];
});

async function rig(options: { mail?: boolean; resolveTo?: string } = {}): Promise<Rig> {
  const web = fakeMessagingFetch();
  const mailer = fakeNoticeMailer();
  const root = await buildTestRoot({
    deps: {
      notificationTransport: fakePushTransport(),
      notificationFetch: web.fetch,
      notificationResolve: fakeResolver(options.resolveTo),
      ...(options.mail === false ? {} : { notificationMailer: mailer }),
    },
  });
  opened.push(root);
  return { root, seeded: await seedInstance(root), web, mailer };
}

async function missionOf(r: Rig, user: UserRecord): Promise<string> {
  const mission = await r.root.store.missions.create({
    name: 'Release train',
    creatorUserId: user.id,
    periodAnchor: '2026-11-01T00:00:00.000Z',
    periodSeconds: 86_400,
    expiresAt: null,
    connections: [{ connectionId: r.seeded.github.connection.id, resourceIds: [] }],
    policy: [
      { riskId: 'github.read-code', quota: 10, rateLimit: 50, rateWindowSeconds: 60, gate: 'auto' },
    ],
  });
  return mission.id;
}

/** Someone else stops Ada's mission: the one notification these tests send. */
async function notifyAda(r: Rig): Promise<void> {
  r.root.notifications.events.missionRevoked(await missionOf(r, r.seeded.ada), r.seeded.bob.id);
  await r.root.notifications.idle();
}

async function form(r: Rig, url: string, user: UserRecord, body: Record<string, string>) {
  const headers = await sessionHeaders(r.root, user, {
    'content-type': 'application/x-www-form-urlencoded',
  });
  return new Request(url, { method: 'POST', headers, body: new URLSearchParams(body) });
}

const add = async (r: Rig, kind: keyof typeof WEBHOOKS, url: string = WEBHOOKS[kind]) =>
  r.root.notifications.addresses.add(r.seeded.ada, { kind, label: `${kind} channel`, url });

describe('messaging addresses', () => {
  it('keeps an address whose test message was taken, sealed, and never shows it back', async () => {
    const r = await rig();
    const response = await r.root.notifications.handlers.addAddress(
      await form(r, ADDRESSES, r.seeded.ada, {
        kind: 'slack',
        label: 'Team',
        url: WEBHOOKS.slack,
      }),
    );
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/settings/notifications?done=address-added');

    // The test message: what an address receives, absolute link to the Settings page.
    expect(r.web.sent).toHaveLength(1);
    expect(r.web.sent[0]?.url).toBe(WEBHOOKS.slack);
    expect(String(r.web.sent[0]?.json.text)).toContain(
      'This address receives notifications of gateway.example.com.',
    );
    expect(String(r.web.sent[0]?.json.text)).toContain(
      'https://gateway.example.com/settings/notifications',
    );

    const [address] = await r.root.notifications.addresses.list(r.seeded.ada);
    expect(address).toMatchObject({ kind: 'slack', label: 'Team' });
    expect(address?.last_delivered_at).not.toBeNull();
    expect(JSON.stringify(address)).not.toContain('hooks.slack.com');

    // Sealed: the clear URL is in no row of any table; the audit names the address only.
    const tables = JSON.stringify(
      ['notification_addresses', 'audit'].map((t) =>
        r.root.store.db.prepare(`SELECT * FROM ${t}`).all(),
      ),
    );
    expect(tables).not.toContain('fixturefixturefixture');
    const trail = r.root.store.db
      .prepare<[], { after_json: string }>(
        "SELECT after_json FROM audit WHERE act = 'address-added'",
      )
      .all();
    expect(trail).toHaveLength(1);
    expect(JSON.parse(trail[0]?.after_json ?? '{}')).toEqual({
      address_id: address?.id,
      kind: 'slack',
      label: 'Team',
    });
  });

  it('keeps nothing when the test message is refused, and says the status, never the URL', async () => {
    const r = await rig();
    r.web.status = 500;
    const response = await r.root.notifications.handlers.addAddress(
      await form(r, ADDRESSES, r.seeded.ada, {
        kind: 'discord',
        label: 'Ops',
        url: WEBHOOKS.discord,
      }),
    );
    expect(response.headers.get('location')).toBe(
      '/settings/notifications?problem=test-failed&status=500',
    );
    expect(await r.root.notifications.addresses.list(r.seeded.ada)).toEqual([]);
    expect(
      r.root.store.db.prepare("SELECT COUNT(*) AS n FROM audit WHERE act = 'address-added'").get(),
    ).toEqual({ n: 0 });
  });

  it('refuses a free host that leads inside a private network, before anything leaves', async () => {
    const r = await rig({ resolveTo: '10.0.0.7' });
    expect(await add(r, 'ntfy', 'https://ntfy.acme.example/alerts')).toEqual({
      ok: false,
      problem: 'private-destination',
    });
    expect(await add(r, 'generic', 'https://169.254.169.254/latest/meta-data')).toEqual({
      ok: false,
      problem: 'private-destination',
    });
    expect(await add(r, 'generic', 'https://localhost/hook')).toEqual({
      ok: false,
      problem: 'private-destination',
    });
    expect(r.web.sent).toEqual([]);
  });

  it('refuses a URL that is not the vendor’s, without a request', async () => {
    const r = await rig();
    expect(await add(r, 'slack', 'https://hooks.example.com/services/x')).toEqual({
      ok: false,
      problem: 'wrong-host',
    });
    expect(r.web.sent).toEqual([]);
  });

  it('deduplicates an address per person, and caps a person at ten', async () => {
    const r = await rig();
    expect((await add(r, 'generic')).ok).toBe(true);
    expect(await add(r, 'generic')).toEqual({ ok: false, problem: 'already-added' });
    // Bob may add the same URL: the dedupe is per person.
    expect(
      (
        await r.root.notifications.addresses.add(r.seeded.bob, {
          kind: 'generic',
          label: 'Mine too',
          url: WEBHOOKS.generic,
        })
      ).ok,
    ).toBe(true);
    for (let i = 1; i < ADDRESSES_MAX; i += 1) {
      expect((await add(r, 'generic', `${WEBHOOKS.generic}/${i}`)).ok).toBe(true);
    }
    expect(await add(r, 'generic', `${WEBHOOKS.generic}/one-more`)).toEqual({
      ok: false,
      problem: 'too-many-addresses',
    });
  });

  it('reads another person’s address as missing', async () => {
    const r = await rig();
    const added = await add(r, 'ntfy');
    if (!added.ok) throw new Error(added.problem);
    const response = await r.root.notifications.handlers.removeAddress(
      await form(r, `${ADDRESSES}/${added.address.id}/remove`, r.seeded.bob, {}),
      added.address.id,
    );
    expect(response.headers.get('location')).toBe(
      '/settings/notifications?problem=address-not-found',
    );
    expect(await r.root.notifications.addresses.list(r.seeded.ada)).toHaveLength(1);

    const removed = await r.root.notifications.handlers.removeAddress(
      await form(r, `${ADDRESSES}/${added.address.id}/remove`, r.seeded.ada, {}),
      added.address.id,
    );
    expect(removed.headers.get('location')).toBe('/settings/notifications?done=address-removed');
    expect(await r.root.notifications.addresses.list(r.seeded.ada)).toEqual([]);
  });

  it('posts each notification to every address, recording a delivery and a failure', async () => {
    const r = await rig();
    for (const kind of ['slack', 'teams', 'discord', 'ntfy', 'generic'] as const) {
      expect((await add(r, kind)).ok).toBe(true);
    }
    r.web.sent.length = 0;
    await notifyAda(r);
    expect(r.web.sent.map((s) => s.url).sort()).toEqual(
      [
        WEBHOOKS.slack,
        WEBHOOKS.teams,
        WEBHOOKS.discord,
        'https://ntfy.sh/',
        WEBHOOKS.generic,
      ].sort(),
    );
    const generic = r.web.sent.find((s) => s.url === WEBHOOKS.generic);
    expect(generic?.json).toEqual({
      title: 'gateway.example.com',
      body: 'Release train was stopped by someone else.',
      url: expect.stringMatching(/^https:\/\/gateway\.example\.com\/missions\//) as string,
      kind: 'mission-revoked',
      instance: 'gateway.example.com',
    });

    r.web.status = 404;
    await notifyAda(r);
    const listed = await r.root.notifications.addresses.list(r.seeded.ada);
    expect(listed.every((a) => a.last_failure_status === 404 && a.last_failure_at !== null)).toBe(
      true,
    );
  });

  it('refuse a bearer, a foreign origin and nobody on the address and mail routes', async () => {
    const r = await rig();
    const headers = await sessionHeaders(r.root, r.seeded.ada, {
      'content-type': 'application/x-www-form-urlencoded',
    });
    const body = new URLSearchParams({ kind: 'slack', label: 'x', url: WEBHOOKS.slack });
    const post = (h: Headers, url = ADDRESSES) =>
      url === MAIL
        ? r.root.notifications.handlers.setMail(
            new Request(url, { method: 'POST', headers: h, body }),
          )
        : r.root.notifications.handlers.addAddress(
            new Request(url, { method: 'POST', headers: h, body }),
          );
    for (const url of [ADDRESSES, MAIL]) {
      const withBearer = new Headers(headers);
      withBearer.set('authorization', 'Bearer vbn_mission_token');
      expect((await post(withBearer, url)).status).toBe(403);
      const foreign = new Headers(headers);
      foreign.set('origin', 'https://evil.example');
      expect((await post(foreign, url)).status).toBe(403);
      expect(
        (await post(new Headers({ origin: r.root.config.publicUrl.origin }), url)).status,
      ).toBe(401);
    }
    expect(r.web.sent).toEqual([]);
  });
});

describe('mail', () => {
  it('sends a mail to the person’s address only once they switched it on, audited', async () => {
    const r = await rig();
    expect(await r.root.notifications.mail.status(r.seeded.ada)).toEqual({
      kind: 'available',
      address: 'ada@example.com',
      on: false,
    });
    await notifyAda(r);
    expect(r.mailer.sent).toEqual([]);

    const on = await r.root.notifications.handlers.setMail(
      await form(r, MAIL, r.seeded.ada, { mail: 'on' }),
    );
    expect(on.headers.get('location')).toBe('/settings/notifications?done=mail-on');
    await notifyAda(r);
    expect(r.mailer.sent).toEqual([
      {
        to: 'ada@example.com',
        subject: 'Something stopped without you',
        text: expect.stringContaining('Release train was stopped by someone else.') as string,
      },
    ]);
    expect(r.mailer.sent[0]?.text).toMatch(/https:\/\/gateway\.example\.com\/missions\//);

    const off = await r.root.notifications.handlers.setMail(
      await form(r, MAIL, r.seeded.ada, { mail: 'off' }),
    );
    expect(off.headers.get('location')).toBe('/settings/notifications?done=mail-off');
    await notifyAda(r);
    expect(r.mailer.sent).toHaveLength(1);

    const trail = r.root.store.db
      .prepare<[], { before_json: string; after_json: string }>(
        "SELECT before_json, after_json FROM audit WHERE act = 'mail-notifications-changed' ORDER BY rowid",
      )
      .all();
    const parsed = (text: string): unknown => JSON.parse(text);
    expect(trail.map((t) => [parsed(t.before_json), parsed(t.after_json)])).toEqual([
      [{ on: false }, { on: true }],
      [{ on: true }, { on: false }],
    ]);
    expect(JSON.stringify(trail)).not.toContain('ada@example.com');
  });

  it('is no channel on an instance that delivers no mail', async () => {
    const r = await rig({ mail: false });
    expect(await r.root.notifications.mail.status(r.seeded.ada)).toEqual({ kind: 'unavailable' });
    const response = await r.root.notifications.handlers.setMail(
      await form(r, MAIL, r.seeded.ada, { mail: 'on' }),
    );
    expect(response.headers.get('location')).toBe(
      '/settings/notifications?problem=mail-unavailable',
    );
  });

  it('counts a person’s channels for an administrator: devices, addresses and mail on', async () => {
    const r = await rig();
    await add(r, 'slack');
    await add(r, 'ntfy');
    await r.root.notifications.mail.set(r.seeded.ada, true);
    const counts = await r.root.notifications.channelCounts();
    expect(counts.get(r.seeded.ada.id)).toBe(3);
    expect(counts.get(r.seeded.bob.id)).toBeUndefined();
  });
});
