import { describe, expect, it } from 'vitest';

import { previewDraft } from '@/lib/missions/preview';
import { acmeConnection } from '../../../../../tests/support/missions/testing';

import { actionRows } from '../cards/card-model';
import {
  addCard,
  applyCustom,
  draftOf,
  entryOf,
  expiryOf,
  initialFormState,
  issueSentence,
  loadResolved,
  newCard,
  periodChoiceOf,
  periodOf,
  raiseMacroAction,
  removeCard,
  setActionLevel,
  setCardResources,
  type CardState,
  type FormState,
} from './form-state';

const NOW = new Date('2026-11-04T09:00:00.000Z');
const acme = acmeConnection();
const context = [acme];

function card(resourceIds: readonly string[], env: string | null, key = 'c1', future = false) {
  return newCard(acme.id, key, { resourceIds, future, env });
}

function withCards(...cards: CardState[]): FormState {
  return cards.reduce(addCard, { ...initialFormState(), name: 'Ship it' });
}

function levelOf(c: CardState, actionId: string) {
  return actionRows(acme, c).find((row) => row.id === actionId)?.level ?? null;
}

describe('mission screen — a card and its macro-actions', () => {
  it('starts empty: no card, a daily period, no end', () => {
    const state = initialFormState();
    expect(state.cards).toEqual([]);
    expect(periodOf(state.period)).toEqual({ kind: 'recurring', length_seconds: 86_400 });
    expect(expiryOf(state, NOW)).toBeNull();
  });

  it('ticks a macro-action at a level: its lines are written, and the draft is issuable', () => {
    const staging = setActionLevel(acme, card(['res-app-staging'], 'staging'), 'read', 'careful');
    expect(Object.keys(staging.entries)).toEqual(['acme.read']);
    expect(levelOf(staging, 'read')).toBe('careful');
    const preview = previewDraft(
      { connections: context, now: NOW },
      draftOf(context, withCards(staging), NOW),
    );
    expect(preview.ok).toBe(true);
    expect(preview.policy.map((p) => p.risk_id)).toEqual(['acme.read']);
  });

  it('writes only the lines of the card’s environment', () => {
    const prod = setActionLevel(acme, card(['res-app-prod'], 'prod'), 'change', 'autonomous');
    expect(Object.keys(prod.entries)).toEqual(['acme[prod].write']);
    const staging = setActionLevel(
      acme,
      card(['res-app-staging'], 'staging'),
      'change',
      'autonomous',
    );
    expect(Object.keys(staging.entries).sort()).toEqual([
      'acme[staging].bulk-delete',
      'acme[staging].write',
    ]);
  });

  it('reads Custom once a line differs from its level, and goes back to a level on a click', () => {
    const ticked = setActionLevel(acme, card(['res-app-staging'], 'staging'), 'read', 'careful');
    const line = ticked.entries['acme.read'];
    if (!line) throw new Error('no line');
    const custom = applyCustom(
      acme,
      ticked,
      'read',
      { 'acme.read': { ...line, quota: '7' } },
      'careful',
    );
    expect(levelOf(custom, 'read')).toBe('custom');
    expect(custom.trustLevels.read).toBe('careful');
    const back = setActionLevel(acme, custom, 'read', 'trusting');
    expect(levelOf(back, 'read')).toBe('trusting');
  });

  it('unticks a macro-action when Custom leaves every line out, and keeps the other lines', () => {
    let c = setActionLevel(acme, card(['res-app-staging'], 'staging'), 'read', 'careful');
    c = setActionLevel(acme, c, 'administer', 'careful');
    const out = applyCustom(acme, c, 'administer', { 'acme.admin': null }, 'careful');
    expect(levelOf(out, 'administer')).toBeNull();
    expect(out.trustLevels.administer).toBeUndefined();
    expect(Object.keys(out.entries)).toEqual(['acme.read']);
  });

  it('rewrites the macro-actions at their level when the resources change, keeps Custom ones', () => {
    let c = setActionLevel(acme, card([], 'staging', 'c1', true), 'change', 'careful');
    // A future-only card reaches no staging resource yet: the env-qualified lines wait.
    expect(Object.keys(c.entries)).toEqual([]);
    c = setCardResources(acme, c, {
      resourceIds: ['res-app-staging'],
      future: true,
      env: 'staging',
    });
    expect(Object.keys(c.entries)).toEqual(['acme[staging].write']);
    const custom = applyCustom(
      acme,
      c,
      'change',
      {
        'acme[staging].write': entryOf({
          quota: 3,
          rate_limit: { max: 1, window_seconds: 60 },
          gate: 'approval',
        }),
      },
      'careful',
    );
    const moved = setCardResources(acme, custom, { resourceIds: [], future: true, env: 'staging' });
    expect(moved.entries['acme[staging].write']?.quota).toBe('3');
  });

  it('removes a card', () => {
    const state = withCards(
      card(['res-app-staging'], 'staging', 'a'),
      card(['res-app-prod'], 'prod', 'b'),
    );
    expect(removeCard(state, 'a').cards.map((c) => c.key)).toEqual(['b']);
  });
});

