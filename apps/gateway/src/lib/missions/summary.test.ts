import { describe, expect, it } from 'vitest';

import type { DraftConnection, DraftPeriod } from './model';
import { previewDraft } from './preview';
import { expiryPhrase, periodPhrase, reloadPhrase, shortLabel } from './summary';
import { acmeConnection } from '../../server/missions/testing';

const NOW = new Date('2026-10-13T09:00:00.000Z');

function summaryOf(
  connections: readonly DraftConnection[],
  period: DraftPeriod = { kind: 'recurring', length_seconds: 86_400 },
  expiresAt: string | null = null,
) {
  return previewDraft(
    { connections: [acmeConnection()], now: NOW },
    { name: 'm', connections, period, expires_at: expiresAt },
  ).summary;
}

describe('summarize — the three lines of the creation screen', () => {
  it('says what the mission can do, per connection, with its most severe risk', () => {
    const s = summaryOf([
      { connection_id: 'conn-acme', trust_levels: { read: 'careful', change: 'trusting' } },
    ]);
    expect(s.can).toBe(
      'Acme "Acme main": 4 risks on 3 of 3 resources, up to "Delete things in bulk" (high).',
    );
  });

  it('says what it cannot do: withheld risks by severity, resources left out', () => {
    const s = summaryOf([
      {
        connection_id: 'conn-acme',
        trust_levels: { read: 'careful' },
        resources: { scope: 'selected', resource_refs: ['app-prod'] },
      },
    ]);
    expect(s.cannot).toBe(
      'Acme: 5 risks withheld, the most severe "Delete things in bulk" (high); 2 resources left out. Anything outside the selected resources and the accepted risks is refused.',
    );
  });

  it('says in what quantities: widest quota, fastest rate, approvals, reload, expiry', () => {
    const s = summaryOf(
      [{ connection_id: 'conn-acme', trust_levels: { read: 'careful', change: 'trusting' } }],
      { kind: 'recurring', length_seconds: 86_400 },
      '2026-11-01T00:00:00.000Z',
    );
    expect(s.quantities).toBe(
      'At most 300 actions per day on the widest risk ("Write a thing") · fastest 180 per 60s · 3 risks need your approval for each action · quotas reload every day · expires 2026-11-01 00:00 UTC.',
    );
  });

  it('speaks of a total for a one-off mission that never expires', () => {
    const s = summaryOf([{ connection_id: 'conn-acme', trust_levels: { read: 'careful' } }], {
      kind: 'one-off',
    });
    expect(s.quantities).toContain('At most 100 actions in total');
    expect(s.quantities).toContain('no approval gate');
    expect(s.quantities).toContain('quotas never reload (one-off)');
    expect(s.quantities).toContain('never expires');
  });

  it('stays readable before anything is picked', () => {
    const s = summaryOf([]);
    expect(s.can).toBe('Nothing yet — include a connection and tick a macro-action.');
    expect(s.cannot).toBe('Everything: no connection is included.');
    expect(s.quantities).toBe('No budget yet.');
  });
});

describe('shortLabel', () => {
  it('keeps a short label and cuts a long one with an ellipsis', () => {
    expect(shortLabel('Read code')).toBe('Read code');
    const cut = shortLabel('Modify a deployment workflow file under the workflows folder');
    expect(cut).toBe('Modify a deployment workflow file under the…');
    expect(cut.length).toBeLessThanOrEqual(44);
  });
});

describe('period and expiry phrases', () => {
  it('names the usual periods and spells out the others', () => {
    const recurring = (length_seconds: number): DraftPeriod => ({
      kind: 'recurring',
      length_seconds,
    });
    expect(periodPhrase(recurring(3600))).toBe('per hour');
    expect(periodPhrase(recurring(604_800))).toBe('per week');
    expect(periodPhrase(recurring(172_800))).toBe('every 2 days');
    expect(periodPhrase(recurring(7200))).toBe('every 2 hours');
    expect(periodPhrase(recurring(1800))).toBe('every 30 minutes');
    expect(reloadPhrase(recurring(3600))).toBe('quotas reload every hour');
    expect(reloadPhrase(recurring(7200))).toBe('quotas reload every 2 hours');
  });
  it('tolerates an expiry that is not a date', () => {
    expect(expiryPhrase('nope')).toBe('expiry not set');
  });
});
