/**
 * A row holding a value outside the closed set of its column fails loudly: every
 * repository validates enum columns through `parseEnum` instead of casting them. The
 * values are forced in with the schema's CHECKs switched off, which is how a hand-edited
 * file or a schema drifting ahead of the code would present itself.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AdminAuditEntry } from '@vaubaan/gateway-core';
import { InvariantError, type Store } from '../../../src/server/store/index.ts';
import { openTestStore, type TestStore } from '../../../src/server/store/testing.ts';

const RISK = 'github.code-read';
const BOGUS = 'bogus';
const LATER = '2027-01-01T00:00:00.000Z';

const ADMIN_ENTRY: AdminAuditEntry = {
  kind: 'admin',
  ts: '2026-10-13T09:00:00.000Z',
  user_id: 'u1',
  act: 'share-created',
  object: { type: 'share', id: 'sh1' },
  before: null,
  after: null,
  delegated_client_id: null,
};

describe('store rows with a value outside a closed set', () => {
  let t: TestStore;
  let store: Store;
  let userId: string;
  let connectionId: string;
  let missionId: string;

  beforeEach(async () => {
    t = openTestStore();
    store = t.store;
    userId = (
      await store.users.upsertFromIdp({
        issuer: 'http://idp.test',
        subject: 'u',
        email: 'u@x',
      })
    ).id;
    connectionId = (
      await store.connections.create({
        provider: 'github',
        owner: { kind: 'user', id: userId },
        displayName: 'gh',
        credential: null,
      })
    ).id;
    missionId = (
      await store.missions.create({
        name: 'm',
        creatorUserId: userId,
        periodSeconds: null,
        connections: [{ connectionId, resourceScope: 'all', resourceIds: [] }],
        policy: [{ riskId: RISK, quota: 1, rateLimit: 1, rateWindowSeconds: 60, gate: 'auto' }],
      })
    ).id;
  });
  afterEach(() => store.close());

  function withoutChecks(write: () => void): void {
    store.db.pragma('ignore_check_constraints = ON');
    try {
      write();
    } finally {
      store.db.pragma('ignore_check_constraints = OFF');
    }
  }

  /** Writes `BOGUS` into one column of one row, past the schema's CHECK. */
  function corrupt(table: string, column: string, keyColumn: string, key: string): void {
    withoutChecks(() => {
      const changed = store.db
        .prepare(`UPDATE ${table} SET ${column} = ? WHERE ${keyColumn} = ?`)
        .run(BOGUS, key).changes;
      expect(changed).toBe(1);
    });
  }

  async function expectLoudFailure(read: () => Promise<unknown>, column: string): Promise<void> {
    const failure: unknown = await read().then(
      () => null,
      (err: unknown) => err,
    );
    expect(failure).toBeInstanceOf(InvariantError);
    expect((failure as InvariantError).message).toBe(`${column}: unexpected value '${BOGUS}'`);
  }

  it('refuses an unknown users.status', async () => {
    corrupt('users', 'status', 'id', userId);
    await expectLoudFailure(() => store.users.getById(userId), 'users.status');
  });

  it('refuses an unknown groups.source', async () => {
    const group = await store.groups.getOrCreate('platform', 'idp');
    corrupt('groups', 'source', 'id', group.id);
    await expectLoudFailure(() => store.groups.getById(group.id), 'groups.source');
  });

  it('refuses an unknown shares.status', async () => {
    const share = await store.shares.create({
      connectionId,
      target: { kind: 'user', id: userId },
      restriction: [RISK],
      createdByUserId: userId,
    });
    corrupt('shares', 'status', 'id', share.id);
    await expectLoudFailure(
      () => store.shares.get({ connectionId: share.connectionId, shareId: share.id }),
      'shares.status',
    );
  });

  it('refuses an unknown missions.status', async () => {
    corrupt('missions', 'status', 'id', missionId);
    await expectLoudFailure(() => store.missions.getById(missionId), 'missions.status');
  });

  it('refuses an unknown mission_connections.resource_scope', async () => {
    corrupt('mission_connections', 'resource_scope', 'mission_id', missionId);
    await expectLoudFailure(
      () => store.missions.getById(missionId),
      'mission_connections.resource_scope',
    );
  });

  it('refuses an unknown mission_policy.gate', async () => {
    corrupt('mission_policy', 'gate', 'mission_id', missionId);
    await expectLoudFailure(() => store.missions.getById(missionId), 'mission_policy.gate');
  });

  it('refuses an unknown mission_tokens.status', async () => {
    const { token } = await store.missions.issueToken({
      missionId,
      prefix: 'vbn_abc',
      hash: 'h',
      hashAlg: 'sha256',
      holder: { kind: 'named', name: 'CI runner' },
      createdBy: userId,
    });
    corrupt('mission_tokens', 'status', 'id', token.id);
    await expectLoudFailure(() => store.missions.listTokens(missionId), 'mission_tokens.status');
  });

  it('refuses an unknown requests.kind and an unknown requests.state', async () => {
    const claim = { missionId, kind: 'claim', riskId: RISK, expiresAt: LATER } as const;
    const byKind = await store.requests.create(claim);
    const byState = await store.requests.create(claim);
    corrupt('requests', 'kind', 'id', byKind.id);
    corrupt('requests', 'state', 'id', byState.id);
    await expectLoudFailure(() => store.requests.getById(byKind.id), 'requests.kind');
    await expectLoudFailure(() => store.requests.getById(byState.id), 'requests.state');
  });

  it('refuses an unknown delegations.status and an unknown code challenge method', async () => {
    const client = await store.delegations.registerClient({
      clientId: 'c',
      name: 'c',
      redirectUris: ['http://127.0.0.1/cb'],
    });
    const delegation = await store.delegations.create({ userId, clientId: client.id, scope: 's' });
    const code = await store.delegations.createCode({
      delegationId: delegation.id,
      codeHash: 'code-hash',
      redirectUri: 'http://127.0.0.1/cb',
      codeChallenge: 'challenge',
      codeChallengeMethod: 'S256',
      expiresAt: LATER,
    });
    corrupt('oauth_codes', 'code_challenge_method', 'id', code.id);
    await expectLoudFailure(
      () =>
        store.delegations.redeemCode('code-hash', () => null, {
          refresh: { tokenHash: 'r1', expiresAt: LATER },
          access: { tokenHash: 'a1', expiresAt: LATER },
        }),
      'oauth_codes.code_challenge_method',
    );
    corrupt('delegations', 'status', 'id', delegation.id);
    await expectLoudFailure(() => store.delegations.getById(delegation.id), 'delegations.status');
  });

  // `audit` is append-only (triggers refuse UPDATE), and `act` / `object_type` carry no
  // CHECK: a foreign row is inserted directly.
  function insertAdminRow(id: string, column: 'kind' | 'act' | 'object_type'): void {
    const values = { kind: 'admin', act: 'share-created', object_type: 'share', [column]: BOGUS };
    withoutChecks(() => {
      store.db
        .prepare(
          `INSERT INTO audit (id, ts, kind, user_id, act, object_type, object_id)
           VALUES (?, '2026-10-13T09:00:00.000Z', ?, 'u1', ?, ?, 'o1')`,
        )
        .run(id, values.kind, values.act, values.object_type);
    });
  }

  it.each(['kind', 'act', 'object_type'] as const)(
    'refuses an unknown audit.%s',
    async (column) => {
      insertAdminRow('a1', column);
      await expectLoudFailure(() => store.audit.getById('a1'), `audit.${column}`);
      await expectLoudFailure(() => store.audit.list(), `audit.${column}`);
    },
  );

  it('still reads an administrative entry the gateway wrote', async () => {
    const record = await store.audit.append(ADMIN_ENTRY);
    expect(await store.audit.getById(record.id)).toMatchObject({
      act: 'share-created',
      object: { type: 'share', id: 'sh1' },
    });
  });

  it('a corrupt request aborts a claim decision without writing anything', async () => {
    const request = await store.requests.create({
      missionId,
      kind: 'claim',
      riskId: RISK,
      expiresAt: LATER,
    });
    corrupt('requests', 'state', 'id', request.id);
    let applied = false;
    await expect(
      store.requests.decideClaim(request.id, userId, () => {
        applied = true;
        return { state: 'granted', decision: {} };
      }),
    ).rejects.toBeInstanceOf(InvariantError);
    expect(applied).toBe(false);
    const raw = store.db
      .prepare<[string], { state: string }>('SELECT state FROM requests WHERE id = ?')
      .get(request.id);
    expect(raw?.state).toBe(BOGUS);
  });
});
