/**
 * The ceilings of the instance (spec §4.3 bis): what each one counts, the sentence
 * of a refusal, and the check "may one more be added".
 *
 * A ceiling is enforced where an item would be added, never by cutting: at or above
 * it the instance keeps everything it holds and only refuses the next addition of
 * that count. The wording of every refusal is here, in one place; each surface
 * carries it in its own error (a `LoginError` code, a `ConnectError`, an issuance
 * result, a `vaubaan__issue_mission` refusal code).
 */
import type { LimitsConfig } from '../config/types';

export const CEILINGS = ['users', 'connections', 'active-missions'] as const;
export type Ceiling = (typeof CEILINGS)[number];

/** Every ceiling absent: what a module wired without limits enforces (nothing). */
export const UNLIMITED: LimitsConfig = { users: null, connections: null, activeMissions: null };

/** The words of a count in a sentence, by ceiling: "3 people", "1 connected account". */
const NOUNS: Readonly<Record<Ceiling, { readonly one: string; readonly many: string }>> = {
  users: { one: 'person', many: 'people' },
  connections: { one: 'connected account', many: 'connected accounts' },
  'active-missions': { one: 'active mission', many: 'active missions' },
};

/** The configured ceiling of a count; `null` when unlimited. */
export function ceilingOf(limits: LimitsConfig, ceiling: Ceiling): number | null {
  switch (ceiling) {
    case 'users':
      return limits.users;
    case 'connections':
      return limits.connections;
    case 'active-missions':
      return limits.activeMissions;
  }
}

/** "This gateway holds 3 active missions; its ceiling is 3." */
export function ceilingSentence(ceiling: Ceiling, count: number, limit: number): string {
  const noun = count === 1 ? NOUNS[ceiling].one : NOUNS[ceiling].many;
  return `This gateway holds ${count} ${noun}; its ceiling is ${limit}.`;
}

/** Why one more item of a count is refused: the count, its ceiling, the sentence. */
export interface LimitReached {
  readonly ceiling: Ceiling;
  readonly count: number;
  readonly limit: number;
  /** `ceilingSentence` of the three. */
  readonly message: string;
}

/** `null` while one more fits under the ceiling (or there is none); else the refusal. */
export function limitReached(
  ceiling: Ceiling,
  count: number,
  limit: number | null,
): LimitReached | null {
  if (limit === null || count < limit) return null;
  return { ceiling, count, limit, message: ceilingSentence(ceiling, count, limit) };
}

/**
 * A refusal thrown where the surface has no closed code of its own to carry it
 * (an administrator's act on a page that shows free sentences).
 */
export class LimitReachedError extends Error {
  constructor(readonly reached: LimitReached) {
    super(reached.message);
    this.name = 'LimitReachedError';
  }
}
