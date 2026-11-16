/**
 * Mandatory test suite of the `vaubaan` plugin: the SDK kit, the catalog and
 * its macro-actions at each trust level, the host credential, the classifier,
 * and the two `execute`s — the declared one, which refuses every call, and the
 * one the host binds to its ports. No IO.
 *
 * The identifier proof of the kit (`assertIdentifiersRefused`) is not run: its
 * `execute` is the host's, which never builds a URL, and the host reads every
 * argument again with its own schemas (`apps/gateway/src/server/vaubaan`).
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from 'vitest';

import { catalogPathNextTo, serializeSlice } from '@vaubaan/plugin-sdk';
import {
  assertCatalogCoverage,
  assertNoWildcard,
  assertPluginWellFormed,
  assertSlicesOnDataModel,
  policyFromMacroActions,
} from '@vaubaan/plugin-sdk/testing';

import defaultExport, {
  classifyVaubaan,
  createVaubaanExecute,
  EXAMPLE_MISSION_ID,
  executeOutsideTheHost,
  HostOnlyPluginError,
  INTERNAL_ERROR_RESULT,
  MALFORMED_MISSION_ID,
  SERVICE_ID,
  TOOL,
  vaubaanCatalog,
  vaubaanPlugin,
  type VaubaanExecuteContext,
  type VaubaanPorts,
} from '../../src/index.ts';

const RISK = {
  readSetup: `${SERVICE_ID}.read-setup`,
  readMissions: `${SERVICE_ID}.read-missions`,
  issue: `${SERVICE_ID}.mission-issue`,
  rename: `${SERVICE_ID}.mission-rename`,
  edit: `${SERVICE_ID}.mission-edit`,
  rotate: `${SERVICE_ID}.mission-key-rotate`,
  revoke: `${SERVICE_ID}.mission-revoke`,
} as const;

function slices(tool: string, args: Record<string, unknown>): string[] {
  const out = classifyVaubaan(tool, args);
  if ('denied' in out) throw new Error(out.denied);
  return out.slices.map(serializeSlice);
}

describe('vaubaan plugin — structural kit', () => {
  test('well-formed, no wildcard', () => {
    assertPluginWellFormed(vaubaanPlugin);
    assertNoWildcard(vaubaanPlugin);
  });

  test('every tool classifies to slices the catalog covers, none on the fallback', () => {
    const report = assertCatalogCoverage(vaubaanPlugin);
    assertSlicesOnDataModel(vaubaanPlugin, vaubaanPlugin.examples, { resources: [] });
    const named = vaubaanCatalog.catalog.risks.filter((r) => !r.fallback).map((r) => r.id);
    expect(named).toEqual(Object.values(RISK));
    expect([...report.risksTouched].sort()).toEqual([...named].sort());
    expect(report.risksUntouched).toEqual([]);
    expect(report.fallbackHits).toEqual([]);
  });

  test('the catalog is read from a filesystem path next to the plugin module', () => {
    const path = catalogPathNextTo(new URL('../../src/index.ts', import.meta.url));
    expect(path).toBe(fileURLToPath(new URL('../../src/risk-catalog.yaml', import.meta.url)));
    expect(existsSync(path)).toBe(true);
    expect(vaubaanCatalog.catalog.service).toBe(SERVICE_ID);
    expect(vaubaanPlugin.id).toBe(SERVICE_ID);
  });

  test('the plugin is the default export, at the version of its package', () => {
    expect(defaultExport).toBe(vaubaanPlugin);
    const pkg = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as { version: string };
    expect(vaubaanPlugin.version).toBe(pkg.version);
  });

  test('the credential is a host account: no field, nothing to verify', () => {
    expect(vaubaanPlugin.credential).toEqual({ kind: 'host' });
  });

  test('no environment anywhere', () => {
    expect('envOf' in vaubaanPlugin).toBe(false);
    for (const plane of vaubaanPlugin.dataModel.planes) {
      expect(plane.entities.some((e) => e.envScopable)).toBe(false);
    }
    for (const risk of vaubaanCatalog.catalog.risks) {
      expect(risk.acceptable_in_envs).toBeUndefined();
    }
  });
});

describe('vaubaan catalog — the macro-actions at each trust level', () => {
  test('four macro-actions, every risk but the fallback in exactly one', () => {
    expect(vaubaanCatalog.catalog.macro_actions?.map((action) => action.id)).toEqual([
      'read',
      'prepare',
      'rotate',
      'stop',
    ]);
  });

  test('Careful: the setup is read and a mission renamed freely; issuing, editing, re-keying and stopping a mission ask first', () => {
    const policy = policyFromMacroActions(vaubaanPlugin, {
      read: 'careful',
      prepare: 'careful',
      rotate: 'careful',
      stop: 'careful',
    });
    const gates = Object.fromEntries(policy.map((line) => [line.risk_id, line.gate]));
    expect(gates).toEqual({
      [RISK.readSetup]: 'auto',
      [RISK.readMissions]: 'auto',
      [RISK.issue]: 'approval',
      [RISK.rename]: 'auto',
      [RISK.edit]: 'approval',
      [RISK.rotate]: 'approval',
      [RISK.revoke]: 'approval',
    });
  });

  test('Trusting: issuing, renaming, editing and re-keying run freely, stopping a mission still asks', () => {
    const policy = policyFromMacroActions(vaubaanPlugin, {
      prepare: 'trusting',
      rotate: 'trusting',
      stop: 'trusting',
    });
    const gates = Object.fromEntries(policy.map((line) => [line.risk_id, line.gate]));
    expect(gates).toEqual({
      [RISK.issue]: 'auto',
      [RISK.rename]: 'auto',
      [RISK.edit]: 'auto',
      [RISK.rotate]: 'auto',
      [RISK.revoke]: 'approval',
    });
  });
});

describe('classifyVaubaan', () => {
  test('each tool lands on its plane', () => {
    expect(slices(TOOL.listMyAccounts, {})).toEqual([`${SERVICE_ID}.account[*].R`]);
    expect(slices(TOOL.previewPolicy, { name: 'x' })).toEqual([`${SERVICE_ID}.account[*].R`]);
    expect(slices(TOOL.getCatalog, { service: 'github' })).toEqual([
      `${SERVICE_ID}.catalog[github].R`,
    ]);
    expect(slices(TOOL.listMyMissions, {})).toEqual([`${SERVICE_ID}.mission[*].R`]);
    expect(slices(TOOL.listMyMissions, { mission_id: EXAMPLE_MISSION_ID })).toEqual([
      `${SERVICE_ID}.mission[${EXAMPLE_MISSION_ID}].R`,
    ]);
    expect(slices(TOOL.issueMission, { name: 'x' })).toEqual([`${SERVICE_ID}.mission[*].issue.W`]);
    expect(slices(TOOL.previewPolicy, { name: 'x', mission_id: EXAMPLE_MISSION_ID })).toEqual([
      `${SERVICE_ID}.account[*].R`,
      `${SERVICE_ID}.mission[${EXAMPLE_MISSION_ID}].R`,
    ]);
    expect(slices(TOOL.renameMission, { mission_id: EXAMPLE_MISSION_ID, name: 'y' })).toEqual([
      `${SERVICE_ID}.mission[${EXAMPLE_MISSION_ID}].rename.W`,
    ]);
    expect(slices(TOOL.editMission, { mission_id: EXAMPLE_MISSION_ID, name: 'x' })).toEqual([
      `${SERVICE_ID}.mission[${EXAMPLE_MISSION_ID}].edit.W`,
    ]);
    expect(slices(TOOL.rotateMissionToken, { mission_id: EXAMPLE_MISSION_ID })).toEqual([
      `${SERVICE_ID}.mission[${EXAMPLE_MISSION_ID}].token.W`,
    ]);
    expect(slices(TOOL.revokeMission, { mission_id: EXAMPLE_MISSION_ID })).toEqual([
      `${SERVICE_ID}.mission[${EXAMPLE_MISSION_ID}].revoke.W`,
    ]);
  });

  test('refuses an unknown tool, an undeclared argument, a missing mission id', () => {
    expect(classifyVaubaan(`${SERVICE_ID}__request_permission`, {})).toEqual({
      denied: `unknown tool '${SERVICE_ID}__request_permission'`,
    });
    expect('denied' in classifyVaubaan(TOOL.revokeMission, { mission_id: 'm', force: 1 })).toBe(
      true,
    );
    expect(classifyVaubaan(TOOL.rotateMissionToken, {})).toEqual({ denied: MALFORMED_MISSION_ID });
    expect(classifyVaubaan(TOOL.editMission, { name: 'x' })).toEqual({
      denied: MALFORMED_MISSION_ID,
    });
  });
});

describe('the two executes', () => {
  const ctx = (missionId = 'mission-caller'): VaubaanExecuteContext =>
    ({
      caller: { missionId, userId: 'user-ada', holderUserId: 'user-ada' },
    }) as unknown as VaubaanExecuteContext;

  test('the declared execute refuses every call: only the host runs one', async () => {
    await expect(executeOutsideTheHost()).rejects.toBeInstanceOf(HostOnlyPluginError);
    expect(vaubaanPlugin.execute).toBe(executeOutsideTheHost);
  });

  test('the host-bound execute hands the caller and the arguments to the act of the tool', async () => {
    const seen: unknown[] = [];
    const ports = Object.fromEntries(
      Object.keys(TOOL).map((act) => [
        act,
        async (caller: unknown, args: unknown) => {
          seen.push([act, caller, args]);
          return { ok: true, data: { act } } as const;
        },
      ]),
    ) as unknown as VaubaanPorts;
    const execute = createVaubaanExecute(ports);
    const result = await execute(ctx(), TOOL.revokeMission, { mission_id: 'm1' });
    expect(result.structuredContent).toEqual({ act: 'revokeMission' });
    expect(seen).toEqual([
      [
        'revokeMission',
        { missionId: 'mission-caller', userId: 'user-ada', holderUserId: 'user-ada' },
        { mission_id: 'm1' },
      ],
    ]);
    await expect(execute(ctx(), `${SERVICE_ID}__nope`, {})).rejects.toThrow(/unknown tool/);
  });

  test('a port that throws answers internal-error, with nothing of the cause', async () => {
    const ports = Object.fromEntries(
      Object.keys(TOOL).map((act) => [
        act,
        async () => {
          throw new Error('secret detail');
        },
      ]),
    ) as unknown as VaubaanPorts;
    const result = await createVaubaanExecute(ports)(ctx(), TOOL.listMyMissions, {});
    expect(result).toEqual(INTERNAL_ERROR_RESULT);
    expect(JSON.stringify(result)).not.toContain('secret detail');
  });
});
