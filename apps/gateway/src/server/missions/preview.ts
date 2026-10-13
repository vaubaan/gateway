/**
 * The issuance decision, as a pure function: a draft, checked against the
 * connections the creator holds authority on, yields a preview — what passes,
 * what exceeds the authority, what cannot resolve, and whether the draft can
 * be issued as written.
 *
 * `MissionService.preview()` and `issue()` call it with the context read from
 * the store; the creation form calls it with the context the page was
 * rendered with, for instant feedback. `issue()` always recomputes it
 * server-side: the browser's copy decides nothing.
 *
 * Spec §3.1 (monotonicity, enumeration, partition per connection, resource
 * selection), §3.2 (mandatory budget, presets), §0 "Resource" (env-qualified
 * ids resolve against the selected resources). Browser-safe: no IO.
 */
import type {
  Gate,
  MissionPolicyEntry,
  Preset,
  PresetEntry,
  RateLimit,
  RiskId,
} from '@vaubaan/shared';

import { isResolvable } from './catalog-view';
import type {
  CatalogRisk,
  ConnectionPreview,
  DraftConnection,
  DraftPeriod,
  DraftPolicyEntry,
  IssuanceConnection,
  IssuanceResource,
  MissionDraft,
  MissionPreview,
  PreviewIssue,
  ResolvedDraftConnection,
  SkippedPresetEntry,
  UnresolvableEntry,
} from './model';
import { summarize } from './summary';

export const MISSION_NAME_MAX_LENGTH = 120;
/** Shortest recurring period: an hour-scale reload is the finest the interface offers. */
export const MIN_PERIOD_SECONDS = 60;
export const MAX_PERIOD_SECONDS = 366 * 24 * 3600;
export const SECONDS_PER_MINUTE = 60;

const GATE_VALUES: readonly Gate[] = ['auto', 'approval'];

export interface PreviewContext {
  /** Connections the creator holds a non-empty authority on. */
  readonly connections: readonly IssuanceConnection[];
  readonly now: Date;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1;
}

/** Why a budget is not acceptable, or `null`. A quota is always a number ≥ 1 (spec §3.2). */
export function budgetProblem(
  entry: { quota: number; rate_limit: RateLimit; gate: Gate },
  risk: Pick<CatalogRisk, 'rate_ceiling_per_minute'>,
): string | null {
  if (!isPositiveInteger(entry.quota)) return 'quota must be a whole number of at least 1';
  if (!isPositiveInteger(entry.rate_limit.max)) {
    return 'rate limit must be a whole number of at least 1';
  }
  if (!isPositiveInteger(entry.rate_limit.window_seconds)) {
    return 'rate window must be a whole number of seconds, at least 1';
  }
  if (!GATE_VALUES.includes(entry.gate)) return `gate must be one of ${GATE_VALUES.join(', ')}`;
  const ceiling = risk.rate_ceiling_per_minute;
  if (ceiling !== null) {
    const perMinute = (entry.rate_limit.max * SECONDS_PER_MINUTE) / entry.rate_limit.window_seconds;
    if (perMinute > ceiling) {
      return `rate limit exceeds the catalog ceiling of ${ceiling} per minute`;
    }
  }
  return null;
}

/** The explicit entry a draft line resolves to, or `null` when its budget is missing. */
function resolveEntry(
  line: DraftPolicyEntry,
  fromPreset: PresetEntry | undefined,
): MissionPolicyEntry | null {
  const quota = line.quota ?? fromPreset?.quota;
  const rateLimit = line.rate_limit ?? fromPreset?.rate_limit;
  if (quota === undefined || rateLimit === undefined) return null;
  return {
    risk_id: line.risk_id,
    quota,
    rate_limit: { max: rateLimit.max, window_seconds: rateLimit.window_seconds },
    gate: line.gate ?? fromPreset?.gate ?? 'auto',
  };
}

interface ResourceResolution {
  readonly selected: IssuanceResource[];
  readonly issues: PreviewIssue[];
}

