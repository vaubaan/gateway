/**
 * State of the mission screen — creation and edit are one screen (spec §4.2) — and
 * its transitions, pure, so the ergonomics that matter are unit-tested without a
 * browser: a card is one account and the resources of ONE environment (ADR
 * resource-set-is-one-environment-with-optional-future-resources), a macro-action
 * at a trust level writes its lines, "Custom" replaces the lines of one macro-action,
 * and the draft sent to the server is always the explicit list. The decision itself
 * is `previewDraft`, shared with the server.
 *
 * What a card shows (its rows, the Custom modal, the groups of "+ Add an account")
 * is read from this state by `../cards/card-model.ts`.
 */
import type { Gate, MissionPolicyEntry, RiskId } from '@vaubaan/shared';

import type {
  DraftAccount,
  DraftPeriod,
  DraftResourceSet,
  IssuanceAccount,
  IssuanceResource,
  MissionDraft,
  PreviewIssue,
  ResolvedDraftAccount,
} from '@/lib/missions/model';
import {
  defaultLineOf,
  expandMacroAction,
  knownTrustLevels,
  macroActionOfRisk,
  type MacroActionTrustLevels,
  type TrustLevel,
} from '@/lib/missions/macro-actions';
import { MS_PER_DAY } from '@vaubaan/shared/time';

/** The inputs of one accepted risk; strings, as typed. An empty string is "no value yet". */
export interface EntryState {
  readonly quota: string;
  readonly rateMax: string;
  readonly rateWindow: string;
  readonly gate: Gate;
}

/**
 * One card of the screen: one account, the resources of one environment it reaches
 * (and, with `future`, those that appear there later), and its policy. A card is a
 * resource set of the protocol (risk model §4.7); the screen never says "set".
 */
export interface CardState {
  /** Tells the cards apart on the screen; the stored set id when there is one. */
  readonly key: string;
  /** The stored set an edit keeps (its counters and requests follow it). */
  readonly id?: string;
  readonly accountId: string;
  /** The resources ticked, in the account's order. */
  readonly resourceIds: readonly string[];
  /** Resources that later appear in `env` join the card. */
  readonly future: boolean;
  /** The environment of its resources: never chosen, it is the group they were ticked in. */
  readonly env: string | null;
  /**
   * The trust level of each ticked macro-action. A macro-action whose lines differ from
   * what its level writes reads "Custom"; its level is then the one Custom started from.
   */
  readonly trustLevels: MacroActionTrustLevels;
  /** Accepted risks, explicit ids. */
  readonly entries: Readonly<Record<RiskId, EntryState>>;
}

export const PERIOD_CHOICES = [
  { id: 'hour', label: 'Every hour', seconds: 3600 },
  { id: 'day', label: 'Every day', seconds: 86_400 },
  { id: 'week', label: 'Every week', seconds: 604_800 },
  { id: 'one-off', label: 'Never: one set of limits for the whole mission', seconds: null },
] as const;
export type PeriodChoice = (typeof PERIOD_CHOICES)[number]['id'];

export const EXPIRY_CHOICES = [
  { id: 'never', label: 'Never', days: null },
  { id: '1d', label: 'In 24 hours', days: 1 },
  { id: '7d', label: 'In 7 days', days: 7 },
  { id: '30d', label: 'In 30 days', days: 30 },
  { id: '90d', label: 'In 90 days', days: 90 },
  { id: 'custom', label: 'On a date…', days: null },
  /** Edit mode only: the end date the mission already has. */
  { id: 'keep', label: 'As it is', days: null },
] as const;
export type ExpiryChoice = (typeof EXPIRY_CHOICES)[number]['id'];

export interface FormState {
  readonly name: string;
  /** The cards of the mission, in the order they were added. */
  readonly cards: readonly CardState[];
  readonly period: PeriodChoice;
  readonly expiry: ExpiryChoice;
  /** `datetime-local` value, used when `expiry` is `custom`. */
  readonly expiryCustom: string;
  /** Edit mode: the mission's end date, sent when `expiry` is `keep`. */
  readonly keptExpiry?: string | null;
  /**
   * Edit mode: cards that were split because their stored set mixed environments
   * (migration 0033), by the key of the first card of each split.
   */
  readonly split?: readonly string[];
}

