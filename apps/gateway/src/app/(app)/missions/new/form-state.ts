/**
 * State of the one-page mission creation form, and its transitions — pure, so
 * the ergonomics that matter (a macro-action at a trust level fills its lines,
 * "select all" yields an enumerated list, a hand-ticked risk gets a sensible
 * default budget, the draft sent to the server is always explicit) are
 * unit-tested without a browser. The decision itself is `previewDraft`,
 * shared with the server.
 */
import type { Gate, MissionPolicyEntry, RateLimit, RiskId } from '@vaubaan/shared';

import { isResolvable } from '@/lib/missions/catalog-view';
import type {
  CatalogRisk,
  DraftConnection,
  DraftPeriod,
  DraftResourceSet,
  DraftResources,
  IssuanceConnection,
  IssuanceResource,
  MissionDraft,
  PreviewIssue,
  ResolvedDraftConnection,
} from '@/lib/missions/model';
import { expansionDigest } from '@/lib/missions/everything-i-hold';
import {
  DEFAULT_TRUST_LEVEL,
  defaultLineOf,
  expandMacroAction,
  highestTier,
  knownTrustLevels,
  linesOfTrustLevels,
  macroActionOfRisk,
  rowsOf,
  type MacroActionTrustLevels,
  type Tier,
  type TrustLevel,
} from '@/lib/missions/macro-actions';
import { enterableResources, previewConnection } from '@/lib/missions/preview';
import { MS_PER_DAY } from '@vaubaan/shared/time';

/** The inputs of one accepted risk; strings, as typed. An empty string is "no value yet". */
export interface EntryState {
  readonly quota: string;
  readonly rateMax: string;
  readonly rateWindow: string;
  readonly gate: Gate;
}

/**
 * How the policy of one connection is shown (risk model §4.6): `simple` — the
 * macro-actions of the service, each ticked at a trust level; `advanced` —
 * every permission with its own limit and gate. The persisted policy is the
 * explicit list either way: the view is a property of the screen, and the
 * trust levels are kept with the mission only to redraw it.
 */
export type PolicyView = 'simple' | 'advanced';

/**
 * How far a mission reaches on one account (spec §3.1 "Resource selection"; ADR
 * resource-set-is-one-environment-with-optional-future-resources). Every choice is sent
 * as the explicit list ticked, which the server splits by environment:
 *
 *   all         every resource known now that may enter (the default)
 *   connection  the same list with `future` on: resources found later in each
 *               environment join it
 *   selected    the ones the creator ticks
 */
export type ResourceChoice = 'all' | 'connection' | 'selected';

/** The three choices of an account's resources: a short label and hint, and the one-line explanation. */
export const RESOURCE_CHOICES: readonly {
  readonly id: ResourceChoice;
  readonly label: string;
  readonly hint: string;
  readonly explanation: string;
}[] = [
  {
    id: 'all',
    label: 'Every resource known now',
    hint: 'found later: not reached',
    explanation:
      'The resources listed today, and the ones this mission creates. One found later is not reached until the creator adds it to this mission with “Edit mission”.',
  },
  {
    id: 'connection',
    label: 'The whole account',
    hint: 'including resources found later',
    explanation:
      'Every resource of the account, today and found later, except the hidden ones. For work that creates resources or runs the whole account.',
  },
  {
    id: 'selected',
    label: 'Only the ones I pick',
    hint: 'nothing else is reached',
    explanation: 'Tick the resources the task needs; nothing else is reached.',
  },
];

/**
 * One resource set of an account in the form (risk model §4.7): its resources and
 * its policy. An account has one set until the person adds another; with one set
 * the screen shows no set at all.
 */
export interface SetState {
  /** The stored set an edit keeps; absent for a set of a creation, or one the edit adds. */
  readonly id?: string;
  /**
   * How far the set reaches on this account; `all` by default. With several sets,
   * `all` and `connection` take what no other set picks.
   */
  readonly resourceScope: ResourceChoice;
  /**
   * Selected resource ids; by default every resource that is neither hidden nor
   * stale. For `all` and `connection`, that default set: what is reached now.
   */
  readonly resourceIds: readonly string[];
  /** The ticked macro-actions, each with its trust level. */
  readonly trustLevels: MacroActionTrustLevels;
  /** True when the policy was filled from "Everything I hold on this account". */
  readonly everything: boolean;
  /** Accepted risks, explicit ids. */
  readonly entries: Readonly<Record<RiskId, EntryState>>;
  /** True once the lines differ from what the trust levels (or "Everything I hold") wrote. */
  readonly edited: boolean;
}

