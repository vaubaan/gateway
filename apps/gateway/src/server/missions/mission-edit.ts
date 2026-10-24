/**
 * An edit of a mission after issuance, as pure functions (ADR
 * mission-editable-after-issuance): the editable state of a mission
 * (`MissionSnapshot`), its revision, the draft that stands for it, the judgement
 * of an edited draft, and the changes between two states.
 *
 * The judgement is issuance's own: the edited draft goes through `previewDraft`
 * under the creator's authority now, and the issues it yields are kept only when
 * they are about something the edit moves (`counts`, below — the table of the
 * ADR). What does not move is carried over from the stored mission as it is: a
 * stale resource kept in a selection stays, an unchanged line keeps its values.
 *
 * Browser-safe, no IO: the edit form judges with it for instant feedback and the
 * server judges again with the store's context; the browser's copy decides
 * nothing.
 */
import type { Gate, MissionChangedEventDetails, MissionPolicyEntry, RiskId } from '@vaubaan/shared';

import type {
  DraftConnection,
  DraftPeriod,
  DraftPolicyEntry,
  IssuanceConnection,
  MissionDraft,
  MissionPreview,
  PreviewIssue,
  PreviewNotice,
} from './model';
import { defaultResources, previewDraft, type PreviewContext } from './preview';

export { describeMissionChange, missionChangeClauses } from './change-words';

/** How far a mission reaches on one account, as stored (spec §3.1). */
export type StoredResourceScope = 'all' | 'selected' | 'connection';

/** One account of a mission, with its part of the policy. */
export interface MissionSnapshotConnection {
  readonly connection_id: string;
  readonly provider: string;
  /** The account's name, for the words of a change; not part of the revision. */
  readonly display_name: string;
  /** `all` with no id: none was known at issuance; `connection`: no id, read live. */
  readonly resource_scope: StoredResourceScope;
  readonly resource_ids: readonly string[];
  readonly policy: readonly MissionPolicyEntry[];
}

