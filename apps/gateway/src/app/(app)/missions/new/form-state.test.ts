import { describe, expect, it } from 'vitest';

import { previewDraft } from '@/server/missions/preview';
import { ACME_HIDDEN, ACME_RESOURCES, ACME_STALE, acmeConnection } from '@/server/missions/testing';

import {
  applyPreset,
  availableCount,
  clearAll,
  defaultEntryFor,
  describeSkipped,
  draftOf,
  dropUnresolvable,
  expiryOf,
  initialFormState,
  loadResolved,
  periodChoiceOf,
  periodOf,
  presetSkipped,
  selectAll,
  setIncluded,
  setResources,
  toggleRisk,
  updateEntry,
  type ConnectionState,
  type FormState,
} from './form-state';

const NOW = new Date('2026-10-13T09:00:00.000Z');
const acme = acmeConnection();
const context = [acme];

function riskOf(id: string) {
  const risk = acme.risks.find((r) => r.risk_id === id);
  if (!risk) throw new Error(`fixture risk ${id} missing`);
  return risk;
}

function connectionOf(state: FormState): ConnectionState {
  const cs = state.connections[acme.id];
  if (!cs) throw new Error('connection state missing');
  return cs;
}

function withConnection(state: FormState, cs: ConnectionState): FormState {
  return { ...state, connections: { ...state.connections, [acme.id]: cs } };
}

function included(presetId = ''): ConnectionState {
  const cs = setIncluded(connectionOf(initialFormState(context)), true);
  return presetId ? applyPreset(acme, cs, presetId) : cs;
}

function previewOf(cs: ConnectionState, name = 'Mission') {
  const state = withConnection({ ...initialFormState(context), name }, cs);
  return previewDraft({ connections: context, now: NOW }, draftOf(context, state, NOW));
}

describe('creation form — initial state', () => {
  it('includes nothing, selects every resource, defaults to a daily period and no expiry', () => {
    const state = initialFormState(context);
    expect(connectionOf(state)).toEqual({
      included: false,
      resourceIds: ['res-app-staging', 'res-app-prod', 'res-scratch'],
      presetId: '',
      entries: {},
      edited: false,
    });
    expect(draftOf(context, state, NOW)).toEqual({
      name: '',
      connections: [],
      period: { kind: 'recurring', length_seconds: 86_400 },
      expires_at: null,
    });
  });
});

describe('creation form — curated resources', () => {
  const curated = acmeConnection({ resources: [...ACME_RESOURCES, ACME_HIDDEN, ACME_STALE] });

  it('starts without the hidden and the stale resources', () => {
    const cs = initialFormState([curated]).connections[curated.id];
    expect(cs?.resourceIds).toEqual(['res-app-staging', 'res-app-prod', 'res-scratch']);
  });

  it('issues with a hidden resource the creator ticked', () => {
    const start = initialFormState([curated]);
    const cs = applyPreset(
      curated,
      setResources(curated, setIncluded(start.connections[curated.id]!, true), [
        'res-app-prod',
        'res-archive',
      ]),
      'reader',
    );
    const state = { ...start, name: 'm', connections: { [curated.id]: cs } };
    const preview = previewDraft(
      { connections: [curated], now: NOW },
      draftOf([curated], state, NOW),
    );
    expect(preview.ok).toBe(true);
    expect(preview.connections[0]?.resources.map((r) => r.ref)).toEqual(['app-prod', 'archive']);
  });
});

