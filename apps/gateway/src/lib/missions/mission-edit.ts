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
 * Every connection holds one resource set or more (risk model §4.7). A draft set
 * names the stored set it keeps by `id`; a connection drafted with one set and
 * stored with one set keeps it without an id. Any other draft set is added, and is
 * judged as a creation judges it; a stored set no draft set keeps is removed.
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
  DraftResourceSet,
  IssuanceConnection,
  MissionDraft,
  MissionPreview,
  PreviewIssue,
  PreviewNotice,
  ResourceSetPreview,
} from './model';
import { draftSetsOf } from './model';
import { defaultResources, previewDraft, type PreviewContext } from './preview';

export { describeMissionChange, missionChangeClauses } from './change-words';

/** How far a mission reaches on one account, as stored (spec §3.1). */
export type StoredResourceScope = 'all' | 'selected' | 'connection';

/** One resource set of an account of a mission, with its part of the policy. */
export interface MissionSnapshotSet {
  /**
   * What the set is called in this snapshot: its stored id, or, for a set an edit
   * adds, `new:<connection id>:<position>` until the store gives it an id.
   */
  readonly key: string;
  /** The stored id; `null` for a set the edit adds. */
  readonly id: string | null;
  /** From 1, among the sets of the account. */
  readonly position: number;
  /** `all` with no id: none was known at issuance; `connection`: no id, read live. */
  readonly resource_scope: StoredResourceScope;
  readonly resource_ids: readonly string[];
  /** Its lines; each names the set by `resource_set_id` (`key`). */
  readonly policy: readonly MissionPolicyEntry[];
  /** The trust levels the form recorded (risk model §4.6): they redraw it, they are no change. */
  readonly trust_levels?: Readonly<Record<string, string>>;
}

/** One account of a mission, with its resource sets. */
export interface MissionSnapshotConnection {
  readonly connection_id: string;
  readonly provider: string;
  /** The account's name, for the words of a change; not part of the revision. */
  readonly display_name: string;
  /** Its sets, by position; never empty. */
  readonly resource_sets: readonly MissionSnapshotSet[];
}

/** Everything an edit may move, and the period it may not. */
export interface MissionSnapshot {
  readonly name: string;
  readonly expires_at: string | null;
  readonly period: DraftPeriod;
  readonly connections: readonly MissionSnapshotConnection[];
}

