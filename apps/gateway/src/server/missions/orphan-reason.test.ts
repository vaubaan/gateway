import { describe, expect, it } from 'vitest';

import { ORPHAN_CAUSES, PART_LOSS_CAUSES } from '../authority/mission-grounds';
import { explainLostAccount, explainOrphan } from './orphan-reason';

describe('explainLostAccount', () => {
  it('says in one line which account, why, and that its calls are refused, for every cause', () => {
    for (const cause of PART_LOSS_CAUSES) {
      const final = cause !== 'access-withdrawn';
      const explanation = explainLostAccount({ cause, final }, 'vps-rp-skills', true);
      expect(explanation.summary).toMatch(/calls through it are refused/);
      expect(explanation.lines.length).toBeGreaterThan(0);
      expect(explanation.final).toBe(final);
    }
  });

  it('words a disconnected account as its owner’s act, for good', () => {
    const explanation = explainLostAccount(
      { cause: 'account-revoked', final: true },
      'vps-rp-skills',
      true,
    );
    expect(explanation.summary).toBe(
      '“vps-rp-skills” was disconnected by its owner; calls through it are refused.',
    );
    expect(explanation.lines.join(' ')).toContain('never comes back');
    expect(explanation.lines.join(' ')).toContain('until you remove it from the mission');
  });

  it('tells a teammate that the creator lost the access, and that the creator removes it', () => {
    const explanation = explainLostAccount(
      { cause: 'access-withdrawn', final: false },
      'Depot',
      false,
    );
    expect(explanation.summary).toMatch(
      /^The creator of this mission no longer has access to “Depot”/,
    );
    expect(explanation.lines.join(' ')).toContain('until the creator removes it');
  });

  it('names an account that no longer exists without a name', () => {
    expect(explainLostAccount({ cause: 'account-missing', final: true }, null, true).summary).toBe(
      'This account no longer exists; calls through it are refused.',
    );
  });
});

const ACCOUNTS = [{ id: 'c1', display_name: 'Depot' }];

describe('explainOrphan', () => {
  it('has a title and at least one line for every cause', () => {
    for (const cause of ORPHAN_CAUSES) {
      const explanation = explainOrphan(
        { cause, account_id: 'c1', uncovered: ['acme.read-things'] },
        ACCOUNTS,
      );
      expect(explanation.title).toMatch(/^Needs an owner: /);
      expect(explanation.lines.length).toBeGreaterThan(0);
    }
  });

  it('says a lost authority can come back, names the account and the risks, and that its activity is kept', () => {
    const explanation = explainOrphan(
      {
        cause: 'authority-lost',
        account_id: 'c1',
        uncovered: ['acme.read-things', 'acme[staging].thing-write'],
      },
      ACCOUNTS,
    );
    expect(explanation.reversible).toBe(true);
    const text = explanation.lines.join(' ');
    expect(text).toContain('the account “Depot”');
    expect(text).toContain('acme.read-things, acme[staging].thing-write');
    expect(text).toContain('serves calls again');
    expect(text).toContain('its activity and what it counted are kept');
  });

  it('says a revoked account never comes back', () => {
    const explanation = explainOrphan(
      { cause: 'account-revoked', account_id: 'c1', uncovered: [] },
      ACCOUNTS,
    );
    expect(explanation.reversible).toBe(false);
    expect(explanation.lines.join(' ')).toContain('never comes back');
    expect(explanation.lines.join(' ')).not.toContain('serves calls again');
  });

  it('cuts a long list of risks and survives an unknown account', () => {
    const uncovered = Array.from({ length: 9 }, (_, i) => `acme.risk-${i}`);
    const explanation = explainOrphan(
      { cause: 'authority-lost', account_id: 'gone', uncovered },
      ACCOUNTS,
    );
    expect(explanation.lines[0]).toContain('one of its accounts');
    expect(explanation.lines[0]).toContain('acme.risk-5 and 3 more');
    expect(explanation.lines[0]).not.toContain('acme.risk-6');
  });
});
