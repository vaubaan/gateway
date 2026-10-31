import { describe, expect, it } from 'vitest';

import { everythingIHold } from '@/server/missions/everything-i-hold';
import type { MacroActionTrustLevels } from '@/server/missions/macro-actions';
import { previewDraft } from '@/server/missions/preview';
import { ACME_HIDDEN, ACME_RESOURCES, ACME_STALE, acmeConnection } from '@/server/missions/testing';

import {
  applyTrustLevels,
  applyEverything,
  availableCount,
  chosenPalier,
  clearAll,
  defaultEntryFor,
  describeEverything,
  discardsEdits,
  draftOf,
  draftResourcesOf,
  dropUnresolvable,
  editorRows,
  expiryOf,
  explainEverything,
  filterRows,
  initialConnectionState,
  initialFormState,
  issueSentence,
  loadResolved,
  macroActionRows,
  periodChoiceOf,
  periodOf,
  policyCounts,
  resetEdits,
  RESOURCE_CHOICES,
  selectAll,
  setIncluded,
  setMacroAction,
  setResourceScope,
  setResources,
  setView,
  toggleRisk,
  updateEntry,
  type ConnectionState,
  type FormState,
} from './form-state';

const NOW = new Date('2026-10-13T09:00:00.000Z');
const acme = acmeConnection();
const context = [acme];

/** Reads at Confiant, changes at Prudent: the usual start of a working mission. */
const WORKING: MacroActionTrustLevels = { read: 'confiant', change: 'prudent' };

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