/** Limits that reset every day are the usual shape of "one key per code project". */
export const DEFAULT_PERIOD: PeriodChoice = 'day';
export const DEFAULT_EXPIRY: ExpiryChoice = 'never';

export function initialFormState(): FormState {
  return {
    name: '',
    cards: [],
    period: DEFAULT_PERIOD,
    expiry: DEFAULT_EXPIRY,
    expiryCustom: '',
  };
}

export function entryOf(
  entry: Pick<MissionPolicyEntry, 'quota' | 'rate_limit' | 'gate'>,
): EntryState {
  return {
    quota: String(entry.quota),
    rateMax: String(entry.rate_limit.max),
    rateWindow: String(entry.rate_limit.window_seconds),
    gate: entry.gate,
  };
}

export function entriesOf(
  lines: readonly Pick<MissionPolicyEntry, 'risk_id' | 'quota' | 'rate_limit' | 'gate'>[],
): Record<RiskId, EntryState> {
  return Object.fromEntries(lines.map((line) => [line.risk_id, entryOf(line)]));
}

const BLANK_ENTRY: EntryState = { quota: '', rateMax: '', rateWindow: '', gate: 'auto' };

export function sameEntry(a: EntryState, b: EntryState): boolean {
  return (
    a.quota === b.quota &&
    a.rateMax === b.rateMax &&
    a.rateWindow === b.rateWindow &&
    a.gate === b.gate
  );
}

/** The resources a card reaches now, in the account's order. */
export function cardResources(
  account: Pick<IssuanceAccount, 'resources'>,
  card: Pick<CardState, 'resourceIds'>,
): IssuanceResource[] {
  const ticked = new Set(card.resourceIds);
  return account.resources.filter((r) => ticked.has(r.id));
}

/** The cards of one account, in screen order. */
export function cardsOf(state: Pick<FormState, 'cards'>, accountId: string): CardState[] {
  return state.cards.filter((card) => card.accountId === accountId);
}

// ─────────────────────────────────────────────────────────────────────────────
// Cards: added, changed, removed
// ─────────────────────────────────────────────────────────────────────────────

/** What step 2 of "+ Add an account" (or "Change") picks for a card. */
export interface CardResources {
  readonly resourceIds: readonly string[];
  readonly future: boolean;
  readonly env: string | null;
}

/** A new card: its resources, nothing ticked yet. */
export function newCard(accountId: string, key: string, resources: CardResources): CardState {
  return {
    key,
    accountId,
    resourceIds: [...resources.resourceIds],
    future: resources.future,
    env: resources.env,
    trustLevels: {},
    entries: {},
  };
}

export function addCard(state: FormState, card: CardState): FormState {
  return { ...state, cards: [...state.cards, card] };
}

export function removeCard(state: FormState, key: string): FormState {
  return { ...state, cards: state.cards.filter((card) => card.key !== key) };
}

export function replaceCard(state: FormState, card: CardState): FormState {
  return { ...state, cards: state.cards.map((c) => (c.key === card.key ? card : c)) };
}

/** The lines of one macro-action of a card, by risk. */
export function actionEntries(
  account: Pick<IssuanceAccount, 'macro_actions' | 'risks'>,
  card: Pick<CardState, 'entries'>,
  actionId: string,
): Record<RiskId, EntryState> {
  return Object.fromEntries(
    Object.entries(card.entries).filter(([riskId]) => {
      const risk = account.risks.find((r) => r.risk_id === riskId);
      return risk !== undefined && macroActionOfRisk(account, risk)?.id === actionId;
    }),
  );
}

/** What a trust level writes for one macro-action on a card's resources. */
export function levelEntries(
  account: IssuanceAccount,
  card: Pick<CardState, 'resourceIds'>,
  actionId: string,
  level: TrustLevel,
): Record<RiskId, EntryState> {
  const action = account.macro_actions.find((a) => a.id === actionId);
  if (!action) return {};
  return entriesOf(expandMacroAction(account, action, level, cardResources(account, card)).lines);
}

/** True when two line maps are the same lines, value for value. */
export function sameEntries(
  a: Readonly<Record<RiskId, EntryState>>,
  b: Readonly<Record<RiskId, EntryState>>,
): boolean {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((riskId) => {
    const left = a[riskId];
    const right = b[riskId];
    return left !== undefined && right !== undefined && sameEntry(left, right);
  });
}

