import { ACTIONS, TERMS, count, formatNumber } from './common';

// ─────────────────────────────────────────────────────────────────────────────
// Accounts and access (the pages under `/accounts`). Protocol names: account,
// resource, share, restriction, discovery, revoke, transfer.
// ─────────────────────────────────────────────────────────────────────────────

export const ACCOUNT_PAGES = {
  connect: {
    title: 'Connect an account',
    lede: 'With a key you create once at the service, reaching what your missions need: each mission narrows it further. A sign-in at the service only where it has no key. The credential never leaves this gateway.',
  },
  yours:
    'You own these, alone or with a team: all permissions, and you decide who else may use them.',
  shared: 'A colleague gave you part of an account; your missions can use that part, never more.',
  whoHasAccess: 'What each person may let their agents do, at most.',
  missions: 'Removing access, or disconnecting, stops them with the reason in every refusal.',
  empty: 'No account yet. Connect one: agents then reach it only through a mission key.',
} as const;

export const ACCOUNT_ACTIONS = {
  reconnect: 'Reconnect',
  disconnect: 'Disconnect',
  refresh: 'Refresh',
  transfer: 'Transfer ownership',
  editAccess: 'Edit',
  updateAccess: 'Update access',
  closeMission: 'Close',
  connect: 'Connect',
  save: 'Save',
  rename: 'Rename',
  /** On the Vaubaan account: the prefilled creation (ADR platform-management-is-a-plugin-on-the-execution-door). */
  createPlatformMission: 'Create the platform management mission',
} as const;

/** Column heads and short facts of the accounts pages. */
export const ACCOUNT_WORDS = {
  account: 'Account',
  resources: 'Resources',
  missions: 'Missions',
  lastChecked: 'Updated',
  neverChecked: 'never checked',
  /** Where "Refresh" was: when the account last refreshed itself, "Updated 12 min ago". */
  updated: (when: string) => `Updated ${when}`,
  /** While a page refreshes the stale accounts it shows. */
  refreshing: 'Refreshing…',
  /** After the time of a check the gateway ran itself: "after a call of fly__create_app". */
  afterCallOf: 'after a call of',
  checkFailed: 'Check failed',
  mayAllow: 'May allow',
  youMayAllow: 'You may allow',
  givenBy: 'Given by',
  status: 'Status',
  who: 'Who',
  since: 'Since',
  environment: 'Environment',
  defaultEnvironment: 'Default environment for unlabelled resources',
  fromDefault: "from the account's default",
  hidden: 'hidden from new missions',
  /** Hidden by the service's discovery (a public repository the token likely cannot act on). */
  hiddenByDiscovery: 'hidden from new missions: the key may only read it',
  gone: 'no longer found',
  /** A resource of `InstanceConfig.selfResources` (SEC 2026-10-15 H1). */
  self: "this instance's own project: never reachable by a mission",
  /** A service this instance cannot connect yet: an OAuth broker it needs is not configured. */
  notConfigured: 'not configured on this gateway',
  noLabel: 'without an environment label',
} as const;

/** "the Platform team" — the server labels a group owner `group <name>`. */
export function holderWords(label: string): string {
  return label.startsWith('group ') ? `the ${label.slice('group '.length)} team` : label;
}

/** "owned by the Platform team (Bob, you, Dan)", "you own it", "owned by Bob". */
export function ownedBy(owner: {
  team: boolean;
  name: string;
  you: boolean;
  people?: readonly { name: string; you: boolean }[];
}): string {
  if (!owner.team) return owner.you ? 'you own it' : `owned by ${owner.name}`;
  const people = (owner.people ?? []).map((person) => (person.you ? 'you' : person.name));
  const names = people.length > 0 ? ` (${people.join(', ')})` : '';
  return `owned by the ${owner.name} team${names}`;
}

/** "3 besides owners", "nobody else" — how many hold an access to an account. */
export function besidesOwners(n: number): string {
  return n === 0 ? 'nobody else' : `${formatNumber(n)} besides owners`;
}

/** "Give access · 10 permissions" — the confirming button of the dialog. */
export function giveAccessLabel(n: number, editing: boolean): string {
  const act = editing ? ACCOUNT_ACTIONS.updateAccess : ACTIONS.giveAccess;
  return `${act} · ${count(n, TERMS.risk)}`;
}

/** Why a mission stopped for want of an owner. Keyed by `OrphanCause`. */
export const ORPHAN_WORDS = {
  'creator-removed': 'its creator was deactivated',
  'account-missing': 'an account it uses no longer exists',
  'account-revoked': 'an account it uses was disconnected',
  'authority-lost': 'its creator no longer holds the permissions it uses',
} as const;

/** Why an account no longer serves a mission that still runs. Keyed by `PartLossCause`. */
export const PART_LOSS_WORDS = {
  'account-revoked': 'no longer uses this account: it was disconnected',
  'account-missing': 'no longer uses this account: it no longer exists',
  'access-withdrawn': 'no longer uses this account: its creator lost access to it',
} as const;

/**
 * The card of an account that no longer serves a mission (ADR
 * decisions/orphaned-missions-and-ownerless-connections.md, amendment 2026-11-16): red, folded
 * on the mission page and in "Edit mission", where the creator removes it.
 */
export const LOST_ACCOUNT_WORDS = {
  showDetails: 'Show the details',
  hideDetails: 'Hide the details',
  /** Edit mission: takes the account out of the mission when the edit is saved. */
  remove: 'Remove from mission',
  /** Edit mission: undoes "Remove from mission" before saving. */
  keep: 'Keep it',
  /** Edit mission: the card once "Remove from mission" is pressed, before saving. */
  removedOnSave: 'Removed from the mission when you save.',
  /** The phrase of the summary bar. */
  removed: (label: string): string => `${label} removed`,
} as const;
