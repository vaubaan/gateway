/**
 * The catalog's decisions that the kit does not check : which gates ask
 * first, what each preset holds, and the data model the slices use.
 */
import { describe, expect, test } from 'vitest';

import { validateDataModel } from '@vaubaan/plugin-sdk';

import { flyCatalog, flyDataModel } from '../../src/index.ts';

const presets = flyCatalog.catalog.presets ?? [];
const preset = (id: string) => presets.find((p) => p.id === id)!;
const entriesOf = (id: string) => preset(id).entries;

describe('fly catalog', () => {
  test('destroying apps and volumes, writing secrets and running commands always ask first', () => {
    const askFirst = /\.(app-destroy|volume-destroy|secret-write|machine-exec)$/;
    const entries = presets.flatMap((p) => p.entries).filter((e) => askFirst.test(e.risk_id));
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) expect(entry.gate, entry.risk_id).toBe('approval');
  });

  test('running a command inside a machine is in the operator preset only', () => {
    const holders = presets.filter((p) =>
      p.entries.some((e) => e.risk_id.endsWith('.machine-exec')),
    );
    expect(holders.map((p) => p.id)).toEqual(['operator']);
  });

  test('fleet-upgrade : snapshots and image changes run freely, nothing else is written', () => {
    expect(entriesOf('fleet-upgrade').map((e) => `${e.risk_id}:${e.gate}`)).toEqual([
      'fly.read-org:auto',
      'fly.read-runtime:auto',
      'fly.read-logs:auto',
      'fly.volume-snapshot:auto',
      'fly[staging].deploy:auto',
      'fly[prod].deploy:auto',
      'fly[staging].machine-power:auto',
      'fly[prod].machine-power:auto',
    ]);
  });

  test('read-only holds reads only ; operator asks first for production configuration and images', () => {
    expect(entriesOf('read-only').every((e) => e.risk_id.startsWith('fly.read-'))).toBe(true);
    const operator = new Map(entriesOf('operator').map((e) => [e.risk_id, e.gate]));
    expect(operator.get('fly[prod].deploy')).toBe('approval');
    expect(operator.get('fly[prod].machine-config-write')).toBe('approval');
    expect(operator.get('fly[staging].deploy')).toBe('auto');
    expect(operator.has('fly[prod].volume-destroy')).toBe(false);
    expect(operator.has('fly.app-create')).toBe(false);
  });

  test('every named risk is in at least one preset, the fallback in none', () => {
    const inPresets = new Set(
      presets.flatMap((p) => p.entries.map((e) => e.risk_id.replace(/\[[a-z]+\]/, ''))),
    );
    for (const risk of flyCatalog.catalog.risks) {
      expect(inPresets.has(risk.id), risk.id).toBe(!risk.fallback);
    }
  });

  test('the data model is consistent and names every leaf once', () => {
    expect(validateDataModel(flyDataModel)).toEqual([]);
    const names = flyDataModel.planes.flatMap((p) => p.entities.map((e) => e.name));
    expect(new Set(names).size).toBe(names.length);
    expect(
      flyDataModel.planes[0]!.entities.filter((e) => e.envScopable).map((e) => e.name),
    ).toEqual(['app']);
  });
});