/** One account of the form: included or not, its view, and its resource sets. */
export interface ConnectionState {
  readonly included: boolean;
  /** Simple or Advanced, for every set of the account. */
  readonly view: PolicyView;
  /** Never empty; the first set is the account's own until another is added. */
  readonly sets: readonly SetState[];
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
  readonly connections: Readonly<Record<string, ConnectionState>>;
  readonly period: PeriodChoice;
  readonly expiry: ExpiryChoice;
  /** `datetime-local` value, used when `expiry` is `custom`. */
  readonly expiryCustom: string;
  /** Edit mode: the mission's end date, sent when `expiry` is `keep`. */
  readonly keptExpiry?: string | null;
}

/** Limits that reset every day are the usual shape of "one key per code project". */
export const DEFAULT_PERIOD: PeriodChoice = 'day';
export const DEFAULT_EXPIRY: ExpiryChoice = 'never';

/** A set as a new account starts with: every resource known now, nothing ticked. */
export function initialSetState(connection: IssuanceConnection): SetState {
  return {
    resourceScope: 'all',
    resourceIds: enterableResources(connection).map((r) => r.id),
    trustLevels: {},
    everything: false,
    entries: {},
    edited: false,
  };
}

export function initialConnectionState(connection: IssuanceConnection): ConnectionState {
  return { included: false, view: 'simple', sets: [initialSetState(connection)] };
}

export function initialFormState(context: readonly IssuanceConnection[]): FormState {
  return {
    name: '',
    connections: Object.fromEntries(context.map((c) => [c.id, initialConnectionState(c)])),
    period: DEFAULT_PERIOD,
    expiry: DEFAULT_EXPIRY,
    expiryCustom: '',
  };
}

function entryOf(entry: Pick<MissionPolicyEntry, 'quota' | 'rate_limit' | 'gate'>): EntryState {
  return {
    quota: String(entry.quota),
    rateMax: String(entry.rate_limit.max),
    rateWindow: String(entry.rate_limit.window_seconds),
    gate: entry.gate,
  };
}

const BLANK_ENTRY: EntryState = { quota: '', rateMax: '', rateWindow: '', gate: 'auto' };

export function selectedResources(
  connection: IssuanceConnection,
  state: Pick<SetState, 'resourceIds'>,
): IssuanceResource[] {
  const selected = new Set(state.resourceIds);
  return connection.resources.filter((r) => selected.has(r.id));
}

/**
 * The resources of a draft line: the explicit list the creator sees ticked ("every
 * resource known now" included, so the confirmation lists exactly what is stored).
 * "The whole account" is that list with `future` on (`futureOf`).
 */
export function draftResourcesOf(state: Pick<SetState, 'resourceIds'>): DraftResources {
  return { scope: 'selected', resource_ids: state.resourceIds };
}

/** `future` of a draft line: on for "the whole account", resources found later included. */
function futureOf(state: Partial<Pick<SetState, 'resourceScope'>>): { future?: true } {
  return state.resourceScope === 'connection' ? { future: true } : {};
}

/** The connection as a draft line that carries only "Everything I hold": what applying it means. */
function everythingDraft(
  connection: IssuanceConnection,
  state: Pick<SetState, 'resourceIds'> & Partial<Pick<SetState, 'resourceScope'>>,
): DraftConnection {
  return {
    connection_id: connection.id,
    everything_i_hold: true,
    resources: draftResourcesOf({ resourceIds: state.resourceIds }),
    ...futureOf(state),
  };
}

function entriesOf(
  lines: readonly Pick<MissionPolicyEntry, 'risk_id' | 'quota' | 'rate_limit' | 'gate'>[],
) {
  return Object.fromEntries(lines.map((line) => [line.risk_id, entryOf(line)]));
}

/**
 * "Everything I hold on this account": its explicit lines, in place of the
 * macro-actions, bounded by the authority and the selection.
 */
export function applyEverything<S extends SetState>(connection: IssuanceConnection, state: S): S {
  const { preview } = previewConnection(connection, everythingDraft(connection, state));
  return {
    ...state,
    trustLevels: {},
    everything: true,
    edited: false,
    entries: entriesOf(preview.passes),
  };
}

/** Fills the policy from the trust levels: the lines `linesOfTrustLevels` writes, nothing else. */
export function applyTrustLevels<S extends SetState>(connection: IssuanceConnection, state: S): S {
  const lines = linesOfTrustLevels(
    connection,
    state.trustLevels,
    selectedResources(connection, state),
  );
  return { ...state, everything: false, edited: false, entries: entriesOf(lines) };
}

