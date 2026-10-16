/**
 * State of the one-page mission creation form, and its transitions — pure, so
 * the ergonomics that matter (a preset fills everything, "select all" yields
 * an enumerated list, a hand-ticked risk gets a sensible default budget, the
 * draft sent to the server is always explicit) are unit-tested without a
 * browser. The decision itself is `previewDraft`, shared with the server.
 */
import type { Gate, Preset, PresetEntry, RateLimit, RiskId } from '@vaubaan/shared';

import { groupVariants, isResolvable, type RiskFamily } from '@/server/missions/catalog-view';
import type {
  CatalogRisk,
  DraftConnection,
  DraftPeriod,
  IssuanceConnection,
  IssuanceResource,
  MissionDraft,
  PreviewIssue,
  ResolvedDraftConnection,
  SkippedPresetEntry,
} from '@/server/missions/model';
import { defaultResources, expandPreset, previewConnection } from '@/server/missions/preview';

/** The inputs of one accepted risk; strings, as typed. An empty string is "no value yet". */
export interface EntryState {
  readonly quota: string;
  readonly rateMax: string;
  readonly rateWindow: string;
  readonly gate: Gate;
}

/**
 * How the policy of one connection is built (spec §4.2): `preset` — pick one
 * of the plugin's presets and read what it yields; `custom` — the full
 * editor, every risk the creator holds with its own budget and gate. The
 * persisted policy is the explicit list either way: the mode is a property of
 * the screen, never of the mission.
 */
export type PolicyMode = 'preset' | 'custom';

export interface ConnectionState {
  readonly included: boolean;
  readonly mode: PolicyMode;
  /** Selected resource ids; by default every resource that is neither hidden nor stale. */
  readonly resourceIds: readonly string[];
  /** Preset the policy was filled from; '' when none. */
  readonly presetId: string;
  /** Accepted risks, explicit ids. */
  readonly entries: Readonly<Record<RiskId, EntryState>>;
  /** True once the creator changed something after the preset filled the policy. */
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
] as const;
export type ExpiryChoice = (typeof EXPIRY_CHOICES)[number]['id'];

export interface FormState {
  readonly name: string;
  readonly connections: Readonly<Record<string, ConnectionState>>;
  readonly period: PeriodChoice;
  readonly expiry: ExpiryChoice;
  /** `datetime-local` value, used when `expiry` is `custom`. */
  readonly expiryCustom: string;
  readonly showExperimental: boolean;
}

/** Limits that reset every day are the usual shape of "one key per code project". */
export const DEFAULT_PERIOD: PeriodChoice = 'day';
export const DEFAULT_EXPIRY: ExpiryChoice = 'never';
const MS_PER_DAY = 86_400_000;

export function initialConnectionState(connection: IssuanceConnection): ConnectionState {
  return {
    included: false,
    mode: 'preset',
    resourceIds: defaultResources(connection).map((r) => r.id),
    presetId: '',
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
    showExperimental: false,
  };
}

