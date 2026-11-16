/**
 * What a notification says (spec §4.2 bis): the instance, the kind, the mission's or account's
 * name and the tool; where it leads; nothing else, and one short line per name.
 */
import { describe, expect, it } from 'vitest';

import { buildPayload, NAME_MAX, serializePayload, type Notification } from './notification';

const INSTANCE = 'Acme gateway';

describe('notification payload', () => {
  it('words a request with the mission and the tool, and leads to the request page', () => {
    const payload = buildPayload({
      kind: 'request-opened',
      instance: INSTANCE,
      request: 'approval',
      mission: 'Release train',
      tool: 'Merge a pull request',
      path: '/r/req-1',
    });
    expect(payload).toEqual({
      title: INSTANCE,
      body: 'Release train asks for your approval to Merge a pull request. Open it to answer.',
      url: '/r/req-1',
      tag: '/r/req-1',
    });
  });

  it('words every kind', () => {
    const cases: Notification[] = [
      {
        kind: 'request-opened',
        instance: INSTANCE,
        request: 'claim',
        mission: 'M',
        tool: null,
        path: '/r/a',
      },
      {
        kind: 'request-opened',
        instance: INSTANCE,
        request: 'permission',
        mission: 'M',
        tool: 't',
        path: '/r/b',
      },
      {
        kind: 'account-needs-reconnecting',
        instance: INSTANCE,
        account: 'acme-org',
        path: '/accounts/c',
      },
      { kind: 'mission-orphaned', instance: INSTANCE, mission: 'M', path: '/missions/d' },
      { kind: 'mission-account-lost', instance: INSTANCE, mission: 'M', path: '/missions/f' },
      { kind: 'mission-revoked', instance: INSTANCE, mission: 'M', path: '/missions/e' },
      { kind: 'backup-failed', instance: INSTANCE, path: '/admin/encryption' },
      { kind: 'master-key-recovery', instance: INSTANCE, path: '/admin/users' },
    ];
    const bodies = cases.map((n) => buildPayload(n).body);
    expect(new Set(bodies).size).toBe(cases.length);
    for (const body of bodies) expect(body.length).toBeGreaterThan(0);
  });

  it('keeps a name to one short line', () => {
    const long = `Mission\nwith ${'x'.repeat(200)}`;
    const { body } = buildPayload({
      kind: 'mission-orphaned',
      instance: INSTANCE,
      mission: long,
      path: '/missions/a',
    });
    expect(body).not.toContain('\n');
    expect(body.split(' stopped')[0]?.length).toBe(NAME_MAX);
  });

  it('serializes to the four fields the service worker reads, and nothing more', () => {
    const json = JSON.parse(
      serializePayload({ kind: 'backup-failed', instance: INSTANCE, path: '/admin/encryption' }),
    ) as Record<string, unknown>;
    expect(Object.keys(json).sort()).toEqual(['body', 'tag', 'title', 'url']);
  });
});
