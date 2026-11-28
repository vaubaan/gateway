import { ALLOW_WORDS } from '@vaubaan/policy-engine';

/** The product, and how it names itself in the shell. */
export const PRODUCT = { name: 'Vaubaan' } as const;

// ─────────────────────────────────────────────────────────────────────────────
// Navigation: seven entries, in this order. Routes follow the words.
// ─────────────────────────────────────────────────────────────────────────────

export const ROUTES = {
  home: '/',
  waiting: '/waiting',
  missions: '/missions',
  newMission: '/missions/new',
  accounts: '/accounts',
  activity: '/activity',
  /** The Activity's tabs: the audit record, and the mission log events of every mission. */
  activityRecord: '/activity/record',
  activityTimeline: '/activity/timeline',
  reference: '/reference',
  settings: '/settings',
  notifications: '/settings/notifications',
  administration: '/admin',
  design: '/design',
} as const;

export type NavKey =
  'now' | 'waiting' | 'missions' | 'accounts' | 'activity' | 'reference' | 'settings';

export const NAV: Readonly<Record<NavKey, { readonly label: string; readonly href: string }>> = {
  now: { label: 'Now', href: ROUTES.home },
  waiting: { label: 'Waiting for you', href: ROUTES.waiting },
  missions: { label: 'Missions', href: ROUTES.missions },
  accounts: { label: 'Accounts', href: ROUTES.accounts },
  activity: { label: 'Activity', href: ROUTES.activity },
  reference: { label: 'Reference', href: ROUTES.reference },
  settings: { label: 'Settings', href: ROUTES.settings },
};

/** The order of the side navigation; Settings comes after the rule. */
/**
 * The word under an entry's icon where the room is a fifth of a phone's width:
 * given only for a label that does not fit. The link keeps its full name.
 */
export const NAV_SHORT: Readonly<Partial<Record<NavKey, string>>> = {
  waiting: 'Waiting',
};

/** The last entry of a phone's bar: the entries it has no room for. */
export const NAV_MORE = 'More';

export const NAV_ORDER: readonly NavKey[] = [
  'now',
  'waiting',
  'missions',
  'accounts',
  'activity',
  'reference',
  'settings',
];

// ─────────────────────────────────────────────────────────────────────────────
// Terms. `one` / `many` are lower case: sentence case is the caller's.
// ─────────────────────────────────────────────────────────────────────────────

export interface Term {
  readonly one: string;
  readonly many: string;
}

/**
 * Keyed by the name the spec and the code use; the value is what a person
 * reads. `mission` and `macroAction` are kept as they are.
 */
export const TERMS = {
  account: { one: 'account', many: 'accounts' },
  disconnectedAccount: { one: 'disconnected account', many: 'disconnected accounts' },
  mission: { one: 'mission', many: 'missions' },
  risk: { one: 'permission', many: 'permissions' },
  macroAction: { one: 'macro-action', many: 'macro-actions' },
  missionToken: { one: 'key', many: 'keys' },
  namedToken: { one: 'machine key', many: 'machine keys' },
  request: { one: 'request', many: 'requests' },
  service: { one: 'service', many: 'services' },
  member: { one: 'teammate', many: 'teammates' },
  operator: { one: 'administrator', many: 'administrators' },
  group: { one: 'team', many: 'teams' },
  user: { one: 'person', many: 'people' },
  resource: { one: 'resource', many: 'resources' },
  agent: { one: 'agent', many: 'agents' },
  call: { one: 'call', many: 'calls' },
} as const satisfies Record<string, Term>;

export type TermKey = keyof typeof TERMS;

/** `count(3, TERMS.risk)` → "3 permissions"; `count(1, TERMS.risk)` → "1 permission". */
export function count(n: number, term: Term): string {
  return `${formatNumber(n)} ${n === 1 ? term.one : term.many}`;
}

/** Thousands are grouped the same way on the server and in the browser. */
export function formatNumber(n: number): string {
  return n.toLocaleString('en-US');
}