/** True when the lines of a ticked macro-action are what its trust level writes. */
export function atItsLevel(account: IssuanceAccount, card: CardState, actionId: string): boolean {
  const level = card.trustLevels[actionId];
  if (!level) return false;
  return sameEntries(
    actionEntries(account, card, actionId),
    levelEntries(account, card, actionId, level),
  );
}

/** The card with the lines of one macro-action replaced; every other line kept. */
function withActionEntries<C extends CardState>(
  account: IssuanceAccount,
  card: C,
  actionId: string,
  lines: Readonly<Record<RiskId, EntryState>>,
): C {
  const own = new Set(Object.keys(actionEntries(account, card, actionId)));
  const kept = Object.entries(card.entries).filter(([riskId]) => !own.has(riskId));
  return { ...card, entries: { ...Object.fromEntries(kept), ...lines } };
}

/**
 * A macro-action ticked at a trust level, moved to another, or (`null`) unticked: its
 * lines are rewritten at that level (a Custom macro-action goes back to a level), every
 * other line of the card is kept.
 */
export function setActionLevel<C extends CardState>(
  account: IssuanceAccount,
  card: C,
  actionId: string,
  level: TrustLevel | null,
): C {
  const trustLevels: Record<string, TrustLevel> = { ...card.trustLevels };
  if (level === null) delete trustLevels[actionId];
  else trustLevels[actionId] = level;
  const lines = level === null ? {} : levelEntries(account, card, actionId, level);
  return { ...withActionEntries(account, card, actionId, lines), trustLevels };
}

/**
 * "Apply" of the Custom modal: the macro-action's lines are the ones the modal holds
 * (`null` = left out). Its level is the one Custom started from; with no line left the
 * macro-action is unticked.
 */
export function applyCustom<C extends CardState>(
  account: IssuanceAccount,
  card: C,
  actionId: string,
  lines: Readonly<Record<RiskId, EntryState | null>>,
  startFrom: TrustLevel,
): C {
  const kept = Object.fromEntries(
    Object.entries(lines).filter((pair): pair is [RiskId, EntryState] => pair[1] !== null),
  );
  const trustLevels: Record<string, TrustLevel> = { ...card.trustLevels };
  if (Object.keys(kept).length === 0) delete trustLevels[actionId];
  else trustLevels[actionId] = startFrom;
  return { ...withActionEntries(account, card, actionId, kept), trustLevels };
}

/**
 * The card's resources changed ("Change" reopens step 2). A macro-action at its level
 * is written again for the new resources (an env-qualified line comes and goes with
 * them); a Custom one keeps its lines, and the preview flags any that no longer resolves.
 */
export function setCardResources<C extends CardState>(
  account: IssuanceAccount,
  card: C,
  resources: CardResources,
): C {
  const atLevel = Object.keys(card.trustLevels).filter((id) => atItsLevel(account, card, id));
  let next: C = {
    ...card,
    resourceIds: [...resources.resourceIds],
    future: resources.future,
    env: resources.env,
  };
  for (const actionId of atLevel) {
    next = setActionLevel(account, next, actionId, card.trustLevels[actionId] ?? null);
  }
  return next;
}

/** A trust-raise applied to one card: the card after it, and the lines it replaced. */
export interface RaisedCard<C extends CardState> {
  readonly card: C;
  /**
   * The lines of the macro-action edited (or removed) by hand, which the raise
   * rewrites: the screen names them before the edit is saved (risk model §4.7).
   */
  readonly replaced: readonly RiskId[];
}

/**
 * A trust-raise (risk model §4.7): one macro-action moved to `to`, its lines rewritten at
 * that level, every other line of the card kept as it is — hand edits included. The lines
 * of the macro-action that differ from what its old level wrote are `replaced`.
 */
export function raiseMacroAction<C extends CardState>(
  account: IssuanceAccount,
  card: C,
  actionId: string,
  to: TrustLevel,
): RaisedCard<C> {
  if (!account.macro_actions.some((a) => a.id === actionId)) return { card, replaced: [] };
  const from = card.trustLevels[actionId];
  const written = from ? levelEntries(account, card, actionId, from) : {};
  const own = actionEntries(account, card, actionId);
  const changed = Object.entries(own)
    .filter(([riskId, entry]) => {
      const before = written[riskId];
      return !before || !sameEntry(before, entry);
    })
    .map(([riskId]) => riskId);
  const removed = Object.keys(written).filter((riskId) => !(riskId in own));
  return {
    card: setActionLevel(account, card, actionId, to),
    replaced: [...changed, ...removed],
  };
}