/**
 * Ticks a macro-action at a trust level, moves it to another trust level, or (`null`) unticks
 * it; the policy is rewritten from the trust levels. The screen asks first when this
 * would throw edits away (`discardsEdits`).
 */
export function setMacroAction<S extends SetState>(
  connection: IssuanceConnection,
  state: S,
  actionId: string,
  trustLevel: TrustLevel | null,
): S {
  const trustLevels: Record<string, TrustLevel> = { ...state.trustLevels };
  if (trustLevel === null) delete trustLevels[actionId];
  else trustLevels[actionId] = trustLevel;
  return applyTrustLevels(connection, { ...state, trustLevels });
}

/** A trust-raise applied to one set: the set after it, and the lines it replaced. */
export interface RaisedSet<S extends SetState> {
  readonly state: S;
  /**
   * The lines of the macro-action edited (or removed) by hand, which the raise
   * rewrites: the form names them before the edit is saved (risk model §4.7).
   */
  readonly replaced: readonly RiskId[];
}

function sameEntry(a: EntryState, b: EntryState): boolean {
  return (
    a.quota === b.quota &&
    a.rateMax === b.rateMax &&
    a.rateWindow === b.rateWindow &&
    a.gate === b.gate
  );
}

/**
 * A trust-raise (risk model §4.7): one macro-action moved to `to`, its lines rewritten at
 * that level, every other line of the set kept as it is — hand edits included. The lines
 * of the macro-action that differ from what its old level wrote are `replaced`.
 */
export function raiseMacroAction<S extends SetState>(
  connection: IssuanceConnection,
  state: S,
  actionId: string,
  to: TrustLevel,
): RaisedSet<S> {
  const action = connection.macro_actions.find((a) => a.id === actionId);
  if (!action) return { state, replaced: [] };
  const resources = selectedResources(connection, state);
  const from = state.trustLevels[actionId];
  const written = from
    ? entriesOf(expandMacroAction(connection, action, from, resources).lines)
    : {};
  const ofAction = (riskId: RiskId): boolean => {
    const risk = connection.risks.find((r) => r.risk_id === riskId);
    return risk !== undefined && macroActionOfRisk(connection, risk)?.id === actionId;
  };
  const kept = Object.entries(state.entries).filter(([riskId]) => !ofAction(riskId));
  const changed = Object.entries(state.entries)
    .filter(([riskId, entry]) => {
      if (!ofAction(riskId)) return false;
      const before = written[riskId];
      return !before || !sameEntry(before, entry);
    })
    .map(([riskId]) => riskId);
  const removed = Object.keys(written).filter((riskId) => !(riskId in state.entries));
  const raised = entriesOf(expandMacroAction(connection, action, to, resources).lines);
  return {
    state: {
      ...state,
      everything: false,
      trustLevels: { ...state.trustLevels, [actionId]: to },
      entries: { ...Object.fromEntries(kept), ...raised },
    },
    replaced: [...changed, ...removed],
  };
}

/** The policy as the trust levels (or "Everything I hold") wrote it: what "Reset" goes back to. */
export function resetEdits<S extends SetState>(connection: IssuanceConnection, state: S): S {
  return state.everything
    ? applyEverything(connection, state)
    : applyTrustLevels(connection, state);
}

/**
 * True when rewriting the policy from the trust levels would throw away something the
 * creator changed line by line: the screen asks before it does.
 */
export function discardsEdits(state: SetState): boolean {
  return state.edited && Object.keys(state.entries).length > 0;
}

export function setView<S extends { readonly view: PolicyView }>(state: S, view: PolicyView): S {
  return { ...state, view };
}

// ─────────────────────────────────────────────────────────────────────────────
// The simple view: macro-actions at a trust level
// ─────────────────────────────────────────────────────────────────────────────

/** One macro-action as its row says it: ticked or not, at which trust level, and what that yields here. */
export interface MacroActionRow {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  /** The trust level it is ticked at, or `null` when not ticked. */
  readonly trustLevel: TrustLevel | null;
  /** The trust level its counts are read at: its own, or Careful when not ticked. */
  readonly shownTrustLevel: TrustLevel;
  /** Permissions the macro-action has in this catalog. */
  readonly total: number;
  readonly free: number;
  readonly asks: number;
  /** Left out by the trust level (tier 4 at Careful). */
  readonly leftOut: number;
  /** Outside what the reader may allow, or no selected resource carries the environment. */
  readonly unavailable: number;
  /** Nothing of it can be given here: its row cannot be ticked. */
  readonly empty: boolean;
}

