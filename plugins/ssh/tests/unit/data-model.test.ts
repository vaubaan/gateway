import { describe, expect, test } from 'vitest';
import { validateDataModel } from '@vaubaan/plugin-sdk';

import { sshDataModel } from '../../src/data-model.ts';

describe('sshDataModel — referential integrity', () => {
  test('every entity.parent references an existing entity in the same plane', () => {
    expect(validateDataModel(sshDataModel)).toEqual([]);
  });

  test('one plane ; the host is the only env-scopable entity ; one marker per class the classifier emits', () => {
    expect(sshDataModel.planes.map((p) => p.slug)).toEqual(['host']);
    const entities = sshDataModel.planes[0]!.entities;
    expect(entities.map((e) => e.name)).toEqual([
      'host',
      'command',
      'secret-file',
      'destructive',
      'package',
      'service',
      'privilege',
    ]);
    expect(entities.filter((e) => e.envScopable).map((e) => e.name)).toEqual(['host']);
    expect(entities.filter((e) => e.parent === 'command').map((e) => e.name)).toEqual([
      'secret-file',
      'destructive',
      'package',
      'service',
      'privilege',
    ]);
  });
});
