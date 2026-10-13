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

export const TOKEN_NOT_ISSUABLE_REASONS = [
  'mission-not-active',
  'holder-not-a-member',
  'name-taken',
] as const;
export type TokenNotIssuableReason = (typeof TOKEN_NOT_ISSUABLE_REASONS)[number];

/**
 * A mission token was about to be inserted for a mission that no longer serves, for a
 * holder who is no longer on it, or under a name a working token already carries. Its
 * own class, apart from `InvariantError` (which a corrupt row raises too): the services
 * answer each reason in its own words.
 */
export class TokenNotIssuableError extends StoreError {
  constructor(
    readonly reason: TokenNotIssuableReason,
    missionId: string,
  ) {
    super(`mission ${missionId}: no token can be issued (${reason})`);
  }
}

/** The migration directory or the applied history is inconsistent. */
export class MigrationError extends StoreError {}
