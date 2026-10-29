/**
 * The absolute lifetime of a delegation (spec §0 "Delegation", §6; ADR
 * management-door-authorization-server).
 *
 * A delegation ends `oauth.delegation_max_lifetime` after the user's consent
 * (`delegations.created_at`), whatever was renewed since. The deadline is
 * **derived, never stored**: every place that issues or accepts a token of a
 * delegation computes it from the row and the configuration of this instant,
 * so there is no background task that could be late, and an operator who
 * shortens the key shortens every delegation at once.
 *
 * Three places ask, and they must all ask this file:
 *
 *   - the token endpoint, before any grant: nothing is issued past the
 *     deadline, and what is issued before it expires at the deadline at the
 *     latest (`expiryWithin`);
 *   - the delegated-token verifier, at every call of the management door;
 *   - the Delegations page, which shows the date and the state.
 */
import type { Clock } from '../store/clock';
import type { DelegationRecord } from '../store/types';

const MS_PER_SECOND = 1000;

/** The instant after which the delegation is over. */
export function delegationDeadline(
  delegation: Pick<DelegationRecord, 'createdAt'>,
  maxLifetimeSeconds: number,
): Date {
  return new Date(Date.parse(delegation.createdAt) + maxLifetimeSeconds * MS_PER_SECOND);
}

/**
 * Has the delegation reached its absolute lifetime? At the deadline itself it
 * has: a token must never be worth anything at an instant its delegation is not.
 * A `created_at` that does not parse reads as past its lifetime.
 */
export function pastLifetime(
  delegation: Pick<DelegationRecord, 'createdAt'>,
  maxLifetimeSeconds: number,
  now: Date,
): boolean {
  const deadline = delegationDeadline(delegation, maxLifetimeSeconds).getTime();
  return !(now.getTime() < deadline);
}

/**
 * When a token minted now for `ttlSeconds` expires: at the end of its own
 * lifetime, or at the delegation's deadline when that comes first.
 */
export function expiryWithin(
  delegation: Pick<DelegationRecord, 'createdAt'>,
  maxLifetimeSeconds: number,
  ttlSeconds: number,
  now: Date,
): Date {
  const own = now.getTime() + ttlSeconds * MS_PER_SECOND;
  const deadline = delegationDeadline(delegation, maxLifetimeSeconds).getTime();
  return new Date(Math.min(own, deadline));
}

/** The lifetime rule bound to one configuration and one clock. */
export interface DelegationLifetime {
  deadlineOf(delegation: Pick<DelegationRecord, 'createdAt'>): Date;
  isOver(delegation: Pick<DelegationRecord, 'createdAt'>): boolean;
  /** Expiry of a token minted now for `ttlSeconds` under this delegation. */
  expiryOf(delegation: Pick<DelegationRecord, 'createdAt'>, ttlSeconds: number): Date;
}

export function delegationLifetime(maxLifetimeSeconds: number, clock: Clock): DelegationLifetime {
  return {
    deadlineOf: (delegation) => delegationDeadline(delegation, maxLifetimeSeconds),
    isOver: (delegation) => pastLifetime(delegation, maxLifetimeSeconds, clock.now()),
    expiryOf: (delegation, ttlSeconds) =>
      expiryWithin(delegation, maxLifetimeSeconds, ttlSeconds, clock.now()),
  };
}
