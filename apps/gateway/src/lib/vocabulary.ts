/**
 * The words of the interface — one file, so that a person meets one word per
 * thing on every page (ADR interface-redesign-vocabulary-and-design-system).
 *
 * This is the vocabulary of what a person READS. Protocol and storage names do
 * not change and are never taken from here: MCP tool names, refusal codes, risk
 * ids, catalog YAML, database columns, API fields and configuration keys keep
 * the names the spec gives them (`connection`, `share`, `risk`, `gate`,
 * `quota`, `request`, `delegation`, `operator`…). A page prints an id as the
 * protocol spells it (in mono) and everything around it with these words.
 *
 * Pure and browser-safe: no import, usable in server and client components.
 */

/** The product, and how it names itself in the shell. */
export const PRODUCT = { name: 'Vaubaan', mark: 'V' } as const;

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
  reference: '/reference',
  settings: '/settings',
  connectedApps: '/delegations',
  administration: '/admin',
  design: '/design',
} as const;

export type NavKey =
  | 'now'
  | 'waiting'
  | 'missions'
  | 'accounts'
  | 'activity'
  | 'reference'
  | 'settings';

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
 * reads. `mission` and `preset` are kept as they are.
 */
export const TERMS = {
  connection: { one: 'account', many: 'accounts' },
  mission: { one: 'mission', many: 'missions' },
  risk: { one: 'permission', many: 'permissions' },
  preset: { one: 'preset', many: 'presets' },
  missionToken: { one: 'key', many: 'keys' },
  namedToken: { one: 'machine key', many: 'machine keys' },
  request: { one: 'request', many: 'requests' },
  delegation: { one: 'connected app', many: 'connected apps' },
  providerApp: { one: 'company app', many: 'company apps' },
  provider: { one: 'service', many: 'services' },
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
  addPeople: 'Add people',
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
} as const;

/** Section headings several pages share. */
export const SECTIONS = {
  waiting: 'Waiting for you',
  running: 'Running now',
  whoHasAccess: 'Who has access',
  sharedWithYou: 'Shared with you',
  yours: 'Yours',
  peopleAndKeys: 'People and keys',
  permissionsAndUsage: 'Permissions and usage',
  connectedApps: 'Connected apps',
  companyApps: 'Company apps',
  administrators: 'Administrators',
  peopleAndTeams: 'People and teams',
  setup: 'Setup',
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Gate → "runs freely" / "ask me first". Protocol values: `auto`, `approval`.
// ─────────────────────────────────────────────────────────────────────────────

export type GateWord = 'free' | 'ask' | 'off';

/** The protocol's gate as the word class the interface draws. */
export function gateWordOf(gate: 'auto' | 'approval'): GateWord {
  return gate === 'approval' ? 'ask' : 'free';
}

export const GATE_WORDS: Readonly<Record<GateWord, string>> = {
  free: 'runs freely',
  ask: 'ask me first',
  off: 'not included',
};

/** The same three, as the headings of the summary of a mission. */
export const ALLOW_WORDS = {
  can: 'Can',
  asks: 'Asks you first',
  cannot: 'Cannot',
  limits: 'Limits today',
} as const;

/** Said of someone else's mission: who is asked is the creator, not the reader. */
export function asksFirst(creator: string | null): string {
  return creator ? `Asks ${creator} first` : ALLOW_WORDS.asks;
}

// ─────────────────────────────────────────────────────────────────────────────
// Severity: one word, kept as a chip. Only medium and above take a colour.
// ─────────────────────────────────────────────────────────────────────────────

export type SeverityWord = 'low' | 'medium' | 'high' | 'critical';

export const SEVERITY_LABEL = 'Risk';

/**
 * The six words behind a severity, as the "why?" disclosure labels them. Keyed
 * by the axis names of the risk model (`RiskVector`).
 */
export const WHY_LABELS = {
  reversibility: 'Undo',
  blast: 'Blast radius',
  data: 'Data',
  cost: 'Cost',
  visibility: 'Visible to',
  persistence: 'Lasts',
} as const;

export type WhyAxis = keyof typeof WHY_LABELS;

/** The order the six cells are drawn in. */
export const WHY_ORDER: readonly WhyAxis[] = [
  'reversibility',
  'blast',
  'data',
  'cost',
  'visibility',
  'persistence',
];

/** A value of the risk model, said in words. Values not listed are printed as they are. */
export const WHY_VALUES: Readonly<Record<WhyAxis, Readonly<Record<string, string>>>> = {
  reversibility: { reversible: 'easy', costly: 'costly', irreversible: 'impossible' },
  blast: {
    single: 'one thing',
    env: 'one environment',
    account: 'whole account',
    bulk: 'many at once',
  },
  data: { metadata: 'metadata', data: 'data', secret: 'secrets', pii: 'personal data' },
  cost: { free: 'free', moderate: 'moderate', unbounded: 'unbounded' },
  visibility: { internal: 'internal', team: 'the team', public: 'public' },
  persistence: { stateless: 'nothing', session: 'the session', posture: 'until reverted' },
};

export function whyValue(axis: WhyAxis, value: string): string {
  return WHY_VALUES[axis][value] ?? value;
}

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
} as const satisfies Record<string, StateWord>;

