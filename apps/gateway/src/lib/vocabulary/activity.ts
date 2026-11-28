import { ROUTES, count } from './common';

// ─────────────────────────────────────────────────────────────────────────────
// Activity (`/activity`: the Record, the audit; the Timeline, the session
// events). Protocol names: audit entry, call, administrative act, decision,
// refusal code, token holder, agent label, mission log event.
// ─────────────────────────────────────────────────────────────────────────────

/** The tabs of Activity, in their order. */
export const ACTIVITY_TABS = {
  overview: { label: 'Overview', href: ROUTES.activity, exact: true },
  record: { label: 'Record', href: ROUTES.activityRecord },
  timeline: { label: 'Timeline', href: ROUTES.activityTimeline },
} as const;

/** The Overview's spans, as its segments name them. Keyed by `OverviewPeriod`. */
export const OVERVIEW_PERIODS = {
  today: 'Today',
  '7d': '7 days',
  '30d': '30 days',
} as const;

/** What the Overview holds, said under its title. */
export const OVERVIEW_LEDE =
  'What each mission did: calls, bytes to and from the services, who holds its keys, and what expires soon.';

/** Whose missions the Overview sums, said once above them (the Timeline's scope). */
export const OVERVIEW_SCOPE = {
  administrator: 'As an administrator you read every mission.',
  person:
    'The missions you created and those shared with you; the calls through the accounts you own are in the Record.',
  installer: 'The setup token reads no mission: sign in as a person.',
} as const;

export const OVERVIEW_WORDS = {
  allowed: 'Allowed',
  refused: 'Refused',
  waiting: 'Waiting',
  up: 'Sent',
  down: 'Received',
  /** The disclosure of a mission's block. */
  show: 'Accounts, permissions and keys',
  hide: 'Hide accounts, permissions and keys',
  accounts: 'Requests per account',
  actions: 'Use per action',
  holders: 'Who holds the keys',
  noCall: 'No call in this period',
  sentWord: 'sent',
  receivedWord: 'received',
  notAttributed: 'Calls before keys had a holder',
  record: 'its record',
  timeline: 'its timeline',
  expiringTitle: (days: number) =>
    `Stops working within ${count(days, { one: 'day', many: 'days' })}`,
  /** No mission to show in the span. */
  nothing: 'No mission ran in this period.',
  notRunning: 'Not running: no period, no use to show.',
  daysUtc: 'Days are in UTC; calls recorded before bytes were counted show none.',
} as const;

/**
 * Bytes in decimal units, one decimal under ten: "0 B", "512 B", "1.2 KB", "34 MB",
 * "2.5 GB". Locale-independent, like `formatNumber`.
 */
export function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'] as const;
  let value = Math.max(0, bytes);
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  if (unit === 0) return `${Math.round(value)} B`;
  const shown = value < 10 ? Math.round(value * 10) / 10 : Math.round(value);
  // 999.95 KB rounds to 1000: say it in the next unit.
  if (shown >= 1000 && unit < units.length - 1) return `1 ${units[unit + 1]}`;
  return `${shown} ${units[unit]}`;
}

/** "42%": a holder's part of a mission's calls. */
export function percentOf(share: number): string {
  return `${Math.round(share * 100)}%`;
}

/** One line of the Overview's "expires soon" list, in words. */
export const EXPIRY_WORDS = {
  missionEnds: (mission: string, day: string) => `Mission ${mission} ends on ${day}`,
  keyEnds: (account: string, day: string) => `The key of ${account} ends on ${day}`,
  accountExpired: (account: string) => `${account} needs reconnecting: the service refused its key`,
  extend: 'Edit the mission',
  reconnect: 'Reconnect',
  openMission: 'Open the mission',
  ownerFixes: 'its owner reconnects it',
} as const;