export function macroActionRows(connection: IssuanceConnection, state: SetState): MacroActionRow[] {
  const resources = selectedResources(connection, state);
  return connection.macro_actions.map((action) => {
    const trustLevel = state.trustLevels[action.id] ?? null;
    const shownTrustLevel = trustLevel ?? DEFAULT_TRUST_LEVEL;
    const expansion = expandMacroAction(connection, action, shownTrustLevel, resources);
    const free = expansion.lines.filter((line) => line.gate === 'auto').length;
    const asks = expansion.lines.length - free;
    return {
      id: action.id,
      label: action.label,
      description: action.description,
      trustLevel,
      shownTrustLevel,
      total: rowsOf(connection, action).length,
      free,
      asks,
      leftOut: expansion.left_out.length,
      unavailable: expansion.unavailable.length,
      // Nothing it holds is reachable here, at any trust level.
      empty:
        expandMacroAction(connection, action, 'autonomous', resources).lines.length === 0 &&
        trustLevel === null,
    };
  });
}

/** The highest tier among the chosen lines, or `null` when nothing is chosen. */
export function chosenTier(connection: IssuanceConnection, state: SetState): Tier | null {
  return highestTier(connection.risks.filter((risk) => state.entries[risk.risk_id]));
}

/** One risk "Everything I hold" yields on this connection, with the values the mission would get. */
export interface ExplainedLine {
  readonly risk: CatalogRisk;
  readonly quota: number;
  readonly rate_limit: RateLimit;
  readonly gate: Gate;
}

/**
 * What "Everything I hold" means on this connection, with this selection and
 * this authority — the content of the card the creator reads before issuing.
 */
export interface EverythingExplanation {
  /** Passes without asking. */
  readonly auto: readonly ExplainedLine[];
  /** Each action waits for the creator's approval. */
  readonly approval: readonly ExplainedLine[];
}

/** Why a permission the catalog lists cannot be given here: the reader's own ceiling on the account. */
export const OUTSIDE_AUTHORITY = 'outside what you may allow';

/**
 * Expands "Everything I hold" against the selected resources and the
 * creator's authority — the same computation as `applyEverything`, read
 * instead of applied, so the card and the policy cannot disagree.
 */
export function explainEverything(
  connection: IssuanceConnection,
  state: Pick<SetState, 'resourceIds'> & Partial<Pick<SetState, 'resourceScope'>>,
): EverythingExplanation {
  const { preview } = previewConnection(connection, everythingDraft(connection, state));
  const byId = new Map(preview.passes.map((entry) => [entry.risk_id, entry]));
  const lines = connection.risks.flatMap((risk): ExplainedLine[] => {
    const entry = byId.get(risk.risk_id);
    return entry
      ? [{ risk, quota: entry.quota, rate_limit: entry.rate_limit, gate: entry.gate }]
      : [];
  });
  return {
    auto: lines.filter((line) => line.gate === 'auto'),
    approval: lines.filter((line) => line.gate === 'approval'),
  };
}

/**
 * What "Everything I hold on this account" writes out here, in the interface's
 * words (ADR preset-everything-i-hold-expands-explicitly): how many permissions,
 * the most severe, the critical ones that run freely, and the uncategorized
 * writes by name.
 */
export function describeEverything(
  connection: Pick<IssuanceConnection, 'risks'>,
  explanation: EverythingExplanation,
): readonly string[] {
  const lines = [...explanation.auto, ...explanation.approval].map((line) => ({
    risk_id: line.risk.risk_id,
    gate: line.gate,
  }));
  const digest = expansionDigest(lines, connection.risks);
  const sentences = [
    `Written out as ${digest.count} ${digest.count === 1 ? 'permission' : 'permissions'}, one by one: every permission you may allow here that the selected resources can reach. Each runs freely, at the service’s rate ceiling, with a generous daily limit.`,
  ];
  if (digest.most_severe) {
    sentences.push(`Most severe: ${digest.most_severe.label} (${digest.most_severe.level}).`);
  }
  sentences.push(
    digest.critical_auto.length > 0
      ? `Critical, and running freely: ${digest.critical_auto.map((r) => r.label).join(', ')}.`
      : 'None of them is critical.',
  );
  for (const risk of digest.fallback) {
    sentences.push(
      `Includes “${risk.label}”: writes that no other permission of this service names, which nobody reviewed.`,
    );
  }
  return sentences;
}

/** The policy of a connection as it stands in the form, counted. */
export interface PolicyCounts {
  /** Chosen, and runs without asking. */
  readonly free: number;
  /** Chosen, and asks the creator first. */
  readonly asks: number;
  /** Could be chosen here, and is not. */
  readonly notIncluded: number;
}