describe('creation form — presets', () => {
  it('fills the policy from the preset in one step, and the draft is issuable', () => {
    const cs = included('developer');
    expect(Object.keys(cs.entries)).toEqual([
      'acme.read',
      'acme[staging].write',
      'acme[staging].bulk-delete',
    ]);
    expect(cs.entries['acme[staging].bulk-delete']).toEqual({
      quota: '5',
      rateMax: '1',
      rateWindow: '60',
      gate: 'approval',
    });
    expect(cs.edited).toBe(false);
    expect(previewOf(cs).ok).toBe(true);
  });

  it('sends the explicit enumeration, never the preset reference', () => {
    const draft = draftOf(
      context,
      withConnection(initialFormState(context), included('reader')),
      NOW,
    );
    expect(draft.connections).toEqual([
      {
        connection_id: 'conn-acme',
        resources: {
          scope: 'selected',
          resource_ids: ['res-app-staging', 'res-app-prod', 'res-scratch'],
        },
        preset: null,
        policy: [
          {
            risk_id: 'acme.read',
            quota: 100,
            rate_limit: { max: 60, window_seconds: 60 },
            gate: 'auto',
          },
        ],
      },
    ]);
  });

  it('follows the resource selection while untouched, and says what the preset left out', () => {
    const prodOnly = setResources(acme, included('developer'), ['res-app-prod']);
    expect(Object.keys(prodOnly.entries)).toEqual(['acme.read']);
    expect(describeSkipped(presetSkipped(acme, prodOnly))).toBe(
      '2 preset entries left out: 2 need a selected resource labelled "staging".',
    );
    const back = setResources(acme, prodOnly, ['res-app-prod', 'res-app-staging']);
    expect(Object.keys(back.entries)).toHaveLength(3);
    expect(describeSkipped(presetSkipped(acme, back))).toBeNull();
  });

  it('keeps the creator’s entries once edited, and flags the ones that no longer resolve', () => {
    const edited = updateEntry(included('developer'), 'acme.read', { quota: '7' });
    const prodOnly = setResources(acme, edited, ['res-app-prod']);
    expect(Object.keys(prodOnly.entries)).toHaveLength(3);
    expect(prodOnly.entries['acme.read']?.quota).toBe('7');
    const preview = previewOf(prodOnly);
    expect(preview.issues.map((i) => i.code)).toEqual(['unresolvable-env']);
    const cleaned = dropUnresolvable(acme, prodOnly);
    expect(Object.keys(cleaned.entries)).toEqual(['acme.read']);
    expect(previewOf(cleaned).ok).toBe(true);
  });

  it('expands a base-id preset entry per selected environment', () => {
    expect(Object.keys(included('writer').entries)).toEqual([
      'acme[staging].write',
      'acme[prod].write',
    ]);
    const unlabelled = setResources(acme, included('writer'), ['res-scratch']);
    expect(unlabelled.entries).toEqual({});
    expect(describeSkipped(presetSkipped(acme, unlabelled))).toBe(
      '1 preset entry left out: 1 needs a selected resource with an environment label.',
    );
  });

  it('reports preset entries outside the authority', () => {
    const narrow = acmeConnection({ authority: ['acme.read'] });
    const cs = applyPreset(narrow, included(), 'developer');
    expect(Object.keys(cs.entries)).toEqual(['acme.read']);
    expect(describeSkipped(presetSkipped(narrow, cs))).toBe(
      '2 preset entries left out: 2 outside your authority.',
    );
  });

  it('empties the policy when the preset is cleared', () => {
    expect(applyPreset(acme, included('developer'), '').entries).toEqual({});
  });
});