/** What the Timeline holds, said under its title. */
export function timelineLede(retentionDays: number): string {
  return `What happened in each mission: calls, requests and their answers, limits, gates and keys, kept ${count(retentionDays, { one: 'day', many: 'days' })}.`;
}

export const ACTIVITY_WORDS = {
  time: 'Time',
  who: 'Who',
  action: 'Action',
  on: 'On',
  permission: 'Permission',
  decision: 'Decision',
  mission: 'Mission',
  detail: 'detail',
  hideDetail: 'hide detail',
  /** The pager: the page before (newer lines), the page after (older lines), the top. */
  newer: 'Newer',
  older: 'Older',
  newest: 'Newest',
  /** Without JavaScript, the filters wait for this button; with it, they apply at once. */
  show: 'Show',
  clear: 'Clear',
  moreFilters: 'More filters',
  fewerFilters: 'Fewer filters',
  nothing: 'Nothing was recorded for these filters.',
  notAttributed: 'not attributed',
  afterYes: 'after a yes',
  machineKey: 'machine key',
  /** Beside "refreshed what an account reaches" when the gateway ran it after a call. */
  afterCreatingCall: 'after a call that created one',
  /** A refresh the gateway ran on its own: hourly, or a page showed the account stale. */
  refreshedOnItsOwn: 'refreshed on its own',
  /** Beside "added resources to a mission" when the mission created them itself. */
  createdByTheMission: 'created by the mission',
  argumentsNeverStored: 'never stored',
  fingerprintHidden:
    'never stored · their fingerprint is shown to the creator of the mission and to the owners of the account only',
} as const;

/** "kept 90 days" — the lede of the record names its retention. */
export function activityLede(retentionDays: number): string {
  return `Every call an agent made and every change a person made, kept ${count(retentionDays, { one: 'day', many: 'days' })}. This is the audit record.`;
}

/** Who reads what, said once above the record. */
export const ACTIVITY_SCOPE = {
  administrator: 'As an administrator you read every call and every change of this gateway.',
  person:
    'You read the missions you created, the missions shared with you, and the accounts you own.',
  installer: 'Until someone signs in, the record holds the changes made while installing.',
} as const;

/** Whose mission logs the Timeline lists, said once above it. */
export const TIMELINE_SCOPE = {
  administrator: 'As an administrator you read the mission log of every mission.',
  person:
    'You read the mission logs of the missions you created and of those shared with you; the calls through the accounts you own are in the Record.',
  installer: 'The setup token reads no mission log: sign in as a person.',
} as const;

/** The periods of the record, as the segments name them. */
export const ACTIVITY_PERIODS = {
  today: 'Today',
  yesterday: 'Yesterday',
  week: '7 days',
  all: 'All',
} as const;

/** Why a call was refused, in a few words. Keyed by the protocol's refusal code. */
export const REFUSAL_WORDS = {
  'risk-not-accepted': 'permission not in this mission',
  'budget-exhausted': 'limit reached',
  'approval-required': 'asked first',
  'resource-not-in-mission': 'resource not in this mission',
  'account-ambiguous': 'which account was not said',
  'rate-limited': 'too fast: per-minute limit',
  'account-unavailable': 'account needs reconnecting',
  'account-revoked': 'account no longer in this mission',
  'mission-inactive': 'mission not running',
  'wrong-credential-kind': 'wrong kind of key',
} as const;

