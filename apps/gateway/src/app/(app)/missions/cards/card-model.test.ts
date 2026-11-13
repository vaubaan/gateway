/**
 * What a mission card shows: its words come from generic fields only, its groups of
 * resources keep one environment per card, Custom lists the permissions of one
 * macro-action and the ones never accepted in the card's environment, the gauge follows
 * the permission closest to its limit, and the summary bar says what changed.
 */
import { describe, expect, it } from 'vitest';

import { acmeConnection } from '../../../../../tests/support/missions/testing';

import {
  addCard,
  applyCustom,
  initialFormState,
  newCard,
  setActionLevel,
  type CardState,
  type FormState,
} from '../new/form-state';
import {
  actionRows,
  cardDigest,
  changeSummary,
  customView,
  freeResources,
  gaugeOf,
  levelLabel,
  levelMatching,
  reachesAccountItself,
  resourceGroups,
  resourcesLine,
  showsEnv,
  startFrom,
} from './card-model';
import { detailCards } from './detail-cards';

const acme = acmeConnection();
const context = [acme];
const noun = acme.resource_noun;

function card(resourceIds: readonly string[], env: string | null, key = 'c1', future = false) {
  return newCard(acme.id, key, { resourceIds, future, env });
}
function stateOf(...cards: CardState[]): FormState {
  return cards.reduce(addCard, initialFormState());
}

describe('a card’s words', () => {
  it('names the resources with the plugin’s noun, and future ones', () => {
    const two = [
      { display_name: 'App (staging)', ref: 'app-staging' },
      { display_name: '', ref: 'scratch' },
    ];
    expect(resourcesLine(noun, two, false)).toBe('2 things: App (staging), scratch');
    expect(resourcesLine(noun, two, true)).toBe('2 things: App (staging), scratch + future things');
    expect(resourcesLine(noun, [], true)).toBe('+ future things');
    expect(resourcesLine(noun, [], false, true)).toBe('the account itself');
    expect(resourcesLine({ one: 'resource', other: 'resources' }, two.slice(0, 1), false)).toBe(
      '1 resource: App (staging)',
    );
  });

  it('shows the environment only where it comes from resource labels', () => {
    expect(showsEnv(acme)).toBe(true);
    expect(showsEnv(acmeConnection({ derives_env: true }))).toBe(false);
    expect(showsEnv(acmeConnection({ risks: acme.risks.filter((r) => r.env === null) }))).toBe(
      false,
    );
  });

  it('labels the four segments from the trust levels, plus Custom', () => {
    expect(
      ['careful', 'trusting', 'autonomous', 'custom'].map((l) => levelLabel(l as never)),
    ).toEqual(['Careful', 'Trusting', 'Autonomous', 'Custom']);
  });

  it('counts the card in its foot', () => {
    let c = setActionLevel(acme, card(['res-app-staging'], 'staging'), 'read', 'careful');
    c = setActionLevel(acme, c, 'change', 'careful');
    const digest = cardDigest(actionRows(acme, c));
    expect(digest.total).toBe(digest.free + digest.asks);
    expect(digest.total).toBeGreaterThan(0);
  });

  it('cannot tick a macro-action nothing of which reaches the card', () => {
    // A prod card: "Change" holds the prod write; a card with no resource at all holds none.
    const rows = actionRows(acme, card([], 'prod', 'c', true));
    expect(rows.find((r) => r.id === 'change')?.empty).toBe(true);
    expect(rows.find((r) => r.id === 'read')?.empty).toBe(false);
  });
});

describe('"+ Add an account": resources grouped by environment', () => {
  it('groups by label, adds the catalog’s environments, and lists the unlabelled last, not selectable', () => {
    const groups = resourceGroups(acme, stateOf(), null);
    expect(groups.map((g) => [g.env, g.resources.map((r) => r.resource.id), g.selectable])).toEqual(
      [
        ['staging', ['res-app-staging'], true],
        ['prod', ['res-app-prod'], true],
        [null, ['res-scratch'], false],
      ],
    );
  });

  it('lets unlabelled resources in where the provider reads the environment from the call', () => {
    const vercelLike = acmeConnection({ derives_env: true });
    const groups = resourceGroups(vercelLike, stateOf(), null);
    expect(groups.find((g) => g.env === null)?.selectable).toBe(true);
  });

  it('marks what another card holds, and the future of an environment another card takes', () => {
    const state = stateOf(card(['res-app-staging'], 'staging', 'a', true));
    const groups = resourceGroups(acme, state, null);
    const staging = groups.find((g) => g.env === 'staging');
    expect(staging?.resources[0]?.elsewhere).toBe(true);
    expect(staging?.futureElsewhere).toBe(true);
    // The card itself, being changed, holds nothing "elsewhere".
    expect(resourceGroups(acme, state, 'a').find((g) => g.env === 'staging')?.futureElsewhere).toBe(
      false,
    );
    expect(freeResources(acme, state)).toEqual({ free: 2, total: 3 });
  });

  it('reaches an account without resources as itself', () => {
    const bare = acmeConnection({ resources: [] });
    expect(
      reachesAccountItself(
        bare,
        newCard(bare.id, 'a', { resourceIds: [], future: false, env: null }),
      ),
    ).toBe(true);
  });
});