function entryOf(entry: Pick<PresetEntry, 'quota' | 'rate_limit' | 'gate'>): EntryState {
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

/** The connection as a draft line that carries only the preset: what "apply the preset" means. */
function presetDraft(connection: IssuanceConnection, state: ConnectionState): DraftConnection {
  return {
    connection_id: connection.id,
    preset: state.presetId || null,
    resources: { scope: 'selected', resource_ids: state.resourceIds },
  };
}

/** Fills the policy from the preset, bounded by the authority and the selected resources. */
export function applyPreset(
  connection: IssuanceConnection,
  state: ConnectionState,
  presetId: string,
): ConnectionState {
  const next: ConnectionState = { ...state, presetId, edited: false, entries: {} };
  if (!presetId) return next;
  const { preview } = previewConnection(connection, presetDraft(connection, next));
  return {
    ...next,
    entries: Object.fromEntries(preview.passes.map((e) => [e.risk_id, entryOf(e)])),
  };
}

/**
 * What the chosen preset could not contribute with this selection and this
 * authority — shown next to the preset so nothing disappears silently.
 */
export function presetSkipped(
  connection: IssuanceConnection,
  state: ConnectionState,
): readonly SkippedPresetEntry[] {
  if (!state.presetId) return [];
  return previewConnection(connection, presetDraft(connection, state)).preview.skipped_from_preset;
}

/** One sentence for the entries a preset left out. */
export function describeSkipped(skipped: readonly SkippedPresetEntry[]): string | null {
  if (skipped.length === 0) return null;
  const outside = skipped.filter((s) => s.reason === 'outside-authority').length;
  const envs = [
    ...new Set(skipped.filter((s) => s.reason === 'unresolvable-env').map((s) => s.env)),
  ];
  const parts: string[] = [];
  if (outside > 0) parts.push(`${outside} outside what you may allow`);
  if (envs.length > 0) {
    const named = envs.filter((e): e is string => e !== null).map((e) => `"${e}"`);
    const unresolved = skipped.length - outside;
    const need = unresolved === 1 ? 'needs' : 'need';
    parts.push(
      named.length > 0
        ? `${unresolved} ${need} a selected resource labelled ${named.join(' or ')}`
        : `${unresolved} ${need} a selected resource with an environment label`,
    );
  }
  return `${skipped.length} ${skipped.length === 1 ? 'permission' : 'permissions'} of the preset left out here: ${parts.join('; ')}.`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Preset or Custom, per connection
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Opens the full editor on what is there: the preset's values are the
 * starting point, nothing is lost and nothing counts as edited yet.
 */
export function enterCustom(state: ConnectionState): ConnectionState {
  return { ...state, mode: 'custom' };
}

/**
 * True when going back to Preset mode would throw away something the creator
 * typed: the screen asks before it calls `backToPreset`.
 */
export function discardsEdits(state: ConnectionState): boolean {
  return state.mode === 'custom' && state.edited;
}

/** Back to the preset as it is: the policy is the preset's again, edits are dropped. */
export function backToPreset(
  connection: IssuanceConnection,
  state: ConnectionState,
): ConnectionState {
  return applyPreset(connection, { ...state, mode: 'preset' }, state.presetId);
}

/** "Start from preset…" in Custom mode: pre-fills the editor, which stays open. */
export function startFromPreset(
  connection: IssuanceConnection,
  state: ConnectionState,
  presetId: string,
): ConnectionState {
  return applyPreset(connection, { ...state, mode: 'custom' }, presetId);
}

/** One risk a preset yields on this connection, with the values the mission would get. */
export interface ExplainedLine {
  readonly risk: CatalogRisk;
  readonly quota: number;
  readonly rate_limit: RateLimit;
  readonly gate: Gate;
}

/** A catalog entry the preset names and this mission cannot get, with why. */
export interface SkippedFamily extends RiskFamily {
  readonly why: string;
}

/**
 * What picking a preset means on this connection, with this selection and
 * this authority — the content of the card the creator reads before issuing.
 */
export interface PresetExplanation {
  readonly preset: Preset;
  /** Passes without asking. */
  readonly auto: readonly ExplainedLine[];
  /** Each action waits for the creator's approval. */
  readonly approval: readonly ExplainedLine[];
  /** Risks the creator could accept here and the preset does not include. */
  readonly leftOut: readonly RiskFamily[];
  /** Entries of the preset that cannot apply: outside the authority, or no resource carries the environment. */
  readonly skipped: readonly SkippedFamily[];
}

/** Why a permission the catalog lists cannot be given here: the reader's own ceiling on the account. */
export const OUTSIDE_AUTHORITY = 'outside what you may allow';

function skippedWhy(skipped: SkippedPresetEntry, envs: readonly string[]): string {
  if (skipped.reason === 'outside-authority') return OUTSIDE_AUTHORITY;
  const named = skipped.env ? [skipped.env] : envs;
  return named.length > 0
    ? `needs a selected resource labelled ${named.map((env) => `"${env}"`).join(' or ')}`
    : 'needs a selected resource with an environment label';
}

/**
 * Expands a preset of the connection's plugin against the selected resources
 * and the creator's authority — the same computation as `applyPreset`, read
 * instead of applied, so the card and the policy cannot disagree. `null` for
 * an id that is not a preset of this plugin.
 */
export function explainPreset(
  connection: IssuanceConnection,
  state: Pick<ConnectionState, 'resourceIds'>,
  presetId: string,
): PresetExplanation | null {
  const preset = connection.presets.find((p) => p.id === presetId);
  if (!preset) return null;
  const { preview } = previewConnection(connection, {
    connection_id: connection.id,
    preset: presetId,
    resources: { scope: 'selected', resource_ids: state.resourceIds },
  });
  const byId = new Map(preview.passes.map((entry) => [entry.risk_id, entry]));
  const lines = connection.risks.flatMap((risk): ExplainedLine[] => {
    const entry = byId.get(risk.risk_id);
    return entry
      ? [{ risk, quota: entry.quota, rate_limit: entry.rate_limit, gate: entry.gate }]
      : [];
  });
  const held = new Set(connection.authority);
  const resources = selectedResources(connection, state);
  const skippedIds = new Set(preview.skipped_from_preset.map((s) => s.risk_id));
  const leftOut = connection.risks.filter(
    (risk) =>
      !byId.has(risk.risk_id) &&
      !skippedIds.has(risk.risk_id) &&
      !skippedIds.has(risk.base_id) &&
      unavailableReason(connection, risk, resources, held) === null,
  );
  const skipped = preview.skipped_from_preset.flatMap((entry): SkippedFamily[] => {
    // A skipped entry names an explicit id, or the base id of an env-scoped risk.
    const variants = connection.risks.filter(
      (risk) => risk.risk_id === entry.risk_id || risk.base_id === entry.risk_id,
    );
    const exact = variants.filter((risk) => risk.risk_id === entry.risk_id);
    const [family] = groupVariants(exact.length > 0 ? exact : variants);
    if (!family) return [];
    const envs = family.variants.flatMap((risk) => (risk.env === null ? [] : [risk.env]));
    return [{ ...family, why: skippedWhy(entry, envs) }];
  });
  return {
    preset,
    auto: lines.filter((line) => line.gate === 'auto'),
    approval: lines.filter((line) => line.gate === 'approval'),
    leftOut: groupVariants(leftOut),
    skipped,
  };
}

/** How many permissions a preset yields here: what its choice says beside its name. */
export function presetWidth(explanation: PresetExplanation): number {
  return explanation.auto.length + explanation.approval.length;
}

/**
 * Why a preset would allow nothing with this selection and this authority, or
 * `null` when it allows something. The choice is then drawn as unavailable and
 * says this sentence, instead of being offered and yielding an empty mission.
 */
export function presetUnavailable(explanation: PresetExplanation): string | null {
  if (presetWidth(explanation) > 0) return null;
  const reasons = [...new Set(explanation.skipped.map((family) => family.why))];
  if (reasons.length === 0) return 'holds no permission';
  return reasons
    .map((reason) => (reason.startsWith('needs ') ? `${reason}: none selected` : reason))
    .join('; ');
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

/**
 * "Custom, start empty": the editor on an empty list, tied to no preset. The
 * screen asks first when this would throw edits away (`discardsEdits`).
 */
export function startEmpty(state: ConnectionState): ConnectionState {
  return { ...state, mode: 'custom', presetId: '', entries: {}, edited: false };
}

// ─────────────────────────────────────────────────────────────────────────────
// The Custom editor: every risk, searchable
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
 * Changes the resource selection. While the policy is the untouched preset
 * it follows the selection (env-qualified entries come and go with the
 * labelled resources); once edited, the creator's entries are kept and the
 * preview flags the ones that no longer resolve.
 */
export function setResources(
  connection: IssuanceConnection,
  state: ConnectionState,
  resourceIds: readonly string[],
): ConnectionState {
  const next = { ...state, resourceIds };
  if (state.presetId && !state.edited) return applyPreset(connection, next, state.presetId);
  return next;
}

/**
 * The budget a hand-ticked risk starts with: the chosen preset's values for
 * it, else those of the first preset of the plugin that carries it, else
 * blank — and a blank budget blocks issuance until the creator types one.
 */
export function defaultEntryFor(
  connection: IssuanceConnection,
  presetId: string,
  risk: Pick<CatalogRisk, 'risk_id' | 'base_id'>,
  resources: readonly Pick<IssuanceResource, 'env'>[],
): EntryState {
  const chosen = connection.presets.filter((p) => p.id === presetId);
  const others = connection.presets.filter((p) => p.id !== presetId);
  for (const preset of [...chosen, ...others]) {
    const { lines } = expandPreset(preset, connection, resources);
    const match =
      lines.find((e) => e.risk_id === risk.risk_id) ??
      preset.entries.find((e) => e.risk_id === risk.base_id);
    if (match) return entryOf(match);
  }
  return BLANK_ENTRY;
}

export function toggleRisk(
  connection: IssuanceConnection,
  state: ConnectionState,
  risk: CatalogRisk,
): ConnectionState {
  const entries = { ...state.entries };
  if (entries[risk.risk_id]) delete entries[risk.risk_id];
  else {
    entries[risk.risk_id] = defaultEntryFor(
      connection,
      state.presetId,
      risk,
      selectedResources(connection, state),
    );
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
    entries[risk.risk_id] ??= defaultEntryFor(connection, state.presetId, risk, resources);
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
    resources: { scope: 'selected', resource_ids: state.resourceIds },
    // The persisted policy is the explicit enumeration: the preset is not sent.
    preset: null,
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
  state: Pick<FormState, 'expiry' | 'expiryCustom'>,
  now: Date,
): string | null {
  if (state.expiry === 'never') return null;
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

/**
 * Loads a resolved draft (a duplicated mission, an agent's proposal after
 * preview) into the form: its connections included, its entries ticked with
 * their values, marked as edited so no preset overwrites them.
 */
export function loadResolved(
  context: readonly IssuanceConnection[],
  state: FormState,
  resolved: readonly ResolvedDraftConnection[],
): FormState {
  const connections: Record<string, ConnectionState> = { ...state.connections };
  let showExperimental = state.showExperimental;
  for (const line of resolved) {
    const connection = context.find((c) => c.id === line.connection_id);
    if (!connection) continue;
    if (connection.experimental) showExperimental = true;
    connections[connection.id] = {
      included: true,
      // Explicit lines are a custom policy: the editor is the honest view of them.
      mode: 'custom',
      resourceIds: line.resources.resource_ids,
      presetId: line.preset ?? '',
      entries: Object.fromEntries(line.policy.map((e) => [e.risk_id, entryOf(e)])),
      edited: true,
    };
  }
  return { ...state, connections, showExperimental };
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
      return `${account} allows nothing yet: pick a preset or a permission, or leave the account out.`;
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