/**
 * The budget a risk turned on in the Custom modal starts with: its macro-action's base
 * budget at that macro-action's level (Careful when not ticked), with the gate that
 * level gives it (`defaultLineOf`) — else blank, and a blank budget blocks issuance
 * until the creator types one.
 */
export function defaultEntryFor(
  account: Pick<IssuanceAccount, 'macro_actions'>,
  trustLevels: MacroActionTrustLevels,
  risk: Parameters<typeof defaultLineOf>[2],
): EntryState {
  const line = defaultLineOf(account, trustLevels, risk);
  return line ? entryOf(line) : BLANK_ENTRY;
}

// ─────────────────────────────────────────────────────────────────────────────
// The draft
// ─────────────────────────────────────────────────────────────────────────────

function numberOf(text: string): number | undefined {
  const trimmed = text.trim();
  if (trimmed === '') return undefined;
  const value = Number(trimmed);
  // Not a number: sent as an impossible budget so the preview names the field.
  return Number.isFinite(value) ? value : -1;
}

/** True when the account lists no resource a card could tick: it is then the account itself. */
export function accountWithoutResources(account: Pick<IssuanceAccount, 'resources'>): boolean {
  return account.resources.length === 0;
}

/** One card as a draft writes it: its resources, its trust levels beside its lines, its lines. */
function draftCard(account: IssuanceAccount, card: CardState): DraftResourceSet {
  const bare = card.resourceIds.length === 0;
  return {
    ...(card.id !== undefined ? { id: card.id } : {}),
    // An account that lists no resource is reached as itself: "all" of nothing.
    resources:
      bare && !card.future && accountWithoutResources(account)
        ? { scope: 'all' }
        : { scope: 'selected', resource_ids: card.resourceIds },
    ...(card.future ? { future: true } : {}),
    // The environment is said only when no resource says it.
    ...(bare ? { env: card.env } : {}),
    // The persisted policy is the explicit enumeration: "Everything I hold" is not sent.
    everything_i_hold: false,
    // Kept with the mission to redraw this screen. Sent beside lines only: without
    // any, the server would write the policy from them, and an emptied card must
    // stay empty.
    ...(Object.keys(card.trustLevels).length > 0 && Object.keys(card.entries).length > 0
      ? { trust_levels: card.trustLevels }
      : {}),
    policy: account.risks
      .filter((risk) => card.entries[risk.risk_id] !== undefined)
      .map((risk) => {
        const entry = card.entries[risk.risk_id] ?? BLANK_ENTRY;
        const quota = numberOf(entry.quota);
        const max = numberOf(entry.rateMax);
        const window = numberOf(entry.rateWindow);
        return {
          risk_id: risk.risk_id,
          ...(quota === undefined ? {} : { quota }),
          ...(max === undefined || window === undefined
            ? {}
            : { rate_limit: { max, window_seconds: window } }),
          gate: entry.gate,
        };
      }),
  };
}

/** The accounts of the cards, in the order their first card appears. */
export function accountsOf(
  context: readonly IssuanceAccount[],
  state: Pick<FormState, 'cards'>,
): IssuanceAccount[] {
  const ids = [...new Set(state.cards.map((card) => card.accountId))];
  return ids.flatMap((id) => {
    const found = context.find((c) => c.id === id);
    return found ? [found] : [];
  });
}

export function periodOf(choice: PeriodChoice): DraftPeriod {
  const found = PERIOD_CHOICES.find((p) => p.id === choice);
  if (!found || found.seconds === null) return { kind: 'one-off' };
  return { kind: 'recurring', length_seconds: found.seconds };
}

export function periodChoiceOf(period: DraftPeriod): PeriodChoice {
  if (period.kind === 'one-off') return 'one-off';
  return PERIOD_CHOICES.find((p) => p.seconds === period.length_seconds)?.id ?? DEFAULT_PERIOD;
}