/** `capitalize('waiting for you')` → "Waiting for you". */
export function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// ─────────────────────────────────────────────────────────────────────────────
// Page titles, ledes (one sentence at most) and the actions a page names.
// ─────────────────────────────────────────────────────────────────────────────

export const PAGES = {
  now: { title: 'Now' },
  waiting: {
    title: 'Waiting for you',
    lede: 'What your agents asked you: a yes before an action, or more room after a limit.',
  },
  missions: {
    title: 'Missions',
    lede: 'A mission says what an agent may touch, what it may do, how much, and what it must ask you first.',
  },
  newMission: {
    title: 'New mission',
    lede: 'What an agent may touch, what it may do, how much, and what it must ask you first. You get the key at the end.',
  },
  accounts: {
    title: 'Accounts',
    lede: 'A cloud account connected once; agents reach it only through a mission key.',
  },
  activity: {
    title: 'Activity',
    lede: 'Every call an agent made and every change a person made. This is the audit record.',
  },
  reference: {
    title: 'Reference',
    lede: 'What an agent can do on each service, permission by permission. Read-only: nothing here changes anything.',
  },
  settings: {
    title: 'Settings',
    lede: 'Your own settings, then the gateway of your company if you administer it.',
  },
  design: {
    title: 'Interface reference',
    lede: 'Every component of the interface, in every state, in both themes.',
  },
} as const;

export const ACTIONS = {
  newMission: 'New mission',
  createMission: 'Create mission',
  connectAccount: 'Connect an account',
  giveAccess: 'Give access',
  removeAccess: 'Remove',
  replaceKey: 'Replace key',
  revokeKey: 'Revoke',
  newMachineKey: 'New machine key',
  /** The one entry of a mission's keys: a teammate, or a machine key. */
  addKeys: 'Add keys',
  addTeammate: 'Add teammate',
  setupKit: 'Setup kit',
  editPermissions: 'Edit permissions',
  approve: 'Approve',
  refuse: 'Refuse',
  raise: 'Raise',
  details: 'Details',
  showDetails: 'Show details',
  hideDetails: 'Hide details',
  why: 'why?',
  hideWhy: 'hide',
  copy: 'Copy',
  copied: 'Copied',
  cancel: 'Cancel',
  signOut: 'Sign out',
  signOutEverywhere: 'Sign out everywhere',
} as const;