/** Keyed by `ConnectionStatus`. */
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

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

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

// ─────────────────────────────────────────────────────────────────────────────
// Now, "Waiting for you" and the answer pages.
//
// A limit is said with its period: "today", "its daily limit", "resets in 13 h".
// The period of a mission is a length in seconds; these are the lengths the
// interface names. Any other length is "this period"; a mission whose limits
// never reset has none.
// ─────────────────────────────────────────────────────────────────────────────

export type Every = 'hour' | 'day' | 'week' | 'month';

const EVERY_SECONDS: Readonly<Record<Every, number>> = {
  hour: 3600,
  day: 86_400,
  week: 604_800,
  month: 2_592_000,
};

/** The name of a period length; `null` for a length that has none, and for no period at all. */
export function everyOf(periodSeconds: number | null): Every | null {
  const found = (Object.keys(EVERY_SECONDS) as Every[]).find(
    (every) => EVERY_SECONDS[every] === periodSeconds,
  );
  return found ?? null;
}

const PERIOD_NOW: Readonly<Record<Every, string>> = {
  hour: 'this hour',
  day: 'today',
  week: 'this week',
  month: 'this month',
};

/** "today", "this week"; "this period" for an unnamed length; "in all" when limits never reset. */
export function periodNow(periodSeconds: number | null): string {
  if (periodSeconds === null) return 'in all';
  const every = everyOf(periodSeconds);
  return every ? PERIOD_NOW[every] : 'this period';
}

const PERIOD_ADJECTIVE: Readonly<Record<Every, string>> = {
  hour: 'hourly',
  day: 'daily',
  week: 'weekly',
  month: 'monthly',
};

/** "daily limit", "weekly limit"; "limit" when the period has no name. */
export function limitOf(periodSeconds: number | null): string {
  const every = everyOf(periodSeconds);
  return every ? `${PERIOD_ADJECTIVE[every]} limit` : 'limit';
}

/** "Nightly audit reached its daily limit" — for any period, named or not. */
export function missionReachedLimit(mission: string, periodSeconds: number | null): string {
  return `${mission} reached its ${limitOf(periodSeconds)}`;
}

/** "Daily limit reached on Read code" */
export function limitReachedOn(permission: string, periodSeconds: number | null): string {
  return `${capitalize(limitOf(periodSeconds))} reached on ${permission}`;
}

/** "5,000 of 5,000" — what was used of a limit. */
export function usedOf(used: number, limit: number): string {
  return `${formatNumber(used)} of ${formatNumber(limit)}`;
}

/** How long until an instant, short: "now", "in 4 min", "in 13 h", "tomorrow", "in 4 d". */
export function until(to: Date | string, now: Date = new Date()): string {
  const left = new Date(to).getTime() - now.getTime();
  if (left < MINUTE) return 'now';
  if (left < HOUR) return `in ${Math.floor(left / MINUTE)} min`;
  if (left < DAY) return `in ${Math.floor(left / HOUR)} h`;
  if (left < 2 * DAY) return 'tomorrow';
  return `in ${Math.floor(left / DAY)} d`;
}

/** "4 min ago", "yesterday", "just now" — `ago` as a phrase. */
export function agoPhrase(from: Date | string, now: Date = new Date()): string {
  const short = ago(from, now);
  if (short === 'now') return 'just now';
  return short === 'yesterday' ? short : `${short} ago`;
}

/** "10 minutes", "90 seconds", "2 hours" — the largest unit that divides a delay. */
export function delay(seconds: number): string {
  const unit = (n: number, word: string): string =>
    `${formatNumber(n)} ${word}${n === 1 ? '' : 's'}`;
  if (seconds >= 3600 && seconds % 3600 === 0) return unit(seconds / 3600, 'hour');
  if (seconds >= 60 && seconds % 60 === 0) return unit(seconds / 60, 'minute');
  return unit(seconds, 'second');
}

/**
 * Who asks, in the fewest words: "Carol · codex", "You · codex", "machine key
 * nightly", "An agent" when the record names nobody. The label of the agent is
 * what it said about itself.
 */
export function asker(who: {
  readonly holder: string | null;
  readonly machine: boolean;
  readonly you: boolean;
  readonly agent: string | null;
}): string {
  const holder = who.machine
    ? who.holder
      ? `${KEY_WORDS.machineKey} ${who.holder}`
      : KEY_WORDS.machineKey
    : who.you
      ? 'You'
      : who.holder;
  if (!holder) return who.agent ?? 'An agent';
  return who.agent ? `${holder} · ${who.agent}` : holder;
}

