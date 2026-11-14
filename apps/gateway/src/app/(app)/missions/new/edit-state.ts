/**
 * The mission screen in edit mode (ADR mission-editable-after-issuance): the cards
 * prefilled from a mission and the draft it sends back — pure, so they are
 * unit-tested without a browser. The judgement is `judgeEdit`, the function the
 * server runs again when the edit is saved; nothing is asked before saving.
 */
import type { RiskId } from '@vaubaan/shared';

import type {
  IssuanceConnection,
  MissionDraft,
  ResolvedDraftConnection,
} from '@/lib/missions/model';
import { draftConnectionOf, type MissionSnapshot } from '@/lib/missions/mission-edit';
import { trustLevelsOf, type TrustLevel } from '@/lib/missions/macro-actions';

import {
  draftOf,
  initialFormState,
  loadResolved,
  periodChoiceOf,
  raiseMacroAction,
  replaceCard,
  type FormState,
} from './form-state';

/**
 * A trust-raise the edit opens with (risk model §4.7): the macro-action of the set,
 * and the level it goes to. The server checked it is offered.
 */
export interface EditRaise {
  readonly connectionId: string;
  readonly resourceSetId: string;
  readonly macroActionId: string;
  readonly to: TrustLevel;
}

/**
 * The edit state with the raise applied, and the hand-edited lines it replaces. A raise
 * whose card the screen does not show leaves the state as it is.
 */
export function raisedEditState(
  context: readonly IssuanceConnection[],
  state: FormState,
  raise: EditRaise,
): { readonly state: FormState; readonly replaced: readonly RiskId[] } {
  const connection = context.find((c) => c.id === raise.connectionId);
  const card = state.cards.find(
    (c) => c.connectionId === raise.connectionId && c.id === raise.resourceSetId,
  );
  if (!connection || !card) return { state, replaced: [] };
  const raised = raiseMacroAction(connection, card, raise.macroActionId, raise.to);
  return { state: replaceCard(state, raised.card), replaced: raised.replaced };
}

/** What the edit form knows of the mission it edits. */
export interface EditSource {
  readonly missionId: string;
  readonly revision: string;
  readonly snapshot: MissionSnapshot;
  /** "Raise" of a trust-raise proposal: the edit opens at the new level. */
  readonly raise?: EditRaise & {
    readonly label: string;
    readonly from: TrustLevel;
    /** The account, and its set when it has several. */
    readonly where: string;
  };
}

/** The mission's accounts as the form loads them: their stored selection and lines. */
export function resolvedOfSnapshot(snapshot: MissionSnapshot): ResolvedDraftConnection[] {
  return snapshot.connections.map((c) => ({
    connection_id: c.connection_id,
    resource_sets: c.resource_sets.map((set) => ({
      ...(set.id !== null ? { id: set.id } : {}),
      resources: { scope: 'selected' as const, resource_ids: [...set.resource_ids] },
      future: set.future,
      env: set.env,
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
  const loaded = loadResolved(context, initialFormState(), resolvedOfSnapshot(snapshot));
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