describe('mission screen — the draft', () => {
  it('sends one connection per account, its cards as resource sets, in screen order', () => {
    const staging = setActionLevel(
      acme,
      card(['res-app-staging'], 'staging', 'a', true),
      'read',
      'careful',
    );
    const prod = setActionLevel(acme, card(['res-app-prod'], 'prod', 'b'), 'read', 'trusting');
    const draft = draftOf(context, withCards(staging, prod), NOW);
    expect(draft.connections).toHaveLength(1);
    const sets = draft.connections[0]?.resource_sets ?? [];
    expect(sets.map((s) => s.resources)).toEqual([
      { scope: 'selected', resource_ids: ['res-app-staging'] },
      { scope: 'selected', resource_ids: ['res-app-prod'] },
    ]);
    expect(sets.map((s) => s.future ?? false)).toEqual([true, false]);
    // The environment is said only by a card without resources.
    expect(sets.every((s) => s.env === undefined)).toBe(true);
    expect(sets[1]?.trust_levels).toEqual({ read: 'trusting' });
    const preview = previewDraft({ connections: context, now: NOW }, draft);
    expect(preview.ok).toBe(true);
    expect(preview.resolved[0]?.resource_sets.map((s) => s.env)).toEqual(['staging', 'prod']);
  });

  it('names the environment of a card of future resources only', () => {
    const future = setActionLevel(acme, card([], 'prod', 'a', true), 'read', 'careful');
    const set = draftOf(context, withCards(future), NOW).connections[0]?.resource_sets?.[0];
    expect(set).toMatchObject({
      resources: { scope: 'selected', resource_ids: [] },
      future: true,
      env: 'prod',
    });
  });

  it('reaches an account that lists no resource as itself', () => {
    const bare = acmeConnection({ resources: [] });
    const c = setActionLevel(
      bare,
      newCard(bare.id, 'a', { resourceIds: [], future: false, env: null }),
      'read',
      'careful',
    );
    const draft = draftOf([bare], withCards(c), NOW);
    expect(draft.connections[0]?.resource_sets?.[0]?.resources).toEqual({ scope: 'all' });
    expect(previewDraft({ connections: [bare], now: NOW }, draft).ok).toBe(true);
  });

  it('refuses a card that ticks nothing, and two cards that take the future of one environment', () => {
    const empty = previewDraft(
      { connections: context, now: NOW },
      draftOf(context, withCards(card(['res-app-staging'], 'staging')), NOW),
    );
    expect(empty.issues.map((i) => i.code)).toContain('no-accepted-risk');
    const a = setActionLevel(
      acme,
      card(['res-app-staging'], 'staging', 'a', true),
      'read',
      'careful',
    );
    const b = setActionLevel(acme, card([], 'staging', 'b', true), 'read', 'careful');
    const twice = previewDraft(
      { connections: context, now: NOW },
      draftOf(context, withCards(a, b), NOW),
    );
    expect(twice.issues.map((i) => i.code)).toContain('resource-sets-overlap');
  });

  it('maps the period and the end', () => {
    expect(periodChoiceOf({ kind: 'one-off' })).toBe('one-off');
    expect(periodChoiceOf({ kind: 'recurring', length_seconds: 604_800 })).toBe('week');
    expect(expiryOf({ expiry: '7d', expiryCustom: '' }, NOW)).toBe('2026-11-11T09:00:00.000Z');
    expect(
      expiryOf({ expiry: 'keep', expiryCustom: '', keptExpiry: '2027-01-01T00:00:00.000Z' }, NOW),
    ).toBe('2027-01-01T00:00:00.000Z');
  });
});

