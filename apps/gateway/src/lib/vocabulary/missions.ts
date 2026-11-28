import { formatDay } from '../dates';
import { LIMIT_WORDS, ago, formatNumber, limitsReset } from './common';

// ─────────────────────────────────────────────────────────────────────────────
// Missions: the list, the mission page, "New mission", the key and its kit.
// ─────────────────────────────────────────────────────────────────────────────

/** The acts of the mission pages that `ACTIONS` does not name. */
export const MISSION_ACTIONS = {
  stop: 'Stop the mission',
  duplicate: 'Duplicate',
  activity: 'Activity',
  generateKey: 'Generate my key',
  revokeMyKey: 'Revoke my key',
  removeTeammate: 'Remove',
  openMission: 'Open the mission',
  savedKey: 'I saved the key',
  startFrom: 'Start from a mission…',
  pasteProposal: 'Paste an agent’s proposal',
  change: 'Change',
  editMission: 'Edit mission',
  saveChanges: 'Save changes',
  leave: 'Leave the mission',
} as const;

/** A trust-raise proposal (risk model §4.7), on the mission page and Now. */
export const TRUST_RAISE_WORDS = {
  /** "Raise “Change” to Autonomous?" */
  title: (macroAction: string, to: string): string => `Raise “${macroAction}” to ${to}?`,
  /** Why it is offered: what was approved, where. */
  because: (approvals: number, where: string, from: string): string =>
    `You approved it ${approvals} times on ${where}, with no refusal since it was set to ${from}.`,
  /** The account, and its set when the account has several ("Acme main, resource set 2"). */
  where: (accountName: string, setPosition: number | null): string =>
    setPosition === null ? accountName : `${accountName}, resource set ${setPosition}`,
  rule: 'Raising is an ordinary edit of the mission, shown before it is saved. Nothing is raised without you.',
  raise: 'Raise',
  notNow: 'Not now',
  /** The toast after "Not now". */
  hidden: 'Hidden until as many approvals again.',
  /** The edit form opened by "Raise". */
  editTitle: (macroAction: string, from: string, to: string, where: string): string =>
    `Raising “${macroAction}” from ${from} to ${to} on ${where}`,
  editLede: 'Its lines are rewritten at the new level. Save to apply; nothing changes until then.',
  /** Lines of the macro-action edited by hand, which the raise replaces. */
  replaced: 'These lines were edited by hand and are replaced:',
} as const;

/**
 * Resource sets (risk model §4.7): the resources of one account split in groups, each
 * with its own trust levels and limits. Never "Set" alone; nothing is said of sets
 * while an account has one.
 */
export const RESOURCE_SET_WORDS = {
  /** "Resource set 2". */
  title: (position: number): string => `Resource set ${position}`,
  add: '+ Add a resource set',
  remove: 'Remove this resource set',
  /** The scope select of a set's head. */
  scope: 'Resources',
  /** A resource another set of the account holds. */
  heldBy: (position: number): string => `in resource set ${position}`,
  /** Why a set takes no "rest" scope: another set of the account does. */
  restTaken: 'another resource set of this account already takes the rest',
  /** What `all` and `account` mean once an account has several sets. */
  rest: 'every resource the other resource sets of this account do not pick',
  explanation:
    'Each resource set has its own trust levels and limits. A call is judged by the set of the resource it names; a call that names none, or resources of several sets, must be allowed in each.',
} as const;

/** The filter of the missions list: running ones by default, stopped ones one click away. */
export const MISSION_LIST_FILTERS = {
  label: 'Which missions',
  running: 'running',
  stopped: 'stopped',
  noneStopped: 'No stopped mission.',
} as const;

/** The History of a mission: the versions of its configuration (spec §4.2 "History"). */
export const MISSION_HISTORY = {
  title: 'History',
  note: 'Every change of its configuration, newest first. Keys, teammates and what was used are not part of a version: restoring one resets no usage and replaces no key.',
  version: (n: number) => `Version ${n}`,
  current: 'Current',
  restore: 'Restore this version',
  showChanges: 'What changed',
  hideChanges: 'Hide what changed',
  by: (who: string) => `by ${who}`,
  restored: 'Restored',
  restoredAs: (from: number, to: number) =>
    `Version ${from} is the configuration again, as version ${to}. The keys, the mission log and what was used this period are unchanged.`,
  alreadyCurrent: (from: number) =>
    `Version ${from} is already the configuration: nothing changed.`,
  leftOut: 'Left out:',
  notRestored: 'Not restored',
  /** Why a version was written; a rollback names its source. */
  causes: {
    issued: 'Created',
    'before-versions': 'As it was when the history began',
    edit: 'Edited',
    'permission-request': 'Permission request accepted',
    'resource-created': 'A resource it created joined',
    'resources-discovered': 'Resources joined or left on their own',
    'claim-granted': 'End moved by an answered request',
    rollback: 'Restored',
  },
  restoredFrom: (n: number) => `Restored from version ${n}`,
} as const;

