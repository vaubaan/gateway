/**
 * A change of the record, in the words of the pages: what a person reads
 * before the raw record. Pure.
 *
 * A change is stored as two JSON values, `before` and `after`, in the names of
 * the protocol (`connection_id`, `resource_ids`, `risk_id`, `quota`, `gate`…).
 * That is the record and it stays available as it is ("Raw record"). A person
 * first reads lines: the account by its name, the resources by theirs, each
 * permission with its limits and whether it asks first.
 *
 * Nothing here is specific to one act: the lines are read from the keys the
 * record holds, so a new act with known keys reads well at once, and an
 * unknown key is printed under its own name rather than dropped. A value that
 * did not change between `before` and `after` is left out; one that did says
 * what it was.
 */
import { formatDay } from '@/lib/dates';
import {
  formatNumber,
  GATE_WORDS,
  gateWordOf,
  limitsResetEvery,
  listed,
  MISSION_WORDS,
  perPeriod,
} from '@/lib/vocabulary';

/** The names behind the ids of a record (`AuditQueryService.changeNames`), and of its permissions. */
export interface ChangeNames {
  /** Keyed by id: an account, a resource, a person, a team. */
  readonly ids: Readonly<Record<string, string>>;
  /** The catalog label of a permission; `null` when the catalog no longer has it. */
  readonly permission: (riskId: string) => string | null;
}

export interface ChangeLine {
  readonly label: string;
  readonly value: string;
  /** What it was before, when the record says so and it differs. */
  readonly was?: string;
  /** An id a person may need to quote (a permission's): printed in mono after the value. */
  readonly id?: string;
}

type Json = unknown;
type JsonObject = Readonly<Record<string, Json>>;

