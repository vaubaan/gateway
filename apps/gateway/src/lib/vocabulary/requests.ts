import {
  DAY,
  HOUR,
  KEY_WORDS,
  MINUTE,
  TERMS,
  WAITING,
  capitalize,
  count,
  formatNumber,
  possessive,
} from './common';

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

/** "10 minutes", "90 seconds", "2 hours" — the largest unit that divides a delay. */
export function delay(seconds: number): string {
  const unit = (n: number, word: string): string =>
    `${formatNumber(n)} ${word}${n === 1 ? '' : 's'}`;
  if (seconds >= 3600 && seconds % 3600 === 0) return unit(seconds / 3600, 'hour');
  if (seconds >= 60 && seconds % 60 === 0) return unit(seconds / 60, 'minute');
  return unit(seconds, 'second');
}

/**
 * Who asks, in the fewest words — the agent first, then whose key it used:
 * "codex, with Carol’s key", "codex, with your key", "An agent with the
 * machine key nightly", "An agent" when the record names nobody. Never "You ·
 * codex": the person is not the one asking, their key is what the agent
 * holds. The label of the agent is what it said about itself.
 */
export function asker(who: {
  readonly holder: string | null;
  readonly machine: boolean;
  readonly you: boolean;
  readonly agent: string | null;
}): string {
  const key = who.machine
    ? who.holder
      ? `the ${KEY_WORDS.machineKey} ${who.holder}`
      : `a ${KEY_WORDS.machineKey}`
    : who.you
      ? KEY_WORDS.yourKey
      : who.holder
        ? `${possessive(who.holder)} key`
        : null;
  if (!key) return who.agent ?? 'An agent';
  return who.agent ? `${who.agent}, with ${key}` : `An agent with ${key}`;
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
    const base = count(n, TERMS.account);
    if (toReconnect === 0) return base;
    const verb = toReconnect === 1 ? 'needs' : 'need';
    return `${base}, ${formatNumber(toReconnect)} ${verb} reconnecting`;
  },
  atItsLimit(n: number): string {
    return `${formatNumber(n)} at ${n === 1 ? 'its' : 'their'} limit`;
  },
  /** `who` is `issuerName(...)`: the issuing mission, or the app of a mission prepared by delegation. */
  preparedBy(who: string): string {
    return `prepared by ${who} for you`;
  },
  noCallYet: 'no call yet',
} as const;

/**
 * Who prepared a mission for its creator, as a page names it: the issuing mission
 * ("mission “Release notes”"), or — history — the app that issued it by delegation
 * before the management door was retired (its own claim, not verified).
 */
export function issuerName(issuer: {
  readonly mission_name: string | null;
  readonly client_name: string | null;
}): string {
  if (issuer.mission_name !== null) return `mission “${issuer.mission_name}”`;
  if (issuer.client_name !== null) return issuer.client_name;
  return 'a mission that no longer exists';
}

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
      text: 'Name it, pick the resources, tick what the agent may do at a trust level, read the three-line summary, create. You get the key.',
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
