/**
 * The catalog's decisions that the kit does not check : which gates ask
 * first, what each macro-action holds at a trust cran, and the data model the
 * slices use.
 */
import { describe, expect, test } from 'vitest';

import { validateDataModel } from '@vaubaan/plugin-sdk';
import { policyFromMacroActions } from '@vaubaan/plugin-sdk/testing';

import { flyCatalog, flyDataModel, flyPlugin } from '../../src/index.ts';

const ENVS = { envs: ['staging', 'prod'] } as const;
const macroActions = flyCatalog.catalog.macro_actions;
const gatesAt = (crans: Parameters<typeof policyFromMacroActions>[1]) =>
  new Map(policyFromMacroActions(flyPlugin, crans, ENVS).map((l) => [l.risk_id, l.gate]));
const everyMacroAction = (cran: 'prudent' | 'confiant' | 'autonome') =>
  Object.fromEntries(macroActions.map((a) => [a.id, cran]));

describe('fly catalog', () => {
  test('destroying apps and volumes and running commands never run freely ; secrets ask first below Autonome', () => {
    const neverFree = /\.(app-destroy|volume-destroy|machine-exec)$/;
    for (const cran of ['prudent', 'confiant', 'autonome'] as const) {
      const gates = gatesAt(everyMacroAction(cran));
      for (const [riskId, gate] of gates) {
        if (neverFree.test(riskId)) expect(gate, `${riskId} at ${cran}`).toBe('approval');
      }
    }
    for (const cran of ['prudent', 'confiant'] as const) {
      expect(gatesAt({ secrets: cran }).get('fly[prod].secret-write')).toBe('approval');
    }
  });

  test('running a command inside a machine is in the operate macro-action only, left out at Prudent', () => {
    const holders = macroActions.filter((a) =>
      a.entries.some((e) => e.risk_id === 'fly.machine-exec'),
    );
    expect(holders.map((a) => a.id)).toEqual(['operate']);
    expect(gatesAt({ operate: 'prudent' }).has('fly[prod].machine-exec')).toBe(false);
    expect(gatesAt({ operate: 'confiant' }).get('fly[prod].machine-exec')).toBe('approval');
  });

  test('operate at Confiant : deploys, power, scaling and snapshots run freely, the shell asks first', () => {
    expect(
      policyFromMacroActions(flyPlugin, { operate: 'confiant' }, ENVS).map(
        (e) => `${e.risk_id}:${e.gate}`,
      ),
    ).toEqual([
      'fly[staging].deploy:auto',
      'fly[prod].deploy:auto',
      'fly[staging].scale:auto',
      'fly[prod].scale:auto',
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

  test('observe holds reads only ; at Prudent production deploys and configuration ask first', () => {
    const observe = macroActions.find((a) => a.id === 'observe')!;
    expect(observe.entries.every((e) => e.risk_id.startsWith('fly.read-'))).toBe(true);
    const prudent = gatesAt({ operate: 'prudent', build: 'confiant', 'tear-down': 'prudent' });
    expect(prudent.get('fly[prod].deploy')).toBe('approval');
    expect(prudent.get('fly[prod].machine-config-write')).toBe('approval');
    expect(prudent.get('fly[staging].machine-power')).toBe('auto');
    expect(prudent.has('fly[prod].volume-destroy')).toBe(false);
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