/** Sentences the mission pages share. */
export const MISSION_WORDS = {
  editLede:
    'Change anything but how often the limits reset. Same key, same mission log, same counters: the next call of every holder sees the edited mission.',
  nothingChangedYet: 'Nothing changed yet.',
  periodFixed:
    'How often the limits reset does not change on a running mission: its counters are kept per period. Duplicate the mission for another one.',
  edited: 'Saved. The next call of every holder sees the edited mission, with the same key.',
  yours: 'Created by you',
  sharedWithYou: 'Shared with you',
  noneYet: 'No mission yet.',
  noneShared: 'No mission is shared with you.',
  noneSharedHow:
    'The creator of a mission adds teammates on its page; a teammate works on it with their own key.',
  teammateRule:
    'You work on it as it is, with your own key: same permissions and limits as everyone on it.',
  sameForEveryone: 'One key each, same permissions and limits; every call is signed by its key.',
  keyShownOnce:
    'Shown once. Lost it? Replace it from the mission page; the mission does not change.',
  kitWithoutKey: 'Three snippets and a check. The key itself was shown once.',
  noKeyWorks: 'No key works on this mission now.',
  notServing: 'No key can be made now: the mission does not serve calls.',
  /** An account a mission was given whole (resource scope `account`). */
  wholeAccount: 'the whole account, including resources found later',
  /** A set with future on (ADR resource-set-is-one-environment-with-optional-future-resources). */
  futureResources: 'resources found later in the same environment',
  /** After a resource the mission created itself (ADR created-resources-join-the-mission). */
  createdByMission: 'created by this mission',
  peopleLater: 'Just you for now; teammates and machine keys are added after creating.',
  railTitle: 'What this mission will be able to do',
  /** The details line of a mission page: what a report or the audit names it by. */
  missionId: 'Mission id',
} as const;

/**
 * The cards of the mission screen and page (spec §4.2): generic words only. What a card
 * names comes from fields every plugin declares — its resource noun, the catalog's
 * macro-action and permission labels, the data model's plane slugs — and the
 * environment labels the owner gave; nothing here is written for one service.
 */
export const CARD_WORDS = {
  addAccount: '+ Add an account',
  searchAccounts: 'Search accounts…',
  pickAccount: 'Which account?',
  addCard: 'Add card',
  saveCard: 'Apply',
  /** Step 2 of "+ Add an account": "Which boards?" */
  whichResources: (other: string): string => `Which ${other}?`,
  /** A resource another card of the mission holds: a resource is in one card only. */
  inAnotherCard: 'in another card',
  /** "+ future boards": the box of a group, and the tail of a card's resources. */
  future: (other: string): string => `+ future ${other}`,
  /** A permission the catalog does not accept in that environment. */
  neverIn: (env: string): string => `never in ${env}`,
  /** A card of an account that lists no resource. */
  accountItself: 'the account itself',
  /** The resources without an environment label, on a service that needs one. */
  notSelectable: 'not selectable',
  labelIt: 'Label it to add it',
  /** Ticks every free listed resource of a group (never a hidden one). */
  selectAll: 'Select all',
  /** The collapsed list of a group's hidden resources: "Hidden from new missions (12)". */
  hiddenResources: (n: number): string => `Hidden from new missions (${formatNumber(n)})`,
  /** "2 of 4 boards free": what another card of the account may still take. */
  free: (free: number, total: number, other: string): string =>
    `${formatNumber(free)} of ${formatNumber(total)} ${other} free`,
  noAccountLeft: 'You may use no account yet: connect one, or ask its owner to share it.',
  whatItCanDo: 'What it can do',
  trust: 'Trust',
  removeCard: (account: string): string => `Remove ${account}`,
  changeResources: (account: string): string => `Change the resources of ${account}`,
  /** The foot of a card. */
  digest: (total: number, free: number, asks: number): string =>
    `${formatNumber(total)} ${total === 1 ? 'permission' : 'permissions'} · ${formatNumber(free)} run freely · ${formatNumber(asks)} ask you`,
  notTicked: 'Not ticked.',
  /** The three behaviours of a permission in the Custom modal and the (i). */
  runsFreely: 'Runs freely',
  asksFirst: 'Asks first',
  asksYouFirst: 'Asks you first',
  leftOut: 'Left out',
  limitsTimes: (factor: number): string => `Limits ×${formatNumber(factor)}`,
  startFrom: 'Start from',
  thenSingleLines: 'then change single lines',
  allPlanes: 'all',
  planesOnlyFilter: 'The plane chips only filter the list; the mission stores permissions.',
  apply: 'Apply',
  permission: 'Permission',
  behaviour: 'Behaviour',
  /** A card with future resources: when discovery last ran, and running it now. */
  checked: (ago: string): string => `checked ${ago}`,
  neverChecked: 'not checked yet',
  checkNow: '↻ Check now',
  raiseLimit: 'Raise this limit',
  /** A permission whose gate the creator opened for the rest of the period. */
  runsFreelyUntil: 'runs freely until',
  closeOpening: 'Close',
  closeOpeningOf: (riskId: string): string => `Close “runs freely until” for ${riskId}`,
  /** The hover of a gauge. */
  usageOf: (action: string, period: string): string => `${action} · ${period}`,
  gaugeRule: 'The bar follows the permission closest to its limit.',
  /** A legacy card that mixed environments, split when the screen opened. */
  splitTitle: 'One card per environment',
  splitBody:
    'A card holds the resources of one environment. Cards that held several are shown split, each with the permissions that apply there; saving keeps them so.',
  nothingYet: 'No account yet: add one, then tick what the agent may do there.',
  /** The summary bar of a creation. */
  creationSummary: (cards: number, total: number, free: number, asks: number): string =>
    `${formatNumber(cards)} ${cards === 1 ? 'card' : 'cards'} · ${formatNumber(total)} ${total === 1 ? 'permission' : 'permissions'} · ${formatNumber(free)} run freely · ${formatNumber(asks)} ask you`,
  /** The summary bar of an edit: "2 changes: …". */
  changes: (n: number): string => `${formatNumber(n)} ${n === 1 ? 'change' : 'changes'}`,
} as const;

