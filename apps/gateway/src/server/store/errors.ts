/**
 * Store errors. Every error the repositories raise on purpose derives from `StoreError`
 * so callers can tell a domain violation from a driver failure.
 */

export class StoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class NotFoundError extends StoreError {
  constructor(
    readonly entity: string,
    readonly id: string,
  ) {
    super(`${entity} not found: ${id}`);
  }
}

/** A risk id that is not in the loaded catalog was about to be persisted. */
export class UnknownRiskIdError extends StoreError {
  constructor(readonly riskIds: readonly string[]) {
    super(`risk ids not in the loaded catalog: ${riskIds.join(', ')}`);
  }
}

/** A write that violates a domain rule the schema or the repository enforces. */
export class InvariantError extends StoreError {}

/** The migration directory or the applied history is inconsistent. */
export class MigrationError extends StoreError {}
