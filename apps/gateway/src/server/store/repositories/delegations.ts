/**
 * Delegations — OAuth clients, consents (delegations), authorization codes, refresh and
 * access tokens of the management door (spec §4.1 bis, §6 "short, traceable delegated
 * tokens"). Secrets are stored hashed by the caller; the store never sees a clear token.
 */

import { withImmediateTransaction } from '../db.ts';
import { InvariantError, NotFoundError } from '../errors.ts';
import type {
  AccessTokenRecord,
  DelegationRecord,
  DelegationStatus,
  Iso,
  OAuthClientRecord,
  OAuthCodeRecord,
  RefreshTokenRecord,
} from '../types.ts';
import { nowIso, type RepoContext } from './context.ts';

export interface RegisterClientInput {
  readonly clientId: string;
  readonly name: string;
  readonly clientSecretHash?: string | null;
  readonly redirectUris: readonly string[];
}

export interface CreateDelegationInput {
  readonly userId: string;
  /** `oauth_clients.id` (internal), not the public `client_id`. */
  readonly clientId: string;
  readonly scope: string;
}

export interface CreateCodeInput {
  readonly delegationId: string;
  readonly codeHash: string;
  readonly redirectUri: string;
  readonly codeChallenge: string;
  readonly codeChallengeMethod: 'S256';
  readonly expiresAt: Iso;
}

export interface CreateTokenInput {
  readonly delegationId: string;
  readonly tokenHash: string;
  readonly expiresAt: Iso;
}

export interface DelegationsRepo {
  registerClient(input: RegisterClientInput): Promise<OAuthClientRecord>;
  getClient(id: string): Promise<OAuthClientRecord | null>;
  getClientByClientId(clientId: string): Promise<OAuthClientRecord | null>;

  create(input: CreateDelegationInput): Promise<DelegationRecord>;
  getById(id: string): Promise<DelegationRecord | null>;
  listForUser(userId: string): Promise<DelegationRecord[]>;
  /** Revokes the consent and every refresh and access token issued under it. */
  revoke(id: string): Promise<DelegationRecord>;

  createCode(input: CreateCodeInput): Promise<OAuthCodeRecord>;
  /** Single-use: returns the code once, when unexpired and unconsumed, null otherwise. */
  consumeCode(codeHash: string): Promise<OAuthCodeRecord | null>;

  createRefreshToken(input: CreateTokenInput): Promise<RefreshTokenRecord>;
  /** Rotation: the presented token must be live; it is revoked and linked to its successor. */
  rotateRefreshToken(
    tokenHash: string,
    next: Omit<CreateTokenInput, 'delegationId'>,
  ): Promise<RefreshTokenRecord | null>;
  revokeRefreshToken(id: string): Promise<boolean>;

  createAccessToken(input: CreateTokenInput): Promise<AccessTokenRecord>;
  /** A live access token whose delegation is still active, with that delegation. */
  findActiveAccessToken(
    tokenHash: string,
  ): Promise<{ token: AccessTokenRecord; delegation: DelegationRecord } | null>;
  revokeAccessToken(id: string): Promise<boolean>;
}

interface ClientRow {
  id: string;
  client_id: string;
  client_secret_hash: string | null;
  name: string;
  created_at: string;
}

interface DelegationRow {
  id: string;
  user_id: string;
  client_id: string;
  scope: string;
  status: string;
  created_at: string;
  revoked_at: string | null;
}

interface CodeRow {
  id: string;
  delegation_id: string;
  redirect_uri: string;
  code_challenge: string;
  code_challenge_method: string;
  created_at: string;
  expires_at: string;
  consumed_at: string | null;
}

interface RefreshRow {
  id: string;
  delegation_id: string;
  created_at: string;
  expires_at: string;
  revoked_at: string | null;
  replaced_by_id: string | null;
}

interface AccessRow {
  id: string;
  delegation_id: string;
  created_at: string;
  expires_at: string;
  revoked_at: string | null;
}

const DELEGATION_COLUMNS = 'id, user_id, client_id, scope, status, created_at, revoked_at';
const CODE_COLUMNS =
  'id, delegation_id, redirect_uri, code_challenge, code_challenge_method, created_at, expires_at, consumed_at';
const REFRESH_COLUMNS = 'id, delegation_id, created_at, expires_at, revoked_at, replaced_by_id';
const ACCESS_COLUMNS = 'id, delegation_id, created_at, expires_at, revoked_at';

function delegationToRecord(row: DelegationRow): DelegationRecord {
  return {
    id: row.id,
    userId: row.user_id,
    clientId: row.client_id,
    scope: row.scope,
    status: row.status as DelegationStatus,
    createdAt: row.created_at,
    revokedAt: row.revoked_at,
  };
}

function codeToRecord(row: CodeRow): OAuthCodeRecord {
  return {
    id: row.id,
    delegationId: row.delegation_id,
    redirectUri: row.redirect_uri,
    codeChallenge: row.code_challenge,
    codeChallengeMethod: 'S256',
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    consumedAt: row.consumed_at,
  };
}