/** How often the limits of a mission start again, keyed by the period in seconds (`null`: never). */
export function limitsResetEvery(lengthSeconds: number | null): string {
  if (lengthSeconds === null) return 'limits do not reset';
  if (lengthSeconds === 3600) return 'limits reset every hour';
  if (lengthSeconds === 86_400) return limitsReset('day');
  if (lengthSeconds === 604_800) return limitsReset('week');
  if (lengthSeconds % 86_400 === 0) return `limits reset every ${lengthSeconds / 86_400} days`;
  if (lengthSeconds % 3600 === 0) return `limits reset every ${lengthSeconds / 3600} hours`;
  return `limits reset every ${Math.round(lengthSeconds / 60)} minutes`;
}

/** The head of the limit column for a period: "Per day", "Per hour", "In total". */
export function limitColumn(lengthSeconds: number | null): string {
  if (lengthSeconds === null) return 'In total';
  if (lengthSeconds === 3600) return 'Per hour';
  if (lengthSeconds === 86_400) return LIMIT_WORDS.perDay;
  if (lengthSeconds === 604_800) return 'Per week';
  return 'Per period';
}

/** The head of the usage column for a period: "Used today", "Used this week". */
export function usedColumn(lengthSeconds: number | null): string {
  if (lengthSeconds === null) return 'Used';
  if (lengthSeconds === 3600) return 'Used this hour';
  if (lengthSeconds === 86_400) return LIMIT_WORDS.usedToday;
  if (lengthSeconds === 604_800) return 'Used this week';
  return 'Used this period';
}

/** "today", "this week": the period a count belongs to, said after it. */
export function periodWord(lengthSeconds: number | null): string {
  if (lengthSeconds === null) return 'in total';
  if (lengthSeconds === 3600) return 'this hour';
  if (lengthSeconds === 86_400) return 'today';
  if (lengthSeconds === 604_800) return 'this week';
  return 'this period';
}

/**
 * A day in the fewest characters: "12 Nov", with the year when it is not this
 * one. Read in UTC so that the server and the browser print the same text;
 * the full date belongs to a `title`.
 */
export function shortDate(at: Date | string, now: Date = new Date()): string {
  return formatDay(at, { now });
}

/** "expires 12 Nov", "expired 12 Nov", "never expires". */
export function expiresOn(at: string | null, now: Date = new Date()): string {
  if (at === null) return 'never expires';
  const past = new Date(at).getTime() <= now.getTime();
  return `${past ? 'expired' : 'expires'} ${shortDate(at, now)}`;
}

/** A list in a sentence, cut after `max` items: "a, b, c and 4 more". */
export function listed(items: readonly string[], max = 4): string {
  if (items.length <= max) return items.join(', ');
  return `${items.slice(0, max).join(', ')} and ${formatNumber(items.length - max)} more`;
}

/**
 * What a mission reaches on one account, in a few words: the resources it reaches,
 * "the account itself, no resource", or — for an account given whole — that later
 * resources join the ones known now.
 */
export function reachedOnAccount(names: readonly string[], future: boolean, max = 3): string {
  if (future) {
    return names.length === 0
      ? `${MISSION_WORDS.futureResources} (none known yet)`
      : `${listed(names, max)}, and ${MISSION_WORDS.futureResources}`;
  }
  return names.length === 0 ? 'the account itself, no resource' : listed(names, max);
}

/** How long ago, inside a sentence: "just now", "4 min ago", "yesterday", "4 d ago". */
export function agoSentence(from: Date | string, now: Date = new Date()): string {
  const short = ago(from, now);
  if (short === 'now') return 'just now';
  return short === 'yesterday' ? short : `${short} ago`;
}
