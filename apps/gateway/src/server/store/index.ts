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
import { SetCatalogIndex, type CatalogIndex } from './catalog-index.ts';
import { systemClock, type Clock } from './clock.ts';
import {
  backupTo,
  MEMORY_PATH,
  openCopyForWriting,
  openDb,
  sizeOnDisk,
  type StoreDb,
} from './db.ts';
import type { Encryptor } from './encryptor.ts';
import { newId, type IdGenerator } from './ids.ts';
import { DEFAULT_MIGRATIONS_DIR, loadMigrations, runMigrations } from './migrate.ts';
import { copyBeforeMigrating, type PreMigrationCopy } from './pre-migration-copy.ts';
import {
  createAdministratorsRepo,
  type AdministratorsRepo,
} from './repositories/administrators.ts';
import { createApprovalsRepo, type ApprovalsRepo } from './repositories/approvals.ts';
import { createAuditRepo, type AuditRepo } from './repositories/audit.ts';
import { createConfigRepo, type ConfigRepo } from './repositories/config.ts';
import { createAccountsRepo, type AccountsRepo } from './repositories/accounts.ts';
import type { RepoContext } from './repositories/context.ts';
import { createGroupsRepo, type GroupsRepo } from './repositories/groups.ts';
import { createInvitationsRepo, type InvitationsRepo } from './repositories/invitations.ts';
import {
  createSignInAccountsRepo,
  type SignInAccountsRepo,
} from './repositories/sign-in-accounts.ts';
import { createPendingRefsRepo, type PendingRefsRepo } from './repositories/pending-refs.ts';
import { createMissionsRepo, type MissionsRepo } from './repositories/missions/index.ts';
import {
  createMissionVersionsRepo,
  type MissionVersionsRepo,
} from './repositories/mission-versions.ts';
import {
  createNotificationDevicesRepo,
  type NotificationDevicesRepo,
} from './repositories/notification-devices.ts';
import {
  createNotificationAddressesRepo,
  type NotificationAddressesRepo,
} from './repositories/notification-addresses.ts';
import {
  createNotificationMailRepo,
  type NotificationMailRepo,
} from './repositories/notification-mail.ts';
import { createPluginSignersRepo, type PluginSignersRepo } from './repositories/plugin-signers.ts';
import {
  createPluginVersionsRepo,
  type PluginVersionsRepo,
} from './repositories/plugin-versions.ts';
import { createRequestsRepo, type RequestsRepo } from './repositories/requests.ts';
import { createSealedBlobsRepo, type SealedBlobsRepo } from './repositories/sealed-blobs.ts';
import { createSecondFactorsRepo, type SecondFactorsRepo } from './repositories/second-factors.ts';
import { createMissionLogsRepo, type MissionLogsRepo } from './repositories/mission-logs.ts';
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
  /** The administrators of the instance: users, pending addresses, groups (migration 0020). */
  readonly administrators: AdministratorsRepo;
  /** The accounts, secrets and links of a sign-in provider of kind `local`. */
  readonly signInAccounts: SignInAccountsRepo;
  /** The second factor of every person, whatever their service (migration 0021). */
  readonly secondFactors: SecondFactorsRepo;
  /** The devices a person receives notifications on, subscriptions sealed (migration 0030). */
  readonly notificationDevices: NotificationDevicesRepo;
  /** The messaging addresses a person receives notifications at, URLs sealed (migration 0031). */
  readonly notificationAddresses: NotificationAddressesRepo;
  /** Who switched mail notifications on (migration 0032). */
  readonly notificationMail: NotificationMailRepo;
  /** Temporary refs of pushes waiting for an approval (migration 0015). */
  readonly pendingRefs: PendingRefsRepo;
  readonly accounts: AccountsRepo;
  readonly shares: SharesRepo;
  readonly missions: MissionsRepo;
  /** The versions of every mission's configuration, kept as long as the mission (0039). */
  readonly missionVersions: MissionVersionsRepo;
  readonly missionLogs: MissionLogsRepo;
  readonly requests: RequestsRepo;
  readonly approvals: ApprovalsRepo;
  readonly audit: AuditRepo;
  readonly config: ConfigRepo;
  /** Web sessions keyed by the digest of their id; satisfies the root's `SessionStore` port. */
  readonly webSessions: WebSessionsRepo;
  /** Every sealed column, for the master-key re-seal (`reseal` command). */
  readonly sealedBlobs: SealedBlobsRepo;
  /** The versions of installed plugins (migration 0041). */
  readonly pluginVersions: PluginVersionsRepo;
  /** The signers trusted for private plugins (migration 0042). */
  readonly pluginSigners: PluginSignersRepo;
  readonly auditWriter: AuditWriter;
  /** Highest migration version applied. */
  readonly schemaVersion: number;
  /** The copy this start left before migrating (ADR store-copied-before-a-migration), or null. */
  readonly preMigrationCopy: PreMigrationCopy | null;
  /** Raw handle, for structural tests and diagnostics only. */
  readonly db: StoreDb;
  /** Cheap liveness probe (`SELECT 1`); rejects when the handle is unusable. */
  ping(): Promise<void>;
  /** Consistent single-file copy (`VACUUM INTO`), safe while the gateway runs. */
  backupTo(destinationPath: string): void;
  /** Bytes on disk: the pages, plus the write-ahead log when there is one (spec §4.3 bis). */
  sizeOnDisk(): number;
  close(): Promise<void>;
}

