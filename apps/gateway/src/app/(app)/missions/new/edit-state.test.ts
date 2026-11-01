/**
 * The creation form in edit mode: prefilled from the mission, the draft it sends
 * back, and what the confirmation says of each change.
 */
import { describe, expect, it } from 'vitest';

import { judgeEdit, type MissionSnapshot } from '@/lib/missions/mission-edit';
import { acmeConnection } from '../../../../../tests/support/missions/testing';

import { changeLines, editDraftOf, initialEditState } from './edit-state';
import { expiryOf, RESOURCE_CHOICES, toggleRisk, type FormState } from './form-state';

const NOW = new Date('2026-10-24T09:00:00.000Z');
const acme = acmeConnection();
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
      resource_scope: 'selected',
      resource_ids: ['res-app-staging'],
      policy: [
        {
          risk_id: 'acme.read',
          quota: 10,
          rate_limit: { max: 10, window_seconds: 60 },
          gate: 'auto',
        },
      ],
    },
  ],
};

const naming = { resource: (_c: string, id: string) => id, risk: (id: string) => id };

describe('the creation form in edit mode', () => {
  it('starts from the mission and sends it back unchanged', () => {
    const state = initialEditState(context, SNAPSHOT);
    expect(state.name).toBe('Ship it');
    expect(state.expiry).toBe('keep');
    expect(expiryOf(state, NOW)).toBe(SNAPSHOT.expires_at);
    expect(state.connections[acme.id]).toMatchObject({
      included: true,
      resourceScope: 'selected',
      resourceIds: ['res-app-staging'],
    });
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
          resource_scope: 'all',
          resource_ids: [],
          policy: [],
        },
      ],
    };
    const state: FormState = { ...initialEditState(context, snapshot), period: 'hour' };
    const draft = editDraftOf(context, state, snapshot, NOW);
    expect(draft.period).toEqual(snapshot.period);
    expect(draft.connections.map((c) => c.connection_id)).toEqual([acme.id, 'conn-lost']);
  });

  it('lists every change with what it means', () => {
    const state = initialEditState(context, SNAPSHOT);
    const cs = state.connections[acme.id];
    if (!cs) throw new Error('fixture');
    const read = acme.risks.find((r) => r.risk_id === 'acme.read');
    if (!read) throw new Error('fixture');
    // Remove the read permission, add scratch.
    const next: FormState = {
      ...state,
      connections: {
        ...state.connections,
        [acme.id]: {
          ...toggleRisk(acme, cs, read),
          resourceIds: ['res-app-staging', 'res-scratch'],
        },
      },
    };
    const lowered: FormState = {
      ...state,
      connections: {
        ...state.connections,
        [acme.id]: {
          ...cs,
          entries: { 'acme.read': { quota: '2', rateMax: '10', rateWindow: '60', gate: 'auto' } },
        },
      },
    };
    const judgedRemoval = judgeEdit(
      { connections: context, now: NOW },
      SNAPSHOT,
      editDraftOf(context, next, SNAPSHOT, NOW),
    );
    const removal = changeLines(
      judgedRemoval.changes,
      {
        used: {},
        openRequests: [{ id: 'r1', kind: 'claim', risk_ids: ['acme.read'] }],
      },
      naming,
    );
    expect(removal.map((l) => [l.section, l.text])).toEqual(
      expect.arrayContaining([
        ['Resources', 'Acme main: res-scratch added'],
        ['Permissions', 'Removed: acme.read'],
      ]),
    );
    expect(removal.find((l) => l.text === 'Removed: acme.read')?.consequence).toBe(
      'Refused from the next call. The request waiting about it is closed.',
    );

    const judgedLower = judgeEdit(
      { connections: context, now: NOW },
      SNAPSHOT,
      editDraftOf(context, lowered, SNAPSHOT, NOW),
    );
    const [limit] = changeLines(
      judgedLower.changes,
      { used: { 'acme.read': 4 }, openRequests: [] },
      naming,
    );
    expect(limit).toMatchObject({
      section: 'Permissions',
      text: 'acme.read: limit 10 → 2',
      warn: true,
      consequence: 'Already used up: 4 used this period. Refused until the limits reset.',
    });
  });

  it('says a resource found later can be added to the same mission', () => {
    expect(RESOURCE_CHOICES.find((c) => c.id === 'all')?.explanation).toBe(
      'The resources listed today, and the ones this mission creates. One found later is not reached until the creator adds it to this mission with “Edit mission”.',
    );
  });
});
