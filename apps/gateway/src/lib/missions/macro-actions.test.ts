import { describe, expect, it } from 'vitest';

import {
  trustLevelsOf,
  defaultLineOf,
  expandMacroAction,
  highestTier,
  knownTrustLevels,
  linesOfTrustLevels,
  macroActionsOf,
  prefillOfTrustLevels,
  unknownMacroActions,
} from './macro-actions';
import {
  ACME_CATALOG,
  ACME_RESOURCES,
  acmeConnection,
} from '../../../tests/support/missions/testing';

const acme = acmeConnection();

function action(id: string) {
  const found = acme.macro_actions.find((a) => a.id === id);
  if (!found) throw new Error(`no macro-action ${id}`);
  return found;
}

describe('macro-actions of a connection', () => {
  it('adds "Anything else" with the fallback at the default base budget, and only when there is one', () => {
    const anything = action('anything-else');
    expect(anything.entries).toEqual([
      {
        risk_id: 'acme.uncategorized-write',
        quota: 50,
        rate_limit: { max: 10, window_seconds: 60 },
      },
    ]);
    const noFallback = {
      ...ACME_CATALOG,
      risks: ACME_CATALOG.risks.filter((r) => r.fallback !== true),
    };
    expect(macroActionsOf(noFallback).map((a) => a.id)).toEqual(['read', 'change', 'administer']);
  });

  it('expands per environment, and sets apart what the selection or the authority cannot give', () => {
    const prodOnly = ACME_RESOURCES.filter((r) => r.env === 'prod');
    const change = expandMacroAction(acme, action('change'), 'trusting', prodOnly);
    expect(change.lines.map((l) => [l.risk_id, l.gate, l.tier, l.quota])).toEqual([
      ['acme[prod].write', 'approval', 3, 300],
    ]);
    expect(change.unavailable.map((r) => r.risk_id)).toEqual([
      'acme[staging].write',
      'acme[staging].bulk-delete',
    ]);
    const narrow = acmeConnection({ authority: ['acme.read'] });
    expect(expandMacroAction(narrow, action('change'), 'autonomous', ACME_RESOURCES).lines).toEqual(
      [],
    );
  });

  it('writes every ticked macro-action in catalog order, and nothing for an unticked one', () => {
    const lines = linesOfTrustLevels(
      acme,
      { administer: 'careful', read: 'careful' },
      ACME_RESOURCES,
    );
    expect(lines.map((l) => l.risk_id)).toEqual(['acme.read', 'acme.admin']);
    expect(linesOfTrustLevels(acme, {}, ACME_RESOURCES)).toEqual([]);
  });

  it('gives a hand-ticked line its macro-action’s trust level, asking first when the trust level leaves it out', () => {
    const bulk = acme.risks.find((r) => r.risk_id === 'acme[staging].bulk-delete');
    if (!bulk) throw new Error('fixture');
    expect(defaultLineOf(acme, {}, bulk)).toMatchObject({ quota: 5, gate: 'approval' });
    expect(defaultLineOf(acme, { change: 'autonomous' }, bulk)).toMatchObject({
      quota: 50,
      gate: 'approval',
    });
  });

  it('keeps only trust levels, and only for macro-actions the connection has', () => {
    expect(trustLevelsOf({ read: 'trusting', change: 'reckless', admin: 3 })).toEqual({
      read: 'trusting',
    });
    expect(knownTrustLevels(acme, { read: 'autonomous', elsewhere: 'careful' })).toEqual({
      read: 'autonomous',
    });
    expect(knownTrustLevels(acme, undefined)).toEqual({});
  });

  it('names the highest tier', () => {
    expect(highestTier(acme.risks.filter((r) => r.risk_id === 'acme.read'))).toBe(1);
    expect(highestTier(acme.risks)).toBe(4);
    expect(highestTier([])).toBeNull();
  });

  it('says what the trust levels leave out, and why', () => {
    const narrow = acmeConnection({ authority: ['acme.read', 'acme[staging].write'] });
    const prodOnly = ACME_RESOURCES.filter((r) => r.env !== 'staging');
    const { lines, left_out } = prefillOfTrustLevels(
      narrow,
      { read: 'careful', change: 'careful' },
      prodOnly,
    );
    expect(lines.map((l) => l.risk_id)).toEqual(['acme.read']);
    expect(left_out.map((l) => [l.risk_id, l.reason])).toEqual([
      ['acme[staging].write', 'unresolvable-env'],
      ['acme[prod].write', 'outside-authority'],
      ['acme[staging].bulk-delete', 'outside-authority'],
    ]);
    expect(
      prefillOfTrustLevels(acme, { change: 'careful' }, ACME_RESOURCES).left_out.map(
        (l) => l.reason,
      ),
    ).toEqual(['trust-level']);
  });

  it('names the trust levels of a draft that are no macro-action here', () => {
    expect(unknownMacroActions(acme, { read: 'careful', deploy: 'autonomous' })).toEqual([
      'deploy',
    ]);
    expect(unknownMacroActions(acme, undefined)).toEqual([]);
  });
});
