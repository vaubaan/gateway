/**
 * Embedded store — public entry point.
 *
 * `openStore()` opens (or creates) the SQLite file, applies pending migrations and
 * returns the repositories. `openMemoryStore()` does the same on `:memory:` for tests.
 * The returned `Store` also satisfies the composition root's `Store` port
 * (`apps/gateway/src/server/compose/ports.ts`: `kind`, `ping()`, `close()`).
 * Handbook: docs/handbook/store.md. ADR: docs/decisions/embedded-store-sqlite-and-migrations.md.
 */

import { SqliteAuditWriter, type AuditWriter } from './audit-writer.ts';
import type { CatalogIndex } from './catalog-index.ts';
import { systemClock, type Clock } from './clock.ts';
import { backupTo, MEMORY_PATH, openDb, type StoreDb } from './db.ts';
import type { Encryptor } from './encryptor.ts';
import { newId, type IdGenerator } from './ids.ts';
import { DEFAULT_MIGRATIONS_DIR, loadMigrations, runMigrations } from './migrate.ts';
import { createApprovalsRepo, type ApprovalsRepo } from './repositories/approvals.ts';
import { createAuditRepo, type AuditRepo } from './repositories/audit.ts';
import { createConfigRepo, type ConfigRepo } from './repositories/config.ts';
import { createConnectionsRepo, type ConnectionsRepo } from './repositories/connections.ts';
import type { RepoContext } from './repositories/context.ts';
import { createDelegationsRepo, type DelegationsRepo } from './repositories/delegations.ts';
import { createGroupsRepo, type GroupsRepo } from './repositories/groups.ts';
import { createInvitationsRepo, type InvitationsRepo } from './repositories/invitations.ts';
import { createPendingRefsRepo, type PendingRefsRepo } from './repositories/pending-refs.ts';
import { createMissionsRepo, type MissionsRepo } from './repositories/missions.ts';
import { createRequestsRepo, type RequestsRepo } from './repositories/requests.ts';
import { createSealedBlobsRepo, type SealedBlobsRepo } from './repositories/sealed-blobs.ts';
import { createSessionsRepo, type SessionsRepo } from './repositories/sessions.ts';
import { createSharesRepo, type SharesRepo } from './repositories/shares.ts';
import { createUsersRepo, type UsersRepo } from './repositories/users.ts';
import { createWebSessionsRepo, type WebSessionsRepo } from './repositories/web-sessions.ts';

export interface StoreOptions {
  /** Database file on the mounted volume (`InstanceConfig.store.path`), or `MEMORY_PATH`. */
  readonly path: string;
  readonly encryptor: Encryptor;
  readonly catalog: CatalogIndex;
  readonly clock?: Clock;
  readonly newId?: IdGenerator;
  /** Directory of `NNNN_name.sql` files; defaults to `apps/gateway/migrations`. */
  readonly migrationsDir?: string;
  readonly busyTimeoutMs?: number;
}

export type StoreKind = 'sqlite' | 'memory';

export interface Store {
  /** `sqlite` for a file, `memory` for `:memory:` (composition root port). */
  readonly kind: StoreKind;
  readonly users: UsersRepo;
  readonly groups: GroupsRepo;
  /** The addresses an administrator invited to sign in (migration 0014). */
  readonly invitations: InvitationsRepo;
  /** Temporary refs of pushes waiting for an approval (migration 0015). */
  readonly pendingRefs: PendingRefsRepo;
  readonly connections: ConnectionsRepo;
  readonly shares: SharesRepo;
  readonly missions: MissionsRepo;
  readonly sessions: SessionsRepo;
  readonly requests: RequestsRepo;
  readonly approvals: ApprovalsRepo;
  readonly delegations: DelegationsRepo;
  readonly audit: AuditRepo;
  readonly config: ConfigRepo;
  /** Web sessions keyed by the digest of their id; satisfies the root's `SessionStore` port. */
  readonly webSessions: WebSessionsRepo;
  /** Every sealed column, for the master-key re-seal (`reseal` command). */
  readonly sealedBlobs: SealedBlobsRepo;
  readonly auditWriter: AuditWriter;
  /** Highest migration version applied. */
  readonly schemaVersion: number;
  /** Raw handle, for structural tests and diagnostics only. */
  readonly db: StoreDb;
  /** Cheap liveness probe (`SELECT 1`); rejects when the handle is unusable. */
  ping(): Promise<void>;
  /** Consistent single-file copy (`VACUUM INTO`), safe while the gateway runs. */
  backupTo(destinationPath: string): void;
  close(): Promise<void>;
}

export function openStore(options: StoreOptions): Store {
  const db = openDb({ path: options.path, busyTimeoutMs: options.busyTimeoutMs });
  const clock = options.clock ?? systemClock;
  let currentVersion: number;
  try {
    const migrations = loadMigrations(options.migrationsDir ?? DEFAULT_MIGRATIONS_DIR);
    currentVersion = runMigrations(db, migrations, clock).currentVersion;
  } catch (err) {
    // A refused boot must not leave the file (and its -wal) locked by this process.
    db.close();
    throw err;
  }

  const ctx: RepoContext = {
    db,
    clock,
    newId: options.newId ?? newId,
    encryptor: options.encryptor,
    catalog: options.catalog,
  };
  const audit = createAuditRepo(ctx);
  const ping = db.prepare('SELECT 1');

  return {
    kind: options.path === MEMORY_PATH ? 'memory' : 'sqlite',
    users: createUsersRepo(ctx),
    groups: createGroupsRepo(ctx),
    invitations: createInvitationsRepo(ctx),
    pendingRefs: createPendingRefsRepo(ctx),
    connections: createConnectionsRepo(ctx),
    shares: createSharesRepo(ctx),
    missions: createMissionsRepo(ctx),
    sessions: createSessionsRepo(ctx),
    requests: createRequestsRepo(ctx),
    approvals: createApprovalsRepo(ctx),
    delegations: createDelegationsRepo(ctx),
    audit,
    config: createConfigRepo(ctx),
    webSessions: createWebSessionsRepo(ctx),
    sealedBlobs: createSealedBlobsRepo(ctx),
    auditWriter: new SqliteAuditWriter(audit),
    schemaVersion: currentVersion,
    db,
    async ping() {
      ping.get();
    },
    backupTo: (destinationPath) => backupTo(db, destinationPath),
    async close() {
      db.close();
    },
  };
}

