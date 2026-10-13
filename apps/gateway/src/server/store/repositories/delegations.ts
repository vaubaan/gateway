/**
 * Delegations — OAuth clients, consents (delegations), authorization codes, refresh and
 * access tokens of the management door (spec §4.1 bis, §6 "short, traceable delegated
 * tokens"). Secrets are stored hashed by the caller; the store never sees a clear token.
 *
 * One delegation is one consent and one family of tokens: revoking it revokes every
 * refresh and access token issued under it, in one transaction.
 */

import { withImmediateTransaction } from '../db.ts';
import { InvariantError, NotFoundError } from '../errors.ts';
import {
  CLIENT_OPERATOR_DECISIONS,
  CLIENT_REGISTRATIONS,
  CODE_CHALLENGE_METHODS,
  DELEGATION_REVOKE_REASONS,
  DELEGATION_STATUSES,
  TOKEN_ENDPOINT_AUTH_METHODS,
  type AccessTokenRecord,
  type ClientOperatorDecision,
  type ClientRegistration,
  type CodeChallengeMethod,
  type DelegationActivity,
  type DelegationRecord,
  type DelegationRevokeReason,
  type Iso,
  type OAuthClientRecord,
  type OAuthCodeRecord,
  type RefreshTokenRecord,
  type TokenEndpointAuthMethod,
} from '../types.ts';
import { nowIso, parseEnum, placeholders, requireRow, type RepoContext } from './context.ts';

export interface RegisterClientInput {
  readonly clientId: string;
  readonly name: string;
  readonly clientSecretHash?: string | null;
  readonly redirectUris: readonly string[];
  /** Defaults to `dynamic`. */
  readonly registration?: ClientRegistration;
  /** Defaults to `none` (a public client). */
  readonly tokenEndpointAuthMethod?: TokenEndpointAuthMethod;
  readonly clientUri?: string | null;
  readonly metadataExpiresAt?: Iso | null;
}

/** What a re-fetched Client ID Metadata Document may change of its client. */
export interface ClientDocumentUpdate {
  readonly name: string;
  readonly redirectUris: readonly string[];
  readonly clientUri: string | null;
  readonly metadataExpiresAt: Iso;
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
  readonly codeChallengeMethod: CodeChallengeMethod;
  readonly expiresAt: Iso;
}

export interface CreateTokenInput {
  readonly delegationId: string;
  readonly tokenHash: string;
  readonly expiresAt: Iso;
}

/** A token to write under a delegation the repository already holds. */
export type TokenToIssue = Omit<CreateTokenInput, 'delegationId'>;

/** What `redeemCode` did with an authorization code (see the method). */
export type RedeemCodeResult =
  | { readonly outcome: 'issued'; readonly delegation: DelegationRecord }
  | { readonly outcome: 'refused'; readonly reason: string; readonly delegation: DelegationRecord }
  | { readonly outcome: 'replayed'; readonly delegation: DelegationRecord }
  | { readonly outcome: 'expired' }
  | { readonly outcome: 'unknown' };

/** `redeemCode` refuses with this reason when the code's delegation is no longer active. */
export const REDEEM_DELEGATION_REVOKED = 'delegation-revoked';

/** A token or code row with the delegation it belongs to, whatever their state. */
export interface WithDelegation<T> {
  readonly token: T;
  readonly delegation: DelegationRecord;
}

export interface DelegationsRepo {
  registerClient(input: RegisterClientInput): Promise<OAuthClientRecord>;
  getClient(id: string): Promise<OAuthClientRecord | null>;
  getClientByClientId(clientId: string): Promise<OAuthClientRecord | null>;
  /** Every client, most recently registered first. */
  listClients(): Promise<OAuthClientRecord[]>;
  /** Replaces what a metadata document says of its client: name, redirect URIs, home page. */
  updateClientDocument(id: string, update: ClientDocumentUpdate): Promise<OAuthClientRecord>;
  /** Records the operator's decision; it replaces the previous one. */
  decideClient(
    id: string,
    decision: ClientOperatorDecision,
    decidedBy: string,
  ): Promise<OAuthClientRecord>;
  /**
   * The operator disables a client: the decision and the revocation of every active
   * delegation the client holds, with their refresh and access tokens (reason
   * `operator`), in one transaction — a disabled client never keeps a live delegation.
   * `revoked` lists the delegations this call ended, oldest first.
   */
  disableClient(
    id: string,
    decidedBy: string,
  ): Promise<{ client: OAuthClientRecord; revoked: DelegationRecord[] }>;
  /**
   * Deletes the clients registered before `createdBefore` that no operator decided
   * about and that never received a delegation. Returns how many went.
   */
  deleteUnusedClients(createdBefore: Iso): Promise<number>;

