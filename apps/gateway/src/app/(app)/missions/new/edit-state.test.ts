/**
 * The creation form in edit mode: prefilled from the mission, the draft it sends
 * back.
 */
import { describe, expect, it } from 'vitest';

import { judgeEdit, type MissionSnapshot } from '@/lib/missions/mission-edit';
import { ACME_RESOURCES, acmeConnection } from '../../../../../tests/support/missions/testing';

import { editDraftOf, initialEditState, raisedEditState } from './edit-state';
import { expiryOf, type FormState } from './form-state';

const NOW = new Date('2026-10-24T09:00:00.000Z');
// `scratch` labelled staging: it may join the staging set (a set holds one environment).
const acme = acmeConnection({
  resources: ACME_RESOURCES.map((r) => (r.id === 'res-scratch' ? { ...r, env: 'staging' } : r)),
});
const context = [acme];

const SNAPSHOT: MissionSnapshot = {
  name: 'Ship it',
  expires_at: '2026-11-30T12:00:00.000Z',
  period: { kind: 'recurring', length_seconds: 86_400 },
  connections: [
    {
      connection_id: acme.id,
      provider: 'acme',
      display_name: acme.display_name,
      resource_sets: [
        {
          key: 'set-1',
          id: 'set-1',
          position: 1,
          resource_ids: ['res-app-staging'],
          future: false,
          env: 'staging',
          policy: [
            {
              resource_set_id: 'set-1',
              risk_id: 'acme.read',
              quota: 10,
              rate_limit: { max: 10, window_seconds: 60 },
              gate: 'auto',
            },
          ],
        },
      ],
    },
  ],
};

describe('the mission screen in edit mode', () => {
  it('starts from the mission and sends it back unchanged', () => {
    const state = initialEditState(context, SNAPSHOT);
    expect(state.name).toBe('Ship it');
    expect(state.expiry).toBe('keep');
    expect(expiryOf(state, NOW)).toBe(SNAPSHOT.expires_at);
    expect(state.cards).toMatchObject([
      { id: 'set-1', connectionId: acme.id, resourceIds: ['res-app-staging'], env: 'staging' },
    ]);
    const judged = judgeEdit(
      { connections: context, now: NOW },
      SNAPSHOT,
      editDraftOf(context, state, SNAPSHOT, NOW),
    );
    expect(judged.ok).toBe(true);
    expect(judged.changes.permissions_changed).toEqual([]);
    expect(judged.changes.expires_at).toBeNull();
  });

  it('carries back an account the form cannot show, and keeps the mission’s period', () => {
    const snapshot: MissionSnapshot = {
      ...SNAPSHOT,
      connections: [
        ...SNAPSHOT.connections,
        {
          connection_id: 'conn-lost',
          provider: 'lost',
          display_name: 'Lost',
          resource_sets: [
            {
              key: 'set-lost',
              id: 'set-lost',
              position: 1,
              resource_ids: [],
              future: false,
              env: null,
              policy: [],
            },
          ],
        },
      ],
    };
    const state: FormState = { ...initialEditState(context, snapshot), period: 'hour' };
    const draft = editDraftOf(context, state, snapshot, NOW);
    expect(draft.period).toEqual(snapshot.period);
    expect(draft.connections.map((c) => c.connection_id)).toEqual([acme.id, 'conn-lost']);
  });
});

describe('the mission screen in edit mode — opened by "Raise"', () => {
  it('raises the macro-action of the set it names, and judges as an ordinary edit', () => {
    const snapshot: MissionSnapshot = {
      ...SNAPSHOT,
      connections: [
        {
          ...SNAPSHOT.connections[0]!,
          resource_sets: [
            { ...SNAPSHOT.connections[0]!.resource_sets[0]!, trust_levels: { read: 'careful' } },
          ],
        },
      ],
    };
    const start = initialEditState(context, snapshot);
    const { state, replaced } = raisedEditState(context, start, {
      connectionId: acme.id,
      resourceSetId: 'set-1',
      macroActionId: 'read',
      to: 'trusting',
    });
    expect(state.cards[0]?.trustLevels).toEqual({ read: 'trusting' });
    expect(replaced).toEqual(['acme.read']);
    const judged = judgeEdit(
      { connections: context, now: NOW },
      snapshot,
      editDraftOf(context, state, snapshot, NOW),
    );
    expect(judged.ok).toBe(true);
    expect(judged.changes.permissions_changed.map((c) => c.risk_id)).toEqual(['acme.read']);

    const elsewhere = raisedEditState(context, start, {
      connectionId: acme.id,
      resourceSetId: 'not-a-set',
      macroActionId: 'read',
      to: 'trusting',
    });
    expect(elsewhere.state).toBe(start);
  });
});