export function policyCounts(connection: IssuanceConnection, state: SetState): PolicyCounts {
  const rows = editorRows(connection, state);
  let free = 0;
  let asks = 0;
  let notIncluded = 0;
  for (const row of rows) {
    const entry = state.entries[row.risk.risk_id];
    if (entry) {
      if (entry.gate === 'approval') asks += 1;
      else free += 1;
    } else if (row.unavailable === null && !row.risk.deprecated && !row.risk.fallback) {
      notIncluded += 1;
    }
  }
  return { free, asks, notIncluded };
}

// ─────────────────────────────────────────────────────────────────────────────
// The advanced view: every risk, searchable
// ─────────────────────────────────────────────────────────────────────────────

/** Which rows the editor shows. */
export const RISK_FILTERS = [
  { id: 'available', label: 'Available to you' },
  { id: 'accepted', label: 'Chosen' },
  { id: 'unavailable', label: 'Not available' },
  { id: 'all', label: 'All' },
] as const;
export type RiskFilter = (typeof RISK_FILTERS)[number]['id'];

/** One explicit id as the editor shows it. */
export interface EditorRow {
  readonly risk: CatalogRisk;
  readonly accepted: boolean;
  /** Why the row cannot be ticked, or `null`. A ticked row with a reason is refused at issuance. */
  readonly unavailable: string | null;
}

/** Every explicit id of the catalog, catalog order: nothing is hidden, what cannot be ticked says why. */
export function editorRows(connection: IssuanceConnection, state: SetState): EditorRow[] {
  const held = new Set(connection.authority);
  const resources = selectedResources(connection, state);
  return connection.risks.map((risk) => ({
    risk,
    accepted: state.entries[risk.risk_id] !== undefined,
    unavailable: unavailableReason(connection, risk, resources, held),
  }));
}

function matchesQuery(risk: CatalogRisk, query: string): boolean {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return true;
  const text = [risk.label, risk.risk_id, risk.reason, risk.env ?? '', risk.kind, risk.level]
    .join(' ')
    .toLowerCase();
  return terms.every((term) => text.includes(term));
}

/**
 * The rows left by the search box and the filter. Every word typed must
 * appear in the label, the id, the reason, the environment, the kind or the
 * severity level.
 */
export function filterRows(
  rows: readonly EditorRow[],
  query: string,
  filter: RiskFilter,
): EditorRow[] {
  return rows.filter((row) => {
    if (filter === 'accepted' && !row.accepted) return false;
    // What the reader can act on: what they may tick, and what is ticked (to untick it).
    if (filter === 'available' && row.unavailable !== null && !row.accepted) return false;
    if (filter === 'unavailable' && row.unavailable === null) return false;
    return matchesQuery(row.risk, query);
  });
}

/** A catalog long enough that the editor offers its search box (Supabase: 25 entries). */
export const SEARCH_THRESHOLD = 8;

/** Includes or leaves out a connection; including it never ticks a risk by itself. */
export function setIncluded<S extends { readonly included: boolean }>(
  state: S,
  included: boolean,
): S {
  return { ...state, included };
}

/**
 * Changes the resource selection. While the policy is what the trust levels (or
 * "Everything I hold") wrote, it follows the selection (env-qualified entries come and go with the
 * labelled resources); once edited, the creator's entries are kept and the
 * preview flags the ones that no longer resolve.
 */
export function setResources<S extends SetState>(
  connection: IssuanceConnection,
  state: S,
  resourceIds: readonly string[],
): S {
  // Ticking a box is picking: the list is what the mission reaches, no more.
  const next: S = { ...state, resourceScope: 'selected', resourceIds };
  return state.edited ? next : resetEdits(connection, next);
}

/**
 * Changes how far the mission reaches on the account. `all` and `connection`
 * reach the default set now (neither hidden nor stale); `selected` starts from
 * the current ticks. The policy follows as with `setResources`.
 */
export function setResourceScope<S extends SetState>(
  connection: IssuanceConnection,
  state: S,
  resourceScope: ResourceChoice,
): S {
  const resourceIds =
    resourceScope === 'selected'
      ? state.resourceIds
      : enterableResources(connection).map((r) => r.id);
  const next: S = { ...state, resourceScope, resourceIds };
  return state.edited ? next : resetEdits(connection, next);
}

/**
 * The budget a hand-ticked risk starts with: its macro-action's base budget at
 * the trust level that macro-action has (Careful when not ticked), with the gate that
 * trust level gives it (`defaultLineOf`) — else blank, and a blank budget blocks
 * issuance until the creator types one.
 */
export function defaultEntryFor(
  connection: IssuanceConnection,
  trustLevels: MacroActionTrustLevels,
  risk: CatalogRisk,
): EntryState {
  const line = defaultLineOf(connection, trustLevels, risk);
  return line ? entryOf(line) : BLANK_ENTRY;
}