  create(input: CreateDelegationInput): Promise<DelegationRecord>;
  getById(id: string): Promise<DelegationRecord | null>;
  listForUser(userId: string): Promise<DelegationRecord[]>;
  /** The delegations given to one client (`oauth_clients.id`), oldest first. */
  listForClient(clientId: string): Promise<DelegationRecord[]>;
  /**
   * Revokes the consent and every refresh and access token issued under it. The reason
   * is recorded by the call that actually revokes; revoking again changes nothing.
   */
  revoke(id: string, reason?: DelegationRevokeReason): Promise<DelegationRecord>;
  /**
   * Same revocation, for a caller that must act once on it (write the audit entry):
   * the revoked delegation when this call is the one that revoked it, `null` when it
   * was already revoked or does not exist.
   */
  revokeIfActive(id: string, reason: DelegationRevokeReason): Promise<DelegationRecord | null>;
  /** Token activity of each delegation asked for; absent ids are absent from the map. */
  activityOf(delegationIds: readonly string[]): Promise<Map<string, DelegationActivity>>;

  createCode(input: CreateCodeInput): Promise<OAuthCodeRecord>;
  /** The code row whatever its state (consumed, expired), with its delegation. */
  findCode(codeHash: string): Promise<WithDelegation<OAuthCodeRecord> | null>;
  /** Single-use: returns the code once, when unexpired and unconsumed, null otherwise. */
  consumeCode(codeHash: string): Promise<OAuthCodeRecord | null>;
  /**
   * The authorization-code grant as one transaction: the code is spent, `check` judges
   * the request against the spent code and its delegation, and the first refresh and
   * access tokens of the family are written.
   *
   * - `issued`: the code was live, `check` returned `null`, the delegation is active;
   *   both tokens exist.
   * - `refused`: the code was live and **is now spent**, and nothing was issued —
   *   `check` returned a reason, or the delegation is revoked (`delegation-revoked`).
   * - `replayed`: the code had been spent before; nothing changes here (the caller
   *   revokes the family).
   * - `expired`, `unknown`: nothing changes.
   *
   * `check` is synchronous and pure (it runs inside the transaction). If a write
   * fails, the whole transaction rolls back — the code is **not** spent, no token
   * exists — and the error is thrown: the request may be sent again.
   */
  redeemCode(
    codeHash: string,
    check: (code: OAuthCodeRecord, delegation: DelegationRecord) => string | null,
    issue: { readonly refresh: TokenToIssue; readonly access: TokenToIssue },
  ): Promise<RedeemCodeResult>;

  createRefreshToken(input: CreateTokenInput): Promise<RefreshTokenRecord>;
  /** The refresh token row whatever its state (rotated, revoked, expired), with its delegation. */
  findRefreshToken(tokenHash: string): Promise<WithDelegation<RefreshTokenRecord> | null>;
  /**
   * Rotation: the presented token must be live; it is revoked and linked to its
   * successor. With `access`, the access token of the renewal is written in the same
   * transaction: a failure of either write leaves the presented token live and
   * nothing issued.
   */
  rotateRefreshToken(
    tokenHash: string,
    next: TokenToIssue,
    access?: TokenToIssue,
  ): Promise<RefreshTokenRecord | null>;
  /**
   * The reuse window of a rotation (ADR management-door-authorization-server,
   * amendment of 2026-10-13): `previousHash` names a token that was rotated at
   * or after `rotatedSince` and whose successor is still the live head of its
   * family. That successor is rotated in turn — revoked and linked to `next` —
   * in one transaction, and `next` is returned. `null` when any of this does not
   * hold: the presented token is then a plain replay. With `access`, the access
   * token of the renewal is written in the same transaction.
   */
  rotateSuccessorOf(
    previousHash: string,
    rotatedSince: Iso,
    next: TokenToIssue,
    access?: TokenToIssue,
  ): Promise<RefreshTokenRecord | null>;

