/**
 * Audit writer — the store's implementation of `@vaubaan/gateway-core`'s `AuditWriter`.
 *
 * The entry shape (`CallAuditEntry`, `AdminAuditEntry`) and the `write(entry)` contract
 * are owned by gateway-core; this module persists them through
 * `AuditRepo.append`. A rejected `write` propagates: the pipeline treats it as an
 * internal error, so a call never completes without its audit entry.
 */

import type { AuditEntry, AuditWriter } from '@vaubaan/gateway-core';

export type { AuditEntry, AuditWriter };

/** The repository surface the writer needs; `AuditRepo` satisfies it. */
export interface AuditAppender {
  append(entry: AuditEntry): Promise<unknown>;
}

export class SqliteAuditWriter implements AuditWriter {
  constructor(private readonly audit: AuditAppender) {}

  async write(entry: AuditEntry): Promise<void> {
    await this.audit.append(entry);
  }
}