function resolveResources(
  connection: IssuanceConnection,
  draft: DraftConnection,
  index: number,
): ResourceResolution {
  const wanted = draft.resources ?? { scope: 'all' };
  if (wanted.scope === 'all') return { selected: [...connection.resources], issues: [] };

  const where = { connection_index: index, connection_id: connection.id };
  const byId = new Map(connection.resources.map((r) => [r.id, r]));
  const byRef = new Map(connection.resources.map((r) => [r.ref, r]));
  const selected = new Map<string, IssuanceResource>();
  const foreign: string[] = [];
  for (const id of wanted.resource_ids ?? []) {
    const found = byId.get(id);
    if (found) selected.set(found.id, found);
    else foreign.push(id);
  }
  for (const ref of wanted.resource_refs ?? []) {
    const found = byRef.get(ref);
    if (found) selected.set(found.id, found);
    else foreign.push(ref);
  }
  const issues: PreviewIssue[] = [];
  if (foreign.length > 0) {
    issues.push({
      code: 'resource-not-in-connection',
      message: `${foreign.length === 1 ? 'Resource' : 'Resources'} ${foreign.join(', ')} ${
        foreign.length === 1 ? 'does' : 'do'
      } not belong to connection "${connection.display_name}".`,
      resource_refs: foreign,
      ...where,
    });
  }
  if (selected.size === 0 && foreign.length === 0) {
    issues.push({
      code: 'no-resource-selected',
      message: `Connection "${connection.display_name}" has no resource selected: the mission could touch nothing on it.`,
      ...where,
    });
  }
  // Keep the connection's own order, so the persisted list is stable.
  return { selected: connection.resources.filter((r) => selected.has(r.id)), issues };
}

/**
 * The lines a preset contributes on one connection. An entry naming an
 * explicit id stands for itself. An entry naming the *base* id of an
 * env-scoped risk (`stripe.read-catalog`: "of the selected mode") stands for
 * that risk in every environment the selection can resolve, and becomes one
 * explicit line per such environment — the persisted policy never holds a
 * base id the runtime could not match.
 */
export function expandPreset(
  preset: Pick<Preset, 'entries'>,
  connection: Pick<IssuanceConnection, 'risks' | 'derives_env'>,
  selected: readonly Pick<IssuanceResource, 'env'>[],
): { readonly lines: PresetEntry[]; readonly unresolved: RiskId[] } {
  const explicit = new Set(connection.risks.map((r) => r.risk_id));
  const lines: PresetEntry[] = [];
  const unresolved: RiskId[] = [];
  for (const entry of preset.entries) {
    if (explicit.has(entry.risk_id)) {
      lines.push(entry);
      continue;
    }
    const perEnv = connection.risks.filter((r) => r.base_id === entry.risk_id && r.env !== null);
    const reachable = perEnv.filter((r) => isResolvable(r, connection, selected));
    if (perEnv.length > 0 && reachable.length === 0) {
      unresolved.push(entry.risk_id);
      continue;
    }
    // Not a base id either: left as is, the caller reports it as unknown.
    if (perEnv.length === 0) lines.push(entry);
    for (const risk of reachable) lines.push({ ...entry, risk_id: risk.risk_id });
  }
  return { lines, unresolved };
}

interface ConnectionOutcome {
  readonly preview: ConnectionPreview;
  readonly issues: PreviewIssue[];
}

function list(ids: readonly string[]): string {
  return ids.join(', ');
}