/** Everything an edit may move, and the period it may not. */
export interface MissionSnapshot {
  readonly name: string;
  readonly expires_at: string | null;
  readonly period: DraftPeriod;
  readonly connections: readonly MissionSnapshotConnection[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Revision
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What a revision is computed over: the editable state with the policy flat, so the
 * store can compute it from a mission row inside its transaction (no provider lookup).
 */
export interface RevisionInput {
  readonly name: string;
  readonly expires_at: string | null;
  readonly period: DraftPeriod;
  readonly connections: readonly Pick<
    MissionSnapshotConnection,
    'connection_id' | 'resource_scope' | 'resource_ids'
  >[];
  readonly policy: readonly MissionPolicyEntry[];
}

function canonical(state: RevisionInput): string {
  const at = state.expires_at === null ? null : Date.parse(state.expires_at);
  return JSON.stringify([
    state.name,
    at,
    state.period.kind === 'one-off' ? null : state.period.length_seconds,
    [...state.connections]
      .sort((a, b) => a.connection_id.localeCompare(b.connection_id))
      .map((c) => [c.connection_id, c.resource_scope, [...c.resource_ids].sort()]),
    [...state.policy]
      .sort((a, b) => a.risk_id.localeCompare(b.risk_id))
      .map((p) => [p.risk_id, p.quota, p.rate_limit.max, p.rate_limit.window_seconds, p.gate]),
  ]);
}

/** The revision of a state given flat (`RevisionInput`). */
export function revisionOf(state: RevisionInput): string {
  return `r${hash53(canonical(state))}`;
}

/** 53-bit string hash (cyrb53): a guard against concurrent edits, not a secret. */
function hash53(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/**
 * The revision of a mission's editable state: what an editor started from. Two
 * snapshots with the same name, expiry instant, period, selections and policy have
 * the same revision, whatever the order of their rows.
 */
export function missionRevision(snapshot: MissionSnapshot): string {
  return revisionOf({ ...snapshot, policy: snapshot.connections.flatMap((c) => c.policy) });
}

// ─────────────────────────────────────────────────────────────────────────────
// The draft that stands for a mission
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The mission as a draft, exactly: same name, expiry and period; each account with
 * its stored selection (`selected` with the stored ids, even stale ones — `all`
 * with no id is `selected` with none) and its explicit lines. Sent back unchanged,
 * it is an edit that moves nothing.
 */
export function draftOfSnapshot(snapshot: MissionSnapshot): MissionDraft {
  return {
    name: snapshot.name,
    expires_at: snapshot.expires_at,
    period: snapshot.period,
    connections: snapshot.connections.map(draftConnectionOf),
  };
}

export function draftConnectionOf(c: MissionSnapshotConnection): DraftConnection {
  return {
    connection_id: c.connection_id,
    resources:
      c.resource_scope === 'connection'
        ? { scope: 'connection' }
        : { scope: 'selected', resource_ids: [...c.resource_ids] },
    preset: null,
    policy: c.policy.map((p) => ({
      risk_id: p.risk_id,
      quota: p.quota,
      rate_limit: { ...p.rate_limit },
      gate: p.gate,
    })),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Changes between two states
// ─────────────────────────────────────────────────────────────────────────────

export interface AccountRef {
  readonly connection_id: string;
  readonly provider: string;
  readonly display_name: string;
}

/** The selection of one account that moved. `null` scope: the account was not there. */
export interface ResourceChange extends AccountRef {
  readonly scope_before: StoredResourceScope | null;
  readonly scope_after: StoredResourceScope | null;
  readonly added: readonly string[];
  readonly removed: readonly string[];
}

export interface PermissionChange {
  readonly risk_id: RiskId;
  readonly before: MissionPolicyEntry;
  readonly after: MissionPolicyEntry;
}

/** Every section of a mission that moved, before and after. */
export interface MissionChanges {
  readonly name: { readonly before: string; readonly after: string } | null;
  readonly expires_at: { readonly before: string | null; readonly after: string | null } | null;
  readonly connections_added: readonly AccountRef[];
  readonly connections_removed: readonly AccountRef[];
  readonly resources: readonly ResourceChange[];
  readonly permissions_added: readonly MissionPolicyEntry[];
  readonly permissions_removed: readonly MissionPolicyEntry[];
  readonly permissions_changed: readonly PermissionChange[];
}

function sameInstant(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return a === b;
  return Date.parse(a) === Date.parse(b);
}

function samePeriod(a: DraftPeriod, b: DraftPeriod): boolean {
  if (a.kind === 'one-off' || b.kind === 'one-off') return a.kind === b.kind;
  return a.length_seconds === b.length_seconds;
}

function sameLine(a: MissionPolicyEntry, b: MissionPolicyEntry): boolean {
  return (
    a.quota === b.quota &&
    a.rate_limit.max === b.rate_limit.max &&
    a.rate_limit.window_seconds === b.rate_limit.window_seconds &&
    a.gate === b.gate
  );
}

function refOf(c: MissionSnapshotConnection): AccountRef {
  return { connection_id: c.connection_id, provider: c.provider, display_name: c.display_name };
}

/** What moved from `before` to `after`. Nothing moved: every list empty, both fields `null`. */
export function diffSnapshots(before: MissionSnapshot, after: MissionSnapshot): MissionChanges {
  const beforeById = new Map(before.connections.map((c) => [c.connection_id, c]));
  const afterById = new Map(after.connections.map((c) => [c.connection_id, c]));
  const resources: ResourceChange[] = [];
  for (const c of after.connections) {
    const was = beforeById.get(c.connection_id);
    const had = new Set(was?.resource_ids ?? []);
    const has = new Set(c.resource_ids);
    const added = c.resource_ids.filter((id) => !had.has(id));
    const removed = (was?.resource_ids ?? []).filter((id) => !has.has(id));
    if (!was || was.resource_scope !== c.resource_scope || added.length > 0 || removed.length > 0) {
      resources.push({
        ...refOf(c),
        scope_before: was?.resource_scope ?? null,
        scope_after: c.resource_scope,
        added,
        removed,
      });
    }
  }
  for (const c of before.connections) {
    if (afterById.has(c.connection_id)) continue;
    resources.push({
      ...refOf(c),
      scope_before: c.resource_scope,
      scope_after: null,
      added: [],
      removed: [...c.resource_ids],
    });
  }
  const linesBefore = new Map(
    before.connections.flatMap((c) => c.policy.map((p) => [p.risk_id, p])),
  );
  const linesAfter = new Map(after.connections.flatMap((c) => c.policy.map((p) => [p.risk_id, p])));
  const permissionsChanged: PermissionChange[] = [];
  for (const [riskId, line] of linesAfter) {
    const was = linesBefore.get(riskId);
    if (was && !sameLine(was, line)) {
      permissionsChanged.push({ risk_id: riskId, before: was, after: line });
    }
  }
  return {
    name: before.name === after.name ? null : { before: before.name, after: after.name },
    expires_at: sameInstant(before.expires_at, after.expires_at)
      ? null
      : { before: before.expires_at, after: after.expires_at },
    connections_added: after.connections.filter((c) => !beforeById.has(c.connection_id)).map(refOf),
    connections_removed: before.connections
      .filter((c) => !afterById.has(c.connection_id))
      .map(refOf),
    resources,
    permissions_added: [...linesAfter.values()].filter((p) => !linesBefore.has(p.risk_id)),
    permissions_removed: [...linesBefore.values()].filter((p) => !linesAfter.has(p.risk_id)),
    permissions_changed: permissionsChanged,
  };
}

export function hasChanges(changes: MissionChanges): boolean {
  return (
    changes.name !== null ||
    changes.expires_at !== null ||
    changes.connections_added.length > 0 ||
    changes.connections_removed.length > 0 ||
    changes.resources.length > 0 ||
    changes.permissions_added.length > 0 ||
    changes.permissions_removed.length > 0 ||
    changes.permissions_changed.length > 0
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// The judgement
// ─────────────────────────────────────────────────────────────────────────────

export interface EditJudgement {
  /** True when the edit may be saved as written (it may move nothing). */
  readonly ok: boolean;
  /** The issues of the creation's preview that are about what the edit moves. */
  readonly issues: readonly PreviewIssue[];
  /** What the creator should know; never blocks. */
  readonly notices: readonly PreviewNotice[];
  /** The mission as it would be stored; equal to `before` where nothing moved. */
  readonly after: MissionSnapshot;
  readonly changes: MissionChanges;
}

/** The resource issues a creation names its resources in. */
const RESOURCE_ISSUES = new Set(['resource-not-in-connection', 'resource-stale', 'resource-self']);
/** The issues about the lines of a connection's policy. */
const LINE_ISSUES = new Set([
  'unknown-risk',
  'duplicate-risk',
  'exceeds-authority',
  'unresolvable-env',
  'missing-budget',
  'invalid-budget',
]);

/** What moves on one account the edit keeps, and the account as it would be stored. */
interface KeptOutcome {
  readonly after: MissionSnapshotConnection;
  /** Ids and refs of what the edit adds to the reach (resource issues naming one count). */
  readonly addedKeys: ReadonlySet<string>;
  readonly selectionChanged: boolean;
  /** Resources added or the scope widened. */
  readonly reachWidens: boolean;
  /** Lines added, or whose quota, calls or window moved: judged. */
  readonly moving: ReadonlySet<RiskId>;
  /** Lines added, or whose quota or rate went up. */
  readonly linesWiden: boolean;
  /** A line added or removed. */
  readonly membershipChanged: boolean;
}

function rateOf(rate: { max: number; window_seconds: number }): number {
  return rate.max / rate.window_seconds;
}

/** The values a draft line asks for: the preview's resolution when it has one. */
function askedLine(
  line: DraftPolicyEntry,
  resolved: MissionPolicyEntry | undefined,
): {
  quota: number | undefined;
  rate_limit: { max: number; window_seconds: number } | undefined;
  gate: Gate;
} {
  if (resolved) return resolved;
  return { quota: line.quota, rate_limit: line.rate_limit, gate: line.gate ?? 'auto' };
}

function keptOutcome(
  before: MissionSnapshotConnection,
  draft: DraftConnection,
  context: IssuanceConnection | undefined,
  passes: readonly MissionPolicyEntry[] | null,
): KeptOutcome {
  // ── The selection ──
  const wanted = draft.resources ?? { scope: 'all' };
  let scope: StoredResourceScope;
  let ids: string[];
  const foreign: string[] = [];
  if (wanted.scope === 'connection') {
    scope = 'connection';
    ids = [];
  } else if (wanted.scope === 'all') {
    // "Every resource known now", resolved as at issuance; unknowable without the context.
    ids = context ? defaultResources(context).map((r) => r.id) : [...before.resource_ids];
    scope = ids.length > 0 ? 'selected' : 'all';
  } else {
    const byRef = new Map((context?.resources ?? []).map((r) => [r.ref, r.id]));
    ids = [...(wanted.resource_ids ?? [])];
    for (const ref of wanted.resource_refs ?? []) {
      const id = byRef.get(ref);
      if (id) ids.push(id);
      else foreign.push(ref);
    }
    ids = [...new Set(ids)];
    scope = ids.length > 0 ? 'selected' : 'all';
  }
  const hidden = new Set((context?.resources ?? []).filter((r) => r.hidden).map((r) => r.id));
  const had = new Set(before.resource_ids);
  const reachedBefore = (id: string): boolean =>
    before.resource_scope === 'connection' ? !hidden.has(id) : had.has(id);
  const added = scope === 'connection' ? [] : ids.filter((id) => !reachedBefore(id));
  const refs = new Map((context?.resources ?? []).map((r) => [r.id, r.ref]));
  const addedKeys = new Set<string>([
    ...added,
    ...added.flatMap((id) => {
      const ref = refs.get(id);
      return ref ? [ref] : [];
    }),
    ...foreign,
  ]);
  const selectionChanged =
    scope !== before.resource_scope ||
    ids.length !== before.resource_ids.length ||
    ids.some((id) => !had.has(id));
  const reachWidens =
    added.length > 0 ||
    foreign.length > 0 ||
    (scope === 'connection' && before.resource_scope !== 'connection');

  // ── The lines ──
  const stored = new Map(before.policy.map((p) => [p.risk_id, p]));
  const resolved = new Map((passes ?? []).map((p) => [p.risk_id, p]));
  const explicit = draft.policy ?? [];
  const lines: readonly DraftPolicyEntry[] =
    explicit.length > 0 || passes === null ? explicit : (passes ?? []);
  const moving = new Set<RiskId>();
  let linesWiden = false;
  let membershipChanged = false;
  const policy: MissionPolicyEntry[] = [];
  const listed = new Set<RiskId>();
  for (const line of lines) {
    if (listed.has(line.risk_id)) continue;
    listed.add(line.risk_id);
    const was = stored.get(line.risk_id);
    const asked = askedLine(line, resolved.get(line.risk_id));
    if (!was) {
      moving.add(line.risk_id);
      linesWiden = true;
      membershipChanged = true;
      const entry = resolved.get(line.risk_id);
      if (entry) policy.push(entry);
      continue;
    }
    const valuesMove =
      asked.quota !== was.quota ||
      asked.rate_limit?.max !== was.rate_limit.max ||
      asked.rate_limit?.window_seconds !== was.rate_limit.window_seconds;
    if (!valuesMove) {
      // Unmoved values stay as stored; a gate alone is not judged (as `setGate`).
      policy.push(asked.gate === was.gate ? was : { ...was, gate: asked.gate });
      continue;
    }
    moving.add(line.risk_id);
    const quotaUp = asked.quota !== undefined && asked.quota > was.quota;
    const rateUp =
      asked.rate_limit !== undefined && rateOf(asked.rate_limit) > rateOf(was.rate_limit);
    if (quotaUp || rateUp) linesWiden = true;
    const entry = resolved.get(line.risk_id);
    if (entry) policy.push(entry);
  }
  if (before.policy.some((p) => !listed.has(p.risk_id))) membershipChanged = true;

  return {
    after: {
      ...before,
      resource_scope: scope,
      resource_ids: scope === 'connection' ? [] : ids,
      policy,
    },
    addedKeys,
    selectionChanged,
    reachWidens,
    moving,
    linesWiden,
    membershipChanged,
  };
}

function intersects(values: readonly string[] | undefined, set: ReadonlySet<string>): boolean {
  return (values ?? []).some((v) => set.has(v));
}

/** Whether an issue about a kept account binds the edit (the ADR's table). */
function countsOnKept(issue: PreviewIssue, kept: KeptOutcome): boolean {
  if (RESOURCE_ISSUES.has(issue.code)) return intersects(issue.resource_refs, kept.addedKeys);
  if (LINE_ISSUES.has(issue.code)) return intersects(issue.risk_ids, kept.moving);
  switch (issue.code) {
    case 'no-resource-selected':
      return kept.selectionChanged;
    case 'connection-unavailable':
      return kept.reachWidens || kept.linesWiden;
    case 'connection-unknown':
      return kept.reachWidens || kept.selectionChanged || kept.moving.size > 0;
    case 'no-accepted-risk':
      return kept.membershipChanged;
    default:
      return true;
  }
}

/** The connection a draft line names, as the preview resolves it. */
function connectionIdOf(
  draft: DraftConnection,
  context: readonly IssuanceConnection[],
): string | null {
  if (draft.connection_id) return draft.connection_id;
  if (!draft.provider) return null;
  const candidates = context.filter((c) => c.provider === draft.provider && c.status === 'active');
  const [only] = candidates;
  return candidates.length === 1 && only ? only.id : null;
}

function fromPreview(
  preview: MissionPreview,
  connectionId: string,
): { passes: readonly MissionPolicyEntry[]; resources: StoredResourceScope; ids: string[] } | null {
  const found = preview.connections.find((c) => c.connection_id === connectionId);
  if (!found) return null;
  const ids = found.resources.map((r) => r.id);
  return {
    passes: found.passes,
    resources: found.reaches_later ? 'connection' : ids.length > 0 ? 'selected' : 'all',
    ids: found.reaches_later ? [] : ids,
  };
}

const PERIOD_NOT_EDITABLE: PreviewIssue = {
  code: 'period-not-editable',
  message:
    'The reset period of a mission does not change after issuance: it is the key of its counters. Duplicate the mission to give it another period.',
};

/**
 * Judges an edited draft against the mission it edits (`before`), under the
 * creator's authority in `context` (the issuance context, read now). The issues
 * are the creation's, word for word, kept when they are about what moves.
 */
export function judgeEdit(
  context: PreviewContext,
  before: MissionSnapshot,
  draft: MissionDraft,
): EditJudgement {
  const preview = previewDraft(context, draft);
  const beforeById = new Map(before.connections.map((c) => [c.connection_id, c]));
  const name = draft.name.trim();
  const nameChanged = name !== before.name;
  const expiryChanged = !sameInstant(draft.expires_at, before.expires_at);

  const issues: PreviewIssue[] = [];
  if (!samePeriod(draft.period, before.period)) issues.push(PERIOD_NOT_EDITABLE);
  for (const issue of preview.issues) {
    if (issue.connection_index !== undefined) continue;
    if (issue.code === 'name-missing' && !nameChanged) continue;
    if (issue.code === 'invalid-expiry' && !expiryChanged) continue;
    if (issue.code === 'invalid-period') continue;
    issues.push(issue);
  }

  const connections: MissionSnapshotConnection[] = [];
  const placed = new Set<string>();
  draft.connections.forEach((line, index) => {
    const own = preview.issues.filter((i) => i.connection_index === index);
    const id = connectionIdOf(line, context.connections);
    const was = id === null ? undefined : beforeById.get(id);
    const ctx = id === null ? undefined : context.connections.find((c) => c.id === id);
    const resolved = id === null ? null : fromPreview(preview, id);
    if (!was || id === null || placed.has(id)) {
      // An account the edit adds (or names twice): judged as a creation judges it.
      issues.push(...own);
      if (id !== null && !placed.has(id) && resolved && ctx) {
        placed.add(id);
        connections.push({
          connection_id: id,
          provider: ctx.provider,
          display_name: ctx.display_name,
          resource_scope: resolved.resources,
          resource_ids: resolved.ids,
          policy: [...resolved.passes],
        });
      }
      return;
    }
    placed.add(id);
    const kept = keptOutcome(was, line, ctx, resolved?.passes ?? null);
    const counting = own.filter((issue) => countsOnKept(issue, kept));
    // A moving line the preview did not pass is never dropped silently: whatever the
    // creation said about it binds the edit.
    const lost = new Set(
      [...kept.moving].filter((r) => !kept.after.policy.some((p) => p.risk_id === r)),
    );
    for (const issue of own) {
      if (!counting.includes(issue) && intersects(issue.risk_ids, lost)) counting.push(issue);
    }
    if (
      kept.membershipChanged &&
      kept.after.policy.length === 0 &&
      !counting.some((i) => i.code === 'no-accepted-risk')
    ) {
      // The creation's own words, also where the creator no longer holds the account.
      counting.push({
        code: 'no-accepted-risk',
        message: `Connection "${ctx?.display_name ?? was.display_name}" accepts no risk: pick a preset or accept at least one risk, or leave the connection out.`,
        connection_index: index,
        connection_id: id,
      });
    }
    issues.push(...counting);
    connections.push(kept.after);
  });

  const after: MissionSnapshot = {
    name: nameChanged ? name : before.name,
    expires_at: expiryChanged
      ? draft.expires_at === null
        ? null
        : new Date(draft.expires_at).toISOString()
      : before.expires_at,
    period: before.period,
    connections,
  };
  // An invalid expiry or name counts above; never build a date from it.
  const ok = issues.length === 0;
  return {
    ok,
    issues,
    notices: preview.notices,
    after: ok ? after : before,
    changes: ok ? diffSnapshots(before, after) : diffSnapshots(before, safeAfter(before, after)),
  };
}

/** A refused edit still lists what it would move, without an unusable date. */
function safeAfter(before: MissionSnapshot, after: MissionSnapshot): MissionSnapshot {
  const at = after.expires_at;
  return at !== null && Number.isNaN(Date.parse(at))
    ? { ...after, expires_at: before.expires_at }
    : after;
}

// ─────────────────────────────────────────────────────────────────────────────
// The summary of an edit, and its words
// ─────────────────────────────────────────────────────────────────────────────

/** The `mission-changed` session event's details for these changes. */
export function changeSummaryOf(
  changes: MissionChanges,
  requestsClosed: number,
): MissionChangedEventDetails {
  return {
    name_changed: changes.name !== null,
    expiry_changed: changes.expires_at !== null,
    ...(changes.expires_at ? { expires_at: changes.expires_at.after } : {}),
    connections_added: changes.connections_added.length,
    connections_removed: changes.connections_removed.length,
    resources_added: changes.resources.reduce((n, r) => n + r.added.length, 0),
    resources_removed: changes.resources.reduce((n, r) => n + r.removed.length, 0),
    scopes_changed: changes.resources.filter(
      (r) => r.scope_before !== null && r.scope_after !== null && r.scope_before !== r.scope_after,
    ).length,
    permissions_added: changes.permissions_added.map((p) => p.risk_id),
    permissions_removed: changes.permissions_removed.map((p) => p.risk_id),
    limits: changes.permissions_changed
      .filter(
        (c) =>
          c.before.quota !== c.after.quota ||
          c.before.rate_limit.max !== c.after.rate_limit.max ||
          c.before.rate_limit.window_seconds !== c.after.rate_limit.window_seconds,
      )
      .map((c) => ({
        risk_id: c.risk_id,
        quota_before: c.before.quota,
        quota: c.after.quota,
        rate_limit_max_before: c.before.rate_limit.max,
        rate_limit_max: c.after.rate_limit.max,
        rate_window_seconds_before: c.before.rate_limit.window_seconds,
        rate_window_seconds: c.after.rate_limit.window_seconds,
      })),
    gates: changes.permissions_changed
      .filter((c) => c.before.gate !== c.after.gate)
      .map((c) => ({ risk_id: c.risk_id, gate_before: c.before.gate, gate: c.after.gate })),
    requests_closed: requestsClosed,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The audit entry of an edit
// ─────────────────────────────────────────────────────────────────────────────

interface AuditSelection {
  readonly connection_id: string;
  readonly resource_scope: StoredResourceScope;
  readonly resource_ids: readonly string[];
}

/** One side of the `mission-changed` entry: only the sections that moved, each in full. */
export interface MissionChangeAuditSide {
  readonly [key: string]: unknown;
  readonly name?: string;
  readonly expires_at?: string | null;
  readonly connections?: readonly string[];
  readonly resources?: readonly AuditSelection[];
  readonly permissions?: readonly MissionPolicyEntry[];
}

function selectionOf(c: MissionSnapshotConnection): AuditSelection {
  return {
    connection_id: c.connection_id,
    resource_scope: c.resource_scope,
    resource_ids: [...c.resource_ids],
  };
}

/**
 * The `before` and `after` of the `mission-changed` administrative entry (ADR
 * mission-editable-after-issuance, point 7): built field by field from snake_case
 * domain shapes, so a rename in the store's types never changes what the audit keeps.
 */
export function auditOfChanges(
  before: MissionSnapshot,
  after: MissionSnapshot,
  changes: MissionChanges,
): { before: MissionChangeAuditSide; after: MissionChangeAuditSide } {
  const b: Record<string, unknown> = {};
  const a: Record<string, unknown> = {};
  if (changes.name) {
    b.name = changes.name.before;
    a.name = changes.name.after;
  }
  if (changes.expires_at) {
    b.expires_at = changes.expires_at.before;
    a.expires_at = changes.expires_at.after;
  }
  if (changes.connections_added.length > 0 || changes.connections_removed.length > 0) {
    b.connections = before.connections.map((c) => c.connection_id);
    a.connections = after.connections.map((c) => c.connection_id);
  }
  if (changes.resources.length > 0) {
    const moved = new Set(changes.resources.map((r) => r.connection_id));
    b.resources = before.connections.filter((c) => moved.has(c.connection_id)).map(selectionOf);
    a.resources = after.connections.filter((c) => moved.has(c.connection_id)).map(selectionOf);
  }
  if (
    changes.permissions_added.length > 0 ||
    changes.permissions_removed.length > 0 ||
    changes.permissions_changed.length > 0
  ) {
    b.permissions = [
      ...changes.permissions_removed,
      ...changes.permissions_changed.map((c) => c.before),
    ];
    a.permissions = [
      ...changes.permissions_added,
      ...changes.permissions_changed.map((c) => c.after),
    ];
  }
  return { before: b, after: a };
}