/** The words of the home. */
export const NOW = {
  /** "Nothing needs you. 4 missions are running." */
  nothingNeedsYou(runningMissions: number): string {
    if (runningMissions === 0) return `${WAITING.nothing} No mission is running.`;
    const verb = runningMissions === 1 ? 'is' : 'are';
    return `${WAITING.nothing} ${count(runningMissions, TERMS.mission)} ${verb} running.`;
  },
  allMissions(total: number): string {
    return total === 1 ? 'The mission' : `All ${count(total, TERMS.mission)}`;
  },
  showRunning: 'Show what is running',
  hideRunning: 'Hide what is running',
  notRunning: 'Not running',
  callsLastDay(n: number): string {
    return `${count(n, TERMS.call)} in the last 24 hours`;
  },
  refusedLastHour(n: number): string {
    return `${formatNumber(n)} refused in the last hour`;
  },
  accounts(n: number, toReconnect: number): string {
    const base = count(n, TERMS.connection);
    if (toReconnect === 0) return base;
    const verb = toReconnect === 1 ? 'needs' : 'need';
    return `${base}, ${formatNumber(toReconnect)} ${verb} reconnecting`;
  },
  atItsLimit(n: number): string {
    return `${formatNumber(n)} at ${n === 1 ? 'its' : 'their'} limit`;
  },
  preparedBy(app: string): string {
    return `prepared by ${app} for you`;
  },
  noCallYet: 'no call yet',
} as const;

/** The words of a first run: what the product is, the model, the steps. */
export const FIRST_RUN = {
  welcome(name: string | null): string {
    return name ? `Welcome, ${name}` : 'Welcome';
  },
  nothingYet: 'Nothing of yours is running yet.',
  nothingConnected: 'The gateway is up. Nothing of yours is connected yet.',
  modelLabel: 'How it fits together',
  model: [
    { name: 'Account', note: 'connected once' },
    { name: 'Mission', note: 'permissions · limits · ask first' },
    { name: 'Key', note: 'one per person or machine' },
    { name: 'Agent', note: 'never holds a credential' },
    { name: 'Activity', note: 'every call, every change' },
  ],
  getStarted: 'Get started',
  fiveMinutes: 'about five minutes',
  setUp: 'Set up this gateway',
  setUpNote: 'you are an administrator',
  thenLikeEveryone: 'Then, like everyone',
  done: 'done',
  steps: {
    account: {
      todo: 'Connect an account',
      done: 'An account you can use',
      todoText:
        'A cloud account of your company, connected once. You own it; give colleagues access to the part they need.',
    },
    mission: {
      title: 'Give an agent a mission',
      text: 'Name it, pick the resources, pick a preset, read the three-line summary, create. You get the key.',
    },
    kit: {
      title: 'Paste the kit into your agent',
      text: 'Three snippets that come with the key: the environment variable, the configuration, the instructions. Then watch it work here.',
    },
  },
  getMyKey: 'Get my key',
  openMission: 'Open',
} as const;

/** The answers a request accepts, keyed by the protocol's resolution. */
export const ANSWERS = {
  grant: { label: 'Approve this call', done: 'You approved this call' },
  'open-gate': {
    label: 'Let it run freely until the reset',
    done: 'You let it run freely until the limits reset',
  },
  refuse: { label: 'Refuse', done: 'You refused' },
  'reset-period': { label: 'Reset the count', done: 'You reset the count' },
  'extend-quota': { label: 'Give back some calls', done: 'You gave calls back' },
  'extend-expiry': { label: 'Extend the mission', done: 'You extended the mission' },
} as const;

export const REQUEST_WORDS = {
  review: 'Review',
  answer: 'Answer',
  wantsTo: 'wants to',
  reachedALimit: 'reached a limit',
  exactlySent: 'Exactly what it sent',
  stoppedOn: 'Stopped on',
  tool: 'tool',
  permissionNeeded: 'Permission it needs',
  permissionsNeeded: 'Permissions it needs',
  roomLeftAfter: 'Room left after this',
  roomLeftNow: 'Room left now',
  limitAnswered: 'answered',
  limitLeft: 'left as it is',
  limit: 'Limit',
  yourAnswer: 'What your answer does',
  whatLedHere: 'What led here',
  missionActivity: 'Mission activity',
  agentSees: 'What the agent sees meanwhile',
  notForYou: 'This request is addressed to the person who created its mission.',
  erased: 'Erased when the request was closed; only their fingerprint remains.',
  eitherAnswer: 'Either answer is written to the activity.',
  nothingOpen: 'Nothing waits for you.',
  answeredLastDay(approved: number, refused: number, expired: number): string {
    const parts = [
      approved > 0 ? `${formatNumber(approved)} approved` : null,
      refused > 0 ? `${formatNumber(refused)} refused` : null,
      expired > 0 ? `${formatNumber(expired)} expired` : null,
    ].filter((part): part is string => part !== null);
    return parts.length === 0
      ? 'Nothing answered in the last 24 hours.'
      : `In the last 24 hours: ${parts.join(', ')}.`;
  },
  /** "2 open · only you can answer: you created these missions" */
  openLede(n: number): string {
    return `${formatNumber(n)} open · only you can answer: you created these missions`;
  },
} as const;