export function toggleRisk<S extends SetState>(
  connection: IssuanceConnection,
  state: S,
  risk: CatalogRisk,
): S {
  const entries = { ...state.entries };
  if (entries[risk.risk_id]) delete entries[risk.risk_id];
  else {
    entries[risk.risk_id] = defaultEntryFor(connection, state.trustLevels, risk);
  }
  return { ...state, entries, edited: true };
}

export function updateEntry<S extends SetState>(
  state: S,
  riskId: RiskId,
  patch: Partial<EntryState>,
): S {
  const current = state.entries[riskId];
  if (!current) return state;
  return {
    ...state,
    entries: { ...state.entries, [riskId]: { ...current, ...patch } },
    edited: true,
  };
}

/** Why a row of the risk table cannot be ticked, or `null`. */
export function unavailableReason(
  connection: IssuanceConnection,
  risk: CatalogRisk,
  resources: readonly Pick<IssuanceResource, 'env'>[],
  held: ReadonlySet<RiskId>,
): string | null {
  if (!held.has(risk.risk_id)) return OUTSIDE_AUTHORITY;
  if (!isResolvable(risk, connection, resources)) {
    return `no selected resource is labelled "${risk.env ?? ''}"`;
  }
  return null;
}

/** How many risks the creator could tick with this selection: held and resolvable. */
export function availableCount(connection: IssuanceConnection, state: SetState): number {
  const held = new Set(connection.authority);
  const resources = selectedResources(connection, state);
  return connection.risks.filter(
    (risk) => unavailableReason(connection, risk, resources, held) === null,
  ).length;
}

/**
 * "Select all": every risk the creator holds that the selection can resolve,
 * as an enumerated list. Deprecated entries and the uncategorized-write
 * fallback are not part of it: the first should not enter a new mission, the
 * second pre-accepts writes nobody reviewed — the creator ticks it knowingly.
 */
export function selectAll<S extends SetState>(connection: IssuanceConnection, state: S): S {
  const held = new Set(connection.authority);
  const resources = selectedResources(connection, state);
  const entries: Record<RiskId, EntryState> = { ...state.entries };
  for (const risk of connection.risks) {
    if (risk.deprecated || risk.fallback) continue;
    if (unavailableReason(connection, risk, resources, held) !== null) continue;
    entries[risk.risk_id] ??= defaultEntryFor(connection, state.trustLevels, risk);
  }
  return { ...state, entries, edited: true };
}

export function clearAll<S extends SetState>(state: S): S {
  return { ...state, entries: {}, edited: true };
}

/** Drops the accepted entries the current selection cannot resolve. */
export function dropUnresolvable<S extends SetState>(connection: IssuanceConnection, state: S): S {
  const held = new Set(connection.authority);
  const resources = selectedResources(connection, state);
  const byId = new Map(connection.risks.map((r) => [r.risk_id, r]));
  const entries = Object.fromEntries(
    Object.entries(state.entries).filter(([riskId]) => {
      const risk = byId.get(riskId);
      return risk !== undefined && unavailableReason(connection, risk, resources, held) === null;
    }),
  );
  return { ...state, entries, edited: true };
}

function numberOf(text: string): number | undefined {
  const trimmed = text.trim();
  if (trimmed === '') return undefined;
  const value = Number(trimmed);
  // Not a number: sent as an impossible budget so the preview names the field.
  return Number.isFinite(value) ? value : -1;
}