  createAccessToken(input: CreateTokenInput): Promise<AccessTokenRecord>;
  /** A live access token whose delegation is still active, with that delegation. */
  findActiveAccessToken(
    tokenHash: string,
  ): Promise<{ token: AccessTokenRecord; delegation: DelegationRecord } | null>;
  revokeAccessToken(id: string): Promise<boolean>;

  /**
   * Deletes the codes and tokens that expired before `expiredBefore`. A rotated refresh
   * token is kept as long as its successor lives, so its replay is still recognised.
   * Returns how many rows went.
   */
  purgeExpired(expiredBefore: Iso): Promise<number>;
}

interface ClientRow {
  id: string;
  client_id: string;
  client_secret_hash: string | null;
  name: string;
  registration: string;
  token_endpoint_auth_method: string;
  client_uri: string | null;
  metadata_expires_at: string | null;
  operator_decision: string | null;
  decided_at: string | null;
  decided_by: string | null;
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
  revoke_reason: string | null;
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

interface ActivityRow {
  delegation_id: string;
  last_token_at: string | null;
  live_until: string | null;
}

const CLIENT_COLUMNS = `id, client_id, client_secret_hash, name, registration,
  token_endpoint_auth_method, client_uri, metadata_expires_at, operator_decision, decided_at,
  decided_by, created_at`;
const DELEGATION_COLUMNS =
  'id, user_id, client_id, scope, status, created_at, revoked_at, revoke_reason';
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
    status: parseEnum(DELEGATION_STATUSES, row.status, 'delegations.status'),
    createdAt: row.created_at,
    revokedAt: row.revoked_at,
    revokeReason:
      row.revoke_reason === null
        ? null
        : parseEnum(DELEGATION_REVOKE_REASONS, row.revoke_reason, 'delegations.revoke_reason'),
  };
}

