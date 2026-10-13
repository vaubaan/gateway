import { describe, expect, it } from 'vitest';

import type { MissionState } from '@/server/budget';

import {
  allowLines,
  briefLabel,
  createdBy,
  missionMark,
  nearestLimit,
  perMinuteOf,
  reachOf,
  yesOf,
} from './mission-view';

const PERIOD = { index: 0, start: '2026-10-13T00:00:00.000Z', end: '2026-10-14T00:00:00.000Z' };

function active(exhausted: string[] = []): MissionState {
  return { kind: 'active', period: PERIOD, exhausted, remaining: {} };
}

describe('the state of a mission, in words', () => {
  it('writes the normal state plainly and colours only the exception', () => {
    expect(missionMark(active(), 0)).toEqual({ label: 'running', tone: null, over: false });
    expect(missionMark(active(['acme.read']), 0)).toMatchObject({
      label: 'Limit reached',
      tone: 'bad',
    });
    expect(missionMark({ kind: 'orphaned' }, 0)).toMatchObject({
      label: 'Needs an owner',
      tone: 'bad',
      over: false,
    });
  });

  it('says a request waits before it says anything else about a running mission', () => {
    expect(missionMark(active(['acme.read']), 2)).toMatchObject({
      label: 'Waiting for you',
      tone: 'warn',
    });
    // A teammate reads whose answer it waits for.
    expect(missionMark(active(), 1, 'alice@acme.test')).toMatchObject({
      label: 'Waiting for alice@acme.test',
      tone: 'warn',
    });
  });

  it('draws a mission that serves nothing any more as over, without a colour', () => {
    expect(missionMark({ kind: 'revoked' }, 3)).toEqual({
      label: 'stopped',
      tone: null,
      over: true,
    });
    expect(missionMark({ kind: 'expired', expires_at: null }, 0)).toEqual({
      label: 'expired',
      tone: null,
      over: true,
    });
  });
});

describe('Can / Asks first / Cannot', () => {
  const policy = [
    { label: 'Read code', gate: 'auto' as const },
    { label: 'Open a pull request', gate: 'auto' as const },
    { label: 'Write on main (direct commit OR PR merge)', gate: 'approval' as const },
  ];

  it('sums up the explicit list and says how many permissions each line stands for', () => {
    const lines = allowLines(policy, ['Delete a release', 'Modify branch protection']);
    expect(lines.can).toBe('Read code · Open a pull request. 2 permissions.');
    expect(lines.asks).toBe('Write on main. 1 permission.');
    expect(lines.cannot).toBe(
      'Delete a release · Modify branch protection, and anything outside its accounts and resources.',
    );
  });

  it('leaves the asking line out when nothing asks, and counts what it does not name', () => {
    const many = Array.from({ length: 6 }, (_, i) => ({
      label: `Thing ${i}`,
      gate: 'auto' as const,
    }));
    const lines = allowLines(many, []);
    expect(lines.asks).toBeNull();
    expect(lines.can).toBe('Thing 0 · Thing 1 · Thing 2 and 3 more. 6 permissions.');
    expect(lines.cannot).toBe('Anything outside its accounts and resources.');
    expect(allowLines(many, [], 2).can).toBe('Thing 0 · Thing 1 and 4 more. 6 permissions.');
  });

  it('says so when nothing runs without asking', () => {
    expect(allowLines([{ label: 'Merge', gate: 'approval' }], []).can).toBe(
      'Nothing runs without asking.',
    );
  });

  it('names a permission without its parenthesis, and keeps a label that is only one', () => {
    expect(briefLabel('Modify a workflow (.github/workflows/*.yml)')).toBe('Modify a workflow');
    expect(briefLabel('Create branches under feature/*, …')).toBe(
      'Create branches under feature/*',
    );
    expect(briefLabel('(everything)')).toBe('(everything)');
  });
});

describe('the one limit that matters', () => {
  it('is the permission closest to its limit, once one is near', () => {
    const near = nearestLimit([
      { label: 'Reads', quota: 1000, remaining: 900 },
      { label: 'Branch writes', quota: 3000, remaining: 1140 },
      { label: 'Merges', quota: 10, remaining: 0 },
    ]);
    expect(near).toEqual({ label: 'Merges', used: 10, limit: 10, near: 2 });
  });

  it('is nothing while every permission is far from its limit, or the mission has no period', () => {
    expect(nearestLimit([{ label: 'Reads', quota: 1000, remaining: 900 }])).toBeNull();
    expect(nearestLimit([{ label: 'Reads', quota: 1000, remaining: null }])).toBeNull();
  });
});

describe('small sentences', () => {
  it('says a limit per minute whatever window it was stored with', () => {
    expect(perMinuteOf({ max: 240, window_seconds: 60 })).toBe(240);
    expect(perMinuteOf({ max: 10, window_seconds: 30 })).toBe(20);
    expect(perMinuteOf({ max: 1, window_seconds: 3600 })).toBe(1);
  });

  it('says who created a mission and whose yes it waits for', () => {
    expect(createdBy('alice@acme.test', true)).toBe('Created by you');
    expect(createdBy('alice@acme.test', false)).toBe('Created by alice@acme.test');
    expect(createdBy(null, false)).toBe('Created by someone who left');
    expect(yesOf('Alice')).toBe('Alice’s yes');
    expect(yesOf(null)).toBe('the creator’s yes');
  });

  it('says what a mission reaches in a few words', () => {
    expect(
      reachOf([
        { provider_label: 'GitHub', resources: [{ ref: 'acme/app' }, { ref: 'acme/web' }] },
        { provider_label: 'Resend', resources: [] },
      ]),
    ).toEqual(['GitHub acme/app, acme/web', 'Resend']);
  });
});
