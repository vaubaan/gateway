/**
 * What the mission pages say, as pure functions of what the services return —
 * so that the words a person reads (the state of a mission, what it can do,
 * what it asks first, what it cannot, the one limit that matters) are tested
 * without a browser.
 *
 * Types only from the server: this file is safe in a client component.
 */
import type { Gate, RateLimit } from '@vaubaan/shared';

import { count, listed, MISSION_STATES, possessive, TERMS, type StateWord } from '@/lib/vocabulary';
import type { MissionState } from '@/server/budget';
import { SECONDS_PER_MINUTE } from '@vaubaan/shared/time';

/** Above this share of a limit, the mission page draws the meter (the design system's own threshold). */
const NEAR_LIMIT_SHARE = 0.6;
/** How many permissions a summary line names before it counts the rest. */
const NAMED_IN_A_LINE = 3;

export interface MissionMark extends StateWord {
  /** A mission that serves nothing any more: its row is drawn quiet. */
  readonly over: boolean;
}

/**
 * The state of a mission in words (spec §2.3). The normal state has no tone;
 * what needs the reader is amber, what is stopped against their will is red.
 * `waiting` is how many requests of this mission wait for its creator.
 */
export function missionMark(
  state: MissionState,
  waiting: number,
  waitsFor: string | null = null,
  /** How many of its accounts no longer serve it (`MissionOverview.lost`). */
  lostAccounts = 0,
): MissionMark {
  switch (state.kind) {
    case 'revoked':
      return { ...MISSION_STATES.revoked, over: true };
    case 'expired':
      return { ...MISSION_STATES.expired, over: true };
    case 'orphaned':
      return { ...MISSION_STATES.orphaned, over: false };
    case 'active':
      break;
  }
  if (waiting > 0) {
    return waitsFor
      ? { label: `Waiting for ${waitsFor}`, tone: 'warn', over: false }
      : { ...MISSION_STATES.waiting, over: false };
  }
  if (lostAccounts > 0) return { ...MISSION_STATES.accountLost, over: false };
  if (state.exhausted.length > 0) return { ...MISSION_STATES.limitReached, over: false };
  return { ...MISSION_STATES.active, over: false };
}

/** A limit as "per minute": the stored window is almost always sixty seconds. */
export function perMinuteOf(rate: RateLimit): number {
  if (rate.window_seconds === SECONDS_PER_MINUTE) return rate.max;
  return Math.max(1, Math.round((rate.max * SECONDS_PER_MINUTE) / rate.window_seconds));
}

export interface AllowEntry {
  readonly label: string;
  readonly gate: Gate;
}

export interface AllowLines {
  /** What runs freely, then how many permissions that is. */
  readonly can: string;
  /** What asks first; `null` when nothing does. */
  readonly asks: string | null;
  readonly cannot: string;
}

/**
 * A catalog label as a summary names it: without its parenthesis ("Write on
 * main (direct commit OR PR merge)" → "Write on main"). The whole label is on
 * the row of the permission.
 */
export function briefLabel(label: string): string {
  const brief = label
    .replace(/\s*\([^)]*\)/g, '')
    .replace(/[\s,…]+$/, '')
    .trim();
  return brief === '' ? label : brief;
}

function namedThenCounted(labels: readonly string[], named: number): string {
  const unique = [...new Set(labels.map(briefLabel))];
  const shown = unique.slice(0, named).join(' · ');
  const more = unique.length - named;
  return more > 0 ? `${shown} and ${more} more` : shown;
}

/**
 * Can / Asks first / Cannot, from the explicit list. A summary, never the
 * list: each line says how many permissions it sums up, and the list is one
 * click away on the page.
 */
export function allowLines(
  policy: readonly AllowEntry[],
  notIncluded: readonly string[],
  named: number = NAMED_IN_A_LINE,
): AllowLines {
  const free = policy.filter((entry) => entry.gate === 'auto');
  const asking = policy.filter((entry) => entry.gate === 'approval');
  const outside = 'anything outside its accounts and resources';
  return {
    can:
      free.length === 0
        ? 'Nothing runs without asking.'
        : `${namedThenCounted(
            free.map((entry) => entry.label),
            named,
          )}. ${count(free.length, TERMS.risk)}.`,
    asks:
      asking.length === 0
        ? null
        : `${namedThenCounted(
            asking.map((entry) => entry.label),
            named,
          )}. ${count(asking.length, TERMS.risk)}.`,
    cannot:
      notIncluded.length === 0
        ? `${outside.charAt(0).toUpperCase()}${outside.slice(1)}.`
        : `${namedThenCounted(notIncluded, named)}, and ${outside}.`,
  };
}

export interface UsageEntry {
  readonly label: string;
  readonly quota: number;
  /** `null` when the mission has no current period. */
  readonly remaining: number | null;
}

export interface NearLimit {
  readonly label: string;
  readonly used: number;
  readonly limit: number;
  /** How many permissions are at or above the threshold, this one included. */
  readonly near: number;
}

/** The permission closest to its limit, when one is near; `null` otherwise. */
export function nearestLimit(policy: readonly UsageEntry[]): NearLimit | null {
  let top: { entry: UsageEntry; share: number } | null = null;
  let near = 0;
  for (const entry of policy) {
    if (entry.remaining === null || entry.quota <= 0) continue;
    const share = (entry.quota - entry.remaining) / entry.quota;
    if (share < NEAR_LIMIT_SHARE) continue;
    near += 1;
    if (top === null || share > top.share) top = { entry, share };
  }
  if (top === null) return null;
  return {
    label: top.entry.label,
    used: top.entry.quota - (top.entry.remaining ?? 0),
    limit: top.entry.quota,
    near,
  };
}

/** "created by you", "created by Alice": who a mission belongs to, in a sentence. */
export function createdBy(creator: string | null, mine: boolean): string {
  if (mine) return 'Created by you';
  return creator ? `Created by ${creator}` : 'Created by someone who left';
}

/** "Alice’s yes": whose answer a waiting request needs, for a teammate. */
export function yesOf(creator: string | null): string {
  return creator ? `${possessive(creator)} yes` : 'the creator’s yes';
}

/** The services and resources of a mission in a few words: "GitHub acme/app, acme/web". */
export function reachOf(
  connections: readonly {
    readonly provider_label: string;
    readonly resources: readonly { readonly ref: string; readonly display_name?: string }[];
  }[],
): string[] {
  return connections.map((connection) => {
    const names = connection.resources.map((resource) => resource.display_name || resource.ref);
    return names.length === 0
      ? connection.provider_label
      : `${connection.provider_label} ${listed(names, 2)}`;
  });
}
