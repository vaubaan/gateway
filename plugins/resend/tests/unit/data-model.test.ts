import { describe, expect, test } from 'vitest';
import { validateDataModel } from '@vaubaan/plugin-sdk';

import { resendDataModel } from '../../src/index.ts';

const entities = resendDataModel.planes[0]!.entities;
const entity = (name: string) => entities.find((e) => e.name === name)!;

describe('resendDataModel', () => {
  test('referential integrity, one plane (email), nine entities', () => {
    expect(validateDataModel(resendDataModel)).toEqual([]);
    expect(resendDataModel.provider).toBe('resend');
    expect(resendDataModel.planes.map((p) => p.slug)).toEqual(['email']);
    expect(entities).toHaveLength(9);
  });

  test('the roots are the two resource kinds plus the account-level contact and email', () => {
    expect(
      entities
        .filter((e) => e.parent === null)
        .map((e) => e.name)
        .sort(),
    ).toEqual(['contact', 'domain', 'email', 'segment']);
  });

  test('domain and segment are the env-scopable entities — the resources the owner labels', () => {
    expect(entities.filter((e) => e.envScopable).map((e) => e.name)).toEqual(['domain', 'segment']);
  });

  test('the sending markers hang under the domain, membership and broadcasts under the segment', () => {
    for (const name of ['dns-record', 'to-zone', 'recipient-count']) {
      expect(entity(name).parent, name).toBe('domain');
    }
    for (const name of ['member', 'broadcast']) {
      expect(entity(name).parent, name).toBe('segment');
    }
  });

  test('cardinalities : resources bounded, history unbounded, markers bounded', () => {
    expect(entity('domain').cardinalities).toEqual(['bounded']);
    expect(entity('segment').cardinalities).toEqual(['bounded']);
    for (const name of ['email', 'contact', 'broadcast', 'member']) {
      expect(entity(name).cardinalities, name).toEqual(['unbounded']);
    }
    for (const name of ['to-zone', 'recipient-count', 'dns-record']) {
      expect(entity(name).cardinalities, name).toEqual(['bounded']);
    }
  });

  test('the version 1 account root and batch marker are gone', () => {
    expect(entities.find((e) => e.name === 'account')).toBeUndefined();
    expect(entities.find((e) => e.name === 'batch')).toBeUndefined();
  });
});