describe('creation form — per-risk detail', () => {
  it('overrides one risk of a preset and issues the adjusted values', () => {
    let cs = included('developer');
    cs = updateEntry(cs, 'acme.read', { quota: '25', rateMax: '3', rateWindow: '10' });
    cs = updateEntry(cs, 'acme[staging].write', { gate: 'approval' });
    expect(cs.edited).toBe(true);
    const preview = previewOf(cs);
    expect(preview.ok).toBe(true);
    expect(preview.policy.slice(0, 2)).toEqual([
      { risk_id: 'acme.read', quota: 25, rate_limit: { max: 3, window_seconds: 10 }, gate: 'auto' },
      {
        risk_id: 'acme[staging].write',
        quota: 200,
        rate_limit: { max: 30, window_seconds: 60 },
        gate: 'approval',
      },
    ]);
  });

  it('gives a hand-ticked risk the chosen preset’s budget, else another preset’s, else none', () => {
    const selected = acme.resources;
    expect(defaultEntryFor(acme, 'reader', riskOf('acme.read'), selected).quota).toBe('100');
    expect(defaultEntryFor(acme, 'developer', riskOf('acme.read'), selected).quota).toBe('1000');
    // Not in `reader`: the first preset that carries it lends its values.
    expect(defaultEntryFor(acme, 'reader', riskOf('acme[staging].bulk-delete'), selected)).toEqual({
      quota: '5',
      rateMax: '1',
      rateWindow: '60',
      gate: 'approval',
    });
    // Carried by `writer` under its base id.
    expect(defaultEntryFor(acme, 'reader', riskOf('acme[prod].write'), selected).quota).toBe('50');
    expect(defaultEntryFor(acme, 'reader', riskOf('acme.admin'), selected)).toEqual({
      quota: '',
      rateMax: '',
      rateWindow: '',
      gate: 'auto',
    });
  });

  it('blocks issuance while a ticked risk has no budget, until the creator types one', () => {
    let cs = toggleRisk(acme, included('reader'), riskOf('acme.admin'));
    expect(previewOf(cs).issues.map((i) => i.code)).toEqual(['missing-budget']);
    cs = updateEntry(cs, 'acme.admin', { quota: '2', rateMax: '1', rateWindow: '60' });
    expect(previewOf(cs).ok).toBe(true);
    cs = updateEntry(cs, 'acme.admin', { quota: 'lots' });
    expect(previewOf(cs).issues.map((i) => i.code)).toEqual(['invalid-budget']);
  });

  it('unticks a risk', () => {
    const cs = toggleRisk(acme, included('developer'), riskOf('acme.read'));
    expect(Object.keys(cs.entries)).toEqual(['acme[staging].write', 'acme[staging].bulk-delete']);
  });

  it('"select all" yields an enumerated list: every held, resolvable risk, one id each', () => {
    const cs = selectAll(acme, included('developer'));
    expect(Object.keys(cs.entries).sort()).toEqual(
      [
        'acme.read',
        'acme[staging].write',
        'acme[prod].write',
        'acme[staging].bulk-delete',
        'acme.admin',
      ].sort(),
    );
    expect(Object.keys(cs.entries).every((id) => !/[*?]/.test(id))).toBe(true);
    // Neither the fallback nor a deprecated entry is part of "all".
    expect(cs.entries['acme.uncategorized-write']).toBeUndefined();
    expect(cs.entries['acme.legacy-export']).toBeUndefined();
    // The preset's values are kept for what it already carried.
    expect(cs.entries['acme.read']?.quota).toBe('1000');
    const draft = draftOf(context, withConnection(initialFormState(context), cs), NOW);
    expect(draft.connections[0]?.policy?.map((e) => e.risk_id)).toEqual([
      'acme.read',
      'acme[staging].write',
      'acme[prod].write',
      'acme[staging].bulk-delete',
      'acme.admin',
    ]);
  });

  it('"select all" stays inside the authority and the selected resources', () => {
    const narrow = acmeConnection({ authority: ['acme.read', 'acme[prod].write', 'acme.admin'] });
    const cs = selectAll(narrow, setResources(narrow, included(), ['res-app-staging']));
    expect(Object.keys(cs.entries).sort()).toEqual(['acme.admin', 'acme.read']);
  });

  it('counts what could be ticked: held and resolvable with the selection', () => {
    expect(availableCount(acme, included())).toBe(7);
    expect(availableCount(acme, setResources(acme, included(), ['res-app-prod']))).toBe(5);
    const narrow = acmeConnection({ authority: ['acme.read'] });
    expect(availableCount(narrow, included())).toBe(1);
  });

  it('lets the creator tick the fallback knowingly, and clear everything', () => {
    const cs = toggleRisk(acme, included(), riskOf('acme.uncategorized-write'));
    expect(Object.keys(cs.entries)).toEqual(['acme.uncategorized-write']);
    expect(clearAll(cs).entries).toEqual({});
  });
});

describe('creation form — period, expiry, loading a draft', () => {
  it('maps the period choices both ways', () => {
    expect(periodOf('one-off')).toEqual({ kind: 'one-off' });
    expect(periodOf('week')).toEqual({ kind: 'recurring', length_seconds: 604_800 });
    expect(periodChoiceOf({ kind: 'one-off' })).toBe('one-off');
    expect(periodChoiceOf({ kind: 'recurring', length_seconds: 3600 })).toBe('hour');
    expect(periodChoiceOf({ kind: 'recurring', length_seconds: 12_345 })).toBe('day');
  });

  it('computes the expiry: never, relative, or the date typed', () => {
    expect(expiryOf({ expiry: 'never', expiryCustom: '' }, NOW)).toBeNull();
    expect(expiryOf({ expiry: '7d', expiryCustom: '' }, NOW)).toBe('2026-10-20T09:00:00.000Z');
    expect(expiryOf({ expiry: 'custom', expiryCustom: '2026-12-01T10:00:00.000Z' }, NOW)).toBe(
      '2026-12-01T10:00:00.000Z',
    );
    expect(expiryOf({ expiry: 'custom', expiryCustom: '' }, NOW)).toBe('unset');
  });

  it('loads a resolved draft: included, ticked with its values, protected from presets', () => {
    const source = previewOf(updateEntry(included('developer'), 'acme.read', { quota: '9' }));
    const loaded = loadResolved(context, initialFormState(context), source.resolved);
    const cs = connectionOf(loaded);
    expect(cs.included).toBe(true);
    expect(cs.edited).toBe(true);
    expect(cs.entries['acme.read']?.quota).toBe('9');
    expect(previewOf(cs).policy).toEqual(source.policy);
  });

  it('shows experimental providers when the loaded draft uses one', () => {
    const experimental = acmeConnection({ experimental: true });
    const source = previewDraft(
      { connections: [experimental], now: NOW },
      {
        name: 'm',
        connections: [{ connection_id: 'conn-acme', preset: 'reader' }],
        period: { kind: 'one-off' },
        expires_at: null,
      },
    );
    const loaded = loadResolved([experimental], initialFormState([experimental]), source.resolved);
    expect(loaded.showExperimental).toBe(true);
  });
});