export function openStore(options: StoreOptions): Store {
  const db = openDb({ path: options.path, busyTimeoutMs: options.busyTimeoutMs });
  const clock = options.clock ?? systemClock;
  let currentVersion: number;
  let preMigrationCopy: PreMigrationCopy | null;
  try {
    const migrations = loadMigrations(options.migrationsDir ?? DEFAULT_MIGRATIONS_DIR);
    preMigrationCopy = copyBeforeMigrating(db, options.path, migrations, clock);
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
    administrators: createAdministratorsRepo(ctx),
    signInAccounts: createSignInAccountsRepo(ctx),
    secondFactors: createSecondFactorsRepo(ctx),
    notificationDevices: createNotificationDevicesRepo(ctx),
    notificationAddresses: createNotificationAddressesRepo(ctx),
    notificationMail: createNotificationMailRepo(ctx),
    pendingRefs: createPendingRefsRepo(ctx),
    accounts: createAccountsRepo(ctx),
    shares: createSharesRepo(ctx),
    missions: createMissionsRepo(ctx),
    missionVersions: createMissionVersionsRepo(ctx),
    missionLogs: createMissionLogsRepo(ctx),
    requests: createRequestsRepo(ctx),
    approvals: createApprovalsRepo(ctx),
    audit,
    config: createConfigRepo(ctx),
    webSessions: createWebSessionsRepo(ctx),
    sealedBlobs: createSealedBlobsRepo(ctx),
    pluginVersions: createPluginVersionsRepo(ctx),
    pluginSigners: createPluginSignersRepo(ctx),
    auditWriter: new SqliteAuditWriter(audit),
    schemaVersion: currentVersion,
    preMigrationCopy,
    db,
    async ping() {
      ping.get();
    },
    backupTo: (destinationPath) => backupTo(db, destinationPath),
    sizeOnDisk: () => sizeOnDisk(db, options.path),
    async close() {
      db.close();
    },
  };
}

/**
 * The `instance_config` of a store copy, open for writing (see
 * docs/handbook/authentication.md): what the `backup` command writes into
 * the copy it made. No migration runs; the secrets are sealed by `encryptor`.
 */
export function openCopyConfig(
  path: string,
  encryptor: Encryptor,
  clock: Clock = systemClock,
): { readonly config: ConfigRepo; close(): void } {
  const db = openCopyForWriting(path);
  const config = createConfigRepo({
    db,
    clock,
    newId,
    encryptor,
    // instance_config names no RiskId.
    catalog: new SetCatalogIndex([]),
  });
  return { config, close: () => db.close() };
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
export { reachedResources, takesFutureResources } from './mission-reach.ts';
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
  HostAccountTakenError,
  InvariantError,
  MigrationError,
  NotFoundError,
  StoreError,
  UnknownRiskIdError,
} from './errors.ts';
export { SqliteAuditWriter } from './audit-writer.ts';
export type { AuditAppender, AuditEntry, AuditWriter } from './audit-writer.ts';
export * from './types.ts';
export { effectiveResourceEnv, ownResourceEnv, type EffectiveEnv } from './resource-env.ts';
export type { MissionTokenKey } from './repositories/missions/index.ts';
export type { ShareKey } from './repositories/shares.ts';
export type { RequestKey } from './repositories/requests.ts';
export type { UpsertUserInput, UsersRepo } from './repositories/users.ts';
export type { GroupsRepo } from './repositories/groups.ts';
export type {
  SecondFactorRecord,
  SecondFactorsRepo,
  SecondFactorSecretKind,
} from './repositories/second-factors.ts';
export type { InvitationRecord, InvitationsRepo } from './repositories/invitations.ts';
export {
  ADMINISTRATOR_KINDS,
  ADMINISTRATOR_ORIGINS,
  type AdministratorKind,
  type AdministratorOrigin,
  type AdministratorsRepo,
  type Designation,
  type EmailDesignation,
  type GroupDesignation,
  type UserDesignation,
} from './repositories/administrators.ts';
export {
  LOCAL_LINK_KINDS,
  LOCAL_SECRET_KINDS,
  type SignInAccountRecord,
  type SignInAccountsRepo,
  type LocalLinkKind,
  type LocalLinkRecord,
  type LocalSecretKind,
  type LockoutRule,
} from './repositories/sign-in-accounts.ts';
export type {
  NewPendingRef,
  PendingRefRecord,
  PendingRefsRepo,
} from './repositories/pending-refs.ts';
export type { AccountFilter, AccountsRepo, CreateAccountInput } from './repositories/accounts.ts';
export { FRESH_RESOURCE_STALE_GRACE_MS } from './repositories/accounts.ts';
export type { CreateShareInput, SharesRepo } from './repositories/shares.ts';
export type {
  AddedMissionResources,
  CreatedBy,
  AddMemberInput,
  AppliedLimitChange,
  CreateMissionInput,
  IssuedToken,
  IssueTokenInput,
  LimitChange,
  MissionsRepo,
  RemovedMember,
  ResourceChange,
  ResourceMove,
  ResourceMoveReason,
} from './repositories/missions/index.ts';
export type {
  DecideContext,
  DecideInput,
  DecideResult,
  DecisionOutcome,
  ListEventsOptions,
  EventHolder,
  EventScope,
  EventSearch,
  MissionEventRecord,
  RiskEventQuery,
  MissionLogsRepo,
  StoredLimits,
} from './repositories/mission-logs.ts';
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
export { DEFAULT_AUDIT_RETENTION_DAYS } from './repositories/audit.ts';
export type {
  AgentLabelActivity,
  AgentLabelSeen,
  AuditCallRecord,
  CallTotalsQuery,
  CallTotalsRow,
  AuditCursor,
  AuditFilter,
  AuditRecord,
  AuditRepo,
  AuditRiskRow,
  AuditScope,
  AuditSearch,
  CallDecisionCounts,
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