/** Every line of an account, all sets together. */
export function policyOfConnection(c: MissionSnapshotConnection): MissionPolicyEntry[] {
  return c.resource_sets.flatMap((set) => [...set.policy]);
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
  readonly connections: readonly {
    readonly connection_id: string;
    readonly resource_sets: readonly {
      readonly id: string;
      readonly position: number;
      readonly resource_scope: StoredResourceScope;
      readonly resource_ids: readonly string[];
    }[];
  }[];
  /** Every line, naming its set (`resource_set_id`). */
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
      .map((c) => [
        c.connection_id,
        [...c.resource_sets]
          .sort((a, b) => a.position - b.position)
          .map((set) => [set.id, set.resource_scope, [...set.resource_ids].sort()]),
      ]),
    [...state.policy]
      .sort(
        (a, b) =>
          (a.resource_set_id ?? '').localeCompare(b.resource_set_id ?? '') ||
          a.risk_id.localeCompare(b.risk_id),
      )
      .map((p) => [
        p.resource_set_id ?? '',
        p.risk_id,
        p.quota,
        p.rate_limit.max,
        p.rate_limit.window_seconds,
        p.gate,
      ]),
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
  return revisionOf({
    ...snapshot,
    connections: snapshot.connections.map((c) => ({
      connection_id: c.connection_id,
      resource_sets: c.resource_sets.map((set) => ({
        id: set.id ?? set.key,
        position: set.position,
        resource_scope: set.resource_scope,
        resource_ids: set.resource_ids,
      })),
    })),
    policy: snapshot.connections.flatMap(policyOfConnection),
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// The draft that stands for a mission
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The mission as a draft, exactly: same name, expiry and period; each account with
 * its stored selection (`selected` with the stored ids, even stale ones — `all`
 * with no id is `selected` with none) and its explicit lines. An account with one
 * resource set is drafted without sets, as before sets existed; one with several
 * lists them, each with its id. Sent back unchanged, it is an edit that moves nothing.
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
  const [only] = c.resource_sets;
  if (c.resource_sets.length === 1 && only) {
    return { connection_id: c.connection_id, ...draftSetOf(only, false) };
  }
  return {
    connection_id: c.connection_id,
    resource_sets: c.resource_sets.map((set) => draftSetOf(set, true)),
  };
}

function draftSetOf(set: MissionSnapshotSet, withId: boolean): DraftResourceSet {
  return {
    ...(withId && set.id !== null ? { id: set.id } : {}),
    resources:
      set.resource_scope === 'connection'
        ? { scope: 'connection' }
        : { scope: 'selected', resource_ids: [...set.resource_ids] },
    everything_i_hold: false,
    policy: set.policy.map((p) => ({
      risk_id: p.risk_id,
      quota: p.quota,
      rate_limit: { ...p.rate_limit },
      gate: p.gate,
    })),
    ...(set.trust_levels ? { trust_levels: { ...set.trust_levels } } : {}),
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

/**
 * The selection of one resource set that moved. `null` scope: the set (or its
 * account) was not there.
 */
export interface ResourceChange extends AccountRef {
  /** The set (`MissionSnapshotSet.key`) and its position after the edit (before, when removed). */
  readonly resource_set_id: string;
  readonly position: number;
  readonly scope_before: StoredResourceScope | null;
  readonly scope_after: StoredResourceScope | null;
  readonly added: readonly string[];
  readonly removed: readonly string[];
}

export interface PermissionChange {
  readonly risk_id: RiskId;
  /** The set of the line (`MissionSnapshotSet.key`). */
  readonly resource_set_id: string;
  readonly before: MissionPolicyEntry;
  readonly after: MissionPolicyEntry;
}

/** Every section of a mission that moved, before and after. */
export interface MissionChanges {
  readonly name: { readonly before: string; readonly after: string } | null;
  readonly expires_at: { readonly before: string | null; readonly after: string | null } | null;
  readonly connections_added: readonly AccountRef[];
  readonly connections_removed: readonly AccountRef[];
  /** Sets added to, or removed from, an account the edit keeps. */
  readonly resource_sets_added: number;
  readonly resource_sets_removed: number;
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

/** The key of a line in a diff: its set and its risk. */
function lineKey(p: MissionPolicyEntry): string {
  return `${p.resource_set_id ?? ''}\n${p.risk_id}`;
}

/** What moved from `before` to `after`. Nothing moved: every list empty, both fields `null`. */
export function diffSnapshots(before: MissionSnapshot, after: MissionSnapshot): MissionChanges {
  const beforeById = new Map(before.connections.map((c) => [c.connection_id, c]));
  const afterById = new Map(after.connections.map((c) => [c.connection_id, c]));
  const resources: ResourceChange[] = [];
  let setsAdded = 0;
  let setsRemoved = 0;
  for (const c of after.connections) {
    const was = beforeById.get(c.connection_id);
    const wasSets = new Map((was?.resource_sets ?? []).map((set) => [set.key, set]));
    for (const set of c.resource_sets) {
      const old = wasSets.get(set.key);
      if (was && !old) setsAdded += 1;
      const had = new Set(old?.resource_ids ?? []);
      const has = new Set(set.resource_ids);
      const added = set.resource_ids.filter((id) => !had.has(id));
      const removed = (old?.resource_ids ?? []).filter((id) => !has.has(id));
      if (
        !old ||
        old.resource_scope !== set.resource_scope ||
        added.length > 0 ||
        removed.length > 0
      ) {
        resources.push({
          ...refOf(c),
          resource_set_id: set.key,
          position: set.position,
          scope_before: old?.resource_scope ?? null,
          scope_after: set.resource_scope,
          added,
          removed,
        });
      }
    }
    if (!was) continue;
    const kept = new Set(c.resource_sets.map((set) => set.key));
    for (const old of was.resource_sets) {
      if (kept.has(old.key)) continue;
      setsRemoved += 1;
      resources.push({
        ...refOf(was),
        resource_set_id: old.key,
        position: old.position,
        scope_before: old.resource_scope,
        scope_after: null,
        added: [],
        removed: [...old.resource_ids],
      });
    }
  }
  for (const c of before.connections) {
    if (afterById.has(c.connection_id)) continue;
    for (const set of c.resource_sets) {
      resources.push({
        ...refOf(c),
        resource_set_id: set.key,
        position: set.position,
        scope_before: set.resource_scope,
        scope_after: null,
        added: [],
        removed: [...set.resource_ids],
      });
    }
  }
  const linesBefore = new Map(
    before.connections.flatMap(policyOfConnection).map((p) => [lineKey(p), p]),
  );
  const linesAfter = new Map(
    after.connections.flatMap(policyOfConnection).map((p) => [lineKey(p), p]),
  );
  const permissionsChanged: PermissionChange[] = [];
  for (const [key, line] of linesAfter) {
    const was = linesBefore.get(key);
    if (was && !sameLine(was, line)) {
      permissionsChanged.push({
        risk_id: line.risk_id,
        resource_set_id: line.resource_set_id ?? '',
        before: was,
        after: line,
      });
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
    resource_sets_added: setsAdded,
    resource_sets_removed: setsRemoved,
    resources,
    permissions_added: [...linesAfter.entries()]
      .filter(([key]) => !linesBefore.has(key))
      .map(([, p]) => p),
    permissions_removed: [...linesBefore.entries()]
      .filter(([key]) => !linesAfter.has(key))
      .map(([, p]) => p),
    permissions_changed: permissionsChanged,
  };
}

export function hasChanges(changes: MissionChanges): boolean {
  return (
    changes.name !== null ||
    changes.expires_at !== null ||
    changes.connections_added.length > 0 ||
    changes.connections_removed.length > 0 ||
    changes.resource_sets_added > 0 ||
    changes.resource_sets_removed > 0 ||
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

/** What moves on one set the edit keeps, and the set as it would be stored. */
interface KeptOutcome {
  readonly after: MissionSnapshotSet;
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
  before: MissionSnapshotSet,
  draft: DraftResourceSet,
  position: number,
  context: IssuanceConnection | undefined,
  resolved: ResourceSetPreview | null,
  several: boolean,
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
    // "Every resource known now", resolved as at issuance (the preview's, which leaves
    // out what another set selects); unknowable without the context.
    ids = resolved
      ? resolved.resources.map((r) => r.id)
      : context && !several
        ? defaultResources(context).map((r) => r.id)
        : [...before.resource_ids];
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
  const passes = resolved?.passes ?? null;
  const stored = new Map(before.policy.map((p) => [p.risk_id, p]));
  const resolvedLines = new Map((passes ?? []).map((p) => [p.risk_id, p]));
  const explicit = draft.policy ?? [];
  const lines: readonly DraftPolicyEntry[] =
    explicit.length > 0 || passes === null ? explicit : passes;
  const moving = new Set<RiskId>();
  let linesWiden = false;
  let membershipChanged = false;
  const policy: MissionPolicyEntry[] = [];
  const listed = new Set<RiskId>();
  const inSet = (entry: MissionPolicyEntry): MissionPolicyEntry => ({
    ...entry,
    resource_set_id: before.key,
  });
  for (const line of lines) {
    if (listed.has(line.risk_id)) continue;
    listed.add(line.risk_id);
    const was = stored.get(line.risk_id);
    const asked = askedLine(line, resolvedLines.get(line.risk_id));
    if (!was) {
      moving.add(line.risk_id);
      linesWiden = true;
      membershipChanged = true;
      const entry = resolvedLines.get(line.risk_id);
      if (entry) policy.push(inSet(entry));
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
    const entry = resolvedLines.get(line.risk_id);
    if (entry) policy.push(inSet(entry));
  }
  if (before.policy.some((p) => !listed.has(p.risk_id))) membershipChanged = true;

  return {
    after: {
      ...before,
      position,
      resource_scope: scope,
      resource_ids: scope === 'connection' ? [] : ids,
      policy,
      ...trustLevelsOf(draft, context),
    },
    addedKeys,
    selectionChanged,
    reachWidens,
    moving,
    linesWiden,
    membershipChanged,
  };
}

/** The trust levels a draft set records, kept to the macro-actions of the connection. */
function trustLevelsOf(
  draft: DraftResourceSet,
  context: IssuanceConnection | undefined,
): { readonly trust_levels?: Readonly<Record<string, string>> } {
  const known = new Set((context?.macro_actions ?? []).map((action) => action.id));
  const levels = Object.fromEntries(
    Object.entries(draft.trust_levels ?? {}).filter(([id]) => known.has(id)),
  );
  return Object.keys(levels).length > 0 ? { trust_levels: levels } : {};
}

function intersects(values: readonly string[] | undefined, set: ReadonlySet<string>): boolean {
  return (values ?? []).some((v) => set.has(v));
}

/** Whether an issue about a kept set (or its account) binds the edit (the ADR's table). */
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

/** The outcomes of the kept sets of one account, as one: what the account-wide issues read. */
function accountOutcome(sets: readonly KeptOutcome[]): KeptOutcome | null {
  const [first] = sets;
  if (!first) return null;
  return {
    after: first.after,
    addedKeys: new Set(sets.flatMap((s) => [...s.addedKeys])),
    selectionChanged: sets.some((s) => s.selectionChanged),
    reachWidens: sets.some((s) => s.reachWidens),
    moving: new Set(sets.flatMap((s) => [...s.moving])),
    linesWiden: sets.some((s) => s.linesWiden),
    membershipChanged: sets.some((s) => s.membershipChanged),
  };
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

/** The set a creation would store from a preview's set: a new set of the snapshot. */
function newSetOf(
  connectionId: string,
  position: number,
  set: ResourceSetPreview,
  draft: DraftResourceSet | undefined,
  context: IssuanceConnection | undefined,
): MissionSnapshotSet {
  const key = `new:${connectionId}:${position}`;
  const ids = set.resources.map((r) => r.id);
  return {
    key,
    id: null,
    position,
    resource_scope: set.reaches_later ? 'connection' : ids.length > 0 ? 'selected' : 'all',
    resource_ids: set.reaches_later ? [] : ids,
    policy: set.passes.map((p) => ({ ...p, resource_set_id: key })),
    ...(draft ? trustLevelsOf(draft, context) : {}),
  };
}

const PERIOD_NOT_EDITABLE: PreviewIssue = {
  code: 'period-not-editable',
  message:
    'The reset period of a mission does not change after issuance: it is the key of its counters. Duplicate the mission to give it another period.',
};

/** The stored set a draft set keeps, or `undefined` for a set the draft adds. */
function keptSetOf(
  stored: readonly MissionSnapshotSet[],
  drafted: readonly DraftResourceSet[],
  set: DraftResourceSet,
): MissionSnapshotSet | undefined {
  if (set.id !== undefined) return stored.find((s) => s.id === set.id);
  // A connection with one set, drafted with one set: the same set.
  const [only] = stored;
  return drafted.length === 1 && stored.length === 1 ? only : undefined;
}

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
    const resolved = id === null ? undefined : previewOf(preview, id);
    const drafted = draftSetsOf(line);
    if (!was || id === null || placed.has(id)) {
      // An account the edit adds (or names twice): judged as a creation judges it.
      issues.push(...own);
      if (id !== null && !placed.has(id) && resolved && ctx) {
        placed.add(id);
        connections.push({
          connection_id: id,
          provider: ctx.provider,
          display_name: ctx.display_name,
          resource_sets: resolved.resource_sets.map((set) =>
            newSetOf(id, set.index + 1, set, drafted[set.index], ctx),
          ),
        });
      }
      return;
    }
    placed.add(id);
    const several = drafted.length > 1;
    const sets: MissionSnapshotSet[] = [];
    const keptOutcomes: KeptOutcome[] = [];
    const counting: PreviewIssue[] = [];
    const keptIds = new Set<string>();
    drafted.forEach((set, setIndex) => {
      const ofSet = own.filter((i) =>
        several ? i.resource_set_index === setIndex : i.resource_set_index === undefined,
      );
      const setPreview = resolved?.resource_sets[setIndex] ?? null;
      const stored = keptSetOf(was.resource_sets, drafted, set);
      if (!stored || keptIds.has(stored.key)) {
        // A set the edit adds: judged as a creation judges it.
        counting.push(...(several ? ofSet : ofSet.filter((i) => !accountWide(i))));
        if (setPreview) sets.push(newSetOf(id, setIndex + 1, setPreview, set, ctx));
        return;
      }
      keptIds.add(stored.key);
      const kept = keptOutcome(stored, set, setIndex + 1, ctx, setPreview, several);
      keptOutcomes.push(kept);
      const bound = ofSet.filter((issue) => !accountWide(issue) && countsOnKept(issue, kept));
      // A moving line the preview did not pass is never dropped silently: whatever the
      // creation said about it binds the edit.
      const lost = new Set(
        [...kept.moving].filter((r) => !kept.after.policy.some((p) => p.risk_id === r)),
      );
      for (const issue of ofSet) {
        if (!bound.includes(issue) && intersects(issue.risk_ids, lost)) bound.push(issue);
      }
      if (
        kept.membershipChanged &&
        kept.after.policy.length === 0 &&
        !bound.some((i) => i.code === 'no-accepted-risk')
      ) {
        // The creation's own words, also where the creator no longer holds the account.
        bound.push({
          code: 'no-accepted-risk',
          message: `Connection "${ctx?.display_name ?? was.display_name}" accepts no risk: tick a macro-action or accept at least one risk, or leave the connection out.`,
          connection_index: index,
          connection_id: id,
          ...(several ? { resource_set_index: setIndex } : {}),
        });
      }
      counting.push(...bound);
      sets.push(kept.after);
    });
    // The account-wide issues (unavailable, unknown, sets overlapping…), read on what
    // the kept sets move together; an added or removed set always moves the account.
    // Removing a set narrows: only an added set widens the account on its own.
    const account = accountOutcome(keptOutcomes);
    const setAdded = sets.length !== keptOutcomes.length;
    for (const issue of own.filter(accountWide)) {
      if (setAdded || !account || countsOnKept(issue, account)) counting.push(issue);
    }
    issues.push(...counting);
    connections.push({ ...was, resource_sets: sets });
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

/** An issue about a whole account, not one of its sets. */
function accountWide(issue: PreviewIssue): boolean {
  return (
    issue.code === 'connection-unavailable' ||
    issue.code === 'connection-unknown' ||
    issue.code === 'connection-ambiguous' ||
    issue.code === 'duplicate-connection' ||
    issue.code === 'duplicate-provider' ||
    issue.code === 'resource-sets-overlap' ||
    issue.code === 'resource-sets-mixed'
  );
}

function previewOf(
  preview: MissionPreview,
  connectionId: string,
): MissionPreview['connections'][number] | undefined {
  return preview.connections.find((c) => c.connection_id === connectionId);
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
    ...(changes.resource_sets_added > 0
      ? { resource_sets_added: changes.resource_sets_added }
      : {}),
    ...(changes.resource_sets_removed > 0
      ? { resource_sets_removed: changes.resource_sets_removed }
      : {}),
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
  readonly resource_set_id: string;
  readonly position: number;
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

function selectionsOf(c: MissionSnapshotConnection): AuditSelection[] {
  return c.resource_sets.map((set) => ({
    connection_id: c.connection_id,
    resource_set_id: set.key,
    position: set.position,
    resource_scope: set.resource_scope,
    resource_ids: [...set.resource_ids],
  }));
}

/**
 * The `before` and `after` of the `mission-changed` administrative entry (ADR
 * mission-editable-after-issuance, point 7): built field by field from snake_case
 * domain shapes, so a rename in the store's types never changes what the audit keeps.
 * A set the edit adds is named `new:<connection id>:<position>` there.
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
    b.resources = before.connections
      .filter((c) => moved.has(c.connection_id))
      .flatMap(selectionsOf);
    a.resources = after.connections.filter((c) => moved.has(c.connection_id)).flatMap(selectionsOf);
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
