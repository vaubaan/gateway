/**
 * The creation form in edit mode (ADR mission-editable-after-issuance): the form
 * prefilled from a mission, the draft it sends back, and what the confirmation
 * says of each change — pure, so the words and the consequences are unit-tested
 * without a browser. The judgement is `judgeEdit`, the function the server runs
 * again when the edit is saved.
 */
import { policyLineKey, type PolicyLineKey } from '@vaubaan/shared/domain';
import type { RiskId } from '@vaubaan/shared';

import type {
  IssuanceConnection,
  MissionDraft,
  ResolvedDraftConnection,
} from '@/lib/missions/model';
import {
  draftConnectionOf,
  type MissionChanges,
  type MissionSnapshot,
  type StoredResourceScope,
} from '@/lib/missions/mission-edit';
import { trustLevelsOf } from '@/lib/missions/macro-actions';

import {
  draftOf,
  initialFormState,
  loadResolved,
  periodChoiceOf,
  type FormState,
} from './form-state';

/** What the edit form knows of the mission it edits. */
export interface EditSource {
  readonly missionId: string;
  readonly revision: string;
  readonly snapshot: MissionSnapshot;
  /** Calls used in the current period, per line (a risk in a resource set, `lineKeyOf`). */
  readonly used: Readonly<Record<PolicyLineKey, number>>;
  /** Open claims and approval requests, with the risks they are about. */
  readonly openRequests: readonly {
    readonly id: string;
    readonly kind: string;
    readonly risk_ids: readonly RiskId[];
  }[];
}

/** The mission's accounts as the form loads them: their stored selection and lines. */
export function resolvedOfSnapshot(snapshot: MissionSnapshot): ResolvedDraftConnection[] {
  return snapshot.connections.map((c) => ({
    connection_id: c.connection_id,
    resource_sets: c.resource_sets.map((set) => ({
      ...(set.id !== null ? { id: set.id } : {}),
      resources:
        set.resource_scope === 'connection'
          ? { scope: 'connection' as const }
          : { scope: 'selected' as const, resource_ids: [...set.resource_ids] },
      everything_i_hold: false,
      policy: set.policy,
      trust_levels: trustLevelsOf(set.trust_levels),
    })),
  }));
}

/**
 * The form on the mission as it stands: its name, its accounts with their
 * resources and permissions, its period, and its end date "as it is".
 */
export function initialEditState(
  context: readonly IssuanceConnection[],
  snapshot: MissionSnapshot,
): FormState {
  const loaded = loadResolved(context, initialFormState(context), resolvedOfSnapshot(snapshot));
  return {
    ...loaded,
    name: snapshot.name,
    period: periodChoiceOf(snapshot.period),
    expiry: 'keep',
    keptExpiry: snapshot.expires_at,
    expiryCustom: '',
  };
}

/**
 * The draft an edit sends: the form's, its period the mission's, and the accounts the
 * form cannot show (the creator no longer holds them) carried back as they are, so
 * nothing is removed that the person did not see.
 */
