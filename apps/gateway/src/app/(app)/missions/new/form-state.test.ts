import { describe, expect, it } from 'vitest';

import { previewDraft } from '@/server/missions/preview';
import { ACME_HIDDEN, ACME_RESOURCES, ACME_STALE, acmeConnection } from '@/server/missions/testing';

import {
  applyPreset,
  availableCount,
  backToPreset,
  clearAll,
  defaultEntryFor,
  describeSkipped,
  discardsEdits,
  draftOf,
  dropUnresolvable,
  editorRows,
  enterCustom,
  expiryOf,
  explainPreset,
  filterRows,
  initialFormState,
  loadResolved,
  presetChoiceLabel,
  presetDigest,
  startFromPreset,
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
      mode: 'preset',
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

describe('creation form — a preset explains itself', () => {
  function explained(cs: ConnectionState, presetId: string, connection = acme) {
    const explanation = explainPreset(connection, cs, presetId);
    if (!explanation) throw new Error(`preset ${presetId} not explained`);
    return explanation;
  }

  it('says what passes, what waits for an approval and what is left out, with each budget', () => {
    const developer = explained(included(), 'developer');
    expect(
      developer.auto.map((l) => [l.risk.label, l.risk.env, l.quota, l.rate_limit.max]),
    ).toEqual([
      ['Read things', null, 1000, 120],
      ['Write a thing', 'staging', 200, 30],
    ]);
    expect(developer.approval.map((l) => l.risk.risk_id)).toEqual(['acme[staging].bulk-delete']);
    expect(developer.leftOut.map((f) => [f.base_id, f.variants.map((v) => v.env)])).toEqual([
      ['acme.write', ['prod']],
      ['acme.admin', [null]],
      ['acme.legacy-export', [null]],
      ['acme.uncategorized-write', [null]],
    ]);
    expect(developer.skipped).toEqual([]);
    expect(presetChoiceLabel(developer)).toBe('3 risks · 1 needs approval');
    expect(presetDigest(developer)).toBe(
      '2 allowed without asking · 1 needs your approval · 4 not included',
    );
  });

  it('is the policy the preset fills: the card and the entries cannot disagree', () => {
    for (const preset of acme.presets) {
      const cs = included(preset.id);
      const explanation = explained(cs, preset.id);
      expect(
        [...explanation.auto, ...explanation.approval].map((l) => l.risk.risk_id).sort(),
      ).toEqual(Object.keys(cs.entries).sort());
    }
  });

  it('names the entries a selection cannot resolve, with the label a resource would need', () => {
    const prodOnly = setResources(acme, included(), ['res-app-prod']);
    const developer = explained(prodOnly, 'developer');
    expect(developer.auto.map((l) => l.risk.risk_id)).toEqual(['acme.read']);
    expect(developer.skipped.map((f) => [f.label, f.why])).toEqual([
      ['Write a thing', 'needs a selected resource labelled "staging"'],
      ['Delete things in bulk', 'needs a selected resource labelled "staging"'],
    ]);
    // What cannot be accepted here is not offered as "not included".
    expect(developer.leftOut.flatMap((f) => f.variants.map((v) => v.risk_id))).toEqual([
      'acme[prod].write',
      'acme.admin',
      'acme.legacy-export',
      'acme.uncategorized-write',
    ]);
    expect(presetDigest(developer)).toBe(
      '1 allowed without asking · 0 need your approval · 4 not included · 2 entries of the preset left out here',
    );
    // A base-id entry no selected resource can resolve names every environment it could use.
    const unlabelled = setResources(acme, included(), ['res-scratch']);
    expect(explained(unlabelled, 'writer').skipped.map((f) => f.why)).toEqual([
      'needs a selected resource labelled "staging" or "prod"',
    ]);
  });

  it('names the entries outside the authority', () => {
    const narrow = acmeConnection({ authority: ['acme.read'] });
    const developer = explained(included(), 'developer', narrow);
    expect(developer.skipped.map((f) => f.why)).toEqual([
      'outside your authority',
      'outside your authority',
    ]);
    expect(developer.leftOut).toEqual([]);
    expect(presetChoiceLabel(developer)).toBe('1 risk');
  });

  it('answers null for an id that is not a preset of the plugin', () => {
    expect(explainPreset(acme, included(), 'no-such-preset')).toBeNull();
  });
});

describe('creation form — Preset or Custom', () => {
  it('opens the editor on the preset values, with nothing to lose yet', () => {
    const preset = included('developer');
    const custom = enterCustom(preset);
    expect(custom.mode).toBe('custom');
    expect(custom.entries).toEqual(preset.entries);
    expect(custom.presetId).toBe('developer');
    expect(discardsEdits(custom)).toBe(false);
    // Untouched, the policy still follows the resource selection.
    expect(Object.keys(setResources(acme, custom, ['res-app-prod']).entries)).toEqual([
      'acme.read',
    ]);
  });

  it('warns before going back once something was edited, then restores the preset as it is', () => {
    const edited = updateEntry(enterCustom(included('developer')), 'acme.read', { quota: '7' });
    expect(discardsEdits(edited)).toBe(true);
    const back = backToPreset(acme, edited);
    expect(back).toMatchObject({ mode: 'preset', presetId: 'developer', edited: false });
    expect(back.entries['acme.read']?.quota).toBe('1000');
    expect(discardsEdits(back)).toBe(false);
  });

  it('never warns in Preset mode, and goes back to an empty policy when no preset was picked', () => {
    expect(discardsEdits(included('developer'))).toBe(false);
    const fromScratch = toggleRisk(acme, enterCustom(included()), riskOf('acme.read'));
    expect(discardsEdits(fromScratch)).toBe(true);
    expect(backToPreset(acme, fromScratch)).toMatchObject({ mode: 'preset', entries: {} });
  });

  it('"start from preset" pre-fills the editor and keeps it open', () => {
    const custom = startFromPreset(acme, enterCustom(included()), 'reader');
    expect(custom).toMatchObject({ mode: 'custom', presetId: 'reader', edited: false });
    expect(Object.keys(custom.entries)).toEqual(['acme.read']);
    expect(custom.entries['acme.read']?.quota).toBe('100');
  });

  it('sends the same explicit draft in both modes: the mode is not part of the mission', () => {
    const preset = included('developer');
    const draftIn = (cs: ConnectionState) =>
      draftOf(context, withConnection({ ...initialFormState(context), name: 'm' }, cs), NOW);
    expect(draftIn(enterCustom(preset))).toEqual(draftIn(preset));
    expect(JSON.stringify(draftIn(enterCustom(preset)))).not.toMatch(/developer|custom|mode/);
  });

  it('loads a duplicated mission or a proposal as a custom policy', () => {
    const source = previewOf(included('developer'));
    const loaded = connectionOf(loadResolved(context, initialFormState(context), source.resolved));
    expect(loaded).toMatchObject({ mode: 'custom', edited: true, included: true });
  });
});

describe('creation form — the Custom editor', () => {
  it('lists every explicit id of the catalog, and says why one cannot be ticked', () => {
    const narrow = acmeConnection({ authority: ['acme.read', 'acme[staging].write'] });
    const cs = setResources(narrow, enterCustom(included()), ['res-app-prod']);
    const rows = editorRows(narrow, toggleRisk(narrow, cs, riskOf('acme.read')));
    expect(rows.map((r) => r.risk.risk_id)).toEqual(narrow.risks.map((r) => r.risk_id));
    const status = Object.fromEntries(rows.map((r) => [r.risk.risk_id, r.unavailable]));
    expect(status['acme.read']).toBeNull();
    expect(status['acme[staging].write']).toBe('no selected resource is labelled "staging"');
    expect(status['acme.admin']).toBe('outside your authority');
    expect(rows.filter((r) => r.accepted).map((r) => r.risk.risk_id)).toEqual(['acme.read']);
  });

  it('searches the label, the id, the reason, the environment, the kind and the level', () => {
    const rows = editorRows(acme, enterCustom(included('developer')));
    const ids = (query: string, filter: Parameters<typeof filterRows>[2] = 'all') =>
      filterRows(rows, query, filter).map((r) => r.risk.risk_id);
    expect(ids('')).toHaveLength(rows.length);
    expect(ids('bulk')).toEqual(['acme[staging].bulk-delete']);
    expect(ids('WRITE prod')).toEqual(['acme[prod].write']);
    expect(ids('posture')).toEqual(['acme.admin']);
    expect(ids('destructive')).toEqual(['acme[staging].bulk-delete']);
    expect(ids('nothing matches this')).toEqual([]);
  });

  it('filters on what is accepted, what could be, and what is unavailable', () => {
    const narrow = acmeConnection({
      authority: ['acme.read', 'acme[staging].write', 'acme[prod].write'],
    });
    const rows = editorRows(narrow, enterCustom(applyPreset(narrow, included(), 'developer')));
    const ids = (filter: Parameters<typeof filterRows>[2]) =>
      filterRows(rows, '', filter).map((r) => r.risk.risk_id);
    expect(ids('accepted')).toEqual(['acme.read', 'acme[staging].write']);
    expect(ids('available')).toEqual(['acme[prod].write']);
    expect(ids('unavailable')).toEqual([
      'acme[staging].bulk-delete',
      'acme.admin',
      'acme.legacy-export',
      'acme.uncategorized-write',
    ]);
    expect(filterRows(rows, 'write', 'accepted').map((r) => r.risk.risk_id)).toEqual([
      'acme[staging].write',
    ]);
  });
});
