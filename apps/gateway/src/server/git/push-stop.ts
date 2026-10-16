/**
 * A push that could not go on (spec §4.1 ter; ADR gateway-as-git-remote):
 * what git is told on every ref, and what the audit keeps.
 */
import { BYTES_PER_MEGABYTE } from './constants';

export class PushStop extends Error {
  constructor(
    readonly reason: string,
    readonly audited: string,
  ) {
    super(reason);
    this.name = 'PushStop';
  }
}

/** The push is larger than `git.max_pack_mb`. */
export function tooLarge(limit: number): PushStop {
  const mb = Math.floor(limit / BYTES_PER_MEGABYTE);
  return new PushStop(
    `this push is larger than the ${mb} MB this gateway accepts; push fewer commits at a time`,
    `the push is larger than the ${mb} MB limit`,
  );
}

/** The request ended before the push did (its deadline, or git went away); `null` while it runs. */
export function interrupted(signal: AbortSignal): PushStop | null {
  if (!signal.aborted) return null;
  const timedOut = (signal.reason as { name?: unknown } | undefined)?.name === 'TimeoutError';
  return timedOut
    ? new PushStop(
        'this push took longer than this gateway allows; push fewer commits at a time',
        'the push exceeded the request timeout',
      )
    : new PushStop('the push was interrupted: the client went away', 'the client went away');
}