/** One connection of a draft against the creator's authority on it. */
export function previewConnection(
  connection: IssuanceConnection,
  draft: DraftConnection,
  index = 0,
): ConnectionOutcome {
  const where = { connection_index: index, connection_id: connection.id };
  const issues: PreviewIssue[] = [];
  const name = connection.display_name;

  const resources = resolveResources(connection, draft, index);
  issues.push(...resources.issues);

  const preset = draft.preset ? connection.presets.find((p) => p.id === draft.preset) : undefined;
  if (draft.preset && !preset) {
    issues.push({
      code: 'unknown-preset',
      message: `"${draft.preset}" is not a preset of ${connection.provider_label} (known: ${list(
        connection.presets.map((p) => p.id),
      )}).`,
      ...where,
    });
  }
  const expanded = preset
    ? expandPreset(preset, connection, resources.selected)
    : { lines: [], unresolved: [] };
  // Defaults for an explicit line: the preset's entry for that id, else the
  // preset's entry for its base id ("in whatever environment").
  const presetEntries = new Map((preset?.entries ?? []).map((e) => [e.risk_id, e]));
  for (const line of expanded.lines) presetEntries.set(line.risk_id, line);

  // A draft with explicit lines accepts exactly those; a draft with only a
  // preset accepts the preset, bounded by what the creator holds and by what
  // the selected resources can resolve.
  const explicit = draft.policy ?? [];
  const presetOnly = explicit.length === 0 && preset !== undefined;
  const lines: readonly DraftPolicyEntry[] = presetOnly ? expanded.lines : explicit;

  const catalog = new Map(connection.risks.map((r) => [r.risk_id, r]));
  const held = new Set(connection.authority);
  const seen = new Set<RiskId>();

  const passes: MissionPolicyEntry[] = [];
  const exceeds: RiskId[] = [];
  const unknown: RiskId[] = [];
  const unresolvable: UnresolvableEntry[] = [];
  const missingBudget: RiskId[] = [];
  const duplicates: RiskId[] = [];
  const skipped: SkippedPresetEntry[] = presetOnly
    ? expanded.unresolved.map((risk_id) => ({ risk_id, reason: 'unresolvable-env', env: null }))
    : [];
  const invalid: { risk_id: RiskId; problem: string }[] = [];

  for (const line of lines) {
    if (seen.has(line.risk_id)) {
      duplicates.push(line.risk_id);
      continue;
    }
    seen.add(line.risk_id);
    const risk = catalog.get(line.risk_id);
    if (!risk) {
      unknown.push(line.risk_id);
      continue;
    }
    if (!held.has(line.risk_id)) {
      if (presetOnly) {
        skipped.push({ risk_id: line.risk_id, reason: 'outside-authority', env: risk.env });
      } else exceeds.push(line.risk_id);
      continue;
    }
    if (!isResolvable(risk, connection, resources.selected)) {
      if (presetOnly) {
        skipped.push({ risk_id: line.risk_id, reason: 'unresolvable-env', env: risk.env });
      } else unresolvable.push({ risk_id: line.risk_id, env: risk.env ?? '' });
      continue;
    }
    const entry = resolveEntry(
      line,
      presetEntries.get(line.risk_id) ?? presetEntries.get(risk.base_id),
    );
    if (!entry) {
      missingBudget.push(line.risk_id);
      continue;
    }
    const problem = budgetProblem(entry, risk);
    if (problem) {
      invalid.push({ risk_id: line.risk_id, problem });
      continue;
    }
    passes.push(entry);
  }

  if (unknown.length > 0) {
    issues.push({
      code: 'unknown-risk',
      message: `Not ${unknown.length === 1 ? 'a risk' : 'risks'} of the ${connection.provider_label} catalog: ${list(unknown)}. A mission policy is an explicit enumeration of catalog ids.`,
      risk_ids: unknown,
      ...where,
    });
  }
  if (duplicates.length > 0) {
    issues.push({
      code: 'duplicate-risk',
      message: `Listed more than once on "${name}": ${list(duplicates)}.`,
      risk_ids: duplicates,
      ...where,
    });
  }
  if (exceeds.length > 0) {
    issues.push({
      code: 'exceeds-authority',
      message: `Outside your authority on "${name}": ${list(exceeds)}.`,
      risk_ids: exceeds,
      ...where,
    });
  }
  if (unresolvable.length > 0) {
    const envs = [...new Set(unresolvable.map((u) => u.env))];
    issues.push({
      code: 'unresolvable-env',
      message: `No selected resource of "${name}" is labelled ${list(
        envs.map((e) => `"${e}"`),
      )}, so these entries could never be touched: ${list(unresolvable.map((u) => u.risk_id))}.`,
      risk_ids: unresolvable.map((u) => u.risk_id),
      ...where,
    });
  }
  if (missingBudget.length > 0) {
    issues.push({
      code: 'missing-budget',
      message: `No budget for ${list(missingBudget)} on "${name}": an accepted risk needs a quota and a rate limit (no infinite budget).`,
      risk_ids: missingBudget,
      ...where,
    });
  }
  for (const bad of invalid) {
    issues.push({
      code: 'invalid-budget',
      message: `${bad.risk_id}: ${bad.problem}.`,
      risk_ids: [bad.risk_id],
      ...where,
    });
  }
  if (lines.length === 0 || (presetOnly && passes.length === 0)) {
    issues.push({
      code: 'no-accepted-risk',
      message: `Connection "${name}" accepts no risk: pick a preset or accept at least one risk, or leave the connection out.`,
      ...where,
    });
  }

  return {
    preview: {
      connection_id: connection.id,
      provider: connection.provider,
      display_name: name,
      resources: resources.selected,
      resources_total: connection.resources.length,
      preset: preset ? { id: preset.id, label: preset.label } : null,
      passes,
      exceeds,
      unknown,
      unresolvable,
      missing_budget: missingBudget,
      skipped_from_preset: skipped,
    },
    issues,
  };
}

/** The connection a draft line names, by id or by provider. */
function findConnection(
  context: PreviewContext,
  draft: DraftConnection,
  index: number,
): { connection: IssuanceConnection } | { issue: PreviewIssue } {
  if (draft.connection_id) {
    const found = context.connections.find((c) => c.id === draft.connection_id);
    if (found) return { connection: found };
    // One answer for "does not exist" and "not yours": no probing of other people's connections.
    return {
      issue: {
        code: 'connection-unknown',
        message: `Connection ${draft.connection_id} does not exist or you hold no authority on it.`,
        connection_index: index,
        connection_id: draft.connection_id,
      },
    };
  }
  if (draft.provider) {
    const candidates = context.connections.filter(
      (c) => c.provider === draft.provider && c.status === 'active',
    );
    const [only] = candidates;
    if (candidates.length === 1 && only) return { connection: only };
    return {
      issue:
        candidates.length === 0
          ? {
              code: 'connection-unknown',
              message: `You hold no active ${draft.provider} connection.`,
              connection_index: index,
            }
          : {
              code: 'connection-ambiguous',
              message: `You hold ${candidates.length} ${draft.provider} connections; name one by connection_id (${list(candidates.map((c) => c.id))}).`,
              connection_index: index,
            },
    };
  }
  return {
    issue: {
      code: 'connection-unknown',
      message: 'A connection is named by connection_id or by provider.',
      connection_index: index,
    },
  };
}

