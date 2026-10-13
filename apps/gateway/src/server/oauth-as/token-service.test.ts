import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { OAuthClientRecord } from '../store/types';
import { AUTHORIZATION_CODE_TTL_MS } from './authorization';
import { OAuthProtocolError, type OAuthErrorCode } from './errors';
import {
  ACCESS_TOKEN_PREFIX,
  digestOf,
  mintAuthorizationCode,
  mintRefreshToken,
  REFRESH_TOKEN_PREFIX,
} from './secrets';
import { openOAuthRig, pkcePair, WEB_REDIRECT, type Granted, type OAuthRig } from './testing';
import { delegationLifetime } from './delegation-lifetime';
import { DelegatedTokenVerifier } from './verifier';
import {
  clientCredentialsOf,
  DELEGATION_LIFETIME_REACHED,
  PURGE_GRACE_MS,
  PURGE_INTERVAL_MS,
  RENEWAL_WINDOW_MS,
  RENEWALS_PER_DELEGATION,
} from './token-service';

/** Longer than any reuse window the configuration accepts. */
const AFTER_REUSE_WINDOW_MS = 61_000;

async function refusal(run: () => Promise<unknown>): Promise<OAuthProtocolError> {
  try {
    await run();
  } catch (err) {
    if (err instanceof OAuthProtocolError) return err;
    throw err;
  }
  throw new Error('expected the request to be refused');
}

