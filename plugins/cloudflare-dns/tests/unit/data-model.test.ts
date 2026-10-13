import { describe, expect, test } from 'vitest';
import { validateDataModel } from '@vaubaan/plugin-sdk';

import { cloudflareDnsDataModel } from '../../src/index.ts';

const entities = () => cloudflareDnsDataModel.planes[0]!.entities;

describe('cloudflareDnsDataModel — referential integrity', () => {
  test('every entity.parent references an existing entity in the same plane', () => {
    expect(validateDataModel(cloudflareDnsDataModel)).toEqual([]);
  });

  test('declares exactly one plane (dns)', () => {
    expect(cloudflareDnsDataModel.planes).toHaveLength(1);
    expect(cloudflareDnsDataModel.planes[0]!.slug).toBe('dns');
  });

  test('no entity has envScopable (DNS has no test/live mode)', () => {
    for (const entity of entities()) {
      expect(entity.envScopable, `entity '${entity.name}' should NOT be envScopable`).toBeFalsy();
    }
  });

  test('account is the plane root (parent === null)', () => {
    const account = entities().find((e) => e.name === 'account');
    expect(account).toBeDefined();
    expect(account!.parent).toBeNull();
    expect(account!.cardinalities).toContain('one');
  });

  test('zone is child of account with bounded cardinality', () => {
    const zone = entities().find((e) => e.name === 'zone');
    expect(zone).toBeDefined();
    expect(zone!.parent).toBe('account');
    expect(zone!.cardinalities).toContain('bounded');
  });

  test('record is child of zone with unbounded cardinality', () => {
    const record = entities().find((e) => e.name === 'record');
    expect(record).toBeDefined();
    expect(record!.parent).toBe('zone');
    expect(record!.cardinalities).toContain('unbounded');
  });

  test('singleton entities under zone are declared with cardinality one', () => {
    for (const slug of ['zone-settings', 'dnssec', 'cache', 'zone-import', 'zone-export']) {
      const e = entities().find((x) => x.name === slug);
      expect(e, `entity '${slug}' must be declared`).toBeDefined();
      expect(e!.parent).toBe('zone');
      expect(e!.cardinalities).toEqual(['one']);
    }
  });

  test('the synthetic overlays critical and delete hang under record', () => {
    for (const slug of ['critical', 'delete']) {
      const e = entities().find((x) => x.name === slug);
      expect(e, `entity '${slug}' must be declared`).toBeDefined();
      expect(e!.parent).toBe('record');
      expect(e!.cardinalities).toEqual(['one']);
    }
  });

  test('declares exactly these 10 entities', () => {
    expect(
      entities()
        .map((e) => e.name)
        .sort(),
    ).toEqual(
      [
        'account',
        'cache',
        'critical',
        'delete',
        'dnssec',
        'record',
        'zone',
        'zone-export',
        'zone-import',
        'zone-settings',
      ].sort(),
    );
  });
});