export function expiryOf(
  state: Pick<FormState, 'expiry' | 'expiryCustom' | 'keptExpiry'>,
  now: Date,
): string | null {
  if (state.expiry === 'never') return null;
  if (state.expiry === 'keep') return state.keptExpiry ?? null;
  if (state.expiry === 'custom') {
    const at = new Date(state.expiryCustom);
    // An unusable date is sent as such: the preview answers "not a valid date".
    return Number.isNaN(at.getTime()) ? state.expiryCustom || 'unset' : at.toISOString();
  }
  const days = EXPIRY_CHOICES.find((e) => e.id === state.expiry)?.days ?? 0;
  return new Date(now.getTime() + days * MS_PER_DAY).toISOString();
}

// ─────────────────────────────────────────────────────────────────────────────
// The platform management mission
// ─────────────────────────────────────────────────────────────────────────────

/** The service id of the gateway's own account (the `vaubaan` plugin). */
export const PLATFORM_SERVICE = 'vaubaan';
export const PLATFORM_MISSION_NAME = 'Platform management';
/** The macro-action the gateway adds to every catalog for its fallback: never ticked here. */
const ANYTHING_ELSE = 'anything-else';

/**
 * The prefill offered after connecting the Vaubaan account (ADR
 * platform-management-is-a-plugin-on-the-execution-door): that account alone,
 * every macro-action of its catalog ticked at Careful, the form's default period
 * and end. A draft the person sees in the creation form and may change before
 * creating it; nothing is issued from here.
 */
export function platformMissionDraft(account: IssuanceAccount): MissionDraft {
  const trustLevels = Object.fromEntries(
    account.macro_actions
      .filter((action) => action.id !== ANYTHING_ELSE)
      .map((action) => [action.id, 'careful']),
  );
  return {
    name: PLATFORM_MISSION_NAME,
    period: periodOf(DEFAULT_PERIOD),
    expires_at: null,
    accounts: [{ account_id: account.id, resources: { scope: 'all' }, trust_levels: trustLevels }],
  };
}

/**
 * The draft the screen stands for: one account per account, its cards as
 * `resource_sets` in screen order, explicit entries only.
 */
