import { describe, expect, it } from 'vitest';

import { depotPlugin } from '../execution/testing';
import { enumerateCatalog } from '../missions/catalog-view';
import {
  envNotes,
  groupBySeverity,
  selectAllIds,
  SEVERITY_ORDER,
  summarizeRestriction,
  type EnvLabelling,
} from './restriction';

const RISKS = enumerateCatalog(depotPlugin().plugin.catalog);
const ALL_IDS = RISKS.map((risk) => risk.risk_id);
const LABELLED: EnvLabelling = {
  derivesEnv: false,
  labelledEnvs: ['prod', 'staging'],
  unlabelledResources: 0,
};

describe('the restriction of a share, as the dialog shows it', () => {
  it('groups the catalog by severity, most severe first, without empty groups', () => {
    const groups = groupBySeverity(RISKS);
    const levels = groups.map((group) => group.level);
    expect(levels).toEqual(SEVERITY_ORDER.filter((level) => levels.includes(level)));
    expect(groups.every((group) => group.risks.length > 0)).toBe(true);
    // Every row is in exactly one group.
    expect(groups.flatMap((group) => group.risks.map((risk) => risk.risk_id)).sort()).toEqual(
      [...ALL_IDS].sort(),
    );
  });

  it('"select all" is an enumerated list: explicit ids, no wildcard, no fallback, no deprecated entry', () => {
    const selected = selectAllIds(RISKS);
    expect(selected).toEqual([
      'depot.read',
      'depot[staging].write',
      'depot[prod].write',
      'depot.purge',
      'depot.profile',
    ]);
    expect(selected.every((id) => !/[*?]/.test(id))).toBe(true);
    expect(selected).not.toContain('depot.uncategorized-write');
    const withDeprecated = RISKS.map((risk, index) =>
      index === 0 ? { ...risk, deprecated: true } : risk,
    );
    expect(selectAllIds(withDeprecated)).not.toContain('depot.read');
  });

  it('summarizes in one line: how many, per level, and the most severe', () => {
    expect(summarizeRestriction(RISKS, new Set())).toBe(
      'No risk selected: the share would authorize nothing.',
    );
    const one = summarizeRestriction(RISKS, new Set(['depot.read']));
    expect(one).toMatch(/^1 of 6 risks · 1 \w+ · most severe: Read items \(\w+\)$/);
    const all = summarizeRestriction(RISKS, new Set(selectAllIds(RISKS)));
    expect(all).toMatch(/^5 of 6 risks · /);
    expect(all).toContain('most severe: Purge a space');
    expect(all.split('\n')).toHaveLength(1);
    // An id that is not in the catalog counts for nothing.
    expect(summarizeRestriction(RISKS, new Set(['depot.nope']))).toMatch(/^No risk selected/);
  });

  describe('environment notes (env-qualified risks are refused on unlabelled resources)', () => {
    const prodWrite = new Set(['depot[prod].write']);

    it('says nothing when no env-qualified risk is ticked', () => {
      expect(
        envNotes(RISKS, new Set(['depot.read', 'depot.purge']), {
          derivesEnv: false,
          labelledEnvs: [],
          unlabelledResources: 3,
        }),
      ).toEqual([]);
    });

    it('says nothing when the plugin derives the environment from the call', () => {
      expect(
        envNotes(RISKS, prodWrite, { derivesEnv: true, labelledEnvs: [], unlabelledResources: 3 }),
      ).toEqual([]);
    });

    it('says nothing when every resource is labelled and the environment is reachable', () => {
      expect(envNotes(RISKS, prodWrite, LABELLED)).toEqual([]);
    });

    it('names the environment no resource carries', () => {
      const notes = envNotes(RISKS, prodWrite, {
        derivesEnv: false,
        labelledEnvs: ['staging'],
        unlabelledResources: 0,
      });
      expect(notes).toHaveLength(1);
      expect(notes[0]).toContain('"prod"');
      expect(notes[0]).toContain('cannot be used');
    });

    it('counts the unlabelled resources the shared env-qualified risks will be refused on', () => {
      const [one] = envNotes(RISKS, prodWrite, { ...LABELLED, unlabelledResources: 1 });
      expect(one).toBe(
        '1 resource has no environment label: environment-qualified risks are refused on it until you label it.',
      );
      const both = envNotes(RISKS, new Set(['depot[prod].write', 'depot[staging].write']), {
        derivesEnv: false,
        labelledEnvs: [],
        unlabelledResources: 2,
      });
      expect(both).toHaveLength(2);
      expect(both[0]).toContain('"staging", "prod"');
      expect(both[1]).toContain('2 resources have no environment label');
    });
  });
});
