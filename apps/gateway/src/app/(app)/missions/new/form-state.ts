/**
 * State of the one-page mission creation form, and its transitions — pure, so
 * the ergonomics that matter (a macro-action at a cran fills its lines,
 * "select all" yields an enumerated list, a hand-ticked risk gets a sensible
 * default budget, the draft sent to the server is always explicit) are
 * unit-tested without a browser. The decision itself is `previewDraft`,
 * shared with the server.
 */
import type { Gate, MissionPolicyEntry, RateLimit, RiskId } from '@vaubaan/shared';

import { isResolvable } from '@/server/missions/catalog-view';
import type {
  CatalogRisk,
  DraftConnection,
  DraftPeriod,
  DraftResources,
  IssuanceConnection,
  IssuanceResource,
  MissionDraft,
  PreviewIssue,
  ResolvedDraftConnection,
} from '@/server/missions/model';
import { EVERYTHING_I_HOLD, expansionDigest } from '@/server/missions/everything-i-hold';
import {
  DEFAULT_CRAN,
  defaultLineOf,
  expandMacroAction,
  highestPalier,
  knownCrans,
  linesOfCrans,
  rowsOf,
  type MacroActionCrans,
  type Palier,
  type TrustCran,
} from '@/server/missions/macro-actions';
import { defaultResources, previewConnection } from '@/server/missions/preview';

/** The inputs of one accepted risk; strings, as typed. An empty string is "no value yet". */
export interface EntryState {
  readonly quota: string;
  readonly rateMax: string;
  readonly rateWindow: string;
  readonly gate: Gate;
}

/**
 * How the policy of one connection is shown (risk model §4.6): `simple` — the
 * macro-actions of the service, each ticked at a trust cran; `advanced` —
 * every permission with its own limit and gate. The persisted policy is the
 * explicit list either way: the view is a property of the screen, and the
 * crans are kept with the mission only to redraw it.
 */
export type PolicyView = 'simple' | 'advanced';

/**
 * How far a mission reaches on one account (spec §3.1 "Resource selection";
 * ADR mission-reaches-the-whole-connection-on-request):
 *
 *   all         every resource known now (the default) — sent as that explicit list
 *   connection  the whole account, resources found later included — sent as the scope
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

export interface ConnectionState {
  readonly included: boolean;
  readonly view: PolicyView;
  /** How far the mission reaches on this account; `all` by default. */
  readonly resourceScope: ResourceChoice;
  /**
   * Selected resource ids; by default every resource that is neither hidden nor
   * stale. For `all` and `connection`, that default set: what is reached now.
   */
  readonly resourceIds: readonly string[];
  /** The ticked macro-actions, each with its cran. */
  readonly crans: MacroActionCrans;
  /** True when the policy was filled from "Everything I hold on this account". */
  readonly everything: boolean;
  /** Accepted risks, explicit ids. */
  readonly entries: Readonly<Record<RiskId, EntryState>>;
  /** True once the lines differ from what the crans (or "Everything I hold") wrote. */
  readonly edited: boolean;
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
const MS_PER_DAY = 86_400_000;

export function initialConnectionState(connection: IssuanceConnection): ConnectionState {
  return {
    included: false,
    view: 'simple',
    resourceScope: 'all',
    resourceIds: defaultResources(connection).map((r) => r.id),
    crans: {},
    everything: false,
    entries: {},
    edited: false,
  };
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
  state: Pick<ConnectionState, 'resourceIds'>,
): IssuanceResource[] {
  const selected = new Set(state.resourceIds);
  return connection.resources.filter((r) => selected.has(r.id));
}

/**
 * The resources of a draft line: the scope for the whole account, else the
 * explicit list the creator sees ticked ("every resource known now" included,
 * so the confirmation lists exactly what is stored).
 */
export function draftResourcesOf(
  state: Pick<ConnectionState, 'resourceScope' | 'resourceIds'>,
): DraftResources {
  return state.resourceScope === 'connection'
    ? { scope: 'connection' }
    : { scope: 'selected', resource_ids: state.resourceIds };
}

