/**
 * State of the one-page mission creation form, and its transitions — pure, so
 * the ergonomics that matter (a preset fills everything, "select all" yields
 * an enumerated list, a hand-ticked risk gets a sensible default budget, the
 * draft sent to the server is always explicit) are unit-tested without a
 * browser. The decision itself is `previewDraft`, shared with the server.
 */
import type { Gate, PresetEntry, RiskId } from '@vaubaan/shared';

import { isResolvable } from '@/server/missions/catalog-view';
import type {
  CatalogRisk,
  DraftConnection,
  DraftPeriod,
  IssuanceConnection,
  IssuanceResource,
  MissionDraft,
  ResolvedDraftConnection,
  SkippedPresetEntry,
} from '@/server/missions/model';
import { expandPreset, previewConnection } from '@/server/missions/preview';

/** The inputs of one accepted risk; strings, as typed. An empty string is "no value yet". */
export interface EntryState {
  readonly quota: string;
  readonly rateMax: string;
  readonly rateWindow: string;
  readonly gate: Gate;
}

export interface ConnectionState {
  readonly included: boolean;
  /** Selected resource ids; every resource of the connection by default. */
  readonly resourceIds: readonly string[];
  /** Preset the policy was filled from; '' when none. */
  readonly presetId: string;
  /** Accepted risks, explicit ids. */
  readonly entries: Readonly<Record<RiskId, EntryState>>;
  /** True once the creator changed something after the preset filled the policy. */
  readonly edited: boolean;
}

export const PERIOD_CHOICES = [
  { id: 'hour', label: 'Quotas reload every hour', seconds: 3600 },
  { id: 'day', label: 'Quotas reload every day', seconds: 86_400 },
  { id: 'week', label: 'Quotas reload every week', seconds: 604_800 },
  { id: 'one-off', label: 'One-off — quotas never reload', seconds: null },
] as const;
export type PeriodChoice = (typeof PERIOD_CHOICES)[number]['id'];

export const EXPIRY_CHOICES = [
  { id: 'never', label: 'Never expires', days: null },
  { id: '1d', label: 'Expires in 24 hours', days: 1 },
  { id: '7d', label: 'Expires in 7 days', days: 7 },
  { id: '30d', label: 'Expires in 30 days', days: 30 },
  { id: '90d', label: 'Expires in 90 days', days: 90 },
  { id: 'custom', label: 'Expires on a date…', days: null },
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

/** Daily reload is the usual shape of "one token per code project". */
export const DEFAULT_PERIOD: PeriodChoice = 'day';
export const DEFAULT_EXPIRY: ExpiryChoice = 'never';
const MS_PER_DAY = 86_400_000;

export function initialConnectionState(connection: IssuanceConnection): ConnectionState {
  return {
    included: false,
    resourceIds: connection.resources.map((r) => r.id),
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
  if (outside > 0) parts.push(`${outside} outside your authority`);
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
  return `${skipped.length} preset ${skipped.length === 1 ? 'entry' : 'entries'} left out: ${parts.join('; ')}.`;
}

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
  if (!held.has(risk.risk_id)) return 'outside your authority';
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
      resourceIds: line.resources.resource_ids,
      presetId: line.preset ?? '',
      entries: Object.fromEntries(line.policy.map((e) => [e.risk_id, entryOf(e)])),
      edited: true,
    };
  }
  return { ...state, connections, showExperimental };
}