/** What a person did, after their name. Keyed by the protocol's administrative act. */
export const ACT_WORDS = {
  'account-created': 'connected an account',
  'account-reconnected': 'reconnected an account',
  'account-refused': 'was refused an account',
  'account-transferred': 'transferred an account to a team',
  'account-reassigned': 'named a new owner for an account',
  'account-revoked': 'disconnected an account',
  'resources-discovered': 'refreshed what an account reaches',
  'resource-edited': 'edited a resource',
  'account-default-env-set': 'changed the default environment of an account',
  'account-renamed': 'renamed an account',
  'share-created': 'gave access',
  'share-revoked': 'removed an access',
  'mission-issued': 'created a mission',
  'mission-rotated': 'replaced a key',
  'mission-revoked': 'stopped a mission',
  'mission-member-added': 'added a teammate',
  'mission-member-removed': 'removed a teammate',
  'mission-token-issued': 'generated a key',
  'mission-token-revoked': 'revoked a key',
  'mission-closed': 'closed a mission',
  'mission-orphaned': 'left a mission without an owner',
  'mission-restored': 'brought a mission back',
  'mission-account-lost': 'took an account out of a mission',
  'mission-account-restored': 'gave an account back to a mission',
  'budget-extended': 'raised a limit',
  'period-reset': 'reset the limits',
  'expiry-extended': 'extended a mission',
  'gate-opened': 'let a permission run freely for the period',
  'gate-changed': 'changed “ask me first”',
  'approval-granted': 'approved a call',
  'request-refused': 'refused a request',
  // History: the management door and its delegations were retired on 2026-11-14.
  'delegation-granted': 'connected an app',
  'delegation-revoked': 'disconnected an app',
  'group-created': 'created a team',
  'group-member-added': 'added someone to a team',
  'group-member-removed': 'removed someone from a team',
  // History, like the delegations above.
  'oauth-client-approved': 'approved an app',
  'oauth-client-disabled': 'disabled an app',
  'user-deactivated': 'deactivated a person',
  'user-reactivated': 'reactivated a person',
  'user-sessions-ended': 'signed a person out everywhere',
  'invitation-added': 'invited an address',
  'invitation-removed': 'removed an invitation',
  'local-link-created': 'sent an account link',
  'sign-in-account-created': 'created a sign-in account',
  'local-password-changed': 'changed a password',
  'local-second-factor-changed': 'changed a second factor',
  'sign-in-account-removed': 'removed a sign-in account',
  'master-key-downloaded': 'downloaded the encryption key',
  'administrator-granted': 'named an administrator',
  'administrator-revoked': 'removed an administrator',
  'administrators-seeded': 'named the administrators of the configuration',
  'setup-finished': 'finished the setup',
  'sign-in-provider-tested': 'tested a sign-in provider',
  'sign-in-provider-enabled': 'switched a sign-in provider on',
  'sign-in-provider-disabled': 'switched a sign-in provider off',
  'second-factor-waiver-changed': 'changed the second-factor waiver of a sign-in provider',
  'second-factor-changed': 'changed a second factor',
  'administrator-recovered': 'named an administrator with the master key',
  'password-recovered': 'chose a new password with the master key',
  'backup-made': 'made a backup',
  'backup-failed': 'failed to make a backup',
  'device-added': 'received notifications on a device',
  'device-removed': 'removed a device from their notifications',
  'address-added': 'received notifications at a messaging address',
  'address-removed': 'removed a messaging address from their notifications',
  'mail-notifications-changed': 'switched their mail notifications',
  'plugin-uploaded': 'uploaded a plugin',
  'plugin-activated': 'activated a plugin version',
  'plugin-refused': 'refused a plugin version',
  'plugin-followed-image': 'set a plugin back to the image’s version',
  'plugin-trial-ended': 'ended the trial of a plugin version',
  'instance-restarted': 'restarted the instance',
  'plugin-signer-added': 'trusted a plugin signer',
  'plugin-signer-removed': 'removed a trusted plugin signer',
  'config-changed': 'changed the configuration',
  'permissions-changed': 'changed the permissions of a mission',
  'mission-resources-added': 'added resources to a mission',
  'mission-resource-joined': 'added a resource found later to a mission',
  'mission-resource-left': 'took a relabelled resource out of a mission',
  'permission-requested': 'requested missing permissions',
  'limits-changed': 'changed the limits of a mission',
  'mission-changed': 'changed a mission',
  'mission-member-left': 'left a mission',
} as const;
