/**
 * `events.agent_label` (migration 0008): the label of a call event is a column
 * the session timeline filters on (spec §7.9). The backfill of rows written by
 * an earlier image, the copy made at insert, and the filtered keyset read.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MEMORY_PATH, openDb, type StoreDb } from '../../../src/server/store/db.ts';
import { loadMigrations, runMigrations } from '../../../src/server/store/migrate.ts';
import {
  agentLabelColumn,
  CALL_EVENT_KINDS,
} from '../../../src/server/store/repositories/sessions.ts';
import { openTestStore, type TestStore } from '../../support/store/testing.ts';

const AT = '2026-10-13T08:00:00.000Z';

const labelsOf = (db: StoreDb) =>
  db
    .prepare<[], { id: string; agent_label: string | null }>(
      'SELECT id, agent_label FROM events ORDER BY id',
    )
    .all();

describe('events.agent_label', () => {
  let t: TestStore;

  beforeEach(() => {
    t = openTestStore();
  });
  afterEach(async () => {
    await t.store.close();
  });

  async function openSession(): Promise<string> {
    const user = await t.store.users.upsertFromIdp({
      issuer: 'http://idp.test',
      subject: 's',
      email: 'ada@example.com',
    });
    const connection = await t.store.connections.create({
      provider: 'github',
      owner: { kind: 'user', id: user.id },
      displayName: 'gh',
      credential: null,
    });
    const mission = await t.store.missions.create({
      name: 'Labels',
      creatorUserId: user.id,
      periodAnchor: AT,
      periodSeconds: 86_400,
      connections: [{ connectionId: connection.id, resourceIds: [] }],
      policy: [
        {
          riskId: 'github.code-read',
          quota: 10,
          rateLimit: 5,
          rateWindowSeconds: 60,
          gate: 'auto',
        },
      ],
    });
    return (await t.store.sessions.getOrCreate(mission.id)).id;
  }

  it('backfills the events an earlier image stored, call events only', () => {
    const db = openDb({ path: MEMORY_PATH });
    try {
      const shipped = loadMigrations();
      runMigrations(
        db,
        shipped.filter((m) => m.version < 8),
        t.clock,
      );
      db.prepare(
        "INSERT INTO users (id, subject, email, status, created_at) VALUES ('u', 's', 'u@x', 'active', ?)",
      ).run(AT);
      db.prepare(
        `INSERT INTO missions (id, name, creator_user_id, status, period_anchor, created_at, updated_at)
         VALUES ('m', 'mission', 'u', 'active', ?, ?, ?)`,
      ).run(AT, AT, AT);
      db.prepare("INSERT INTO sessions (id, mission_id, created_at) VALUES ('s', 'm', ?)").run(AT);
      const insert = db.prepare(
        "INSERT INTO events (id, session_id, ts, kind, details_json) VALUES (?, 's', ?, ?, ?)",
      );
      const call = (label: unknown) => JSON.stringify({ tool: 't', agent_label: label });
      insert.run('1-labelled', AT, 'call-allowed', call('coder'));
      insert.run('2-refused', AT, 'call-refused', call('reviewer'));
      insert.run('3-unlabelled', AT, 'call-allowed', call(null));
      insert.run('4-empty', AT, 'call-allowed', call(''));
      insert.run('5-not-text', AT, 'call-allowed', call(7));
      insert.run('6-no-key', AT, 'call-allowed', JSON.stringify({ tool: 't' }));
      insert.run('7-not-a-call', AT, 'rotation', call('coder'));
      insert.run('8-malformed', AT, 'call-allowed', '{"agent_label": "coder"');
      insert.run('9-no-details', AT, 'call-refused', null);

      runMigrations(db, shipped, t.clock);

      expect(labelsOf(db)).toEqual([
        { id: '1-labelled', agent_label: 'coder' },
        { id: '2-refused', agent_label: 'reviewer' },
        { id: '3-unlabelled', agent_label: null },
        { id: '4-empty', agent_label: null },
        { id: '5-not-text', agent_label: null },
        { id: '6-no-key', agent_label: null },
        { id: '7-not-a-call', agent_label: null },
        { id: '8-malformed', agent_label: null },
        { id: '9-no-details', agent_label: null },
      ]);
      // The details are left as written.
      expect(
        db
          .prepare<[], { details_json: string }>(
            "SELECT details_json FROM events WHERE id = '1-labelled'",
          )
          .get()?.details_json,
      ).toBe(call('coder'));
      const indexes = db
        .prepare<[], { name: string }>("SELECT name FROM pragma_index_list('events')")
        .all()
        .map((row) => row.name);
      expect(indexes).toContain('events_session_label_ts');
    } finally {
      db.close();
    }
  });

  it('the copy made at insert follows the rule of the backfill', async () => {
    expect(CALL_EVENT_KINDS).toEqual(['call-allowed', 'call-refused']);
    const label = (kind: string, details: object | null) => agentLabelColumn({ kind, details });
    expect(label('call-allowed', { agent_label: 'coder' })).toBe('coder');
    expect(label('call-refused', { agent_label: 'coder' })).toBe('coder');
    expect(label('call-allowed', { agent_label: null })).toBeNull();
    expect(label('call-allowed', { agent_label: '' })).toBeNull();
    expect(label('call-allowed', { agent_label: 7 })).toBeNull();
    expect(label('call-allowed', {})).toBeNull();
    expect(label('call-allowed', null)).toBeNull();
    expect(label('rotation', { agent_label: 'coder' })).toBeNull();

    const sessionId = await openSession();
    const stored = await t.store.sessions.recordEvent(sessionId, {
      kind: 'call-refused',
      details: { tool: 't', agent_label: 'coder' },
    });
    await t.store.sessions.recordEvent(sessionId, {
      kind: 'rotation',
      details: { agent_label: 'coder' },
    });
    expect(labelsOf(t.store.db).map((row) => row.agent_label)).toEqual(['coder', null]);
    // The record is read back from the details, as before: the column is not on it.
    expect(stored.details).toEqual({ tool: 't', agent_label: 'coder' });
    expect(stored).not.toHaveProperty('agentLabel');
  });

  it('reads the calls of one label, or the unlabelled ones, newest first by keyset', async () => {
    const sessionId = await openSession();
    const { sessions } = t.store;
    const ids: Record<string, string[]> = { coder: [], other: [], none: [] };
    for (let i = 0; i < 4; i++) {
      for (const [key, label] of [
        ['coder', 'coder'],
        ['other', 'other'],
        ['none', null],
      ] as const) {
        const event = await sessions.recordEvent(sessionId, {
          kind: i % 2 === 0 ? 'call-allowed' : 'call-refused',
          details: { tool: 't', agent_label: label },
        });
        ids[key]?.push(event.id);
      }
      // Not a call: in no filtered read, whatever its details say.
      await sessions.recordEvent(sessionId, { kind: 'request', details: { agent_label: 'coder' } });
    }
    const newestFirst = (key: string) => [...(ids[key] ?? [])].reverse();
    const idsOf = async (options: Parameters<typeof sessions.listRecentEvents>[1]) =>
      (await sessions.listRecentEvents(sessionId, options)).map((e) => e.id);

    expect(await idsOf({ limit: 100 })).toHaveLength(16);
    expect(await idsOf({ limit: 100, calls: { agentLabel: 'coder' } })).toEqual(
      newestFirst('coder'),
    );
    expect(await idsOf({ limit: 100, calls: { agentLabel: null } })).toEqual(newestFirst('none'));
    expect(await idsOf({ limit: 100, calls: { agentLabel: 'nobody' } })).toEqual([]);

    // Keyset: a page of 3, then what is older than its last event.
    const page = await sessions.listRecentEvents(sessionId, {
      limit: 3,
      calls: { agentLabel: 'coder' },
    });
    expect(page.map((e) => e.id)).toEqual(newestFirst('coder').slice(0, 3));
    const last = page.at(-1);
    if (!last) throw new Error('expected a page');
    const before = { ts: last.ts, id: last.id };
    expect(await idsOf({ limit: 3, before, calls: { agentLabel: 'coder' } })).toEqual(
      newestFirst('coder').slice(3),
    );
    expect(await idsOf({ limit: 3, before, calls: { agentLabel: null } })).toEqual(
      newestFirst('none').slice(3),
    );

    // Another session's events are never in the read.
    expect(
      await sessions.listRecentEvents('no-such-session', {
        limit: 10,
        calls: { agentLabel: 'coder' },
      }),
    ).toEqual([]);
  });
});