/** Section headings several pages share. */
export const SECTIONS = {
  waiting: 'Waiting for you',
  running: 'Running now',
  whoHasAccess: 'Who has access',
  sharedWithYou: 'Shared with you',
  yours: 'Yours',
  keys: 'Keys',
  permissionsAndUsage: 'Permissions and usage',
  notifications: 'Notifications',
  administrators: 'Administrators',
  peopleAndTeams: 'People and teams',
  setup: 'Setup',
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Gate → "runs freely" / "ask me first". Protocol values: `auto`, `approval`.
// ─────────────────────────────────────────────────────────────────────────────

// The gate words and a mission's Can / Asks first / Cannot belong to the risk
// model: `@vaubaan/policy-engine` (`risk-words.ts`) holds them, so the public
// site prints the same words (re-exported at the top of this file).

/**
 * Said of someone else's mission: who is asked is the creator, not the reader.
 * A label of a narrow column: it names the role, not the address — the page
 * names the creator in its header, and an email here ran under the value
 * beside it.
 */
export function asksFirst(creator: string | null): string {
  return creator ? 'Asks the creator first' : ALLOW_WORDS.asks;
}

// ─────────────────────────────────────────────────────────────────────────────
// Risk: one concept, the row (four names, worst first) and the reason that put
// a permission there. Only rows 2 and above take a colour.
// ─────────────────────────────────────────────────────────────────────────────

// The four rows, the reasons, the five facts and their words:
// `@vaubaan/policy-engine` (`risk-words.ts`), re-exported at the top of this file.

// ─────────────────────────────────────────────────────────────────────────────
// Limits: budget, quota and rate limit are "limits", with their unit.
// ─────────────────────────────────────────────────────────────────────────────

export const LIMIT_WORDS = {
  limits: 'limits',
  perDay: 'Per day',
  perMinute: 'Per minute',
  usedToday: 'Used today',
  limitReached: 'Limit reached',
} as const;

/** "1,860 / 3,000" */
export function usage(used: number, limit: number): string {
  return `${formatNumber(used)} / ${formatNumber(limit)}`;
}

/** "49 of 50 left today" */
export function roomLeft(left: number, limit: number, period = 'today'): string {
  return `${formatNumber(left)} of ${formatNumber(limit)} left ${period}`;
}

/** "3,000 a day", "60 a minute" */
export function perPeriod(n: number, unit: 'day' | 'minute' | 'hour' | 'week' | 'month'): string {
  return `${formatNumber(n)} a ${unit}`;
}

/** "limits reset every day" — how a recurring period is said. */
export function limitsReset(every: 'day' | 'week' | 'month' | null): string {
  return every ? `limits reset every ${every}` : 'limits do not reset';
}

// ─────────────────────────────────────────────────────────────────────────────
// Keys and their holders. A person knows one word: key.
// ─────────────────────────────────────────────────────────────────────────────

export const KEY_WORDS = {
  yourKey: 'your key',
  machineKey: 'machine key',
  shownOnce: 'Shown once.',
  notGenerated: 'no key yet',
  /** A mission that was stopped: its keys are not "not made yet", they were revoked. */
  revoked: 'keys revoked',
  /** A mission that ended before the reader made a key. */
  noneMade: 'no key was made',
  /** The two choices of "Add keys". */
  forTeammate: 'A teammate',
  forMachine: 'A machine key',
} as const;

/** "Carol's key", "your key", "the machine key nightly". */
export function keyOf(holder: { name: string; you?: boolean; machine?: boolean }): string {
  if (holder.machine) return `the machine key ${holder.name}`;
  if (holder.you) return KEY_WORDS.yourKey;
  return `${possessive(holder.name)} key`;
}

export function possessive(name: string): string {
  return name.endsWith('s') ? `${name}’` : `${name}’s`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Roles, said in sentences where they matter; "beneficiary" and "principal"
// are never said.
// ─────────────────────────────────────────────────────────────────────────────

export const ROLE_WORDS = {
  you: 'you',
  creator: 'creator',
  teammate: 'teammate',
  owner: 'owner',
  administrator: 'administrator',
  admin: 'admin',
  installer: 'installing this gateway',
} as const;

/** The qualifiers after a name: `qualifiers(['you', 'creator'])` → "· you · creator". */
export function qualifiers(words: readonly (string | null | undefined | false)[]): string {
  const kept = words.filter((word): word is string => Boolean(word));
  return kept.length === 0 ? '' : `· ${kept.join(' · ')}`;
}

/** "you own it", "you own it with Platform", "Bob owns it". */
export function ownership(owner: { you: boolean; name?: string; team?: string }): string {
  if (owner.you) return owner.team ? `you own it with ${owner.team}` : 'you own it';
  return `${owner.name ?? 'someone else'} owns it`;
}

/** "access given by Bob · 12 of 17" */
export function accessGiven(by: string, allowed: number, total: number): string {
  return `access given by ${by} · ${mayAllow(allowed, total)}`;
}

/** "all 15", "12 of 15" — the ceiling a person holds on an account. */
export function mayAllow(allowed: number, total: number): string {
  return allowed >= total
    ? `all ${formatNumber(total)}`
    : `${formatNumber(allowed)} of ${formatNumber(total)}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// States. The rule is the exception: nothing is ever labelled "active" or
// "allowed" in colour. A state has a tone only when it differs from normal.
// ─────────────────────────────────────────────────────────────────────────────

export type Tone = 'neutral' | 'info' | 'ok' | 'warn' | 'bad';

export interface StateWord {
  readonly label: string;
  /** `null`: the normal state, written plainly (or not at all), never coloured. */
  readonly tone: Exclude<Tone, 'neutral' | 'info' | 'ok'> | null;
}

/** Keyed by the mission states of the spec (§2.3), plus the per-permission exception. */
export const MISSION_STATES = {
  active: { label: 'running', tone: null },
  limitReached: { label: 'Limit reached', tone: 'bad' },
  waiting: { label: 'Waiting for you', tone: 'warn' },
  expired: { label: 'expired', tone: null },
  revoked: { label: 'stopped', tone: null },
  orphaned: { label: 'Needs an owner', tone: 'bad' },
  /** Running, with an account that no longer serves it (revoked, or access withdrawn). */
  accountLost: { label: 'Lost an account', tone: 'warn' },
} as const satisfies Record<string, StateWord>;

/** Keyed by `AccountStatus`. */
export const ACCOUNT_STATES = {
  active: { label: 'connected', tone: null },
  expired: { label: 'Needs reconnecting', tone: 'bad' },
  revoked: { label: 'disconnected', tone: null },
  unowned: { label: 'Needs an owner', tone: 'warn' },
} as const satisfies Record<string, StateWord>;

/** Keyed by `RequestStatus`. */
export const REQUEST_STATES = {
  open: { label: 'waiting', tone: 'warn' },
  granted: { label: 'approved', tone: null },
  refused: { label: 'refused', tone: null },
  expired: { label: 'expired', tone: null },
} as const satisfies Record<string, StateWord>;

/** Keyed by the decision of an audit record. */
export const DECISION_WORDS = {
  allowed: { label: 'allowed', tone: null },
  refused: { label: 'refused', tone: 'bad' },
  asked: { label: 'asked you', tone: 'warn' },
  act: { label: 'change', tone: null },
} as const satisfies Record<string, StateWord>;

// ─────────────────────────────────────────────────────────────────────────────
// Sentence patterns of "Waiting for you": one inbox, the sentence says the kind.
// Protocol kinds: `approval` (a gated action), `claim` (a limit was reached).
// ─────────────────────────────────────────────────────────────────────────────

export const WAITING = {
  /** Why only the reader can answer. */
  onlyYou: 'Only you can answer: you created these missions.',
  nothing: 'Nothing needs you.',
  /** What a yes is worth, under the two buttons. */
  yesIsWorth:
    'Your yes is valid 10 minutes, for exactly this call; the agent retries it on its own. Anything different asks again.',
  recorded: 'Recorded in the activity, like every change.',
} as const;

/** "waiting for your yes" / "waiting for Alice’s yes" — what a teammate reads. */
export function waitingFor(creator: string | null): string {
  return creator ? `waiting for ${possessive(creator)} yes` : 'waiting for your yes';
}

/** "you asked to be asked first" — why an approval exists. */
export const ASKED_FIRST = 'you asked to be asked first';

/** "Nightly audit reached its daily limit" */
export function reachedLimit(mission: string, every: 'day' | 'week' | 'month' = 'day'): string {
  const period = every === 'day' ? 'daily' : every === 'week' ? 'weekly' : 'monthly';
  return `${mission} reached its ${period} limit`;
}

/** "4 missions running", "Nothing needs you. 4 missions are running." */
export function running(n: number): string {
  return `${count(n, TERMS.mission)} running`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Time, short: "4 min", "1 h", "yesterday".
// ─────────────────────────────────────────────────────────────────────────────

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/** How long ago, in the fewest characters; the full date belongs to a `title`. */
export function ago(from: Date | string, now: Date = new Date()): string {
  const elapsed = now.getTime() - new Date(from).getTime();
  if (elapsed < MINUTE) return 'now';
  if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)} min`;
  if (elapsed < DAY) return `${Math.floor(elapsed / HOUR)} h`;
  if (elapsed < 2 * DAY) return 'yesterday';
  return `${Math.floor(elapsed / DAY)} d`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Theme
// ─────────────────────────────────────────────────────────────────────────────

export const THEME_WORDS = {
  system: 'System',
  light: 'Light',
  dark: 'Dark',
  label: 'Theme',
} as const;