describe('Custom: the permissions of one macro-action', () => {
  it('lists the card’s environment only, and says "never in" what the catalog refuses there', () => {
    const prod = card(['res-app-prod'], 'prod');
    const view = customView(acme, prod, 'change', null);
    expect(view.rows.map((r) => r.risk.risk_id)).toEqual(['acme[prod].write']);
    expect(view.never.map((n) => n.baseId)).toEqual(['acme.bulk-delete']);
    const staging = customView(acme, card(['res-app-staging'], 'staging'), 'change', null);
    expect(staging.never).toEqual([]);
    expect(staging.rows).toHaveLength(2);
  });

  it('offers the planes as filter chips, counted', () => {
    const planes = {
      planes: ['db', 'storage'],
      by_risk: { 'acme.write': ['db'], 'acme.bulk-delete': ['storage'] },
    };
    const view = customView(acme, card(['res-app-prod'], 'prod'), 'change', planes);
    expect(view.planes).toEqual([
      { slug: 'db', count: 1 },
      { slug: 'storage', count: 1 },
    ]);
  });

  it('"Start from" a level writes its lines; lines that fall on a level are that level', () => {
    const c = card(['res-app-staging'], 'staging');
    const view = customView(acme, c, 'change', null);
    const careful = startFrom(acme, c, 'change', view, 'careful');
    // Careful leaves the irreversible bulk delete out.
    expect(careful['acme[staging].bulk-delete']).toBeNull();
    expect(careful['acme[staging].write']).not.toBeNull();
    expect(levelMatching(acme, c, 'change', careful, ['careful', 'trusting', 'autonomous'])).toBe(
      'careful',
    );
    const edited = {
      ...careful,
      'acme[staging].write': { quota: '1', rateMax: '1', rateWindow: '60', gate: 'auto' as const },
    };
    expect(
      levelMatching(acme, c, 'change', edited, ['careful', 'trusting', 'autonomous']),
    ).toBeNull();
  });
});

describe('the gauge of a macro-action', () => {
  it('follows the permission closest to its limit, never an average', () => {
    const top = gaugeOf([
      { riskId: 'a', label: 'A', used: 310, quota: 2000, gate: 'auto' },
      { riskId: 'b', label: 'B', used: 82, quota: 100, gate: 'auto' },
      { riskId: 'c', label: 'C', used: 0, quota: 20, gate: 'auto' },
    ]);
    expect(top?.riskId).toBe('b');
    expect(gaugeOf([])).toBeNull();
  });

  it('reads the use of the period from the mission, card by card', () => {
    const line = {
      resource_set_id: 'set-1',
      risk_id: 'acme.read',
      quota: 100,
      rate_limit: { max: 60, window_seconds: 60 },
      gate: 'auto' as const,
      label: 'Read things',
      row: 1 as const,
      remaining: 76,
      gate_open_until: '2026-11-05T00:00:00.000Z',
    };
    const cards = detailCards(
      {
        policy: [line],
        connections: [
          {
            id: acme.id,
            provider: 'acme',
            provider_label: 'Acme',
            resource_noun: noun,
            display_name: 'Acme main',
            status: 'active',
            resources: [],
            future: true,
            last_checked_at: '2026-11-04T08:00:00.000Z',
            resource_sets: [
              {
                id: 'set-1',
                position: 1,
                resources: acme.resources.filter((r) => r.id === 'res-app-staging'),
                future: true,
                env: 'staging',
                mixed_env: false,
                trust_levels: { read: 'careful' },
              },
            ],
            lost: null,
          },
        ],
      },
      [],
      () => ({ risks: acme.risks, macro_actions: acme.macro_actions, derives_env: false }),
    );
    expect(cards).toHaveLength(1);
    expect(cards[0]?.used).toEqual({ 'acme.read': 24 });
    // A gate opened for the period says until when: the gauge's hover offers to close it.
    expect(cards[0]?.openUntil).toEqual({ 'acme.read': '2026-11-05T00:00:00.000Z' });
    expect(cards[0]?.card).toMatchObject({ id: 'set-1', env: 'staging', future: true });
    expect(cards[0]?.lastCheckedAt).toBe('2026-11-04T08:00:00.000Z');
  });
});

describe('the summary bar', () => {
  it('says what changed at the level of the cards', () => {
    const before = stateOf(
      setActionLevel(acme, card(['res-app-staging'], 'staging', 'a'), 'read', 'careful'),
    );
    const [a] = before.cards;
    if (!a) throw new Error('fixture');
    const moved = setActionLevel(
      acme,
      setActionLevel(acme, a, 'read', 'trusting'),
      'administer',
      'careful',
    );
    const after: FormState = { ...before, name: 'Renamed', cards: [moved] };
    expect(changeSummary(context, before, after, { before: null, after: null })).toEqual([
      'Name changed',
      'Read Careful → Trusting',
      'Administer added',
    ]);
    const line = moved.entries['acme.read'];
    if (!line) throw new Error('fixture');
    const custom = applyCustom(
      acme,
      moved,
      'read',
      { 'acme.read': { ...line, quota: '1' } },
      'trusting',
    );
    const withNew = { ...after, cards: [custom, card(['res-app-prod'], 'prod', 'b')] };
    expect(
      changeSummary(context, after, withNew, { before: null, after: '2027-01-01T00:00:00Z' }),
    ).toEqual(['End date changed', 'Acme · Read Trusting → Custom', 'Acme · Acme main added']);
    expect(
      changeSummary(
        context,
        withNew,
        { ...withNew, cards: [custom] },
        { before: null, after: null },
      ),
    ).toEqual(['Acme · Acme main removed']);
  });
});