function codeToRecord(row: CodeRow): OAuthCodeRecord {
  return {
    id: row.id,
    delegationId: row.delegation_id,
    redirectUri: row.redirect_uri,
    codeChallenge: row.code_challenge,
    codeChallengeMethod: parseEnum(
      CODE_CHALLENGE_METHODS,
      row.code_challenge_method,
      'oauth_codes.code_challenge_method',
    ),
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
    `SELECT ${CLIENT_COLUMNS} FROM oauth_clients WHERE id = ?`,
  );
  const clientByClientId = db.prepare<[string], ClientRow>(
    `SELECT ${CLIENT_COLUMNS} FROM oauth_clients WHERE client_id = ?`,
  );
  const allClients = db.prepare<[], ClientRow>(
    `SELECT ${CLIENT_COLUMNS} FROM oauth_clients ORDER BY created_at DESC, id DESC`,
  );
  const insertClient = db.prepare<
    [string, string, string | null, string, string, string, string | null, string | null, string]
  >(
    `INSERT INTO oauth_clients (id, client_id, client_secret_hash, name, registration,
       token_endpoint_auth_method, client_uri, metadata_expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const updateClientDocumentStmt = db.prepare<[string, string | null, string, string]>(
    'UPDATE oauth_clients SET name = ?, client_uri = ?, metadata_expires_at = ? WHERE id = ?',
  );
  const decideClientStmt = db.prepare<[string, string, string, string]>(
    'UPDATE oauth_clients SET operator_decision = ?, decided_at = ?, decided_by = ? WHERE id = ?',
  );
  const insertRedirect = db.prepare<[string, string]>(
    'INSERT INTO oauth_client_redirect_uris (client_id, uri) VALUES (?, ?)',
  );
  const deleteRedirects = db.prepare<[string]>(
    'DELETE FROM oauth_client_redirect_uris WHERE client_id = ?',
  );
  const redirectsOf = db.prepare<[string], { uri: string }>(
    'SELECT uri FROM oauth_client_redirect_uris WHERE client_id = ? ORDER BY uri',
  );
  // The redirect URIs go with their client (ON DELETE CASCADE).
  const deleteUnusedClientsStmt = db.prepare<[string]>(
    `DELETE FROM oauth_clients
     WHERE created_at < ? AND operator_decision IS NULL
       AND id NOT IN (SELECT client_id FROM delegations)`,
  );
  const delegationById = db.prepare<[string], DelegationRow>(
    `SELECT ${DELEGATION_COLUMNS} FROM delegations WHERE id = ?`,
  );
  const delegationsOfUser = db.prepare<[string], DelegationRow>(
    `SELECT ${DELEGATION_COLUMNS} FROM delegations WHERE user_id = ? ORDER BY created_at, id`,
  );
  const delegationsOfClient = db.prepare<[string], DelegationRow>(
    `SELECT ${DELEGATION_COLUMNS} FROM delegations WHERE client_id = ? ORDER BY created_at, id`,
  );
  const insertDelegation = db.prepare<[string, string, string, string, string]>(
    `INSERT INTO delegations (id, user_id, client_id, scope, status, created_at)
     VALUES (?, ?, ?, ?, 'active', ?)`,
  );
  const revokeDelegation = db.prepare<[string, string | null, string]>(
    `UPDATE delegations SET status = 'revoked', revoked_at = ?, revoke_reason = ?
     WHERE id = ? AND status = 'active'`,
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
  const codeByHash = db.prepare<[string], CodeRow>(
    `SELECT ${CODE_COLUMNS} FROM oauth_codes WHERE code_hash = ?`,
  );
  const liveCodeByHash = db.prepare<[string, string], CodeRow>(
    `SELECT ${CODE_COLUMNS} FROM oauth_codes WHERE code_hash = ? AND consumed_at IS NULL AND expires_at > ?`,
  );
  const consumeCodeStmt = db.prepare<[string, string]>(
    'UPDATE oauth_codes SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL',
  );
  const insertRefresh = db.prepare<[string, string, string, string, string]>(
    `INSERT INTO oauth_refresh_tokens (id, delegation_id, token_hash, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?)`,
  );
  const refreshById = db.prepare<[string], RefreshRow>(
    `SELECT ${REFRESH_COLUMNS} FROM oauth_refresh_tokens WHERE id = ?`,
  );
  const refreshByHash = db.prepare<[string], RefreshRow>(
    `SELECT ${REFRESH_COLUMNS} FROM oauth_refresh_tokens WHERE token_hash = ?`,
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
  const liveRefreshById = db.prepare<[string, string], RefreshRow & { delegation_status: string }>(
    `SELECT t.id, t.delegation_id, t.created_at, t.expires_at, t.revoked_at, t.replaced_by_id,
       d.status AS delegation_status
     FROM oauth_refresh_tokens t JOIN delegations d ON d.id = t.delegation_id
     WHERE t.id = ? AND t.revoked_at IS NULL AND t.replaced_by_id IS NULL AND t.expires_at > ?`,
  );
  const replaceRefresh = db.prepare<[string, string, string]>(
    'UPDATE oauth_refresh_tokens SET revoked_at = ?, replaced_by_id = ? WHERE id = ?',
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
  const purgeCodes = db.prepare<[string]>('DELETE FROM oauth_codes WHERE expires_at < ?');
  const purgeAccess = db.prepare<[string]>('DELETE FROM oauth_access_tokens WHERE expires_at < ?');
  // A rotated token points at its successor: it stays while that successor lives, and a
  // successor stays while a surviving token still points at it.
  const purgeRefresh = db.prepare<[string, string, string]>(
    `DELETE FROM oauth_refresh_tokens
     WHERE expires_at < ?
       AND (replaced_by_id IS NULL
            OR replaced_by_id NOT IN (SELECT id FROM oauth_refresh_tokens WHERE expires_at >= ?))
       AND id NOT IN (SELECT replaced_by_id FROM oauth_refresh_tokens
                      WHERE replaced_by_id IS NOT NULL AND expires_at >= ?)`,
  );
  // The successor of a token deleted above may itself be deleted: unlink first.
  const unlinkPurgedSuccessors = db.prepare<[string, string]>(
    `UPDATE oauth_refresh_tokens SET replaced_by_id = NULL
     WHERE replaced_by_id IN (SELECT id FROM oauth_refresh_tokens WHERE expires_at < ?)
       AND expires_at < ?`,
  );

  function clientToRecord(row: ClientRow): OAuthClientRecord {
    return {
      id: row.id,
      clientId: row.client_id,
      name: row.name,
      clientSecretHash: row.client_secret_hash,
      redirectUris: redirectsOf.all(row.id).map((r) => r.uri),
      registration: parseEnum(CLIENT_REGISTRATIONS, row.registration, 'oauth_clients.registration'),
      tokenEndpointAuthMethod: parseEnum(
        TOKEN_ENDPOINT_AUTH_METHODS,
        row.token_endpoint_auth_method,
        'oauth_clients.token_endpoint_auth_method',
      ),
      clientUri: row.client_uri,
      metadataExpiresAt: row.metadata_expires_at,
      operatorDecision:
        row.operator_decision === null
          ? null
          : parseEnum(
              CLIENT_OPERATOR_DECISIONS,
              row.operator_decision,
              'oauth_clients.operator_decision',
            ),
      decidedAt: row.decided_at,
      decidedBy: row.decided_by,
      createdAt: row.created_at,
    };
  }

  function requireClient(id: string): OAuthClientRecord {
    const row = clientById.get(id);
    if (!row) throw new NotFoundError('oauth_client', id);
    return clientToRecord(row);
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

  /**
   * Inside a transaction: `current` (a live refresh token of an active delegation) is
   * revoked and linked to its successor `next`; the renewal's access token, when
   * given, is written with it. A throw rolls the caller's transaction back.
   */
  function rotateInto(
    current: Pick<RefreshRow, 'id' | 'delegation_id'>,
    next: TokenToIssue,
    access: TokenToIssue | undefined,
    now: Iso,
  ): RefreshTokenRecord | null {
    const id = ctx.newId();
    insertRefresh.run(id, current.delegation_id, next.tokenHash, now, next.expiresAt);
    replaceRefresh.run(now, id, current.id);
    if (access) {
      insertAccess.run(ctx.newId(), current.delegation_id, access.tokenHash, now, access.expiresAt);
    }
    const row = refreshById.get(id);
    return row ? refreshToRecord(row) : null;
  }

  function requireRedirectUris(uris: readonly string[]): readonly string[] {
    if (uris.length === 0) {
      throw new InvariantError('an OAuth client registers at least one redirect URI');
    }
    return [...new Set(uris)];
  }

  return {
    async registerClient(input) {
      const redirectUris = requireRedirectUris(input.redirectUris);
      const id = ctx.newId();
      withImmediateTransaction(db, () => {
        insertClient.run(
          id,
          input.clientId,
          input.clientSecretHash ?? null,
          input.name,
          input.registration ?? 'dynamic',
          input.tokenEndpointAuthMethod ?? 'none',
          input.clientUri ?? null,
          input.metadataExpiresAt ?? null,
          nowIso(ctx),
        );
        for (const uri of redirectUris) insertRedirect.run(id, uri);
      });
      return clientToRecord(requireRow(clientById.get(id), 'oauth_client', id));
    },
    async getClient(id) {
      const row = clientById.get(id);
      return row ? clientToRecord(row) : null;
    },
    async getClientByClientId(clientId) {
      const row = clientByClientId.get(clientId);
      return row ? clientToRecord(row) : null;
    },
    async listClients() {
      return allClients.all().map(clientToRecord);
    },
    async updateClientDocument(id, update) {
      const redirectUris = requireRedirectUris(update.redirectUris);
      requireClient(id);
      withImmediateTransaction(db, () => {
        updateClientDocumentStmt.run(update.name, update.clientUri, update.metadataExpiresAt, id);
        deleteRedirects.run(id);
        for (const uri of redirectUris) insertRedirect.run(id, uri);
      });
      return requireClient(id);
    },
    async decideClient(id, decision, decidedBy) {
      requireClient(id);
      decideClientStmt.run(decision, nowIso(ctx), decidedBy, id);
      return requireClient(id);
    },
    async disableClient(id, decidedBy) {
      const now = nowIso(ctx);
      return withImmediateTransaction(db, () => {
        requireClient(id);
        decideClientStmt.run('disabled', now, decidedBy, id);
        const ended: string[] = [];
        for (const row of delegationsOfClient.all(id)) {
          if (revokeDelegation.run(now, 'operator', row.id).changes === 0) continue;
          revokeRefreshOfDelegation.run(now, row.id);
          revokeAccessOfDelegation.run(now, row.id);
          ended.push(row.id);
        }
        return { client: requireClient(id), revoked: ended.map(requireDelegation) };
      });
    },
    async deleteUnusedClients(createdBefore) {
      return deleteUnusedClientsStmt.run(createdBefore).changes;
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
    async listForClient(clientId) {
      return delegationsOfClient.all(clientId).map(delegationToRecord);
    },
    async revoke(id, reason) {
      requireDelegation(id);
      const now = nowIso(ctx);
      withImmediateTransaction(db, () => {
        revokeDelegation.run(now, reason ?? null, id);
        revokeRefreshOfDelegation.run(now, id);
        revokeAccessOfDelegation.run(now, id);
      });
      return requireDelegation(id);
    },
    async revokeIfActive(id, reason) {
      const now = nowIso(ctx);
      const revoked = withImmediateTransaction(db, () => {
        if (revokeDelegation.run(now, reason, id).changes === 0) return false;
        revokeRefreshOfDelegation.run(now, id);
        revokeAccessOfDelegation.run(now, id);
        return true;
      });
      return revoked ? requireDelegation(id) : null;
    },
    async activityOf(delegationIds) {
      const out = new Map<string, DelegationActivity>();
      const ids = [...new Set(delegationIds)];
      if (ids.length === 0) return out;
      const list = placeholders(ids.length);
      // Both token tables as one set of (delegation, created, live-until) rows.
      const rows = db
        .prepare<string[], ActivityRow>(
          `SELECT delegation_id, MAX(created_at) AS last_token_at, MAX(live_until) AS live_until
           FROM (
             SELECT delegation_id, created_at,
               CASE WHEN revoked_at IS NULL THEN expires_at END AS live_until
             FROM oauth_refresh_tokens WHERE delegation_id IN (${list})
             UNION ALL
             SELECT delegation_id, created_at,
               CASE WHEN revoked_at IS NULL THEN expires_at END AS live_until
             FROM oauth_access_tokens WHERE delegation_id IN (${list})
           ) AS tokens
           GROUP BY delegation_id`,
        )
        .all(...ids, ...ids);
      for (const row of rows) {
        out.set(row.delegation_id, {
          lastTokenAt: row.last_token_at,
          liveUntil: row.live_until,
        });
      }
      return out;
    },

    async createCode(input) {
      const id = ctx.newId();
      // The check and the insert are one transaction: no code under a delegation
      // revoked in between, whatever the driver.
      withImmediateTransaction(db, () => {
        requireActiveDelegation(input.delegationId);
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
      });
      return codeToRecord(requireRow(codeById.get(id), 'oauth_code', id));
    },
    async findCode(codeHash) {
      const row = codeByHash.get(codeHash);
      if (!row) return null;
      return { token: codeToRecord(row), delegation: requireDelegation(row.delegation_id) };
    },
    async consumeCode(codeHash) {
      const now = nowIso(ctx);
      return withImmediateTransaction(db, () => {
        const row = liveCodeByHash.get(codeHash, now);
        if (!row) return null;
        if (consumeCodeStmt.run(now, row.id).changes === 0) return null;
        const consumed = codeById.get(row.id);
        return consumed ? codeToRecord(consumed) : null;
      });
    },
    async redeemCode(codeHash, check, issue) {
      const now = nowIso(ctx);
      return withImmediateTransaction(db, (): RedeemCodeResult => {
        const row = codeByHash.get(codeHash);
        if (!row) return { outcome: 'unknown' };
        const delegation = requireDelegation(row.delegation_id);
        if (row.consumed_at !== null) return { outcome: 'replayed', delegation };
        if (row.expires_at <= now) return { outcome: 'expired' };
        if (consumeCodeStmt.run(now, row.id).changes === 0) {
          return { outcome: 'replayed', delegation };
        }
        // From here on the code is spent: a refusal below commits that.
        const code = codeToRecord({ ...row, consumed_at: now });
        const reason =
          check(code, delegation) ??
          (delegation.status === 'active' ? null : REDEEM_DELEGATION_REVOKED);
        if (reason !== null) return { outcome: 'refused', reason, delegation };
        // A failure of either insert throws: the transaction rolls back, code included.
        insertRefresh.run(
          ctx.newId(),
          delegation.id,
          issue.refresh.tokenHash,
          now,
          issue.refresh.expiresAt,
        );
        insertAccess.run(
          ctx.newId(),
          delegation.id,
          issue.access.tokenHash,
          now,
          issue.access.expiresAt,
        );
        return { outcome: 'issued', delegation };
      });
    },

    async createRefreshToken(input) {
      const id = ctx.newId();
      withImmediateTransaction(db, () => {
        requireActiveDelegation(input.delegationId);
        insertRefresh.run(id, input.delegationId, input.tokenHash, nowIso(ctx), input.expiresAt);
      });
      return refreshToRecord(requireRow(refreshById.get(id), 'oauth_refresh_token', id));
    },
    async findRefreshToken(tokenHash) {
      const row = refreshByHash.get(tokenHash);
      if (!row) return null;
      return { token: refreshToRecord(row), delegation: requireDelegation(row.delegation_id) };
    },
    async rotateRefreshToken(tokenHash, next, access) {
      const now = nowIso(ctx);
      return withImmediateTransaction(db, () => {
        const current = liveRefreshByHash.get(tokenHash, now);
        if (!current || current.delegation_status !== 'active') return null;
        return rotateInto(current, next, access, now);
      });
    },
    async rotateSuccessorOf(previousHash, rotatedSince, next, access) {
      const now = nowIso(ctx);
      return withImmediateTransaction(db, () => {
        const previous = refreshByHash.get(previousHash);
        if (!previous || previous.replaced_by_id === null || previous.revoked_at === null) {
          return null;
        }
        if (previous.revoked_at < rotatedSince) return null;
        const head = liveRefreshById.get(previous.replaced_by_id, now);
        if (!head || head.delegation_status !== 'active') return null;
        return rotateInto(head, next, access, now);
      });
    },

    async createAccessToken(input) {
      const id = ctx.newId();
      withImmediateTransaction(db, () => {
        requireActiveDelegation(input.delegationId);
        insertAccess.run(id, input.delegationId, input.tokenHash, nowIso(ctx), input.expiresAt);
      });
      return accessToRecord(requireRow(accessById.get(id), 'oauth_access_token', id));
    },
    async findActiveAccessToken(tokenHash) {
      const row = liveAccessByHash.get(tokenHash, nowIso(ctx));
      if (!row) return null;
      return { token: accessToRecord(row), delegation: requireDelegation(row.delegation_id) };
    },
    async revokeAccessToken(id) {
      return revokeAccess.run(nowIso(ctx), id).changes > 0;
    },

    async purgeExpired(expiredBefore) {
      return withImmediateTransaction(db, () => {
        let purged = purgeCodes.run(expiredBefore).changes;
        purged += purgeAccess.run(expiredBefore).changes;
        unlinkPurgedSuccessors.run(expiredBefore, expiredBefore);
        purged += purgeRefresh.run(expiredBefore, expiredBefore, expiredBefore).changes;
        return purged;
      });
    },
  };
}
