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
import { createMissionsRepo, type MissionsRepo } from './repositories/missions.ts';
import { createRequestsRepo, type RequestsRepo } from './repositories/requests.ts';
import { createSessionsRepo, type SessionsRepo } from './repositories/sessions.ts';
import { createSharesRepo, type SharesRepo } from './repositories/shares.ts';
import { createUsersRepo, type UsersRepo } from './repositories/users.ts';

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
  readonly connections: ConnectionsRepo;
  readonly shares: SharesRepo;
  readonly missions: MissionsRepo;
  readonly sessions: SessionsRepo;
  readonly requests: RequestsRepo;
  readonly approvals: ApprovalsRepo;
  readonly delegations: DelegationsRepo;
  readonly audit: AuditRepo;
  readonly config: ConfigRepo;
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
  const migrations = loadMigrations(options.migrationsDir ?? DEFAULT_MIGRATIONS_DIR);
  const { currentVersion } = runMigrations(db, migrations, clock);

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
    connections: createConnectionsRepo(ctx),
    shares: createSharesRepo(ctx),
    missions: createMissionsRepo(ctx),
    sessions: createSessionsRepo(ctx),
    requests: createRequestsRepo(ctx),
    approvals: createApprovalsRepo(ctx),
    delegations: createDelegationsRepo(ctx),
    audit,
    config: createConfigRepo(ctx),
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

export { MEMORY_PATH, withImmediateTransaction, journalMode } from './db.ts';
export type { StoreDb } from './db.ts';
export { ManualClock, systemClock, toIso } from './clock.ts';
export type { Clock } from './clock.ts';
export { newId, isUuidV7, idTimestampMs } from './ids.ts';
export type { IdGenerator } from './ids.ts';
export { openText, sealText } from './encryptor.ts';
export type { EncryptedBlob, Encryptor, SealedBlob } from './encryptor.ts';
export { SetCatalogIndex, assertKnownRiskIds } from './catalog-index.ts';
export type { CatalogIndex } from './catalog-index.ts';
export {
  DEFAULT_MIGRATIONS_DIR,
  checksumOf,
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
export type {
  ConnectionFilter,
  ConnectionsRepo,
  CreateConnectionInput,
} from './repositories/connections.ts';
export type { CreateShareInput, SharesRepo } from './repositories/shares.ts';
export type { CreateMissionInput, IssueTokenInput, MissionsRepo } from './repositories/missions.ts';
export type {
  DecideContext,
  DecideInput,
  DecideResult,
  DecisionOutcome,
  SessionsRepo,
} from './repositories/sessions.ts';
export { prepareRequestArguments } from './repositories/requests.ts';
export type {
  CreateRequestInput,
  InsertRequestInput,
  PreparedArguments,
  RequestInput,
  RequestsRepo,
} from './repositories/requests.ts';
export type { ApprovalsRepo, CreateApprovalInput } from './repositories/approvals.ts';
export type {
  CreateCodeInput,
  CreateDelegationInput,
  CreateTokenInput,
  DelegationsRepo,
  RegisterClientInput,
} from './repositories/delegations.ts';
export { DEFAULT_AUDIT_RETENTION_DAYS } from './repositories/audit.ts';
export type { AuditFilter, AuditRecord, AuditRepo, AuditRiskRow } from './repositories/audit.ts';
export type { ConfigRepo } from './repositories/config.ts';