function included(trustLevels: MacroActionTrustLevels = {}, connection = acme): ConnectionState {
  const cs = setIncluded(connectionOf(initialFormState(context)), true);
  return Object.keys(trustLevels).length > 0
    ? applyTrustLevels(connection, { ...cs, trustLevels })
    : cs;
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
      view: 'simple',
      resourceScope: 'all',
      resourceIds: ['res-app-staging', 'res-app-prod', 'res-scratch'],
      trustLevels: {},
      everything: false,
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
    const cs = setMacroAction(
      curated,
      setResources(curated, setIncluded(start.connections[curated.id]!, true), [
        'res-app-prod',
        'res-archive',
      ]),
      'read',
      'prudent',
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

describe('creation form — macro-actions at a trust level', () => {
  it('lists the catalog\'s macro-actions, then "Anything else" holding the fallback', () => {
    expect(acme.macro_actions.map((a) => a.id)).toEqual([
      'read',
      'change',
      'administer',
      'anything-else',
    ]);
    expect(acme.macro_actions.at(-1)?.entries.map((e) => e.risk_id)).toEqual([
      'acme.uncategorized-write',
    ]);
  });

  it('fills the lines of each ticked macro-action from its trust level, and the draft is issuable', () => {
    const cs = included(WORKING);
    expect(cs.entries).toEqual({
      // Palier 1 at Confiant: runs freely, base budget ×3.
      'acme.read': { quota: '300', rateMax: '180', rateWindow: '60', gate: 'auto' },
      // Palier 3 (costly) at Prudent: asks first, base budget.
      'acme[staging].write': { quota: '100', rateMax: '60', rateWindow: '60', gate: 'approval' },
      'acme[prod].write': { quota: '100', rateMax: '60', rateWindow: '60', gate: 'approval' },
    });
    expect(cs.edited).toBe(false);
    expect(previewOf(cs).ok).toBe(true);
  });

  it('leaves out an irreversible permission at Prudent and asks first above it', () => {
    const prudent = macroActionRows(acme, included({ change: 'prudent' })).find(
      (row) => row.id === 'change',
    );
    expect(prudent).toMatchObject({
      trustLevel: 'prudent',
      free: 0,
      asks: 2,
      leftOut: 1,
      total: 3,
    });
    const autonome = setMacroAction(acme, included(), 'change', 'autonome');
    expect(autonome.entries['acme[staging].write']?.gate).toBe('auto');
    expect(autonome.entries['acme[staging].bulk-delete']).toEqual({
      quota: '50',
      rateMax: '10',
      rateWindow: '60',
      gate: 'approval',
    });
  });

  it('keeps the rate under the catalog ceiling whatever the trust level multiplies', () => {
    const cs = included({ administer: 'autonome' });
    expect(cs.entries['acme.admin']).toMatchObject({ quota: '50', rateMax: '10' });
  });

  it('unticks a macro-action, and says what a row cannot give here', () => {
    const cs = setMacroAction(acme, included(WORKING), 'change', null);
    expect(Object.keys(cs.entries)).toEqual(['acme.read']);
    const narrow = acmeConnection({ authority: ['acme.read'] });
    const rows = macroActionRows(narrow, included({}, narrow));
    expect(rows.find((r) => r.id === 'change')).toMatchObject({ unavailable: 3, empty: true });
    expect(rows.find((r) => r.id === 'read')).toMatchObject({ unavailable: 0, empty: false });
  });

  it('follows the resource selection while untouched, and keeps edits once made', () => {
    const prodOnly = setResources(acme, included(WORKING), ['res-app-prod']);
    expect(Object.keys(prodOnly.entries)).toEqual(['acme.read', 'acme[prod].write']);
    const edited = updateEntry(included(WORKING), 'acme.read', { quota: '7' });
    const kept = setResources(acme, edited, ['res-app-prod']);
    expect(Object.keys(kept.entries)).toHaveLength(3);
    expect(kept.entries['acme.read']?.quota).toBe('7');
    expect(previewOf(kept).issues.map((i) => i.code)).toEqual(['unresolvable-env']);
    const cleaned = dropUnresolvable(acme, kept);
    expect(Object.keys(cleaned.entries)).toEqual(['acme.read', 'acme[prod].write']);
    expect(previewOf(cleaned).ok).toBe(true);
  });

  it('sends the explicit lines and the trust levels, never a preset', () => {
    const draft = draftOf(
      context,
      withConnection(initialFormState(context), included(WORKING)),
      NOW,
    );
    expect(draft.connections[0]).toMatchObject({ preset: null, trust_levels: WORKING });
    expect(draft.connections[0]?.policy?.map((e) => e.risk_id)).toEqual([
      'acme.read',
      'acme[staging].write',
      'acme[prod].write',
    ]);
    // No macro-action ticked: no trust levels sent.
    const bare = toggleRisk(acme, included(), riskOf('acme.read'));
    const none = draftOf(context, withConnection(initialFormState(context), bare), NOW);
    expect(none.connections[0]).not.toHaveProperty('trust_levels');
  });

  it('counts the policy and names its highest palier', () => {
    expect(policyCounts(acme, included(WORKING))).toEqual({ free: 1, asks: 2, notIncluded: 2 });
    expect(chosenPalier(acme, included(WORKING))).toBe(3);
    expect(chosenPalier(acme, included({ read: 'prudent' }))).toBe(1);
    expect(chosenPalier(acme, included())).toBeNull();
  });
});

describe('creation form — Simple and Advanced', () => {
  it('switches the view without touching the policy', () => {
    const cs = included(WORKING);
    const advanced = setView(cs, 'advanced');
    expect(advanced.entries).toEqual(cs.entries);
    expect(discardsEdits(advanced)).toBe(false);
    const draftIn = (state: ConnectionState) =>
      draftOf(context, withConnection({ ...initialFormState(context), name: 'm' }, state), NOW);
    expect(draftIn(advanced)).toEqual(draftIn(cs));
    expect(JSON.stringify(draftIn(advanced))).not.toMatch(/simple|advanced|view/);
  });

  it('warns before the trust levels rewrite edits, and resets to what the trust levels write', () => {
    const edited = updateEntry(setView(included(WORKING), 'advanced'), 'acme.read', {
      quota: '7',
    });
    expect(discardsEdits(edited)).toBe(true);
    const back = resetEdits(acme, edited);
    expect(back).toMatchObject({ edited: false, trustLevels: WORKING });
    expect(back.entries['acme.read']?.quota).toBe('300');
  });

  it("gives a hand-ticked risk its macro-action's base budget at that trust level, else none", () => {
    expect(defaultEntryFor(acme, {}, riskOf('acme.read'))).toEqual({
      quota: '100',
      rateMax: '60',
      rateWindow: '60',
      gate: 'auto',
    });
    expect(defaultEntryFor(acme, { read: 'autonome' }, riskOf('acme.read')).quota).toBe('1000');
    // Left out at Prudent: ticked by hand, it asks first at the base budget.
    expect(defaultEntryFor(acme, {}, riskOf('acme[staging].bulk-delete'))).toEqual({
      quota: '5',
      rateMax: '1',
      rateWindow: '60',
      gate: 'approval',
    });
    // The fallback belongs to "Anything else".
    expect(defaultEntryFor(acme, {}, riskOf('acme.uncategorized-write')).gate).toBe('approval');
    // A deprecated entry is in no macro-action.
    expect(defaultEntryFor(acme, {}, riskOf('acme.legacy-export'))).toEqual({
      quota: '',
      rateMax: '',
      rateWindow: '',
      gate: 'auto',
    });
  });

  it('redraws a loaded mission in the simple view when its trust levels write its lines', () => {
    const source = previewOf(included(WORKING));
    const loaded = connectionOf(loadResolved(context, initialFormState(context), source.resolved));
    expect(loaded).toMatchObject({
      view: 'simple',
      edited: false,
      trustLevels: WORKING,
      included: true,
    });
  });

  it('opens a loaded mission in the advanced view when its lines differ from its trust levels', () => {
    const adjusted = previewOf(updateEntry(included(WORKING), 'acme.read', { quota: '9' }));
    const loaded = connectionOf(
      loadResolved(context, initialFormState(context), adjusted.resolved),
    );
    expect(loaded).toMatchObject({ view: 'advanced', edited: true, trustLevels: WORKING });
    expect(loaded.entries['acme.read']?.quota).toBe('9');
    expect(previewOf(loaded).policy).toEqual(adjusted.policy);
    // No trust levels recorded (an older mission, a proposal): the advanced view too.
    const bare = previewOf(toggleRisk(acme, included(), riskOf('acme.read')));
    expect(connectionOf(loadResolved(context, initialFormState(context), bare.resolved)).view).toBe(
      'advanced',
    );
  });

  it('drops the trust levels of a macro-action the connection does not have', () => {
    const source = previewOf(included(WORKING));
    const [line] = source.resolved;
    if (!line) throw new Error('no resolved line');
    const loaded = connectionOf(
      loadResolved(context, initialFormState(context), [
        { ...line, trust_levels: { ...line.trust_levels, nonsense: 'autonome' } },
      ]),
    );
    expect(loaded.trustLevels).toEqual(WORKING);
  });
});

describe('creation form — per-risk detail', () => {
  it('overrides one line the trust levels wrote and issues the adjusted values', () => {
    let cs = included(WORKING);
    cs = updateEntry(cs, 'acme.read', { quota: '25', rateMax: '3', rateWindow: '10' });
    cs = updateEntry(cs, 'acme[staging].write', { gate: 'approval' });
    expect(cs.edited).toBe(true);
    const preview = previewOf(cs);
    expect(preview.ok).toBe(true);
    expect(preview.policy.slice(0, 2)).toEqual([
      { risk_id: 'acme.read', quota: 25, rate_limit: { max: 3, window_seconds: 10 }, gate: 'auto' },
      {
        risk_id: 'acme[staging].write',
        quota: 100,
        rate_limit: { max: 60, window_seconds: 60 },
        gate: 'approval',
      },
    ]);
  });

  it('blocks issuance while a ticked risk has no budget, until the creator types one', () => {
    let cs = toggleRisk(acme, included({ read: 'prudent' }), riskOf('acme.admin'));
    cs = updateEntry(cs, 'acme.admin', { quota: '' });
    expect(previewOf(cs).issues.map((i) => i.code)).toEqual(['missing-budget']);
    cs = updateEntry(cs, 'acme.admin', { quota: '2', rateMax: '1', rateWindow: '60' });
    expect(previewOf(cs).ok).toBe(true);
    cs = updateEntry(cs, 'acme.admin', { quota: 'lots' });
    expect(previewOf(cs).issues.map((i) => i.code)).toEqual(['invalid-budget']);
  });

  it('unticks a risk', () => {
    const cs = toggleRisk(acme, included(WORKING), riskOf('acme.read'));
    expect(Object.keys(cs.entries)).toEqual(['acme[staging].write', 'acme[prod].write']);
  });

  it('"select all" yields an enumerated list: every held, resolvable risk, one id each', () => {
    const cs = selectAll(acme, included(WORKING));
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
    // The trust levels' values are kept for what they already wrote.
    expect(cs.entries['acme.read']?.quota).toBe('300');
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

  it('loads a resolved draft: included, ticked with its values, protected from the trust levels', () => {
    const source = previewOf(updateEntry(included(WORKING), 'acme.read', { quota: '9' }));
    const loaded = loadResolved(context, initialFormState(context), source.resolved);
    const cs = connectionOf(loaded);
    expect(cs.included).toBe(true);
    expect(cs.edited).toBe(true);
    expect(cs.entries['acme.read']?.quota).toBe('9');
    expect(previewOf(cs).policy).toEqual(source.policy);
  });
});

describe('creation form — the advanced view', () => {
  it('lists every explicit id of the catalog, and says why one cannot be ticked', () => {
    const narrow = acmeConnection({ authority: ['acme.read', 'acme[staging].write'] });
    const cs = setResources(narrow, setView(included(), 'advanced'), ['res-app-prod']);
    const rows = editorRows(narrow, toggleRisk(narrow, cs, riskOf('acme.read')));
    expect(rows.map((r) => r.risk.risk_id)).toEqual(narrow.risks.map((r) => r.risk_id));
    const status = Object.fromEntries(rows.map((r) => [r.risk.risk_id, r.unavailable]));
    expect(status['acme.read']).toBeNull();
    expect(status['acme[staging].write']).toBe('no selected resource is labelled "staging"');
    expect(status['acme.admin']).toBe('outside what you may allow');
    expect(rows.filter((r) => r.accepted).map((r) => r.risk.risk_id)).toEqual(['acme.read']);
  });

  it('searches the label, the id, the reason, the environment, the kind and the level', () => {
    const rows = editorRows(acme, setView(included(WORKING), 'advanced'));
    const ids = (query: string, filter: Parameters<typeof filterRows>[2] = 'all') =>
      filterRows(rows, query, filter).map((r) => r.risk.risk_id);
    expect(ids('')).toHaveLength(rows.length);
    expect(ids('bulk')).toEqual(['acme[staging].bulk-delete']);
    expect(ids('WRITE prod')).toEqual(['acme[prod].write']);
    expect(ids('posture')).toEqual(['acme.admin']);
    expect(ids('destructive')).toEqual(['acme[staging].bulk-delete']);
    expect(ids('nothing matches this')).toEqual([]);
  });

  it('filters on what the reader can act on, what is chosen, and what is not available', () => {
    const narrow = acmeConnection({
      authority: ['acme.read', 'acme[staging].write', 'acme[prod].write'],
    });
    const picked = toggleRisk(
      narrow,
      included({ read: 'prudent' }, narrow),
      riskOf('acme[staging].write'),
    );
    const rows = editorRows(narrow, picked);
    const ids = (filter: Parameters<typeof filterRows>[2]) =>
      filterRows(rows, '', filter).map((r) => r.risk.risk_id);
    expect(ids('accepted')).toEqual(['acme.read', 'acme[staging].write']);
    // Available to you: what may be ticked, and what is ticked (so that it can be unticked).
    expect(ids('available')).toEqual(['acme.read', 'acme[staging].write', 'acme[prod].write']);
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

describe('creation form — what stands in the way, in the words of the interface', () => {
  it('says each blocking reason without a protocol word, and names the account', () => {
    const blank = previewOf(included());
    const sentences = blank.issues.map((issue) => issueSentence(issue, context));
    expect(sentences).toContain(
      `${acme.provider_label} · ${acme.display_name} allows nothing yet: tick a macro-action or a permission, or leave the account out.`,
    );
    expect(issueSentence({ code: 'name-missing', message: 'x' }, context)).toBe(
      'Give the mission a name.',
    );
    expect(
      issueSentence(
        { code: 'missing-budget', message: 'x', connection_id: acme.id, risk_ids: ['acme.read'] },
        context,
      ),
    ).toBe(`${acme.provider_label} · ${acme.display_name}: give a limit to acme.read.`);
    for (const sentence of sentences) {
      expect(sentence).not.toMatch(/\b(risk|quota|budget|connection|authority)\b/i);
    }
  });

  it('prints what the server said when it has no sentence of its own', () => {
    expect(issueSentence({ code: 'unknown-risk', message: 'As the server says.' }, context)).toBe(
      'As the server says.',
    );
    expect(
      issueSentence({ code: 'exceeds-authority', message: 'No account named.' }, context),
    ).toBe('No account named.');
  });
});

describe('creation form — how far the mission reaches on an account', () => {
  it('offers three choices; the whole account is sent as its scope, the others as the ticked list', () => {
    expect(RESOURCE_CHOICES.map((c) => c.id)).toEqual(['all', 'connection', 'selected']);
    for (const choice of RESOURCE_CHOICES) expect(choice.explanation.length).toBeGreaterThan(20);

    const [connection] = context;
    if (!connection) throw new Error('no connection');
    const start = initialConnectionState(connection);
    expect(draftResourcesOf(start)).toEqual({
      scope: 'selected',
      resource_ids: ['res-app-staging', 'res-app-prod', 'res-scratch'],
    });

    const picked = setResources(connection, start, ['res-app-prod']);
    expect(picked.resourceScope).toBe('selected');

    const whole = setResourceScope(connection, picked, 'connection');
    expect(whole.resourceScope).toBe('connection');
    // What it reaches now is the default set again; later resources join at read time.
    expect(whole.resourceIds).toEqual(['res-app-staging', 'res-app-prod', 'res-scratch']);
    expect(draftResourcesOf(whole)).toEqual({ scope: 'connection' });

    const back = setResourceScope(connection, whole, 'all');
    expect(draftResourcesOf(back)).toEqual({
      scope: 'selected',
      resource_ids: ['res-app-staging', 'res-app-prod', 'res-scratch'],
    });
  });

  it('loads a whole-connection proposal as such', () => {
    const state = initialFormState(context);
    const loaded = loadResolved(context, state, [
      {
        connection_id: 'conn-acme',
        resources: { scope: 'connection' },
        preset: null,
        policy: [],
        trust_levels: {},
      },
    ]);
    expect(loaded.connections['conn-acme']?.resourceScope).toBe('connection');
  });
});

describe('creation form — "Everything I hold on this account"', () => {
  it('is offered on every account, and fills the explicit list in place of the trust levels', () => {
    const cs = applyEverything(acme, included(WORKING));
    expect(cs.trustLevels).toEqual({});
    const expected = everythingIHold(acme, ACME_RESOURCES).entries;
    expect(Object.keys(cs.entries)).toEqual(expected.map((e) => e.risk_id));
    expect(cs.entries['acme.admin']).toEqual({
      quota: String(expected.find((e) => e.risk_id === 'acme.admin')?.quota),
      rateMax: '10',
      rateWindow: '60',
      gate: 'auto',
    });
    // What is sent is the explicit list, with no preset reference; the server accepts it.
    const preview = previewOf(cs);
    expect(preview.ok).toBe(true);
    expect(preview.policy.map((l) => l.risk_id)).toEqual(expected.map((e) => e.risk_id));
    const state = withConnection(initialFormState(context), cs);
    expect(draftOf(context, state, NOW).connections[0]?.preset).toBeNull();
  });

  it('follows the resource selection while untouched', () => {
    const cs = setResources(acme, applyEverything(acme, included()), ['res-scratch']);
    expect(Object.keys(cs.entries)).toEqual([
      'acme.read',
      'acme.admin',
      'acme.uncategorized-write',
    ]);
  });

  it('says how many, the most severe, and names the uncategorized writes, in the words of the interface', () => {
    const explanation = explainEverything(acme, included());
    expect(explanation.auto.length + explanation.approval.length).toBe(6);
    const sentences = describeEverything(acme, explanation);
    expect(sentences[0]).toContain('Written out as 6 permissions');
    expect(sentences).toContain('Most severe: Delete things in bulk (high).');
    expect(sentences).toContain('None of them is critical.');
    expect(sentences.some((s) => s.includes('“Uncategorized write”'))).toBe(true);
    for (const sentence of sentences) {
      expect(sentence).not.toMatch(/\b(risk|quota|budget|connection|authority)\b/i);
    }
  });

  it('names the critical permissions that run freely', () => {
    const risks = acme.risks.map((r) =>
      r.risk_id === 'acme.admin' ? { ...r, severity: 12, level: 'critical' as const } : r,
    );
    const critical = acmeConnection({ risks });
    expect(describeEverything(critical, explainEverything(critical, included()))).toContain(
      'Critical, and running freely: Change account settings.',
    );
  });
});