describe('mission screen — loading a mission', () => {
  const line = (risk_id: string) => ({
    risk_id,
    quota: 100,
    rate_limit: { max: 60, window_seconds: 60 },
    gate: 'auto' as const,
  });

  it('loads one card per set, with its lines, its level and its future', () => {
    const state = loadResolved(context, initialFormState(), [
      {
        connection_id: acme.id,
        resource_sets: [
          {
            id: 'set-1',
            resources: { scope: 'selected', resource_ids: ['res-app-staging'] },
            future: true,
            env: 'staging',
            everything_i_hold: false,
            policy: [line('acme.read')],
            trust_levels: { read: 'careful' },
          },
        ],
      },
    ]);
    expect(state.cards).toHaveLength(1);
    const [only] = state.cards;
    expect(only).toMatchObject({ key: 'set-1', id: 'set-1', future: true, env: 'staging' });
    expect(only && levelOf(only, 'read')).toBe('careful');
    expect(state.split).toBeUndefined();
  });

  it('splits a set that mixed environments into one card per environment, each with its lines', () => {
    const state = loadResolved(context, initialFormState(), [
      {
        connection_id: acme.id,
        resource_sets: [
          {
            id: 'legacy',
            resources: { scope: 'selected', resource_ids: ['res-app-staging', 'res-app-prod'] },
            future: false,
            env: null,
            everything_i_hold: false,
            policy: [line('acme.read'), line('acme[staging].write'), line('acme[prod].write')],
            trust_levels: {},
          },
        ],
      },
    ]);
    expect(state.split).toEqual(['legacy']);
    expect(state.cards.map((c) => [c.id ?? null, c.env, Object.keys(c.entries).sort()])).toEqual([
      ['legacy', 'staging', ['acme.read', 'acme[staging].write']],
      [null, 'prod', ['acme.read', 'acme[prod].write']],
    ]);
    const preview = previewDraft(
      { connections: context, now: NOW },
      draftOf(context, { ...state, name: 'x' }, NOW),
    );
    expect(preview.ok).toBe(true);
  });

  it('a trust raise rewrites one macro-action and names the hand edits it replaces', () => {
    let c = setActionLevel(acme, card(['res-app-staging'], 'staging'), 'read', 'careful');
    const line0 = c.entries['acme.read'];
    if (!line0) throw new Error('no line');
    c = applyCustom(acme, c, 'read', { 'acme.read': { ...line0, quota: '1' } }, 'careful');
    const raised = raiseMacroAction(acme, c, 'read', 'trusting');
    expect(raised.replaced).toEqual(['acme.read']);
    expect(levelOf(raised.card, 'read')).toBe('trusting');
    const clean = raiseMacroAction(
      acme,
      setActionLevel(acme, card(['res-app-staging'], 'staging'), 'read', 'careful'),
      'read',
      'trusting',
    );
    expect(clean.replaced).toEqual([]);
  });
});

describe('mission screen — what stands in the way, in words', () => {
  it('says each blocking reason with the account, and the card rules in the interface’s words', () => {
    const at = { connection_id: acme.id };
    expect(issueSentence({ code: 'name-missing', message: '' }, context)).toBe(
      'Give the mission a name.',
    );
    expect(issueSentence({ code: 'resource-set-mixed-env', message: '', ...at }, context)).toBe(
      'Acme · Acme main: a card holds the resources of one environment. Split it.',
    );
    expect(
      issueSentence(
        { code: 'resource-unlabelled', message: '', resource_refs: ['scratch'], ...at },
        context,
      ),
    ).toContain('scratch has no environment label');
    expect(issueSentence({ code: 'resource-sets-overlap', message: '', ...at }, context)).toContain(
      'in two cards',
    );
    expect(
      issueSentence({ code: 'unknown-risk', message: 'As the server said.', ...at }, context),
    ).toBe('As the server said.');
  });
});
