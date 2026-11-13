/**
 * The catalog's decisions that the kit does not check : which gates ask
 * first, what each macro-action holds at a trust level, and the data model the
 * slices use.
 */
import { describe, expect, test } from 'vitest';

import { validateDataModel } from '@vaubaan/plugin-sdk';
import { policyFromMacroActions } from '@vaubaan/plugin-sdk/testing';

import { flyCatalog, flyDataModel, flyPlugin } from '../../src/index.ts';

const ENVS = { envs: ['staging', 'prod'] } as const;
const macroActions = flyCatalog.catalog.macro_actions;
const gatesAt = (trustLevels: Parameters<typeof policyFromMacroActions>[1]) =>
  new Map(policyFromMacroActions(flyPlugin, trustLevels, ENVS).map((l) => [l.risk_id, l.gate]));
const everyMacroAction = (trustLevel: 'careful' | 'trusting' | 'autonomous') =>
  Object.fromEntries(macroActions.map((a) => [a.id, trustLevel]));

describe('fly catalog', () => {
  test('destroying apps and volumes and running commands never run freely ; secrets ask first below Autonomous', () => {
    const neverFree = /\.(app-destroy|volume-destroy|machine-exec)$/;
    for (const trustLevel of ['careful', 'trusting', 'autonomous'] as const) {
      const gates = gatesAt(everyMacroAction(trustLevel));
      for (const [riskId, gate] of gates) {
        if (neverFree.test(riskId)) expect(gate, `${riskId} at ${trustLevel}`).toBe('approval');
      }
    }
    for (const trustLevel of ['careful', 'trusting'] as const) {
      expect(gatesAt({ secrets: trustLevel }).get('fly[prod].secret-write')).toBe('approval');
    }
  });

  test('running a command inside a machine is in the operate macro-action only, left out at Careful', () => {
    const holders = macroActions.filter((a) =>
      a.entries.some((e) => e.risk_id === 'fly.machine-exec'),
    );
    expect(holders.map((a) => a.id)).toEqual(['operate']);
    expect(gatesAt({ operate: 'careful' }).has('fly[prod].machine-exec')).toBe(false);
    expect(gatesAt({ operate: 'trusting' }).get('fly[prod].machine-exec')).toBe('approval');
  });

  test('operate at Trusting : deploys, power and snapshots run freely ; scaling (unbounded cost) and the shell ask first', () => {
    expect(
      policyFromMacroActions(flyPlugin, { operate: 'trusting' }, ENVS).map(
        (e) => `${e.risk_id}:${e.gate}`,
      ),
    ).toEqual([
      'fly[staging].deploy:auto',
      'fly[prod].deploy:auto',
      'fly[staging].scale:approval',
      'fly[prod].scale:approval',
      'fly[staging].machine-power:auto',
      'fly[prod].machine-power:auto',
      'fly[staging].machine-exec:approval',
      'fly[prod].machine-exec:approval',
      'fly[staging].volume-backup-settings:auto',
      'fly[prod].volume-backup-settings:auto',
      'fly.volume-snapshot:auto',
      'fly[staging].certificate-write:auto',
      'fly[prod].certificate-write:auto',
    ]);
  });

  test('observe holds reads only ; at Careful production deploys and configuration ask first', () => {
    const observe = macroActions.find((a) => a.id === 'observe')!;
    expect(observe.entries.every((e) => e.risk_id.startsWith('fly.read-'))).toBe(true);
    const careful = gatesAt({ operate: 'careful', build: 'trusting', 'tear-down': 'careful' });
    expect(careful.get('fly[prod].deploy')).toBe('approval');
    expect(careful.get('fly[prod].machine-config-write')).toBe('approval');
    expect(careful.get('fly[staging].machine-power')).toBe('approval');
    expect(careful.has('fly[prod].volume-destroy')).toBe(false);
  });

  test('every named risk is in exactly one macro-action, the fallback in none', () => {
    const owners = macroActions.flatMap((a) => a.entries.map((e) => e.risk_id));
    for (const risk of flyCatalog.catalog.risks) {
      expect(owners.filter((id) => id === risk.id).length, risk.id).toBe(risk.fallback ? 0 : 1);
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