function isObject(value: Json): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function same(a: Json, b: Json): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** `resource_ids` → "Resource ids": a key nothing below knows, under its own name. */
function wordsOfKey(key: string): string {
  const words = key.replaceAll('_', ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

const KEY_LABELS: Readonly<Record<string, string>> = {
  name: 'Name',
  display_name: 'Name',
  provider: 'Service',
  status: 'State',
  owner: 'Owner',
  target: 'Given to',
  restriction: 'May allow',
  expires_at: 'Ends',
  period: 'Limits',
  token_prefix: 'Key',
  token_kind: 'Kind of key',
  holder: 'Key of',
  member_email: 'Teammate',
  email: 'Person',
  client_name: 'App',
  client_id: 'App id',
  scope: 'May',
  redirect_uri: 'Returns to',
  resource: 'For',
  ref: 'Resource',
  resource_id: 'Resource',
  connection_id: 'Account',
  env: 'Environment',
  hidden: 'Hidden from missions',
  tokens_revoked: 'Keys revoked',
  source: 'Comes from',
  quota: 'Limit',
  gate: 'Asks first',
  amount: 'Calls given back',
  resolution: 'Answer',
};

/** A key whose value another key of the same record already says by name. */
const SAID_BY: Readonly<Record<string, string>> = {
  member_user_id: 'member_email',
  user_id: 'email',
  resource_id: 'ref',
};

/**
 * A stored status in the words of the pages, by the kind of object that holds
 * it: a mission runs and is stopped, an account is connected and disconnected.
 * For any other object the stored word is printed as it is.
 */
const STATE_WORDS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  mission: { active: 'running', revoked: 'stopped', expired: 'ended', orphaned: 'cannot run' },
  connection: {
    active: 'connected',
    revoked: 'disconnected',
    expired: 'needs reconnecting',
    unowned: 'without owner',
  },
};

const KEY_KIND_WORDS: Readonly<Record<string, string>> = {
  member: 'a person’s',
  named: 'machine key',
};

function nameOf(names: ChangeNames, id: Json): string {
  return typeof id === 'string' ? (names.ids[id] ?? id) : String(id);
}

function scalar(value: Json): string {
  if (value === null || value === undefined) return 'none';
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (typeof value === 'number') return formatNumber(value);
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

function periodWords(value: Json): string {
  if (!isObject(value)) return scalar(value);
  const length = typeof value.length_seconds === 'number' ? value.length_seconds : null;
  // Under the label "Limits": "reset every day", "do not reset".
  const words = value.kind === 'recurring' ? limitsResetEvery(length) : limitsResetEvery(null);
  return words.replace(/^limits /, '');
}

/** One value in words, by the key it is stored under. */
function valueWords(key: string, value: Json, names: ChangeNames, objectType: string): string {
  if (value === null || value === undefined) {
    if (key === 'expires_at') return 'never';
    return 'none';
  }
  switch (key) {
    case 'connection_id':
    case 'resource_id':
      return nameOf(names, value);
    case 'owner':
    case 'target':
      return isObject(value) ? nameOf(names, value.id) : scalar(value);
    case 'restriction':
      return Array.isArray(value)
        ? `${formatNumber(value.length)} of its permissions: ${listed(
            value.map((riskId) => names.permission(String(riskId)) ?? String(riskId)),
            3,
          )}`
        : scalar(value);
    case 'expires_at':
      return typeof value === 'string' ? formatDay(value) || value : scalar(value);
    case 'period':
      return periodWords(value);
    case 'status':
      return typeof value === 'string'
        ? (STATE_WORDS[objectType]?.[value] ?? value)
        : scalar(value);
    case 'token_prefix':
      return `vbn_live_${scalar(value)}_…`;
    case 'token_kind':
      return typeof value === 'string' ? (KEY_KIND_WORDS[value] ?? value) : scalar(value);
    case 'gate':
      return value === 'approval' ? 'yes' : 'no';
    default:
      return scalar(value);
  }
}

/** "Acme product repositories · acme-org/app, acme-org/web" per account of a mission. */
function accountLines(value: Json, names: ChangeNames): ChangeLine[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isObject).map((entry) => {
    const resources = Array.isArray(entry.resource_ids)
      ? entry.resource_ids.map((id) => nameOf(names, id))
      : [];
    return {
      label: 'Account',
      value: [
        nameOf(names, entry.connection_id),
        // Entries before migration 0033 record `resource_scope` (`connection`: the whole
        // account); later ones an explicit list with `future`.
        entry.resource_scope === 'connection'
          ? MISSION_WORDS.wholeAccount
          : resources.length > 0
            ? `${listed(resources, 4)}${entry.future === true ? `, and ${MISSION_WORDS.futureResources}` : ''}`
            : entry.future === true
              ? MISSION_WORDS.futureResources
              : 'no resource',
      ].join(' · '),
    };
  });
}

/** "Read code · 200 a day · 60 a minute · runs freely", one line per permission. */
function permissionLines(value: Json, period: Json, names: ChangeNames): ChangeLine[] {
  if (!Array.isArray(value)) return [];
  const recurring = isObject(period) && period.kind === 'recurring';
  const length = isObject(period) && typeof period.length_seconds === 'number' ? period : null;
  const everyDay = recurring && length?.length_seconds === 86_400;
  return value.filter(isObject).map((entry) => {
    const riskId = String(entry.risk_id);
    const quota = typeof entry.quota === 'number' ? entry.quota : null;
    const rate = isObject(entry.rate_limit) ? entry.rate_limit : null;
    const parts = [
      quota === null
        ? null
        : everyDay
          ? perPeriod(quota, 'day')
          : `${formatNumber(quota)} ${recurring ? 'per period' : 'in all'}`,
      rate && typeof rate.max === 'number' && rate.window_seconds === 60
        ? perPeriod(rate.max, 'minute')
        : null,
      entry.gate === 'approval' || entry.gate === 'auto'
        ? GATE_WORDS[gateWordOf(entry.gate)]
        : null,
    ].filter((part): part is string => part !== null);
    return {
      label: 'Permission',
      value: [names.permission(riskId) ?? riskId, ...parts].join(' · '),
      id: riskId,
    };
  });
}

/**
 * The lines of one change. `before` and `after` are what the record holds;
 * either may be `null` (a creation, a removal) or not an object at all (then
 * there is nothing to say in lines and the raw record is the whole detail).
 * `objectType` is the kind of object the change is about (`mission`,
 * `connection`…): a stored status reads in that object's words.
 */
export function changeLines(
  before: Json,
  after: Json,
  names: ChangeNames,
  objectType = '',
): ChangeLine[] {
  const now = isObject(after) ? after : null;
  const was = isObject(before) ? before : null;
  const subject = now ?? was;
  if (!subject) return [];

  const lines: ChangeLine[] = [];
  for (const [key, value] of Object.entries(subject)) {
    const saidBy = SAID_BY[key];
    if (saidBy !== undefined && subject[saidBy] !== undefined) continue;
    // Said by another line: the period is part of each permission's limit and of "Limits".
    if (key === 'connections') {
      lines.push(...accountLines(value, names));
      continue;
    }
    if (key === 'policy') {
      lines.push(...permissionLines(value, subject.period, names));
      continue;
    }
    const previous = now && was ? was[key] : undefined;
    // A change says what changed: a value both sides hold alike is not news.
    if (now && was && key in was && same(previous, value)) continue;
    if (value === null && !(now && was && key in was) && key !== 'expires_at') continue;
    lines.push({
      label: KEY_LABELS[key] ?? wordsOfKey(key),
      value: valueWords(key, value, names, objectType),
      ...(now && was && key in was ? { was: valueWords(key, previous, names, objectType) } : {}),
    });
  }
  return lines;
}
