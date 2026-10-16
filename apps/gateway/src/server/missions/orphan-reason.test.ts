import { describe, expect, it } from 'vitest';

import { ORPHAN_CAUSES } from '../authority/mission-grounds';
import { explainOrphan } from './orphan-reason';

const CONNECTIONS = [{ id: 'c1', display_name: 'Depot' }];

describe('explainOrphan', () => {
  it('has a title and at least one line for every cause', () => {
    for (const cause of ORPHAN_CAUSES) {
      const explanation = explainOrphan(
        { cause, connection_id: 'c1', uncovered: ['acme.read-things'] },
        CONNECTIONS,
      );
      expect(explanation.title).toMatch(/^Needs an owner: /);
      expect(explanation.lines.length).toBeGreaterThan(0);
    }
  });

  it('says a lost authority can come back, names the connection and the risks, and that the session is kept', () => {
    const explanation = explainOrphan(
      {
        cause: 'authority-lost',
        connection_id: 'c1',
        uncovered: ['acme.read-things', 'acme[staging].thing-write'],
      },
      CONNECTIONS,
    );
    expect(explanation.reversible).toBe(true);
    const text = explanation.lines.join(' ');
    expect(text).toContain('the account “Depot”');
    expect(text).toContain('acme.read-things, acme[staging].thing-write');
    expect(text).toContain('serves calls again');
    expect(text).toContain('its activity and what it counted are kept');
  });

  it('says a revoked connection never comes back', () => {
    const explanation = explainOrphan(
      { cause: 'connection-revoked', connection_id: 'c1', uncovered: [] },
      CONNECTIONS,
    );
    expect(explanation.reversible).toBe(false);
    expect(explanation.lines.join(' ')).toContain('never comes back');
    expect(explanation.lines.join(' ')).not.toContain('serves calls again');
  });

  it('cuts a long list of risks and survives an unknown connection', () => {
    const uncovered = Array.from({ length: 9 }, (_, i) => `acme.risk-${i}`);
    const explanation = explainOrphan(
      { cause: 'authority-lost', connection_id: 'gone', uncovered },
      CONNECTIONS,
    );
    expect(explanation.lines[0]).toContain('one of its accounts');
    expect(explanation.lines[0]).toContain('acme.risk-5 and 3 more');
    expect(explanation.lines[0]).not.toContain('acme.risk-6');
  });
});