export function draftOf(
  context: readonly IssuanceAccount[],
  state: FormState,
  now: Date,
): MissionDraft {
  return {
    name: state.name,
    accounts: accountsOf(context, state).map((account): DraftAccount => ({
      account_id: account.id,
      resource_sets: cardsOf(state, account.id).map((card) => draftCard(account, card)),
    })),
    period: periodOf(state.period),
    expires_at: expiryOf(state, now),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Loading a mission, a copy or an agent's proposal
// ─────────────────────────────────────────────────────────────────────────────

/** The environment a risk id is qualified with (`supabase[prod].row-write` → `prod`), or `null`. */
function qualifiedEnvOf(riskId: RiskId): string | null {
  return /^[^.[]+\[([^\]]+)\]\./.exec(riskId)?.[1] ?? null;
}

/**
 * Loads a resolved draft (a mission being edited or duplicated, an agent's proposal
 * after preview) as cards: one per set, its lines with their values, its trust levels.
 * A set whose resources span several environments (a legacy set, migration 0033) is
 * split into one card per environment, each with the lines that apply there; the first
 * keeps the stored set, and the split is recorded in `split` for the screen to say.
 */
export function loadResolved(
  context: readonly IssuanceAccount[],
  state: FormState,
  resolved: readonly ResolvedDraftAccount[],
): FormState {
  const cards: CardState[] = [];
  const split: string[] = [];
  for (const line of resolved) {
    const account = context.find((c) => c.id === line.account_id);
    if (!account) continue;
    line.resource_sets.forEach((set, index) => {
      const base = set.id ?? `${account.id}:loaded-${index}`;
      const trustLevels = knownTrustLevels(account, set.trust_levels);
      const resources = cardResources(account, { resourceIds: set.resources.resource_ids });
      const envs = [...new Set(resources.map((r) => r.env))];
      if (envs.length <= 1) {
        cards.push({
          key: base,
          ...(set.id !== undefined ? { id: set.id } : {}),
          accountId: account.id,
          resourceIds: resources.map((r) => r.id),
          future: set.future,
          env: envs[0] ?? set.env,
          trustLevels,
          entries: entriesOf(set.policy),
        });
        return;
      }
      split.push(base);
      envs.forEach((env, i) => {
        cards.push({
          key: i === 0 ? base : `${base}:${env ?? 'none'}`,
          ...(i === 0 && set.id !== undefined ? { id: set.id } : {}),
          accountId: account.id,
          resourceIds: resources.filter((r) => r.env === env).map((r) => r.id),
          future: set.future,
          env,
          trustLevels,
          entries: entriesOf(
            set.policy.filter((p) => {
              const qualified = qualifiedEnvOf(p.risk_id);
              return qualified === null || qualified === env;
            }),
          ),
        });
      });
    });
  }
  return { ...state, cards, ...(split.length > 0 ? { split } : {}) };
}

// ─────────────────────────────────────────────────────────────────────────────
// What stands in the way, in the words of the interface
// ─────────────────────────────────────────────────────────────────────────────

/** Longest list of ids quoted in a sentence. */
const IDS_QUOTED = 4;

function quotedIds(ids: readonly string[] | undefined): string {
  const list = ids ?? [];
  const shown = list.slice(0, IDS_QUOTED).join(', ');
  const more = list.length - IDS_QUOTED;
  return more > 0 ? `${shown} and ${more} more` : shown;
}

/** Outside what the reader may allow on an account. */
export const OUTSIDE_AUTHORITY = 'outside what you may allow';

/**
 * One reason the draft cannot be created, said with the words a person reads.
 * The code and the fields are the protocol's (`PreviewIssue`, also answered
 * to an agent on the management door, in its own words): this is the same
 * fact for the page. An issue this function has no sentence for — a later
 * code, a missing field — is printed as the server worded it.
 */
export function issueSentence(
  issue: PreviewIssue,
  context: readonly Pick<IssuanceAccount, 'id' | 'service_label' | 'display_name'>[],
): string {
  const found = context.find((c) => c.id === issue.account_id);
  const account = found ? `${found.service_label} · ${found.display_name}` : null;
  const ids = quotedIds(issue.risk_ids);
  const refs = quotedIds(issue.resource_refs);
  const several = (issue.risk_ids?.length ?? 0) !== 1;
  switch (issue.code) {
    case 'name-missing':
      return 'Give the mission a name.';
    case 'no-account':
      return 'Add at least one account.';
    case 'invalid-period':
      return 'Choose how often the limits reset.';
    case 'invalid-expiry':
      return 'The end date must be a valid date in the future.';
    default:
      break;
  }
  if (!account) return issue.message;
  switch (issue.code) {
    case 'account-unavailable':
      return `${account} cannot be used now: it needs reconnecting, or it was disconnected.`;
    case 'duplicate-account':
      return `${account} is listed twice.`;
    case 'no-resource-selected':
      return `${account}: tick at least one resource, or future ones.`;
    case 'no-accepted-risk':
      return `${account} allows nothing yet: tick a macro-action, or remove the card.`;
    case 'resource-stale':
      return refs
        ? `${account}: ${refs} can no longer be found there. Leave it out.`
        : issue.message;
    case 'resource-self':
      return refs
        ? `${account}: ${refs} is this instance's own hosting. A mission can never reach it.`
        : issue.message;
    case 'resource-sets-overlap':
      return `${account}: a resource, or the future resources of one environment, is in two cards.`;
    case 'resource-set-mixed-env':
      return `${account}: a card holds the resources of one environment. Split it.`;
    case 'resource-unlabelled':
      return refs
        ? `${account}: ${refs} has no environment label. Label it on the page of the account, or leave it out.`
        : `${account}: future resources need an environment. Pick one with “Change”.`;
    case 'exceeds-authority':
      return ids
        ? `${account}: ${ids} ${several ? 'are' : 'is'} ${OUTSIDE_AUTHORITY} on this account.`
        : issue.message;
    case 'unresolvable-env':
      return ids
        ? `${account}: no resource of the card carries the environment of ${ids}.`
        : issue.message;
    case 'missing-budget':
      return ids ? `${account}: give a limit to ${ids}.` : issue.message;
    case 'invalid-budget':
      return ids ? `${account}: a limit is a whole number above zero (${ids}).` : issue.message;
    default:
      return issue.message;
  }
}