/** One set as a draft writes it: its resources, its trust levels beside its lines, its lines. */
function draftSet(connection: IssuanceConnection, state: SetState): DraftResourceSet {
  return {
    resources: draftResourcesOf(state),
    ...futureOf(state),
    // The persisted policy is the explicit enumeration: "Everything I hold" is not sent.
    everything_i_hold: false,
    // Kept with the mission to redraw this form. Sent beside lines only: without
    // any, the server would write the policy from them, and an emptied policy
    // must stay empty.
    ...(Object.keys(state.trustLevels).length > 0 && Object.keys(state.entries).length > 0
      ? { trust_levels: state.trustLevels }
      : {}),
    policy: connection.risks
      .filter((risk) => state.entries[risk.risk_id] !== undefined)
      .map((risk) => {
        const entry = state.entries[risk.risk_id] ?? BLANK_ENTRY;
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

/**
 * An account as a draft line: with one set, the set's fields directly, as before sets
 * existed; with several, `resource_sets`, each with the id of the stored set it keeps.
 */
function draftConnection(connection: IssuanceConnection, state: ConnectionState): DraftConnection {
  const [only] = state.sets;
  if (state.sets.length === 1 && only) {
    return { connection_id: connection.id, ...draftSet(connection, only) };
  }
  return {
    connection_id: connection.id,
    resource_sets: state.sets.map((set) => ({
      ...(set.id !== undefined ? { id: set.id } : {}),
      ...draftSet(connection, set),
    })),
  };
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

/** The draft the form stands for: included connections only, explicit entries only. */
export function draftOf(
  context: readonly IssuanceConnection[],
  state: FormState,
  now: Date,
): MissionDraft {
  return {
    name: state.name,
    connections: context.flatMap((connection) => {
      const cs = state.connections[connection.id];
      return cs?.included ? [draftConnection(connection, cs)] : [];
    }),
    period: periodOf(state.period),
    expires_at: expiryOf(state, now),
  };
}

/** True when the form's entries are exactly these lines, value for value. */
function sameLines(
  entries: Readonly<Record<RiskId, EntryState>>,
  lines: readonly Pick<MissionPolicyEntry, 'risk_id' | 'quota' | 'rate_limit' | 'gate'>[],
): boolean {
  if (Object.keys(entries).length !== lines.length) return false;
  return lines.every((line) => {
    const entry = entries[line.risk_id];
    const expected = entryOf(line);
    return (
      entry !== undefined &&
      entry.quota === expected.quota &&
      entry.rateMax === expected.rateMax &&
      entry.rateWindow === expected.rateWindow &&
      entry.gate === expected.gate
    );
  });
}

/**
 * Loads a resolved draft (a mission being edited or duplicated, an agent's
 * proposal after preview) into the form: its connections included, its
 * entries ticked with their values, its trust levels ticked. When the trust levels write
 * exactly those lines the simple view redraws them; otherwise the lines are
 * marked edited and shown in the advanced view, the honest view of them.
 */
export function loadResolved(
  context: readonly IssuanceConnection[],
  state: FormState,
  resolved: readonly ResolvedDraftConnection[],
): FormState {
  const connections: Record<string, ConnectionState> = { ...state.connections };
  for (const line of resolved) {
    const connection = context.find((c) => c.id === line.connection_id);
    if (!connection) continue;
    const several = line.resource_sets.length > 1;
    const sets = line.resource_sets.map((set): SetState => {
      const resourceIds = set.resources.resource_ids;
      const trustLevels = knownTrustLevels(connection, set.trust_levels);
      const entries = entriesOf(set.policy);
      const written = linesOfTrustLevels(
        connection,
        trustLevels,
        selectedResources(connection, { resourceIds }),
      );
      const matches = Object.keys(trustLevels).length > 0 && sameLines(entries, written);
      return {
        ...(set.id !== undefined ? { id: set.id } : {}),
        // A set with future resources reads as "the whole account" until the form has cards.
        resourceScope: set.future ? 'connection' : 'selected',
        resourceIds,
        trustLevels,
        everything: false,
        entries,
        edited: !matches,
      };
    });
    // Simple only when the trust levels of every set write exactly its lines.
    const simple = sets.every((set) => !set.edited);
    connections[connection.id] = {
      included: true,
      view: simple ? 'simple' : 'advanced',
      sets: several ? rebalance(connection, sets) : sets,
    };
  }
  return { ...state, connections };
}

// ─────────────────────────────────────────────────────────────────────────────
// Resource sets (risk model §4.7): several on one account
// ─────────────────────────────────────────────────────────────────────────────

/** True when a set takes what no other set picks: `all` or `connection`. */
export function takesTheRest(set: Pick<SetState, 'resourceScope'>): boolean {
  return set.resourceScope !== 'selected';
}

/** Whether the account may hold several sets: it has two resources at least. */
export function setsOffered(connection: IssuanceConnection): boolean {
  return connection.resources.filter((r) => !r.stale && !r.self).length >= 2;
}

/**
 * The sets after a change of one of them: a set that takes the rest reaches every
 * resource of `defaultResources` no picking set holds, and its policy follows its
 * resources while it was not edited by hand (as `setResources`).
 */
export function rebalance(connection: IssuanceConnection, sets: readonly SetState[]): SetState[] {
  const picked = new Set(
    sets.filter((set) => !takesTheRest(set)).flatMap((set) => set.resourceIds),
  );
  return sets.map((set) => {
    if (!takesTheRest(set)) return set;
    const resourceIds = enterableResources(connection)
      .map((r) => r.id)
      .filter((id) => !picked.has(id));
    const same =
      resourceIds.length === set.resourceIds.length &&
      resourceIds.every((id, i) => set.resourceIds[i] === id);
    if (same) return set;
    const next = { ...set, resourceIds };
    return set.edited ? next : resetEdits(connection, next);
  });
}

/** One set of the account replaced, the others rebalanced. */
export function updateSet(
  connection: IssuanceConnection,
  state: ConnectionState,
  index: number,
  next: SetState,
): ConnectionState {
  const sets = state.sets.map((set, i) => (i === index ? next : set));
  return { ...state, sets: rebalance(connection, sets) };
}

/**
 * "+ Add a resource set": a set that picks its resources, none yet, nothing ticked.
 * The resources it picks leave the set that takes the rest.
 */
export function addResourceSet(
  connection: IssuanceConnection,
  state: ConnectionState,
): ConnectionState {
  const added: SetState = {
    resourceScope: 'selected',
    resourceIds: [],
    trustLevels: {},
    everything: false,
    entries: {},
    edited: false,
  };
  return { ...state, sets: rebalance(connection, [...state.sets, added]) };
}

/** Removes one set; the last one stays. */
export function removeResourceSet(
  connection: IssuanceConnection,
  state: ConnectionState,
  index: number,
): ConnectionState {
  if (state.sets.length < 2) return state;
  return {
    ...state,
    sets: rebalance(
      connection,
      state.sets.filter((_, i) => i !== index),
    ),
  };
}

/** The set of the account that picks a resource, by index; `null` when none picks it. */
export function setOfResource(state: ConnectionState, resourceId: string): number | null {
  const index = state.sets.findIndex(
    (set) => !takesTheRest(set) && set.resourceIds.includes(resourceId),
  );
  return index === -1 ? null : index;
}

/** Every set's lines of an account, by risk: what the rail reads. */
export function entriesOfAccount(state: ConnectionState): Readonly<Record<RiskId, EntryState>> {
  return Object.assign({}, ...state.sets.map((set) => set.entries)) as Record<RiskId, EntryState>;
}

/** Every resource an account's sets reach now, in the account's order. */
export function resourceIdsOfAccount(state: ConnectionState): readonly string[] {
  return [...new Set(state.sets.flatMap((set) => set.resourceIds))];
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

/**
 * One reason the draft cannot be created, said with the words a person reads.
 * The code and the fields are the protocol's (`PreviewIssue`, also answered
 * to an agent on the management door, in its own words): this is the same
 * fact for the page. An issue this function has no sentence for — a later
 * code, a missing field — is printed as the server worded it.
 */
export function issueSentence(
  issue: PreviewIssue,
  context: readonly Pick<IssuanceConnection, 'id' | 'provider_label' | 'display_name'>[],
): string {
  const connection = context.find((c) => c.id === issue.connection_id);
  const account = connection ? `${connection.provider_label} · ${connection.display_name}` : null;
  const ids = quotedIds(issue.risk_ids);
  const refs = quotedIds(issue.resource_refs);
  const several = (issue.risk_ids?.length ?? 0) !== 1;
  switch (issue.code) {
    case 'name-missing':
      return 'Give the mission a name.';
    case 'no-connection':
      return 'Include at least one account.';
    case 'duplicate-provider':
      return 'A mission takes one account per service.';
    case 'invalid-period':
      return 'Choose how often the limits reset.';
    case 'invalid-expiry':
      return 'The end date must be a valid date in the future.';
    default:
      break;
  }
  if (!account) return issue.message;
  switch (issue.code) {
    case 'connection-unavailable':
      return `${account} cannot be used now: it needs reconnecting, or it was disconnected.`;
    case 'duplicate-connection':
      return `${account} is listed twice.`;
    case 'no-resource-selected':
      return `${account}: select at least one resource.`;
    case 'no-accepted-risk':
      return `${account} allows nothing yet: tick a macro-action or a permission, or leave the account out.`;
    case 'resource-stale':
      return refs
        ? `${account}: ${refs} can no longer be found there. Leave it out.`
        : issue.message;
    case 'resource-self':
      return refs
        ? `${account}: ${refs} is this instance's own hosting. A mission can never reach it.`
        : issue.message;
    case 'exceeds-authority':
      return ids
        ? `${account}: ${ids} ${several ? 'are' : 'is'} ${OUTSIDE_AUTHORITY} on this account.`
        : issue.message;
    case 'unresolvable-env':
      return ids
        ? `${account}: no selected resource carries the environment of ${ids}.`
        : issue.message;
    case 'missing-budget':
      return ids ? `${account}: give a limit to ${ids}.` : issue.message;
    case 'invalid-budget':
      return ids ? `${account}: a limit is a whole number above zero (${ids}).` : issue.message;
    default:
      return issue.message;
  }
}