export function editDraftOf(
  context: readonly IssuanceConnection[],
  state: FormState,
  snapshot: MissionSnapshot,
  now: Date,
): MissionDraft {
  const draft = draftOf(context, state, now);
  const shown = new Set(context.map((c) => c.id));
  const carried = snapshot.connections
    .filter((c) => !shown.has(c.connection_id))
    .map(draftConnectionOf);
  return {
    ...draft,
    period: snapshot.period,
    connections: [...draft.connections, ...carried],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The confirmation: every change, before → after, and what it means
// ─────────────────────────────────────────────────────────────────────────────

export interface ChangeLine {
  /** The section of the mission: Name, End date, Accounts, Resources, Permissions. */
  readonly section: string;
  readonly text: string;
  /** What it means for the agent, when something follows from it. */
  readonly consequence: string | null;
  /** True for what narrows the mission or stops something (shown as a warning). */
  readonly warn: boolean;
}

export interface Naming {
  /** A resource's name as the pages show it, or its id. */
  resource(connectionId: string, resourceId: string): string;
  /** A permission's label, or its id. */
  risk(riskId: RiskId): string;
}

const SCOPE_WORDS: Readonly<Record<StoredResourceScope, string>> = {
  all: 'no resource',
  selected: 'the resources picked',
  connection: 'the whole account, including resources found later',
};

function endWords(at: string | null): string {
  return at === null ? 'never' : at.slice(0, 16).replace('T', ' ');
}

function perWindow(max: number, seconds: number): string {
  return seconds === 60 ? `${max} a minute` : `${max} per ${seconds} s`;
}

function askWords(gate: 'auto' | 'approval'): string {
  return gate === 'approval' ? 'asks first' : 'runs freely';
}

/** Every change of an edit as the confirmation lists it, in a fixed order. */
export function changeLines(
  changes: MissionChanges,
  source: Pick<EditSource, 'used' | 'openRequests'>,
  naming: Naming,
): ChangeLine[] {
  const lines: ChangeLine[] = [];
  if (changes.name) {
    lines.push({
      section: 'Name',
      text: `“${changes.name.before}” → “${changes.name.after}”`,
      consequence: null,
      warn: false,
    });
  }
  if (changes.expires_at) {
    const { before, after } = changes.expires_at;
    lines.push({
      section: 'End date',
      text: `${endWords(before)} → ${endWords(after)}`,
      consequence:
        after !== null && (before === null || Date.parse(after) < Date.parse(before))
          ? 'The mission refuses every call after this date.'
          : null,
      warn: after !== null && (before === null || Date.parse(after) < Date.parse(before)),
    });
  }
  for (const account of changes.connections_added) {
    lines.push({
      section: 'Accounts',
      text: `Added: ${account.display_name}`,
      consequence: 'The agent reaches it from its next call, with the permissions below.',
      warn: false,
    });
  }
  for (const account of changes.connections_removed) {
    lines.push({
      section: 'Accounts',
      text: `Removed: ${account.display_name}`,
      consequence: 'Every call on it is refused from the next one, with its permissions.',
      warn: true,
    });
  }
  const added = new Set(changes.connections_added.map((c) => c.connection_id));
  const removed = new Set(changes.connections_removed.map((c) => c.connection_id));
  // Sets are named only on an account that has several, before or after the edit.
  const several = new Set(
    changes.resources
      .filter(
        (r) =>
          changes.resources.some(
            (o) => o.connection_id === r.connection_id && o.resource_set_id !== r.resource_set_id,
          ) || r.position > 1,
      )
      .map((r) => r.connection_id),
  );
  const where = (r: (typeof changes.resources)[number]): string =>
    several.has(r.connection_id) ? `${r.display_name}, resource set ${r.position}` : r.display_name;
  for (const r of changes.resources) {
    if (added.has(r.connection_id) || removed.has(r.connection_id)) continue;
    if (r.scope_before === null && r.scope_after !== null) {
      lines.push({
        section: 'Resources',
        text: `${r.display_name}: resource set ${r.position} added`,
        consequence: 'Its resources are judged by its own permissions from the next call.',
        warn: false,
      });
    }
    if (r.scope_after === null && r.scope_before !== null) {
      lines.push({
        section: 'Resources',
        text: `${r.display_name}: resource set ${r.position} removed`,
        consequence: 'Its resources are no longer reached unless another set holds them.',
        warn: true,
      });
      continue;
    }
    if (r.scope_before !== r.scope_after && r.scope_before !== null && r.scope_after !== null) {
      lines.push({
        section: 'Resources',
        text: `${where(r)}: ${SCOPE_WORDS[r.scope_before]} → ${SCOPE_WORDS[r.scope_after]}`,
        consequence:
          r.scope_after === 'connection'
            ? 'Resources found later on the account are reached too.'
            : null,
        warn: false,
      });
    }
    for (const id of r.added) {
      lines.push({
        section: 'Resources',
        text: `${where(r)}: ${naming.resource(r.connection_id, id)} added`,
        consequence: 'Reached from the next call.',
        warn: false,
      });
    }
    for (const id of r.removed) {
      lines.push({
        section: 'Resources',
        text: `${where(r)}: ${naming.resource(r.connection_id, id)} removed`,
        consequence: 'No longer reached: a call that cites it is refused from the next one.',
        warn: true,
      });
    }
  }
  for (const p of changes.permissions_added) {
    lines.push({
      section: 'Permissions',
      text: `Added: ${naming.risk(p.risk_id)} — ${p.quota} a period, ${perWindow(p.rate_limit.max, p.rate_limit.window_seconds)}, ${askWords(p.gate)}`,
      consequence: 'Starts at zero.',
      warn: false,
    });
  }
  for (const p of changes.permissions_removed) {
    const closing = source.openRequests.filter((r) => r.risk_ids.includes(p.risk_id)).length;
    lines.push({
      section: 'Permissions',
      text: `Removed: ${naming.risk(p.risk_id)}`,
      consequence: `Refused from the next call.${
        closing > 0
          ? ` ${closing === 1 ? 'The request' : `${closing} requests`} waiting about it ${closing === 1 ? 'is' : 'are'} closed.`
          : ''
      }`,
      warn: true,
    });
  }
  for (const c of changes.permissions_changed) {
    const { before, after } = c;
    const parts: string[] = [];
    if (before.quota !== after.quota) parts.push(`limit ${before.quota} → ${after.quota}`);
    if (
      before.rate_limit.max !== after.rate_limit.max ||
      before.rate_limit.window_seconds !== after.rate_limit.window_seconds
    ) {
      parts.push(
        `rate ${perWindow(before.rate_limit.max, before.rate_limit.window_seconds)} → ${perWindow(after.rate_limit.max, after.rate_limit.window_seconds)}`,
      );
    }
    if (before.gate !== after.gate)
      parts.push(`${askWords(before.gate)} → ${askWords(after.gate)}`);
    const used = source.used[policyLineKey(c.resource_set_id, c.risk_id)] ?? 0;
    const usedUp = after.quota < before.quota && used >= after.quota;
    lines.push({
      section: 'Permissions',
      text: `${naming.risk(c.risk_id)}: ${parts.join(', ')}`,
      consequence: usedUp
        ? `Already used up: ${used} used this period. Refused until the limits reset.`
        : null,
      warn: usedUp,
    });
  }
  return lines;
}