function periodIssue(period: DraftPeriod): PreviewIssue | null {
  if (period.kind === 'one-off') return null;
  const length = period.length_seconds;
  if (!Number.isInteger(length) || length < MIN_PERIOD_SECONDS || length > MAX_PERIOD_SECONDS) {
    return {
      code: 'invalid-period',
      message: `A recurring period lasts between ${MIN_PERIOD_SECONDS} seconds and ${MAX_PERIOD_SECONDS / 86_400} days.`,
    };
  }
  return null;
}

function expiryIssue(expiresAt: string | null, now: Date): PreviewIssue | null {
  if (expiresAt === null) return null;
  const at = Date.parse(expiresAt);
  if (Number.isNaN(at)) {
    return { code: 'invalid-expiry', message: 'The expiry is not a valid date.' };
  }
  if (at <= now.getTime()) {
    return { code: 'invalid-expiry', message: 'The expiry is in the past.' };
  }
  return null;
}

/**
 * The whole draft. Never throws on a refusable draft: every reason is an
 * issue, so the creator (or the agent) fixes everything in one pass.
 */
export function previewDraft(context: PreviewContext, draft: MissionDraft): MissionPreview {
  const issues: PreviewIssue[] = [];
  const name = draft.name.trim();
  if (name.length === 0) {
    issues.push({ code: 'name-missing', message: 'Give the mission a name.' });
  } else if (name.length > MISSION_NAME_MAX_LENGTH) {
    issues.push({
      code: 'name-missing',
      message: `The name is longer than ${MISSION_NAME_MAX_LENGTH} characters.`,
    });
  }
  if (draft.connections.length === 0) {
    issues.push({ code: 'no-connection', message: 'A mission carries at least one connection.' });
  }

  const previews: ConnectionPreview[] = [];
  const used: IssuanceConnection[] = [];
  const seenConnections = new Set<string>();
  const seenProviders = new Map<string, string>();

  draft.connections.forEach((draftConnection, index) => {
    const found = findConnection(context, draftConnection, index);
    if ('issue' in found) {
      issues.push(found.issue);
      return;
    }
    const { connection } = found;
    const where = { connection_index: index, connection_id: connection.id };
    if (seenConnections.has(connection.id)) {
      issues.push({
        code: 'duplicate-connection',
        message: `Connection "${connection.display_name}" is listed twice.`,
        ...where,
      });
      return;
    }
    seenConnections.add(connection.id);
    const sameProvider = seenProviders.get(connection.provider);
    if (sameProvider !== undefined) {
      // The policy is keyed by RiskId, whose first segment is the provider: two
      // connections of one provider would share one partition and one budget.
      issues.push({
        code: 'duplicate-provider',
        message: `"${connection.display_name}" and "${sameProvider}" are both ${connection.provider_label} connections; a mission carries one connection per provider. Issue a second mission for the other one.`,
        ...where,
      });
      return;
    }
    seenProviders.set(connection.provider, connection.display_name);
    if (connection.status !== 'active') {
      issues.push({
        code: 'connection-unavailable',
        message: `Connection "${connection.display_name}" is ${connection.status}; reconnect it before issuing a mission on it.`,
        ...where,
      });
    }
    const outcome = previewConnection(connection, draftConnection, index);
    issues.push(...outcome.issues);
    previews.push(outcome.preview);
    used.push(connection);
  });

  const period = periodIssue(draft.period);
  if (period) issues.push(period);
  const expiry = expiryIssue(draft.expires_at, context.now);
  if (expiry) issues.push(expiry);

  const resolved: ResolvedDraftConnection[] = previews.map((p) => ({
    connection_id: p.connection_id,
    resources: { scope: 'selected', resource_ids: p.resources.map((r) => r.id) },
    preset: p.preset?.id ?? null,
    policy: p.passes,
  }));

  return {
    ok: issues.length === 0,
    issues,
    name,
    connections: previews,
    policy: previews.flatMap((p) => p.passes),
    period: draft.period,
    expires_at: draft.expires_at,
    summary: summarize({
      connections: used,
      previews,
      period: draft.period,
      expires_at: draft.expires_at,
    }),
    resolved,
  };
}

/** The uncovered list of a preview: every accepted id outside the authority (spec §3.1). */
export function uncoveredOf(preview: Pick<MissionPreview, 'connections'>): RiskId[] {
  return preview.connections.flatMap((c) => c.exceeds);
}
