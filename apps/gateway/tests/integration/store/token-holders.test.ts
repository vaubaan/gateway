/**
 * Migration 0010 — one holder per mission token, and who called (spec §0 "Mission
 * token", §8 "the token used and its holder"; ADR mission-members-and-per-holder-tokens).
 *
 *   - a token an earlier image issued becomes a member token of its mission's creator,
 *     same id, prefix, hash and status: the Bearer in use keeps working;
 *   - the audit entries and the events written before keep no holder (the audit is
 *     append-only), and the reads count them apart instead of guessing;
 *   - a call event's `token_kind` / `token_holder` columns are copies of its details,
 *     and the timeline of one holder is a keyset read on them.
 */
import type { CallAuditEntry } from '@vaubaan/gateway-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MEMORY_PATH, openDb } from '../../../src/server/store/db.ts';
import { loadMigrations, runMigrations } from '../../../src/server/store/migrate.ts';
import { holderColumns } from '../../../src/server/store/repositories/sessions.ts';
import { openTestStore, type TestStore } from '../../support/store/testing.ts';

const AT = '2026-10-13T08:00:00.000Z';
const READ = 'github.code-read';

describe('token holders (migration 0010)', () => {
  let t: TestStore;

  beforeEach(() => {
    t = openTestStore();
  });
  afterEach(async () => {
    await t.store.close();
  });

  it('turns every token an earlier image issued into a member token of the creator, unchanged otherwise', () => {
    const db = openDb({ path: MEMORY_PATH });
    try {
      const shipped = loadMigrations();
      runMigrations(
        db,
        shipped.filter((m) => m.version < 10),
        t.clock,
      );
      const user = db.prepare(
        "INSERT INTO users (id, subject, email, status, created_at) VALUES (?, ?, ?, 'active', ?)",
      );
      user.run('ada', 's-ada', 'ada@x', AT);
      user.run('bob', 's-bob', 'bob@x', AT);
      const mission = db.prepare(
        `INSERT INTO missions (id, name, creator_user_id, status, period_anchor, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      mission.run('m-ada', 'Ada', 'ada', 'active', AT, AT, AT);
      mission.run('m-bob', 'Bob', 'bob', 'revoked', AT, AT, AT);
      const token = db.prepare(
        `INSERT INTO mission_tokens (id, mission_id, prefix, hash, hash_alg, status, created_at, retired_at)
         VALUES (?, ?, ?, ?, 'argon2id', ?, ?, ?)`,
      );
      token.run('t1', 'm-ada', 'aaaa1111', 'hash-1', 'rotated', AT, '2026-10-13T09:00:00.000Z');
      token.run('t2', 'm-ada', 'bbbb2222', 'hash-2', 'active', '2026-10-13T09:00:00.000Z', null);
      token.run('t3', 'm-bob', 'cccc3333', 'hash-3', 'revoked', AT, '2026-10-13T10:00:00.000Z');
      db.prepare(
        `INSERT INTO audit (id, ts, kind, mission_id, tool, arguments_hash, decision)
         VALUES ('a1', ?, 'call', 'm-ada', 'github__get_file', 'abc', 'allowed')`,
      ).run(AT);

      // Up to 0026: 0027 revokes the argon2id rows this era stored (its own test).
      runMigrations(
        db,
        shipped.filter((m) => m.version < 27),
        t.clock,
      );

      expect(
        db
          .prepare(
            `SELECT id, mission_id, prefix, hash, hash_alg, status, kind, holder_user_id, name,
                    created_by, created_at, retired_at, last_used_at
             FROM mission_tokens ORDER BY id`,
          )
          .all(),
      ).toEqual([
        {
          id: 't1',
          mission_id: 'm-ada',
          prefix: 'aaaa1111',
          hash: 'hash-1',
          hash_alg: 'argon2id',
          status: 'rotated',
          kind: 'member',
          holder_user_id: 'ada',
          name: null,
          created_by: 'ada',
          created_at: AT,
          retired_at: '2026-10-13T09:00:00.000Z',
          last_used_at: null,
        },
        {
          id: 't2',
          mission_id: 'm-ada',
          prefix: 'bbbb2222',
          hash: 'hash-2',
          hash_alg: 'argon2id',
          status: 'active',
          kind: 'member',
          holder_user_id: 'ada',
          name: null,
          created_by: 'ada',
          created_at: '2026-10-13T09:00:00.000Z',
          retired_at: null,
          last_used_at: null,
        },
        {
          id: 't3',
          mission_id: 'm-bob',
          prefix: 'cccc3333',
          hash: 'hash-3',
          hash_alg: 'argon2id',
          status: 'revoked',
          kind: 'member',
          holder_user_id: 'bob',
          name: null,
          created_by: 'bob',
          created_at: AT,
          retired_at: '2026-10-13T10:00:00.000Z',
          last_used_at: null,
        },
      ]);
      // No member row is written for a creator: they are a member by construction.
      expect(db.prepare('SELECT COUNT(*) AS n FROM mission_members').get()).toEqual({ n: 0 });
      // The audit is append-only: an entry written before keeps no holder.
      expect(
        db.prepare("SELECT token_id, token_kind, token_holder FROM audit WHERE id = 'a1'").get(),
      ).toEqual({ token_id: null, token_kind: null, token_holder: null });
      // The old "one active token per mission" index is gone with the old table.
      const indexes = db
        .prepare<[], { name: string }>(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'mission_tokens' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .all()
        .map((i) => i.name);
      expect(indexes).toEqual([
        'mission_tokens_holder',
        'mission_tokens_mission',
        'mission_tokens_one_active_per_member',
        'mission_tokens_one_active_per_name',
      ]);
    } finally {
      db.close();
    }
  });

  async function openMission(): Promise<{ missionId: string; sessionId: string; ada: string }> {
    const ada = (
      await t.store.users.upsertFromIdp({
        issuer: 'http://idp.test',
        subject: 'a',
        email: 'ada@example.com',
      })
    ).id;
    const account = await t.store.accounts.create({
      provider: 'github',
      owner: { kind: 'user', id: ada },
      displayName: 'gh',
      credential: null,
    });
    const mission = await t.store.missions.create({
      name: 'Team',
      creatorUserId: ada,
      periodAnchor: AT,
      periodSeconds: 86_400,
      accounts: [{ accountId: account.id, resourceIds: [] }],
      policy: [{ riskId: READ, quota: 100, rateLimit: 50, rateWindowSeconds: 60, gate: 'auto' }],
    });
    const session = await t.store.sessions.getOrCreate(mission.id);
    return { missionId: mission.id, sessionId: session.id, ada };
  }

  it('copies the holder of a call event into its columns, and of nothing else', () => {
    const call = (details: object) => ({ kind: 'call-allowed', details });
    expect(holderColumns(call({ token_kind: 'member', holder: 'usr-bob' }))).toEqual({
      kind: 'member',
      holder: 'usr-bob',
    });
    expect(holderColumns(call({ token_kind: 'named', holder: 'CI runner' }))).toEqual({
      kind: 'named',
      holder: 'CI runner',
    });
    expect(holderColumns(call({ token_kind: 'machine', holder: 'x' }))).toBeNull();
    expect(holderColumns(call({ token_kind: 'member', holder: '' }))).toBeNull();
    expect(holderColumns(call({ token_kind: 'member' }))).toBeNull();
    expect(holderColumns(call({}))).toBeNull();
    // A rotation names a holder in its details, but it is not a call.
    expect(
      holderColumns({ kind: 'rotation', details: { token_kind: 'member', holder: 'usr-bob' } }),
    ).toBeNull();
  });

  it('reads the timeline of one holder by keyset, newest first, and counts the calls per holder', async () => {
    const { missionId, sessionId, ada } = await openMission();
    const event = (kind: string, tokenKind: string | null, holder: string | null) =>
      t.store.sessions.recordEvent(sessionId, {
        kind,
        details: {
          tool: 'github__get_file',
          fingerprint: 'f',
          risk_ids: [READ],
          agent_label: null,
          ...(tokenKind ? { token_id: 'tok', token_kind: tokenKind, holder } : {}),
        },
      });
    const entry = (
      decision: 'allowed' | 'refused',
      kind: 'member' | 'named' | null,
      holder: string | null,
    ): CallAuditEntry => ({
      kind: 'call',
      ts: t.clock.now().toISOString(),
      mission_id: missionId,
      token_id: kind ? 'tok' : null,
      token_kind: kind,
      token_holder: holder,
      session_id: sessionId,
      account_id: null,
      resource_ref: null,
      tool: 'github__get_file',
      arguments_hash: 'abc',
      slices_executed: [],
      risks_touched: [READ],
      accepted_risks_snapshot: [READ],
      decision,
      refusal_code: decision === 'refused' ? 'rate-limited' : null,
      refusal_reason: null,
      approval_id: null,
      remaining_budget: null,
      agent_label: null,
      upstream_latency_ms: null,
      upstream_error: null,
      client_ip: null,
      client_user_agent: null,
    });

    const steps: [string, 'allowed' | 'refused', 'member' | 'named' | null, string | null][] = [
      ['call-allowed', 'allowed', 'member', ada],
      ['call-allowed', 'allowed', 'named', 'CI runner'],
      ['call-refused', 'refused', 'member', ada],
      ['call-allowed', 'allowed', 'member', 'usr-bob'],
      ['call-allowed', 'allowed', null, null],
      ['call-allowed', 'allowed', 'member', ada],
    ];
    for (const [kind, decision, tokenKind, holder] of steps) {
      t.clock.advance(1000);
      await event(kind, tokenKind, holder);
      await t.store.audit.append(entry(decision, tokenKind, holder));
    }
    // A member whose id is spelled like a token name is still another holder.
    await event('call-allowed', 'named', ada);

    const of = { calls: { holder: { kind: 'member', holder: ada } } } as const;
    const first = await t.store.sessions.listRecentEvents(sessionId, { limit: 2, ...of });
    expect(first.map((e) => e.kind)).toEqual(['call-allowed', 'call-refused']);
    const last = first.at(-1);
    const rest = await t.store.sessions.listRecentEvents(sessionId, {
      limit: 2,
      before: { ts: last?.ts ?? '', id: last?.id ?? '' },
      ...of,
    });
    expect(rest.map((e) => e.kind)).toEqual(['call-allowed']);
    expect(
      await t.store.sessions.listRecentEvents(sessionId, {
        limit: 10,
        calls: { holder: { kind: 'named', holder: 'CI runner' } },
      }),
    ).toHaveLength(1);
    expect(
      await t.store.sessions.listRecentEvents(sessionId, {
        limit: 10,
        calls: { holder: { kind: 'member', holder: 'nobody' } },
      }),
    ).toEqual([]);

    const activity = await t.store.audit.tokenHolderActivity(missionId, {
      since: AT,
      until: null,
    });
    expect(activity.map((a) => [a.kind, a.holder, a.allowed, a.refused])).toEqual([
      ['member', ada, 2, 1],
      // One call each: by holder, the unattributed entry first (no holder).
      [null, null, 1, 0],
      ['named', 'CI runner', 1, 0],
      ['member', 'usr-bob', 1, 0],
    ]);
    // A span that ends before the calls counts nothing.
    expect(await t.store.audit.tokenHolderActivity(missionId, { since: AT, until: AT })).toEqual(
      [],
    );
  });

  it('searches the audit by token holder: a kind and its holders, never across kinds', async () => {
    const { missionId, ada } = await openMission();
    const write = (kind: 'member' | 'named' | null, holder: string | null, tool: string) =>
      t.store.audit.append({
        kind: 'call',
        ts: t.clock.now().toISOString(),
        mission_id: missionId,
        token_id: kind ? 'tok' : null,
        token_kind: kind,
        token_holder: holder,
        session_id: null,
        account_id: null,
        resource_ref: null,
        tool,
        arguments_hash: 'abc',
        slices_executed: [],
        risks_touched: [],
        accepted_risks_snapshot: [READ],
        decision: 'allowed',
        refusal_code: null,
        refusal_reason: null,
        approval_id: null,
        remaining_budget: null,
        agent_label: null,
        upstream_latency_ms: null,
        upstream_error: null,
        client_ip: null,
        client_user_agent: null,
      });
    await write('member', ada, 'by-ada');
    await write('member', 'usr-bob', 'by-bob');
    await write('named', 'CI runner', 'by-ci');
    await write('named', ada, 'by-a-name-spelled-like-ada');
    await write(null, null, 'unattributed');

    const scope = {
      missionCreatorUserId: ada,
      missionMemberUserId: null,
      accountOwners: [],
      allAdmin: false,
      allCalls: false,
    };
    const tools = async (tokenHolders: { kind: 'member' | 'named'; holders: string[] }) =>
      (await t.store.audit.search({ scope, limit: 50, tokenHolders }))
        .map((r) => (r.kind === 'call' ? r.tool : r.act))
        .sort();
    expect(await tools({ kind: 'member', holders: [ada] })).toEqual(['by-ada']);
    expect(await tools({ kind: 'member', holders: [ada, 'usr-bob'] })).toEqual([
      'by-ada',
      'by-bob',
    ]);
    expect(await tools({ kind: 'named', holders: ['CI runner'] })).toEqual(['by-ci']);
    expect(await tools({ kind: 'named', holders: [ada] })).toEqual(['by-a-name-spelled-like-ada']);
    // An empty list matches nothing: it never widens to "every holder".
    expect(await tools({ kind: 'member', holders: [] })).toEqual([]);
    const read = await t.store.audit.search({ scope, limit: 50 });
    expect(read.find((r) => r.kind === 'call' && r.tool === 'by-ci')).toMatchObject({
      token_id: 'tok',
      token_kind: 'named',
      token_holder: 'CI runner',
    });
  });
});