describe('TokenService', () => {
  let rig: OAuthRig;
  let client: OAuthClientRecord;

  beforeEach(async () => {
    rig = await openOAuthRig();
    client = await rig.registerClient();
  });
  afterEach(() => rig.close());

  function codeForm(granted: Granted, overrides: Record<string, string> = {}): URLSearchParams {
    return rig.form({
      grant_type: 'authorization_code',
      code: granted.code,
      code_verifier: granted.pkce.verifier,
      redirect_uri: granted.redirectUri,
      ...overrides,
    });
  }

  function refreshForm(refreshToken: string, extra: Record<string, string> = {}): URLSearchParams {
    return rig.form({ grant_type: 'refresh_token', refresh_token: refreshToken, ...extra });
  }

  const revocations = () => rig.audit.admin.filter((entry) => entry.act === 'delegation-revoked');

  /** Every insert into `table` fails until `heal()`: a store fault in the middle of a grant. */
  function breakInserts(on: OAuthRig, table: string): () => void {
    on.store.db.exec(
      `CREATE TRIGGER fault_${table} BEFORE INSERT ON ${table}
       BEGIN SELECT RAISE(ABORT, 'simulated store fault'); END`,
    );
    return () => on.store.db.exec(`DROP TRIGGER fault_${table}`);
  }

  /** What a store fault looks like to the caller: an error, and never an OAuth refusal. */
  async function storeFault(run: () => Promise<unknown>): Promise<void> {
    const err: unknown = await run().then(
      () => null,
      (thrown: unknown) => thrown,
    );
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(OAuthProtocolError);
    expect((err as Error).message).toContain('simulated store fault');
  }

  function rows<T>(on: OAuthRig, sql: string): T[] {
    return on.store.db.prepare<[], T>(sql).all();
  }

  describe('authorization-code grant', () => {
    it('exchanges the code for an opaque access token and a refresh token', async () => {
      const granted = await rig.grant(rig.ada, client);
      const tokens = await rig.tokens.exchangeCode(client, codeForm(granted));
      expect(tokens).toEqual({
        access_token: tokens.access_token,
        token_type: 'Bearer',
        expires_in: 900,
        refresh_token: tokens.refresh_token,
        scope: 'mgmt',
      });
      expect(tokens.access_token).toMatch(new RegExp(`^${ACCESS_TOKEN_PREFIX}[\\w-]{43}$`));
      expect(tokens.refresh_token).toMatch(new RegExp(`^${REFRESH_TOKEN_PREFIX}[\\w-]{43}$`));
      expect(await rig.verifier.resolve(tokens.access_token)).toMatchObject({
        delegation_id: granted.delegationId,
        user_id: rig.ada.id,
        client_id: client.clientId,
        scopes: ['mgmt'],
      });
    });

    it('stores digests only: neither token appears in the database', async () => {
      const { tokens } = await rig.issue(rig.ada, client);
      const dump = JSON.stringify(
        ['oauth_access_tokens', 'oauth_refresh_tokens', 'oauth_codes', 'delegations'].map((table) =>
          rig.store.db.prepare(`SELECT * FROM ${table}`).all(),
        ),
      );
      expect(dump).not.toContain(tokens.access_token);
      expect(dump).not.toContain(tokens.refresh_token);
      expect(dump).toContain(digestOf(tokens.access_token));
      expect(dump).toContain(digestOf(tokens.refresh_token));
      expect(JSON.stringify(rig.audit.entries)).not.toContain(tokens.access_token);
      expect(JSON.stringify(rig.audit.entries)).not.toContain(tokens.refresh_token);
    });

    it('does not need the redirect URI again, but refuses one that differs', async () => {
      const without = await rig.grant(rig.ada, client);
      const form = codeForm(without);
      form.delete('redirect_uri');
      await expect(rig.tokens.exchangeCode(client, form)).resolves.toBeTruthy();

      const differing = await rig.grant(rig.ada, client);
      const err = await refusal(() =>
        rig.tokens.exchangeCode(
          client,
          codeForm(differing, { redirect_uri: 'http://127.0.0.1:1/callback' }),
        ),
      );
      expect(err.code).toBe('invalid_grant');
    });

    it('PKCE: refuses a wrong verifier, and the code is spent by the attempt', async () => {
      const granted = await rig.grant(rig.ada, client);
      const err = await refusal(() =>
        rig.tokens.exchangeCode(client, codeForm(granted, { code_verifier: pkcePair().verifier })),
      );
      expect(err).toMatchObject({ code: 'invalid_grant', status: 400 });
      expect(err.message).toContain('code_verifier');
      // The right verifier arrives too late: the code was single-use.
      const second = await refusal(() => rig.tokens.exchangeCode(client, codeForm(granted)));
      expect(second.code).toBe('invalid_grant');
      expect(rig.store.db.prepare('SELECT * FROM oauth_access_tokens').all()).toEqual([]);
    });

    it('PKCE: refuses the challenge presented as the verifier, and a missing verifier', async () => {
      const granted = await rig.grant(rig.ada, client);
      const plain = await refusal(() =>
        rig.tokens.exchangeCode(
          client,
          codeForm(granted, { code_verifier: granted.pkce.challenge }),
        ),
      );
      expect(plain.code).toBe('invalid_grant');

      const other = await rig.grant(rig.ada, client);
      const form = codeForm(other);
      form.delete('code_verifier');
      expect((await refusal(() => rig.tokens.exchangeCode(client, form))).code).toBe(
        'invalid_request',
      );
    });

    it('a code is single-use: its replay revokes the delegation and the tokens it produced', async () => {
      const granted = await rig.grant(rig.ada, client);
      const tokens = await rig.tokens.exchangeCode(client, codeForm(granted));
      rig.audit.entries.length = 0;

      const err = await refusal(() => rig.tokens.exchangeCode(client, codeForm(granted)));
      expect(err.code).toBe('invalid_grant');
      expect(await rig.store.delegations.getById(granted.delegationId)).toMatchObject({
        status: 'revoked',
        revokeReason: 'authorization-code-replay',
      });
      expect(await rig.verifier.resolve(tokens.access_token)).toBeNull();
      expect(
        (await refusal(() => rig.tokens.refresh(client, refreshForm(tokens.refresh_token)))).code,
      ).toBe('invalid_grant');
      expect(revocations()).toMatchObject([
        {
          user_id: rig.ada.id,
          object: { type: 'delegation', id: granted.delegationId },
          before: { status: 'active' },
          after: {
            status: 'revoked',
            reason: 'authorization-code-replay',
            client_id: client.clientId,
          },
          delegated_client_id: client.clientId,
        },
      ]);
    });

    it('two simultaneous exchanges of one code yield one pair of tokens at most', async () => {
      const granted = await rig.grant(rig.ada, client);
      const results = await Promise.allSettled([
        rig.tokens.exchangeCode(client, codeForm(granted)),
        rig.tokens.exchangeCode(client, codeForm(granted)),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled').length).toBeLessThanOrEqual(1);
      expect(results.some((r) => r.status === 'rejected')).toBe(true);
      // Two parties held the code: the family is gone whichever came first.
      expect((await rig.store.delegations.getById(granted.delegationId))?.status).toBe('revoked');
    });

    it('a code expires after a minute', async () => {
      const granted = await rig.grant(rig.ada, client);
      rig.clock.advance(AUTHORIZATION_CODE_TTL_MS);
      const err = await refusal(() => rig.tokens.exchangeCode(client, codeForm(granted)));
      expect(err.code).toBe('invalid_grant');
      // An expired code is not a replay: the delegation is left alone.
      expect((await rig.store.delegations.getById(granted.delegationId))?.status).toBe('active');
      expect(revocations()).toEqual([]);
    });

    it('a code is bound to the client it was issued to, and is spent by the wrong one', async () => {
      const other = await rig.registerClient();
      const granted = await rig.grant(rig.ada, client);
      const err = await refusal(() => rig.tokens.exchangeCode(other, codeForm(granted)));
      expect(err.code).toBe('invalid_grant');
      expect(rig.store.db.prepare('SELECT * FROM oauth_access_tokens').all()).toEqual([]);
      expect((await refusal(() => rig.tokens.exchangeCode(client, codeForm(granted)))).code).toBe(
        'invalid_grant',
      );
    });

    it.each([
      ['an unknown code', mintAuthorizationCode()],
      ['a value that is not a code', 'not-a-code'],
      ['a refresh token in place of the code', mintRefreshToken()],
    ])('refuses %s', async (_case, code) => {
      const granted = await rig.grant(rig.ada, client);
      const err = await refusal(() => rig.tokens.exchangeCode(client, codeForm(granted, { code })));
      expect(err.code).toBe('invalid_grant');
    });

    it('refuses a resource other than the management door', async () => {
      const granted = await rig.grant(rig.ada, client);
      const err = await refusal(() =>
        rig.tokens.exchangeCode(
          client,
          codeForm(granted, { resource: 'https://gateway.example.com/mcp' }),
        ),
      );
      expect(err.code).toBe('invalid_target');
      // Refused before the code was touched.
      await expect(
        rig.tokens.exchangeCode(client, codeForm(granted, { resource: rig.endpoints.resource })),
      ).resolves.toBeTruthy();
    });

    it('issues nothing for a user who was removed after consenting', async () => {
      const granted = await rig.grant(rig.ada, client);
      rig.store.db.prepare("UPDATE users SET status = 'removed' WHERE id = ?").run(rig.ada.id);
      const err = await refusal(() => rig.tokens.exchangeCode(client, codeForm(granted)));
      expect(err.code).toBe('invalid_grant');
    });
  });

  describe('a grant is one transaction: a write that fails leaves nothing behind', () => {
    it.each(['oauth_refresh_tokens', 'oauth_access_tokens'])(
      'code exchange, %s cannot be written: the code is unspent, no token exists, the same request then succeeds',
      async (table) => {
        const granted = await rig.grant(rig.ada, client);
        const heal = breakInserts(rig, table);
        await storeFault(() => rig.tokens.exchangeCode(client, codeForm(granted)));

        expect(rows(rig, 'SELECT consumed_at FROM oauth_codes')).toEqual([{ consumed_at: null }]);
        expect(rows(rig, 'SELECT id FROM oauth_refresh_tokens')).toEqual([]);
        expect(rows(rig, 'SELECT id FROM oauth_access_tokens')).toEqual([]);
        expect(await rig.store.delegations.getById(granted.delegationId)).toMatchObject({
          status: 'active',
        });
        expect(revocations()).toEqual([]);

        heal();
        const tokens = await rig.tokens.exchangeCode(client, codeForm(granted));
        expect(await rig.verifier.resolve(tokens.access_token)).not.toBeNull();
      },
    );

    it('a check that fails still spends the code, although nothing was written', async () => {
      const granted = await rig.grant(rig.ada, client);
      const err = await refusal(() =>
        rig.tokens.exchangeCode(client, codeForm(granted, { code_verifier: pkcePair().verifier })),
      );
      expect(err.code).toBe('invalid_grant');
      expect(
        rows<{ consumed_at: string | null }>(rig, 'SELECT consumed_at FROM oauth_codes'),
      ).toEqual([{ consumed_at: rig.clock.now().toISOString() }]);
      expect(rows(rig, 'SELECT id FROM oauth_refresh_tokens')).toEqual([]);
      expect(rows(rig, 'SELECT id FROM oauth_access_tokens')).toEqual([]);
    });

    it('renewal, the access token cannot be written: the presented refresh token is still the live head, and the retry is not a replay — even with no reuse window', async () => {
      await rig.close();
      rig = await openOAuthRig({ ttl: { refreshReuseWindowSeconds: 0 } });
      client = await rig.registerClient();
      const { tokens, delegationId } = await rig.issue(rig.ada, client);
      const before = rows(rig, 'SELECT id, revoked_at, replaced_by_id FROM oauth_refresh_tokens');

      const heal = breakInserts(rig, 'oauth_access_tokens');
      await storeFault(() => rig.tokens.refresh(client, refreshForm(tokens.refresh_token)));

      // The rotation was rolled back with the insert that failed.
      expect(rows(rig, 'SELECT id, revoked_at, replaced_by_id FROM oauth_refresh_tokens')).toEqual(
        before,
      );
      expect(before).toHaveLength(1);
      expect(before).toMatchObject([{ revoked_at: null, replaced_by_id: null }]);
      expect(await rig.store.delegations.getById(delegationId)).toMatchObject({ status: 'active' });
      expect(await rig.verifier.resolve(tokens.access_token)).not.toBeNull();
      expect(revocations()).toEqual([]);

      heal();
      const renewed = await rig.tokens.refresh(client, refreshForm(tokens.refresh_token));
      expect(await rig.verifier.resolve(renewed.access_token)).not.toBeNull();
      expect(await rig.store.delegations.getById(delegationId)).toMatchObject({ status: 'active' });
    });

    it('reuse window, the access token cannot be written: the head is not rotated, and the token is answered once the store is back', async () => {
      const { tokens, delegationId } = await rig.issue(rig.ada, client);
      const first = await rig.tokens.refresh(client, refreshForm(tokens.refresh_token));
      const before = rows(
        rig,
        'SELECT id, revoked_at, replaced_by_id FROM oauth_refresh_tokens ORDER BY id',
      );

      const heal = breakInserts(rig, 'oauth_access_tokens');
      await storeFault(() => rig.tokens.refresh(client, refreshForm(tokens.refresh_token)));
      expect(
        rows(rig, 'SELECT id, revoked_at, replaced_by_id FROM oauth_refresh_tokens ORDER BY id'),
      ).toEqual(before);
      expect(revocations()).toEqual([]);

      heal();
      // Still the token rotated last, still inside the window: a new pair.
      const again = await rig.tokens.refresh(client, refreshForm(tokens.refresh_token));
      expect(again.refresh_token).not.toBe(first.refresh_token);
      expect(await rig.store.delegations.getById(delegationId)).toMatchObject({ status: 'active' });
    });
  });

  describe('renewals are counted per delegation, once the refresh token is recognised', () => {
    /** Renews `times` times in a row, each time with the token the previous renewal returned. */
    async function renewChain(refreshToken: string, times: number): Promise<string> {
      let current = refreshToken;
      for (let i = 0; i < times; i += 1) {
        current = (await rig.tokens.refresh(client, refreshForm(current))).refresh_token;
      }
      return current;
    }

    it('the budget of one delegation stops its renewals and changes nothing; it comes back with the window', async () => {
      const { tokens, delegationId } = await rig.issue(rig.ada, client);
      const head = await renewChain(tokens.refresh_token, RENEWALS_PER_DELEGATION);

      const err = await refusal(() => rig.tokens.refresh(client, refreshForm(head)));
      expect(err).toMatchObject({ code: 'slow_down', status: 429 });
      expect(err.retryAfterSeconds).toBeGreaterThan(0);
      // Refused before any write: the head is still the head, the family lives.
      expect(await rig.store.delegations.getById(delegationId)).toMatchObject({ status: 'active' });
      expect(revocations()).toEqual([]);

      rig.clock.advance(RENEWAL_WINDOW_MS);
      await expect(rig.tokens.refresh(client, refreshForm(head))).resolves.toMatchObject({
        token_type: 'Bearer',
      });
    });

    it('another delegation of the same client is not held back', async () => {
      const spent = await rig.issue(rig.ada, client);
      const head = await renewChain(spent.tokens.refresh_token, RENEWALS_PER_DELEGATION);
      await expect(rig.tokens.refresh(client, refreshForm(head))).rejects.toMatchObject({
        code: 'slow_down',
      });

      const other = await rig.issue(rig.bob, client);
      await expect(
        rig.tokens.refresh(client, refreshForm(other.tokens.refresh_token)),
      ).resolves.toBeTruthy();
    });

    it('a caller that proves nothing spends nothing: unknown and foreign refresh tokens do not touch the budget', async () => {
      const { tokens } = await rig.issue(rig.ada, client);
      const stranger = await rig.registerClient();
      for (let i = 0; i < RENEWALS_PER_DELEGATION + 5; i += 1) {
        await refusal(() => rig.tokens.refresh(client, refreshForm(mintRefreshToken())));
        // The right token under another client id: recognised as not theirs.
        await refusal(() => rig.tokens.refresh(stranger, refreshForm(tokens.refresh_token)));
      }
      await expect(
        rig.tokens.refresh(client, refreshForm(tokens.refresh_token)),
      ).resolves.toBeTruthy();
    });

    it('a replay is never rate-limited: it revokes the family although the budget is spent', async () => {
      const { tokens, delegationId } = await rig.issue(rig.ada, client);
      const head = await renewChain(tokens.refresh_token, RENEWALS_PER_DELEGATION);
      // The budget is spent: the live head itself is told to slow down…
      await expect(rig.tokens.refresh(client, refreshForm(head))).rejects.toMatchObject({
        code: 'slow_down',
      });

      // …and the first generation, presented in that same window, is still a replay.
      const err = await refusal(() =>
        rig.tokens.refresh(client, refreshForm(tokens.refresh_token)),
      );
      expect(err.code).toBe('invalid_grant');
      expect(await rig.store.delegations.getById(delegationId)).toMatchObject({
        status: 'revoked',
        revokeReason: 'refresh-token-replay',
      });
    });
  });

  describe('reuse window of a rotated refresh token', () => {
    /** Rows of the family, oldest first: which are spent, which is the live head. */
    function family(): { revoked: boolean; replaced: boolean }[] {
      return rig.store.db
        .prepare<[], { revoked_at: string | null; replaced_by_id: string | null }>(
          'SELECT revoked_at, replaced_by_id FROM oauth_refresh_tokens ORDER BY created_at, rowid',
        )
        .all()
        .map((row) => ({
          revoked: row.revoked_at !== null,
          replaced: row.replaced_by_id !== null,
        }));
    }

    it('the token rotated last, presented again inside the window, gets a new pair and the delegation lives', async () => {
      const { tokens: first, delegationId } = await rig.issue(rig.ada, client);
      // Session A renews; session B, which read the same stored token, renews a moment later.
      const sessionA = await rig.tokens.refresh(client, refreshForm(first.refresh_token));
      rig.clock.advance(5_000);
      const sessionB = await rig.tokens.refresh(client, refreshForm(first.refresh_token));

      expect(sessionB.refresh_token).not.toBe(sessionA.refresh_token);
      expect(sessionB).toMatchObject({ token_type: 'Bearer', expires_in: 900, scope: 'mgmt' });
      expect(await rig.store.delegations.getById(delegationId)).toMatchObject({ status: 'active' });
      expect(revocations()).toEqual([]);
      // Both access tokens work; the family is still one chain with one live head.
      expect(await rig.verifier.resolve(sessionA.access_token)).not.toBeNull();
      expect(await rig.verifier.resolve(sessionB.access_token)).not.toBeNull();
      expect(family()).toEqual([
        { revoked: true, replaced: true },
        { revoked: true, replaced: true },
        { revoked: false, replaced: false },
      ]);
      // The head is the token session B received: it renews normally.
      rig.clock.advance(AFTER_REUSE_WINDOW_MS);
      await expect(
        rig.tokens.refresh(client, refreshForm(sessionB.refresh_token)),
      ).resolves.toBeTruthy();
    });

    it('the window is inclusive of its last second and closed right after', async () => {
      const windowMs = rig.config.refreshReuseWindowSeconds * 1000;
      const inside = await rig.issue(rig.ada, client);
      await rig.tokens.refresh(client, refreshForm(inside.tokens.refresh_token));
      rig.clock.advance(windowMs);
      await expect(
        rig.tokens.refresh(client, refreshForm(inside.tokens.refresh_token)),
      ).resolves.toBeTruthy();

      const outside = await rig.issue(rig.ada, client);
      await rig.tokens.refresh(client, refreshForm(outside.tokens.refresh_token));
      rig.clock.advance(windowMs + 1);
      const err = await refusal(() =>
        rig.tokens.refresh(client, refreshForm(outside.tokens.refresh_token)),
      );
      expect(err.code).toBe('invalid_grant');
      expect(await rig.store.delegations.getById(outside.delegationId)).toMatchObject({
        status: 'revoked',
        revokeReason: 'refresh-token-replay',
      });
      expect(await rig.store.delegations.getById(inside.delegationId)).toMatchObject({
        status: 'active',
      });
    });

    it('an older generation is a replay even inside the window', async () => {
      const { tokens: first, delegationId } = await rig.issue(rig.ada, client);
      const second = await rig.tokens.refresh(client, refreshForm(first.refresh_token));
      await rig.tokens.refresh(client, refreshForm(second.refresh_token));
      // `first` was rotated a moment ago, but its successor is no longer the head.
      await refusal(() => rig.tokens.refresh(client, refreshForm(first.refresh_token)));
      expect(await rig.store.delegations.getById(delegationId)).toMatchObject({
        status: 'revoked',
        revokeReason: 'refresh-token-replay',
      });
      expect(revocations()).toHaveLength(1);
    });

    it('the same token cannot be reused twice: the second reuse is a replay', async () => {
      const { tokens: first, delegationId } = await rig.issue(rig.ada, client);
      await rig.tokens.refresh(client, refreshForm(first.refresh_token));
      const reused = await rig.tokens.refresh(client, refreshForm(first.refresh_token));
      await refusal(() => rig.tokens.refresh(client, refreshForm(first.refresh_token)));
      expect((await rig.store.delegations.getById(delegationId))?.status).toBe('revoked');
      expect(await rig.verifier.resolve(reused.access_token)).toBeNull();
    });

    it('the token the first renewal received, replaced by the reuse, is a replay once the window closed', async () => {
      const { tokens: first, delegationId } = await rig.issue(rig.ada, client);
      const sessionA = await rig.tokens.refresh(client, refreshForm(first.refresh_token));
      await rig.tokens.refresh(client, refreshForm(first.refresh_token));
      rig.clock.advance(AFTER_REUSE_WINDOW_MS);
      // Session A never picked up the token session B stored: two holders, as far as the server can tell.
      await refusal(() => rig.tokens.refresh(client, refreshForm(sessionA.refresh_token)));
      expect((await rig.store.delegations.getById(delegationId))?.status).toBe('revoked');
    });

    it('another client gets nothing from the window: the family ends', async () => {
      const other = await rig.registerClient();
      const { tokens, delegationId } = await rig.issue(rig.ada, client);
      await rig.tokens.refresh(client, refreshForm(tokens.refresh_token));
      await refusal(() => rig.tokens.refresh(other, refreshForm(tokens.refresh_token)));
      expect((await rig.store.delegations.getById(delegationId))?.status).toBe('revoked');
    });

    it('two simultaneous renewals of one token both succeed and the delegation lives', async () => {
      const { tokens, delegationId } = await rig.issue(rig.ada, client);
      const results = await Promise.all([
        rig.tokens.refresh(client, refreshForm(tokens.refresh_token)),
        rig.tokens.refresh(client, refreshForm(tokens.refresh_token)),
      ]);
      expect(new Set(results.map((r) => r.refresh_token)).size).toBe(2);
      expect((await rig.store.delegations.getById(delegationId))?.status).toBe('active');
      expect(family().filter((row) => !row.revoked)).toHaveLength(1);
      expect(revocations()).toEqual([]);
    });

    it('a revoked delegation or a removed user gets nothing from the window', async () => {
      const revoked = await rig.issue(rig.ada, client);
      await rig.tokens.refresh(client, refreshForm(revoked.tokens.refresh_token));
      await rig.delegations.revoke(rig.ada, revoked.delegationId);
      expect(
        (await refusal(() => rig.tokens.refresh(client, refreshForm(revoked.tokens.refresh_token))))
          .code,
      ).toBe('invalid_grant');

      const removed = await rig.issue(rig.bob, client);
      await rig.tokens.refresh(client, refreshForm(removed.tokens.refresh_token));
      rig.store.db.prepare("UPDATE users SET status = 'removed' WHERE id = ?").run(rig.bob.id);
      expect(
        (await refusal(() => rig.tokens.refresh(client, refreshForm(removed.tokens.refresh_token))))
          .code,
      ).toBe('invalid_grant');
    });

    it('with the window set to 0 every replay ends the family at once', async () => {
      const strict = await openOAuthRig({ ttl: { refreshReuseWindowSeconds: 0 } });
      try {
        const strictClient = await strict.registerClient();
        const { tokens, delegationId } = await strict.issue(strict.ada, strictClient);
        const form = (): URLSearchParams =>
          strict.form({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token });
        await strict.tokens.refresh(strictClient, form());
        await expect(strict.tokens.refresh(strictClient, form())).rejects.toMatchObject({
          code: 'invalid_grant',
        });
        expect((await strict.store.delegations.getById(delegationId))?.status).toBe('revoked');
      } finally {
        await strict.close();
      }
    });
  });

  describe('refresh grant', () => {
    it('rotates: a new pair is issued and the presented refresh token stops working', async () => {
      const { tokens: first, delegationId } = await rig.issue(rig.ada, client);
      rig.clock.advance(60_000);
      const second = await rig.tokens.refresh(client, refreshForm(first.refresh_token));
      expect(second.refresh_token).not.toBe(first.refresh_token);
      expect(second.access_token).not.toBe(first.access_token);
      expect(second).toMatchObject({ token_type: 'Bearer', expires_in: 900, scope: 'mgmt' });
      expect(await rig.verifier.resolve(second.access_token)).toMatchObject({
        delegation_id: delegationId,
      });
      // The access token issued before the rotation lives out its short life.
      expect(await rig.verifier.resolve(first.access_token)).not.toBeNull();

      const rows = rig.store.db
        .prepare<
          [],
          { revoked_at: string | null; replaced_by_id: string | null }
        >('SELECT revoked_at, replaced_by_id FROM oauth_refresh_tokens ORDER BY created_at')
        .all();
      expect(rows).toHaveLength(2);
      expect(rows[0]?.revoked_at).not.toBeNull();
      expect(rows[0]?.replaced_by_id).not.toBeNull();
      expect(rows[1]).toEqual({ revoked_at: null, replaced_by_id: null });
    });

    it('each rotation starts the refresh lifetime again', async () => {
      const { tokens } = await rig.issue(rig.ada, client);
      let current = tokens.refresh_token;
      // Renewed every 20 days for 80 days: never idle for the 30 days it lasts.
      for (let i = 0; i < 4; i += 1) {
        rig.clock.advance(20 * 86_400_000);
        current = (await rig.tokens.refresh(client, refreshForm(current))).refresh_token;
      }
      rig.clock.advance(31 * 86_400_000);
      expect((await refusal(() => rig.tokens.refresh(client, refreshForm(current)))).code).toBe(
        'invalid_grant',
      );
    });

    describe('the delegation has an absolute lifetime', () => {
      const DAY_MS = 86_400_000;
      const LIFETIME_DAYS = 90;

      /** Renews every 20 days until `days` have passed since the consent. */
      async function renewedFor(days: number): Promise<{ refresh: string; delegationId: string }> {
        const { tokens, delegationId } = await rig.issue(rig.ada, client);
        let refresh = tokens.refresh_token;
        for (let elapsed = 20; elapsed <= days; elapsed += 20) {
          rig.clock.advance(20 * DAY_MS);
          refresh = (await rig.tokens.refresh(client, refreshForm(refresh))).refresh_token;
        }
        rig.clock.advance((days % 20) * DAY_MS);
        return { refresh, delegationId };
      }

      it('a delegation renewed faithfully still ends 90 days after the consent: the client must ask again', async () => {
        const { refresh, delegationId } = await renewedFor(80);
        // Day 89: still renewed.
        rig.clock.advance(9 * DAY_MS);
        const last = await rig.tokens.refresh(client, refreshForm(refresh));
        // Day 90, to the millisecond: nothing more.
        rig.clock.advance(DAY_MS);
        const err = await refusal(() =>
          rig.tokens.refresh(client, refreshForm(last.refresh_token)),
        );
        expect(err.code).toBe('invalid_grant');
        expect(err.message).toBe(DELEGATION_LIFETIME_REACHED);
        expect(await rig.verifier.resolve(last.access_token)).toBeNull();
        // Derived, never written: the row is as it was and no entry says "revoked".
        expect((await rig.store.delegations.getById(delegationId))?.status).toBe('active');
        expect(revocations()).toEqual([]);
        // Asking again changes nothing and ends nothing.
        await refusal(() => rig.tokens.refresh(client, refreshForm(last.refresh_token)));
        expect((await rig.store.delegations.getById(delegationId))?.status).toBe('active');
      });

      it('one millisecond before the deadline a renewal still passes, and what it issues dies at the deadline', async () => {
        const { refresh, delegationId } = await renewedFor(80);
        rig.clock.advance(10 * DAY_MS - 1);
        const pair = await rig.tokens.refresh(client, refreshForm(refresh));
        // The access token is announced for what it is really worth: under a second.
        expect(pair.expires_in).toBe(0);
        const deadline = new Date(
          Date.parse((await rig.store.delegations.getById(delegationId))!.createdAt) +
            LIFETIME_DAYS * DAY_MS,
        ).toISOString();
        const rows = rig.store.db
          .prepare(
            `SELECT expires_at FROM oauth_refresh_tokens WHERE delegation_id = ? AND revoked_at IS NULL
             UNION ALL
             SELECT expires_at FROM oauth_access_tokens WHERE delegation_id = ? ORDER BY expires_at DESC LIMIT 2`,
          )
          .all(delegationId, delegationId) as { expires_at: string }[];
        expect(rows.map((r) => r.expires_at)).toEqual([deadline, deadline]);
        expect(await rig.verifier.resolve(pair.access_token)).not.toBeNull();
        rig.clock.advance(1);
        expect(await rig.verifier.resolve(pair.access_token)).toBeNull();
      });

      it('no token ever expires after the deadline: a pair obtained on day 80 does not carry the delegation to day 110', async () => {
        const { delegationId } = await renewedFor(80);
        const deadline = new Date(
          Date.parse((await rig.store.delegations.getById(delegationId))!.createdAt) +
            LIFETIME_DAYS * DAY_MS,
        ).toISOString();
        const latest = rig.store.db
          .prepare(
            'SELECT MAX(expires_at) AS until FROM oauth_refresh_tokens WHERE delegation_id = ?',
          )
          .get(delegationId) as { until: string };
        expect(latest.until).toBe(deadline);
      });

      it('the first pair of a delegation is bounded too', async () => {
        const short = await openOAuthRig({
          ttl: { delegationMaxLifetimeSeconds: 600, accessTokenTtlSeconds: 900 },
        });
        try {
          const shortClient = await short.registerClient();
          const { tokens, delegationId } = await short.issue(short.ada, shortClient);
          expect(tokens.expires_in).toBe(600);
          const row = short.store.db
            .prepare('SELECT expires_at FROM oauth_refresh_tokens WHERE delegation_id = ?')
            .get(delegationId) as { expires_at: string };
          expect(Date.parse(row.expires_at) - short.clock.now().getTime()).toBe(600_000);
          short.clock.advance(600_000);
          expect(await short.verifier.resolve(tokens.access_token)).toBeNull();
        } finally {
          await short.close();
        }
      });

      it('a consent left unredeemed past the lifetime issues nothing, and its code is spent', async () => {
        const short = await openOAuthRig({ ttl: { delegationMaxLifetimeSeconds: 30 } });
        try {
          const shortClient = await short.registerClient();
          const granted = await short.grant(short.ada, shortClient);
          short.clock.advance(30_000);
          const form = short.form({
            grant_type: 'authorization_code',
            code: granted.code,
            code_verifier: granted.pkce.verifier,
            redirect_uri: granted.redirectUri,
          });
          const err = await refusal(() => short.tokens.exchangeCode(shortClient, form));
          expect(err.code).toBe('invalid_grant');
          expect(err.message).toBe(DELEGATION_LIFETIME_REACHED);
          expect(
            short.store.db.prepare('SELECT COUNT(*) AS n FROM oauth_refresh_tokens').get(),
          ).toEqual({ n: 0 });
        } finally {
          await short.close();
        }
      });

      it('the reuse window gives nothing past the deadline: the replay ends the family as any replay does', async () => {
        const { refresh, delegationId } = await renewedFor(80);
        rig.clock.advance((LIFETIME_DAYS - 80) * DAY_MS - 5_000);
        // Rotated five seconds before the deadline...
        await rig.tokens.refresh(client, refreshForm(refresh));
        rig.clock.advance(5_000);
        // ...and presented again inside the reuse window, but past the lifetime.
        const err = await refusal(() => rig.tokens.refresh(client, refreshForm(refresh)));
        expect(err.code).toBe('invalid_grant');
        expect((await rig.store.delegations.getById(delegationId))?.revokeReason).toBe(
          'refresh-token-replay',
        );
      });

      it('consenting again gives a new delegation with a lifetime of its own', async () => {
        const { refresh } = await renewedFor(80);
        rig.clock.advance(10 * DAY_MS);
        await refusal(() => rig.tokens.refresh(client, refreshForm(refresh)));
        const again = await rig.issue(rig.ada, client);
        expect(await rig.verifier.resolve(again.tokens.access_token)).not.toBeNull();
        rig.clock.advance(20 * DAY_MS);
        await expect(
          rig.tokens.refresh(client, refreshForm(again.tokens.refresh_token)),
        ).resolves.toBeTruthy();
      });

      it('a lifetime the operator shortened applies at once to tokens already issued', async () => {
        const { tokens } = await rig.issue(rig.ada, client);
        rig.clock.advance(2 * DAY_MS);
        const strict = new DelegatedTokenVerifier({
          repo: rig.store.delegations,
          users: rig.store.users,
          clients: rig.clients,
          lifetime: delegationLifetime(DAY_MS / 1000, rig.clock),
        });
        const renewed = await rig.tokens.refresh(client, refreshForm(tokens.refresh_token));
        expect(await rig.verifier.resolve(renewed.access_token)).not.toBeNull();
        expect(await strict.resolve(renewed.access_token)).toBeNull();
      });
    });

    it('replay revokes the whole family and the delegation, and is audited', async () => {
      const { tokens: first, delegationId } = await rig.issue(rig.ada, client);
      const second = await rig.tokens.refresh(client, refreshForm(first.refresh_token));
      const third = await rig.tokens.refresh(client, refreshForm(second.refresh_token));
      rig.audit.entries.length = 0;

      // The first refresh token, rotated two generations ago, comes back.
      const err = await refusal(() => rig.tokens.refresh(client, refreshForm(first.refresh_token)));
      expect(err).toMatchObject({ code: 'invalid_grant', status: 400 });

      expect(await rig.store.delegations.getById(delegationId)).toMatchObject({
        status: 'revoked',
        revokeReason: 'refresh-token-replay',
        revokedAt: rig.clock.now().toISOString(),
      });
      // Every token of the family is dead: the latest refresh token and every access token.
      for (const access of [first, second, third]) {
        expect(await rig.verifier.resolve(access.access_token)).toBeNull();
      }
      expect(
        (await refusal(() => rig.tokens.refresh(client, refreshForm(third.refresh_token)))).code,
      ).toBe('invalid_grant');
      const live = rig.store.db
        .prepare<[], { n: number }>(
          `SELECT (SELECT COUNT(*) FROM oauth_refresh_tokens WHERE revoked_at IS NULL)
                + (SELECT COUNT(*) FROM oauth_access_tokens WHERE revoked_at IS NULL) AS n`,
        )
        .get();
      expect(live?.n).toBe(0);

      expect(revocations()).toEqual([
        {
          kind: 'admin',
          ts: rig.clock.now().toISOString(),
          user_id: rig.ada.id,
          act: 'delegation-revoked',
          object: { type: 'delegation', id: delegationId },
          before: { status: 'active' },
          after: {
            status: 'revoked',
            reason: 'refresh-token-replay',
            client_id: client.clientId,
            client_name: client.name,
            // It issued no mission: the list is there, and empty.
            missions_to_review: [],
          },
          delegated_client_id: client.clientId,
        },
      ]);
    });

    it('a replay is audited once, however many times the dead token is tried', async () => {
      const { tokens } = await rig.issue(rig.ada, client);
      await rig.tokens.refresh(client, refreshForm(tokens.refresh_token));
      rig.clock.advance(AFTER_REUSE_WINDOW_MS);
      for (let i = 0; i < 3; i += 1) {
        await refusal(() => rig.tokens.refresh(client, refreshForm(tokens.refresh_token)));
      }
      expect(revocations()).toHaveLength(1);
    });

    it('a replay under another client id still ends the family', async () => {
      const other = await rig.registerClient();
      const { tokens, delegationId } = await rig.issue(rig.ada, client);
      await rig.tokens.refresh(client, refreshForm(tokens.refresh_token));
      await refusal(() => rig.tokens.refresh(other, refreshForm(tokens.refresh_token)));
      expect((await rig.store.delegations.getById(delegationId))?.status).toBe('revoked');
    });

    it('two simultaneous renewals of one token, with no reuse window: one wins, and the family ends', async () => {
      const strict = await openOAuthRig({ ttl: { refreshReuseWindowSeconds: 0 } });
      try {
        const strictClient = await strict.registerClient();
        const { tokens, delegationId } = await strict.issue(strict.ada, strictClient);
        const form = (): URLSearchParams =>
          strict.form({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token });
        const results = await Promise.allSettled([
          strict.tokens.refresh(strictClient, form()),
          strict.tokens.refresh(strictClient, form()),
        ]);
        expect(results.filter((r) => r.status === 'fulfilled').length).toBeLessThanOrEqual(1);
        expect(await strict.store.delegations.getById(delegationId)).toMatchObject({
          status: 'revoked',
          revokeReason: 'refresh-token-replay',
        });
        expect(strict.audit.admin.filter((e) => e.act === 'delegation-revoked')).toHaveLength(1);
      } finally {
        await strict.close();
      }
    });

    it('revoking the family of one delegation leaves the others alone', async () => {
      const mine = await rig.issue(rig.ada, client);
      const again = await rig.issue(rig.ada, client);
      const bobs = await rig.issue(rig.bob, client);
      await rig.tokens.refresh(client, refreshForm(mine.tokens.refresh_token));
      rig.clock.advance(AFTER_REUSE_WINDOW_MS);
      await refusal(() => rig.tokens.refresh(client, refreshForm(mine.tokens.refresh_token)));
      expect(await rig.verifier.resolve(again.tokens.access_token)).not.toBeNull();
      expect(await rig.verifier.resolve(bobs.tokens.access_token)).not.toBeNull();
      await expect(
        rig.tokens.refresh(client, refreshForm(bobs.tokens.refresh_token)),
      ).resolves.toBeTruthy();
    });

    it('a refresh token is bound to its client: another client gets nothing and breaks nothing', async () => {
      const other = await rig.registerClient();
      const { tokens, delegationId } = await rig.issue(rig.ada, client);
      const err = await refusal(() => rig.tokens.refresh(other, refreshForm(tokens.refresh_token)));
      expect(err.code).toBe('invalid_grant');
      expect((await rig.store.delegations.getById(delegationId))?.status).toBe('active');
      await expect(
        rig.tokens.refresh(client, refreshForm(tokens.refresh_token)),
      ).resolves.toBeTruthy();
    });

    it('expires when unused for the refresh lifetime, without being a replay', async () => {
      const { tokens, delegationId } = await rig.issue(rig.ada, client);
      rig.clock.advance(30 * 86_400_000);
      const err = await refusal(() =>
        rig.tokens.refresh(client, refreshForm(tokens.refresh_token)),
      );
      expect(err.code).toBe('invalid_grant');
      expect((await rig.store.delegations.getById(delegationId))?.status).toBe('active');
      expect(revocations()).toEqual([]);
    });

    it.each([
      ['an unknown token', mintRefreshToken()],
      ['an access token in its place', 'vbn_dat_' + 'a'.repeat(43)],
      ['a value that is not a token', 'refresh-me'],
    ])('refuses %s', async (_case, token) => {
      expect((await refusal(() => rig.tokens.refresh(client, refreshForm(token)))).code).toBe(
        'invalid_grant',
      );
    });

    it('refuses to widen the scope or to change the resource', async () => {
      const { tokens } = await rig.issue(rig.ada, client);
      const scope = await refusal(() =>
        rig.tokens.refresh(client, refreshForm(tokens.refresh_token, { scope: 'mgmt admin' })),
      );
      expect(scope.code).toBe('invalid_scope');
      const resource = await refusal(() =>
        rig.tokens.refresh(
          client,
          refreshForm(tokens.refresh_token, { resource: 'https://evil.example/mcp/manage' }),
        ),
      );
      expect(resource.code).toBe('invalid_target');
      // Neither refusal consumed the token.
      await expect(
        rig.tokens.refresh(client, refreshForm(tokens.refresh_token, { scope: 'mgmt' })),
      ).resolves.toBeTruthy();
    });

    it('stops renewing once the delegation is revoked or the user is removed', async () => {
      const revoked = await rig.issue(rig.ada, client);
      await rig.delegations.revoke(rig.ada, revoked.delegationId);
      expect(
        (await refusal(() => rig.tokens.refresh(client, refreshForm(revoked.tokens.refresh_token))))
          .code,
      ).toBe('invalid_grant');

      const removed = await rig.issue(rig.bob, client);
      rig.store.db.prepare("UPDATE users SET status = 'removed' WHERE id = ?").run(rig.bob.id);
      expect(
        (await refusal(() => rig.tokens.refresh(client, refreshForm(removed.tokens.refresh_token))))
          .code,
      ).toBe('invalid_grant');
    });
  });

  describe('access tokens are short-lived', () => {
    it('stop working when they expire, to the second', async () => {
      const { tokens } = await rig.issue(rig.ada, client);
      rig.clock.advance(899_000);
      expect(await rig.verifier.resolve(tokens.access_token)).not.toBeNull();
      rig.clock.advance(1000);
      expect(await rig.verifier.resolve(tokens.access_token)).toBeNull();
    });

    it('follow the configured lifetimes', async () => {
      const short = await openOAuthRig({
        ttl: { accessTokenTtlSeconds: 60, refreshTokenTtlSeconds: 3600 },
      });
      const shortClient = await short.registerClient();
      const { tokens } = await short.issue(short.ada, shortClient);
      expect(tokens.expires_in).toBe(60);
      short.clock.advance(61_000);
      expect(await short.verifier.resolve(tokens.access_token)).toBeNull();
      short.clock.advance(3_600_000);
      expect(
        (
          await refusal(() =>
            short.tokens.refresh(
              shortClient,
              short.form({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token }),
            ),
          )
        ).code,
      ).toBe('invalid_grant');
      await short.close();
    });
  });

  describe('revocation (RFC 7009)', () => {
    it('a refresh token ends the delegation of the client that revokes it, with an entry', async () => {
      const { tokens, delegationId } = await rig.issue(rig.ada, client);
      rig.audit.entries.length = 0;
      await rig.tokens.revoke(client, rig.form({ token: tokens.refresh_token }));
      expect(await rig.store.delegations.getById(delegationId)).toMatchObject({
        status: 'revoked',
        revokeReason: 'client',
      });
      expect(await rig.verifier.resolve(tokens.access_token)).toBeNull();
      expect(revocations()).toMatchObject([
        {
          user_id: rig.ada.id,
          object: { type: 'delegation', id: delegationId },
          after: { reason: 'client' },
          delegated_client_id: client.clientId,
        },
      ]);
    });

    it('an access token is revoked alone: the delegation and its refresh token stay', async () => {
      const { tokens, delegationId } = await rig.issue(rig.ada, client);
      rig.audit.entries.length = 0;
      await rig.tokens.revoke(client, rig.form({ token: tokens.access_token }));
      expect(await rig.verifier.resolve(tokens.access_token)).toBeNull();
      expect((await rig.store.delegations.getById(delegationId))?.status).toBe('active');
      await expect(
        rig.tokens.refresh(client, refreshForm(tokens.refresh_token)),
      ).resolves.toBeTruthy();
      expect(rig.audit.entries).toEqual([]);
    });

    it('a token of another client, an unknown token and a dead token change nothing', async () => {
      const other = await rig.registerClient();
      const { tokens, delegationId } = await rig.issue(rig.ada, client);
      rig.audit.entries.length = 0;
      await rig.tokens.revoke(other, rig.form({ token: tokens.refresh_token }));
      await rig.tokens.revoke(other, rig.form({ token: tokens.access_token }));
      await rig.tokens.revoke(client, rig.form({ token: mintRefreshToken() }));
      await rig.tokens.revoke(client, rig.form({ token: 'garbage' }));
      expect((await rig.store.delegations.getById(delegationId))?.status).toBe('active');
      expect(await rig.verifier.resolve(tokens.access_token)).not.toBeNull();
      expect(rig.audit.entries).toEqual([]);

      await rig.tokens.revoke(client, rig.form({ token: tokens.refresh_token }));
      await rig.tokens.revoke(client, rig.form({ token: tokens.refresh_token }));
      expect(revocations()).toHaveLength(1);
    });

    it('requires a token', async () => {
      expect((await refusal(() => rig.tokens.revoke(client, rig.form({})))).code).toBe(
        'invalid_request',
      );
    });
  });

  describe('client authentication', () => {
    const expectCode = async (
      run: () => Promise<unknown>,
      code: OAuthErrorCode,
      status: number,
    ) => {
      expect(await refusal(run)).toMatchObject({ code, status });
    };

    it('identifies a public client by its id', async () => {
      const authenticated = await rig.tokens.authenticateClient({
        clientId: client.clientId,
        clientSecret: null,
        via: 'body',
      });
      expect(authenticated.id).toBe(client.id);
    });

    it('refuses an unknown client', async () => {
      await expectCode(
        () =>
          rig.tokens.authenticateClient({
            clientId: 'vbn_client_nope',
            clientSecret: null,
            via: 'body',
          }),
        'invalid_client',
        401,
      );
    });

    it('requires the secret of a confidential client, and the right one', async () => {
      const open = await openOAuthRig({ registration: { policy: 'open' } });
      const registered = await open.clients.register({ redirect_uris: [WEB_REDIRECT] });
      const id = registered.client.clientId;
      const secret = registered.clientSecret ?? '';
      await expect(
        open.tokens.authenticateClient({ clientId: id, clientSecret: secret, via: 'basic' }),
      ).resolves.toMatchObject({ id: registered.client.id });
      for (const wrong of [null, '', 'wrong', `${secret}x`, secret.slice(0, -1)]) {
        expect(
          await refusal(() =>
            open.tokens.authenticateClient({ clientId: id, clientSecret: wrong, via: 'body' }),
          ),
        ).toMatchObject({ code: 'invalid_client', status: 401 });
      }
      await open.close();
    });

    it('gives nothing to a client that waits for an operator, or that one disabled', async () => {
      const waiting = await rig.registerClient([WEB_REDIRECT]);
      await expectCode(
        () =>
          rig.tokens.authenticateClient({
            clientId: waiting.clientId,
            clientSecret: null,
            via: 'body',
          }),
        'unauthorized_client',
        400,
      );
      await rig.clients.decide('operator-1', client.id, 'disabled');
      await expectCode(
        () =>
          rig.tokens.authenticateClient({
            clientId: client.clientId,
            clientSecret: null,
            via: 'body',
          }),
        'unauthorized_client',
        400,
      );
    });

    it('reads the credentials from the body or from HTTP Basic, never from both', () => {
      expect(clientCredentialsOf(new Headers(), rig.form({ client_id: 'abc' }))).toEqual({
        clientId: 'abc',
        clientSecret: null,
        via: 'body',
      });
      expect(
        clientCredentialsOf(new Headers(), rig.form({ client_id: 'abc', client_secret: 's' })),
      ).toEqual({ clientId: 'abc', clientSecret: 's', via: 'body' });
      const basic = (id: string, secret: string) =>
        new Headers({
          authorization: `Basic ${Buffer.from(`${encodeURIComponent(id)}:${encodeURIComponent(secret)}`).toString('base64')}`,
        });
      expect(clientCredentialsOf(basic('a b', 's:e/c+r'), rig.form({}))).toEqual({
        clientId: 'a b',
        clientSecret: 's:e/c+r',
        via: 'basic',
      });
      expect(() =>
        clientCredentialsOf(basic('abc', 's'), rig.form({ client_secret: 's' })),
      ).toThrow(/both/);
      expect(() =>
        clientCredentialsOf(new Headers({ authorization: 'Basic !!!' }), rig.form({})),
      ).toThrow(OAuthProtocolError);
      expect(() =>
        clientCredentialsOf(
          new Headers({ authorization: `Basic ${Buffer.from('%zz:%zz').toString('base64')}` }),
          rig.form({}),
        ),
      ).toThrow(OAuthProtocolError);
      expect(() => clientCredentialsOf(new Headers(), rig.form({}))).toThrow(/client_id/);
      // RFC 6749 §2.3.1: both parts are form-urlencoded before the base64 —
      // `%XX` escapes and `+` for a space are decoded, a literal `+` is `%2B`.
      const raw = (pair: string) =>
        new Headers({ authorization: `Basic ${Buffer.from(pair).toString('base64')}` });
      expect(clientCredentialsOf(raw('my+client%3A1:p%2Bs+s%25'), rig.form({}))).toEqual({
        clientId: 'my client:1',
        clientSecret: 'p+s s%',
        via: 'basic',
      });
      // The header names the client; a `client_id` repeated in the body is not a second credential.
      expect(clientCredentialsOf(basic('abc', 's'), rig.form({ client_id: 'other' }))).toEqual({
        clientId: 'abc',
        clientSecret: 's',
        via: 'basic',
      });
      // A bearer in the header is not a client credential.
      expect(
        clientCredentialsOf(
          new Headers({ authorization: 'Bearer x' }),
          rig.form({ client_id: 'abc' }),
        ),
      ).toMatchObject({ clientId: 'abc', via: 'body' });
    });
  });

  describe('sweep', () => {
    it('removes long-expired codes and tokens now and then, never a live one', async () => {
      const { tokens } = await rig.issue(rig.ada, client);
      const count = (table: string): number =>
        rig.store.db.prepare<[], { n: number }>(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n ?? 0;
      expect(count('oauth_codes')).toBe(1);
      rig.clock.advance(PURGE_GRACE_MS + PURGE_INTERVAL_MS);
      // The next issuance sweeps what expired more than a day ago.
      const renewed = await rig.tokens.refresh(client, refreshForm(tokens.refresh_token));
      expect(count('oauth_codes')).toBe(0);
      expect(count('oauth_access_tokens')).toBe(1);
      // The rotated refresh token stays while its successor lives.
      expect(count('oauth_refresh_tokens')).toBe(2);
      expect(await rig.verifier.resolve(renewed.access_token)).not.toBeNull();
    });
  });
});