function refreshToRecord(row: RefreshRow): RefreshTokenRecord {
  return {
    id: row.id,
    delegationId: row.delegation_id,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    replacedById: row.replaced_by_id,
  };
}

function accessToRecord(row: AccessRow): AccessTokenRecord {
  return {
    id: row.id,
    delegationId: row.delegation_id,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
  };
}

export function createDelegationsRepo(ctx: RepoContext): DelegationsRepo {
  const { db } = ctx;
  const clientById = db.prepare<[string], ClientRow>(
    'SELECT id, client_id, client_secret_hash, name, created_at FROM oauth_clients WHERE id = ?',
  );
  const clientByClientId = db.prepare<[string], ClientRow>(
    'SELECT id, client_id, client_secret_hash, name, created_at FROM oauth_clients WHERE client_id = ?',
  );
  const insertClient = db.prepare<[string, string, string | null, string, string]>(
    'INSERT INTO oauth_clients (id, client_id, client_secret_hash, name, created_at) VALUES (?, ?, ?, ?, ?)',
  );
  const insertRedirect = db.prepare<[string, string]>(
    'INSERT INTO oauth_client_redirect_uris (client_id, uri) VALUES (?, ?)',
  );
  const redirectsOf = db.prepare<[string], { uri: string }>(
    'SELECT uri FROM oauth_client_redirect_uris WHERE client_id = ? ORDER BY uri',
  );
  const delegationById = db.prepare<[string], DelegationRow>(
    `SELECT ${DELEGATION_COLUMNS} FROM delegations WHERE id = ?`,
  );
  const delegationsOfUser = db.prepare<[string], DelegationRow>(
    `SELECT ${DELEGATION_COLUMNS} FROM delegations WHERE user_id = ? ORDER BY created_at`,
  );
  const insertDelegation = db.prepare<[string, string, string, string, string]>(
    `INSERT INTO delegations (id, user_id, client_id, scope, status, created_at)
     VALUES (?, ?, ?, ?, 'active', ?)`,
  );
  const revokeDelegation = db.prepare<[string, string]>(
    `UPDATE delegations SET status = 'revoked', revoked_at = ? WHERE id = ? AND status = 'active'`,
  );
  const revokeRefreshOfDelegation = db.prepare<[string, string]>(
    'UPDATE oauth_refresh_tokens SET revoked_at = ? WHERE delegation_id = ? AND revoked_at IS NULL',
  );
  const revokeAccessOfDelegation = db.prepare<[string, string]>(
    'UPDATE oauth_access_tokens SET revoked_at = ? WHERE delegation_id = ? AND revoked_at IS NULL',
  );
  const insertCode = db.prepare<[string, string, string, string, string, string, string, string]>(
    `INSERT INTO oauth_codes (id, code_hash, delegation_id, redirect_uri, code_challenge,
       code_challenge_method, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const codeById = db.prepare<[string], CodeRow>(
    `SELECT ${CODE_COLUMNS} FROM oauth_codes WHERE id = ?`,
  );
  const liveCodeByHash = db.prepare<[string, string], CodeRow>(
    `SELECT ${CODE_COLUMNS} FROM oauth_codes WHERE code_hash = ? AND consumed_at IS NULL AND expires_at > ?`,
  );
  const consumeCode = db.prepare<[string, string]>(
    'UPDATE oauth_codes SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL',
  );
  const insertRefresh = db.prepare<[string, string, string, string, string]>(
    `INSERT INTO oauth_refresh_tokens (id, delegation_id, token_hash, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?)`,
  );
  const refreshById = db.prepare<[string], RefreshRow>(
    `SELECT ${REFRESH_COLUMNS} FROM oauth_refresh_tokens WHERE id = ?`,
  );
  const liveRefreshByHash = db.prepare<
    [string, string],
    RefreshRow & { delegation_status: string }
  >(
    `SELECT t.id, t.delegation_id, t.created_at, t.expires_at, t.revoked_at, t.replaced_by_id,
       d.status AS delegation_status
     FROM oauth_refresh_tokens t JOIN delegations d ON d.id = t.delegation_id
     WHERE t.token_hash = ? AND t.revoked_at IS NULL AND t.expires_at > ?`,
  );
  const replaceRefresh = db.prepare<[string, string, string]>(
    'UPDATE oauth_refresh_tokens SET revoked_at = ?, replaced_by_id = ? WHERE id = ?',
  );
  const revokeRefresh = db.prepare<[string, string]>(
    'UPDATE oauth_refresh_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL',
  );
  const insertAccess = db.prepare<[string, string, string, string, string]>(
    `INSERT INTO oauth_access_tokens (id, delegation_id, token_hash, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?)`,
  );
  const accessById = db.prepare<[string], AccessRow>(
    `SELECT ${ACCESS_COLUMNS} FROM oauth_access_tokens WHERE id = ?`,
  );
  const liveAccessByHash = db.prepare<[string, string], AccessRow>(
    `SELECT t.id, t.delegation_id, t.created_at, t.expires_at, t.revoked_at
     FROM oauth_access_tokens t JOIN delegations d ON d.id = t.delegation_id
     WHERE t.token_hash = ? AND t.revoked_at IS NULL AND t.expires_at > ? AND d.status = 'active'`,
  );
  const revokeAccess = db.prepare<[string, string]>(
    'UPDATE oauth_access_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL',
  );

  function clientToRecord(row: ClientRow): OAuthClientRecord {
    return {
      id: row.id,
      clientId: row.client_id,
      name: row.name,
      clientSecretHash: row.client_secret_hash,
      redirectUris: redirectsOf.all(row.id).map((r) => r.uri),
      createdAt: row.created_at,
    };
  }

  function requireDelegation(id: string): DelegationRecord {
    const row = delegationById.get(id);
    if (!row) throw new NotFoundError('delegation', id);
    return delegationToRecord(row);
  }

  function requireActiveDelegation(id: string): DelegationRecord {
    const delegation = requireDelegation(id);
    if (delegation.status !== 'active') {
      throw new InvariantError(`delegation ${id} is revoked`);
    }
    return delegation;
  }

  return {
    async registerClient(input) {
      if (input.redirectUris.length === 0) {
        throw new InvariantError('an OAuth client registers at least one redirect URI');
      }
      const id = ctx.newId();
      withImmediateTransaction(db, () => {
        insertClient.run(
          id,
          input.clientId,
          input.clientSecretHash ?? null,
          input.name,
          nowIso(ctx),
        );
        for (const uri of new Set(input.redirectUris)) insertRedirect.run(id, uri);
      });
      const row = clientById.get(id);
      if (!row) throw new NotFoundError('oauth_client', id);
      return clientToRecord(row);
    },
    async getClient(id) {
      const row = clientById.get(id);
      return row ? clientToRecord(row) : null;
    },
    async getClientByClientId(clientId) {
      const row = clientByClientId.get(clientId);
      return row ? clientToRecord(row) : null;
    },

    async create(input) {
      const id = ctx.newId();
      insertDelegation.run(id, input.userId, input.clientId, input.scope, nowIso(ctx));
      return requireDelegation(id);
    },
    async getById(id) {
      const row = delegationById.get(id);
      return row ? delegationToRecord(row) : null;
    },
    async listForUser(userId) {
      return delegationsOfUser.all(userId).map(delegationToRecord);
    },
    async revoke(id) {
      requireDelegation(id);
      const now = nowIso(ctx);
      withImmediateTransaction(db, () => {
        revokeDelegation.run(now, id);
        revokeRefreshOfDelegation.run(now, id);
        revokeAccessOfDelegation.run(now, id);
      });
      return requireDelegation(id);
    },

    async createCode(input) {
      requireActiveDelegation(input.delegationId);
      const id = ctx.newId();
      insertCode.run(
        id,
        input.codeHash,
        input.delegationId,
        input.redirectUri,
        input.codeChallenge,
        input.codeChallengeMethod,
        nowIso(ctx),
        input.expiresAt,
      );
      const row = codeById.get(id);
      if (!row) throw new NotFoundError('oauth_code', id);
      return codeToRecord(row);
    },
    async consumeCode(codeHash) {
      const now = nowIso(ctx);
      return withImmediateTransaction(db, () => {
        const row = liveCodeByHash.get(codeHash, now);
        if (!row) return null;
        if (consumeCode.run(now, row.id).changes === 0) return null;
        const consumed = codeById.get(row.id);
        return consumed ? codeToRecord(consumed) : null;
      });
    },

    async createRefreshToken(input) {
      requireActiveDelegation(input.delegationId);
      const id = ctx.newId();
      insertRefresh.run(id, input.delegationId, input.tokenHash, nowIso(ctx), input.expiresAt);
      const row = refreshById.get(id);
      if (!row) throw new NotFoundError('oauth_refresh_token', id);
      return refreshToRecord(row);
    },
    async rotateRefreshToken(tokenHash, next) {
      const now = nowIso(ctx);
      return withImmediateTransaction(db, () => {
        const current = liveRefreshByHash.get(tokenHash, now);
        if (!current || current.delegation_status !== 'active') return null;
        const id = ctx.newId();
        insertRefresh.run(id, current.delegation_id, next.tokenHash, now, next.expiresAt);
        replaceRefresh.run(now, id, current.id);
        const row = refreshById.get(id);
        return row ? refreshToRecord(row) : null;
      });
    },
    async revokeRefreshToken(id) {
      return revokeRefresh.run(nowIso(ctx), id).changes > 0;
    },

    async createAccessToken(input) {
      requireActiveDelegation(input.delegationId);
      const id = ctx.newId();
      insertAccess.run(id, input.delegationId, input.tokenHash, nowIso(ctx), input.expiresAt);
      const row = accessById.get(id);
      if (!row) throw new NotFoundError('oauth_access_token', id);
      return accessToRecord(row);
    },
    async findActiveAccessToken(tokenHash) {
      const row = liveAccessByHash.get(tokenHash, nowIso(ctx));
      if (!row) return null;
      return { token: accessToRecord(row), delegation: requireDelegation(row.delegation_id) };
    },
    async revokeAccessToken(id) {
      return revokeAccess.run(nowIso(ctx), id).changes > 0;
    },
  };
}