/** Ephemeral store for tests: fresh schema in memory, gone on `close()`. */
export function openMemoryStore(options: Omit<StoreOptions, 'path'>): Store {
  return openStore({ ...options, path: MEMORY_PATH });
}

export {
  DEFAULT_BUSY_TIMEOUT_MS,
  MEMORY_PATH,
  MIN_SQLITE_VERSION,
  isSqliteVersionAtLeast,
  withImmediateTransaction,
  journalMode,
} from './db.ts';
export type { StoreDb } from './db.ts';
export { MEMBERSHIPS, isOnMission, membershipOf, type Membership } from './membership.ts';
export { TOKEN_NOT_ISSUABLE_REASONS, TokenNotIssuableError } from './errors.ts';
export type { TokenNotIssuableReason } from './errors.ts';
export { ManualClock, systemClock, toIso } from './clock.ts';
export type { Clock } from './clock.ts';
export { newId, isUuidV7, idTimestampMs } from './ids.ts';
export type { IdGenerator } from './ids.ts';
export { openSealedColumn, openText, sealText } from './encryptor.ts';
export type { EncryptedBlob, Encryptor, SealedBlob } from './encryptor.ts';
export { SetCatalogIndex, assertKnownRiskIds } from './catalog-index.ts';
export type { CatalogIndex } from './catalog-index.ts';
export {
  DEFAULT_MIGRATIONS_DIR,
  checksumOf,
  ensureMigrationsTable,
  listApplied,
  loadMigrations,
  runMigrations,
} from './migrate.ts';
export type { AppliedMigration, Migration, MigrationResult } from './migrate.ts';
export {
  InvariantError,
  MigrationError,
  NotFoundError,
  StoreError,
  UnknownRiskIdError,
} from './errors.ts';
export { SqliteAuditWriter } from './audit-writer.ts';
export type { AuditAppender, AuditEntry, AuditWriter } from './audit-writer.ts';
export * from './types.ts';
export type { UpsertUserInput, UsersRepo } from './repositories/users.ts';
export type { GroupsRepo } from './repositories/groups.ts';
export type { InvitationRecord, InvitationsRepo } from './repositories/invitations.ts';
export type {
  NewPendingRef,
  PendingRefRecord,
  PendingRefsRepo,
} from './repositories/pending-refs.ts';
export type {
  ConnectionFilter,
  ConnectionsRepo,
  CreateConnectionInput,
} from './repositories/connections.ts';
export type { CreateShareInput, SharesRepo } from './repositories/shares.ts';
export type {
  AddMemberInput,
  AppliedLimitChange,
  CreateMissionInput,
  IssuedToken,
  IssueTokenInput,
  LimitChange,
  MissionsRepo,
  RemovedMember,
} from './repositories/missions.ts';
export type {
  DecideContext,
  DecideInput,
  DecideResult,
  DecisionOutcome,
  ListEventsOptions,
  EventHolder,
  RiskEventQuery,
  SessionsRepo,
  StoredLimits,
} from './repositories/sessions.ts';
export { prepareRequestArguments } from './repositories/requests.ts';
export type {
  ApprovalDecisionContext,
  ClaimDecisionContext,
  ClaimDecisionOutcome,
  ClaimDecisionResult,
  RequestDecisionOutcome,
  RequestDecisionResult,
  CreateRequestInput,
  InsertRequestInput,
  OpenRequestLookup,
  PreparedArguments,
  RequestInput,
  RequestsRepo,
} from './repositories/requests.ts';
export type { ApprovalsRepo, ApprovedCall, CreateApprovalInput } from './repositories/approvals.ts';
export type {
  ClientDocumentUpdate,
  CreateCodeInput,
  CreateDelegationInput,
  CreateTokenInput,
  DelegationsRepo,
  RegisterClientInput,
  WithDelegation,
} from './repositories/delegations.ts';
export { DEFAULT_AUDIT_RETENTION_DAYS } from './repositories/audit.ts';
export type {
  AgentLabelActivity,
  AgentLabelSeen,
  AuditCallRecord,
  AuditCursor,
  AuditFilter,
  AuditRecord,
  AuditRepo,
  AuditRiskRow,
  AuditScope,
  AuditSearch,
  CallLookup,
  TokenHolderActivity,
} from './repositories/audit.ts';
export type { ConfigRepo, ConfigWrite } from './repositories/config.ts';
export type { WebSessionsRepo } from './repositories/web-sessions.ts';
export { SEALED_COLUMNS, sealedVersionsOf } from './repositories/sealed-blobs.ts';
export type {
  ResealReport,
  ResealTableReport,
  SealedBlobsRepo,
  SealedProbe,
  SealedTable,
  SealedVersionCount,
} from './repositories/sealed-blobs.ts';