/** The connection as a draft line that carries only "Everything I hold": what applying it means. */
function everythingDraft(
  connection: IssuanceConnection,
  state: Pick<ConnectionState, 'resourceIds'> & Partial<Pick<ConnectionState, 'resourceScope'>>,
): DraftConnection {
  return {
    connection_id: connection.id,
    preset: EVERYTHING_I_HOLD,
    resources: draftResourcesOf({
      resourceScope: state.resourceScope ?? 'selected',
      resourceIds: state.resourceIds,
    }),
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
export function applyEverything(
  connection: IssuanceConnection,
  state: ConnectionState,
): ConnectionState {
  const { preview } = previewConnection(connection, everythingDraft(connection, state));
  return {
    ...state,
    crans: {},
    everything: true,
    edited: false,
    entries: entriesOf(preview.passes),
  };
}

/** Fills the policy from the crans: the lines `linesOfCrans` writes, nothing else. */
export function applyCrans(
  connection: IssuanceConnection,
  state: ConnectionState,
): ConnectionState {
  const lines = linesOfCrans(connection, state.crans, selectedResources(connection, state));
  return { ...state, everything: false, edited: false, entries: entriesOf(lines) };
}

/**
 * Ticks a macro-action at a cran, moves it to another cran, or (`null`) unticks
 * it; the policy is rewritten from the crans. The screen asks first when this
 * would throw edits away (`discardsEdits`).
 */
export function setMacroAction(
  connection: IssuanceConnection,
  state: ConnectionState,
  actionId: string,
  cran: TrustCran | null,
): ConnectionState {
  const crans: Record<string, TrustCran> = { ...state.crans };
  if (cran === null) delete crans[actionId];
  else crans[actionId] = cran;
  return applyCrans(connection, { ...state, crans });
}

/** The policy as the crans (or "Everything I hold") wrote it: what "Reset" goes back to. */
export function resetEdits(
  connection: IssuanceConnection,
  state: ConnectionState,
): ConnectionState {
  return state.everything ? applyEverything(connection, state) : applyCrans(connection, state);
}

/**
 * True when rewriting the policy from the crans would throw away something the
 * creator changed line by line: the screen asks before it does.
 */
export function discardsEdits(state: ConnectionState): boolean {
  return state.edited && Object.keys(state.entries).length > 0;
}

export function setView(state: ConnectionState, view: PolicyView): ConnectionState {
  return { ...state, view };
}

// ─────────────────────────────────────────────────────────────────────────────
// The simple view: macro-actions at a cran
// ─────────────────────────────────────────────────────────────────────────────

/** One macro-action as its row says it: ticked or not, at which cran, and what that yields here. */
export interface MacroActionRow {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  /** The cran it is ticked at, or `null` when not ticked. */
  readonly cran: TrustCran | null;
  /** The cran its counts are read at: its own, or Prudent when not ticked. */
  readonly shownCran: TrustCran;
  /** Permissions the macro-action has in this catalog. */
  readonly total: number;
  readonly free: number;
  readonly asks: number;
  /** Left out by the cran (palier 4 at Prudent). */
  readonly leftOut: number;
  /** Outside what the reader may allow, or no selected resource carries the environment. */
  readonly unavailable: number;
  /** Nothing of it can be given here: its row cannot be ticked. */
  readonly empty: boolean;
}

export function macroActionRows(
  connection: IssuanceConnection,
  state: ConnectionState,
): MacroActionRow[] {
  const resources = selectedResources(connection, state);
  return connection.macro_actions.map((action) => {
    const cran = state.crans[action.id] ?? null;
    const shownCran = cran ?? DEFAULT_CRAN;
    const expansion = expandMacroAction(connection, action, shownCran, resources);
    const free = expansion.lines.filter((line) => line.gate === 'auto').length;
    const asks = expansion.lines.length - free;
    return {
      id: action.id,
      label: action.label,
      description: action.description,
      cran,
      shownCran,
      total: rowsOf(connection, action).length,
      free,
      asks,
      leftOut: expansion.left_out.length,
      unavailable: expansion.unavailable.length,
      // Nothing it holds is reachable here, at any cran.
      empty:
        expandMacroAction(connection, action, 'autonome', resources).lines.length === 0 &&
        cran === null,
    };
  });
}

/** The highest palier among the chosen lines, or `null` when nothing is chosen. */
export function chosenPalier(
  connection: IssuanceConnection,
  state: ConnectionState,
): Palier | null {
  return highestPalier(connection.risks.filter((risk) => state.entries[risk.risk_id]));
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
  state: Pick<ConnectionState, 'resourceIds'> & Partial<Pick<ConnectionState, 'resourceScope'>>,
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

export function policyCounts(connection: IssuanceConnection, state: ConnectionState): PolicyCounts {
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
export function editorRows(connection: IssuanceConnection, state: ConnectionState): EditorRow[] {
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
export function setIncluded(state: ConnectionState, included: boolean): ConnectionState {
  return { ...state, included };
}

/**
 * Changes the resource selection. While the policy is what the crans (or
 * "Everything I hold") wrote, it follows the selection (env-qualified entries come and go with the
 * labelled resources); once edited, the creator's entries are kept and the
 * preview flags the ones that no longer resolve.
 */
export function setResources(
  connection: IssuanceConnection,
  state: ConnectionState,
  resourceIds: readonly string[],
): ConnectionState {
  // Ticking a box is picking: the list is what the mission reaches, no more.
  const next: ConnectionState = { ...state, resourceScope: 'selected', resourceIds };
  return state.edited ? next : resetEdits(connection, next);
}

/**
 * Changes how far the mission reaches on the account. `all` and `connection`
 * reach the default set now (neither hidden nor stale); `selected` starts from
 * the current ticks. The policy follows as with `setResources`.
 */
export function setResourceScope(
  connection: IssuanceConnection,
  state: ConnectionState,
  resourceScope: ResourceChoice,
): ConnectionState {
  const resourceIds =
    resourceScope === 'selected'
      ? state.resourceIds
      : defaultResources(connection).map((r) => r.id);
  const next: ConnectionState = { ...state, resourceScope, resourceIds };
  return state.edited ? next : resetEdits(connection, next);
}

/**
 * The budget a hand-ticked risk starts with: its macro-action's base budget at
 * the cran that macro-action has (Prudent when not ticked), with the gate that
 * cran gives it (`defaultLineOf`) — else blank, and a blank budget blocks
 * issuance until the creator types one.
 */
export function defaultEntryFor(
  connection: IssuanceConnection,
  crans: MacroActionCrans,
  risk: CatalogRisk,
): EntryState {
  const line = defaultLineOf(connection, crans, risk);
  return line ? entryOf(line) : BLANK_ENTRY;
}

export function toggleRisk(
  connection: IssuanceConnection,
  state: ConnectionState,
  risk: CatalogRisk,
): ConnectionState {
  const entries = { ...state.entries };
  if (entries[risk.risk_id]) delete entries[risk.risk_id];
  else {
    entries[risk.risk_id] = defaultEntryFor(connection, state.crans, risk);
  }
  return { ...state, entries, edited: true };
}

export function updateEntry(
  state: ConnectionState,
  riskId: RiskId,
  patch: Partial<EntryState>,
): ConnectionState {
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
export function availableCount(connection: IssuanceConnection, state: ConnectionState): number {
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
export function selectAll(connection: IssuanceConnection, state: ConnectionState): ConnectionState {
  const held = new Set(connection.authority);
  const resources = selectedResources(connection, state);
  const entries: Record<RiskId, EntryState> = { ...state.entries };
  for (const risk of connection.risks) {
    if (risk.deprecated || risk.fallback) continue;
    if (unavailableReason(connection, risk, resources, held) !== null) continue;
    entries[risk.risk_id] ??= defaultEntryFor(connection, state.crans, risk);
  }
  return { ...state, entries, edited: true };
}

export function clearAll(state: ConnectionState): ConnectionState {
  return { ...state, entries: {}, edited: true };
}

/** Drops the accepted entries the current selection cannot resolve. */
export function dropUnresolvable(
  connection: IssuanceConnection,
  state: ConnectionState,
): ConnectionState {
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

function draftConnection(connection: IssuanceConnection, state: ConnectionState): DraftConnection {
  return {
    connection_id: connection.id,
    resources: draftResourcesOf(state),
    // The persisted policy is the explicit enumeration: "Everything I hold" is not sent.
    preset: null,
    // Kept with the mission to redraw this form. Sent beside lines only: without
    // any, the server would write the policy from them, and an emptied policy
    // must stay empty.
    ...(Object.keys(state.crans).length > 0 && Object.keys(state.entries).length > 0
      ? { crans: state.crans }
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
 * entries ticked with their values, its crans ticked. When the crans write
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
    const resourceIds =
      line.resources.scope === 'connection'
        ? defaultResources(connection).map((r) => r.id)
        : line.resources.resource_ids;
    const crans = knownCrans(connection, line.crans);
    const entries = entriesOf(line.policy);
    const written = linesOfCrans(connection, crans, selectedResources(connection, { resourceIds }));
    const matches = Object.keys(crans).length > 0 && sameLines(entries, written);
    connections[connection.id] = {
      included: true,
      view: matches ? 'simple' : 'advanced',
      resourceScope: line.resources.scope === 'connection' ? 'connection' : 'selected',
      resourceIds,
      crans,
      everything: false,
      entries,
      edited: !matches,
    };
  }
  return { ...state, connections };
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
