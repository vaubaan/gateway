/**
 * The candidate resource sets of a call and their label (risk model §4.7): the sets of
 * every ref each slice cites; a slice naming none brings every set in.
 */
import { parseSlice } from '@vaubaan/policy-engine';
import { describe, expect, it } from 'vitest';

import { candidateResourceSets, resourceSetsLabel } from '../../src/risk-gateway.ts';

const SETS = [
  { id: 's1', position: 1, refs: ['alpha', 'gamma'] },
  { id: 's2', position: 2, refs: ['beta'] },
  { id: 's3', position: 3, refs: ['delta'] },
];
const slices = (...texts: string[]) => texts.map((t) => parseSlice(t));
const ids = (sets: readonly { id: string }[]) => sets.map((s) => s.id);

describe('candidateResourceSets', () => {
  it('places a call naming one resource in its set', () => {
    expect(ids(candidateResourceSets(slices('twin.space[beta].item[*].R'), SETS))).toEqual(['s2']);
  });

  it('places a call naming resources of two sets in both, in position order', () => {
    const named = slices('twin.space[delta].item[*].W', 'twin.space[alpha].item[*].R');
    expect(ids(candidateResourceSets(named, SETS))).toEqual(['s1', 's3']);
  });

  it('judges a call naming no resource against every set', () => {
    expect(ids(candidateResourceSets(slices('twin.account.profile.R'), SETS))).toEqual([
      's1',
      's2',
      's3',
    ]);
  });

  it('brings every set in as soon as one slice names no resource', () => {
    const mixed = slices('twin.space[beta].item[*].R', 'twin.account.profile.R');
    expect(ids(candidateResourceSets(mixed, SETS))).toHaveLength(3);
  });

  it('takes every identifier equal to a ref: a nested one of another set brings its set in', () => {
    expect(ids(candidateResourceSets(slices('twin.space[gamma].item[beta].R'), SETS))).toEqual([
      's1',
      's2',
    ]);
  });

  it('is not fooled by an org slug equal to the ref of an app of another set (Fly)', () => {
    const fly = [
      { id: 's1', position: 1, refs: ['acme'] },
      { id: 's2', position: 2, refs: ['acme-db'] },
    ];
    expect(ids(candidateResourceSets(slices('fly.org[acme].app[acme-db].deploy.W'), fly))).toEqual([
      's1',
      's2',
    ]);
  });

  it('judges a list naming resources of two sets against both', () => {
    const boards = [
      { id: 's1', position: 1, refs: ['b1'] },
      { id: 's2', position: 2, refs: ['b2'] },
    ];
    expect(ids(candidateResourceSets(slices('miro.board[b1,b2].item[*].W'), boards))).toEqual([
      's1',
      's2',
    ]);
  });
});

describe('resourceSetsLabel', () => {
  it('names one set, two sets and more', () => {
    expect(resourceSetsLabel([{ position: 2 }])).toBe('resource set 2');
    expect(resourceSetsLabel([{ position: 1 }, { position: 2 }])).toBe('resource sets 1 and 2');
    expect(resourceSetsLabel([{ position: 1 }, { position: 2 }, { position: 4 }])).toBe(
      'resource sets 1, 2 and 4',
    );
  });
});
