/**
 * Mandatory suite of the `fly` plugin : the SDK kit (definition, presets,
 * coverage of every tool, the identifier proof), identity and version.
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from 'vitest';

import { catalogPathNextTo, toolPrefixFor } from '@vaubaan/plugin-sdk';
import {
  assertCatalogCoverage,
  assertIdentifiersRefused,
  assertNoWildcard,
  assertPluginWellFormed,
  assertPresetsValid,
  type ToolSamples,
} from '@vaubaan/plugin-sdk/testing';

import { PROVIDER_ID, TOOL } from '../../src/identity.ts';
import defaultExport, { flyCatalog, flyPlugin } from '../../src/index.ts';
import {
  IMAGE,
  acme,
  appIdentityRoute,
  canary,
  config,
  context,
  leaseRoutes,
  machineRoute,
} from './fixtures.ts';

const M = { app: 'acme-gw', machine_id: 'm1' };
const V = { app: 'acme-gw', volume_id: 'vol_1' };
const H = { app: 'acme-gw', hostname: 'acme.example.com' };

/** One realistic call per tool, and the refusals worth showing. */
export const SAMPLES: ToolSamples = {
  [TOOL.listRegions]: [{ args: {} }],
  [TOOL.listApps]: [{ args: {} }],
  [TOOL.getApp]: [{ args: { app: 'acme-gw' } }, { args: { app: 'other-gw' }, expectDenied: true }],
  [TOOL.createApp]: [
    { args: { name: 'beta-gw', network: 'beta-net' } },
    { args: { name: 'beta-gw' }, expectDenied: true },
  ],
  [TOOL.destroyApp]: [{ args: { app: 'acme-gw' } }],
  [TOOL.listMachines]: [{ args: { app: 'acme-gw', region: 'cdg' } }],
  [TOOL.getMachine]: [{ args: M }],
  [TOOL.listMachineEvents]: [{ args: { ...M, limit: 10 } }],
  [TOOL.listMachineProcesses]: [{ args: M }],
  [TOOL.waitMachine]: [{ args: { ...M, state: 'started', timeout: 30 } }],
  [TOOL.createMachine]: [
    { args: { app: 'acme-gw', config: config(), region: 'cdg' } },
    { args: { app: 'acme-gw', config: config('nginx:latest'), region: 'cdg' }, expectDenied: true },
  ],
  [TOOL.updateMachine]: [{ args: { ...M, config: config() } }],
  [TOOL.deployImage]: [
    { args: { ...M, image: IMAGE } },
    { args: { ...M, image: 'ghcr.io/vaubaan/gateway:latest' }, expectDenied: true },
  ],
  [TOOL.scaleMachine]: [{ args: { ...M, cpu_kind: 'shared', cpus: 2, memory_mb: 1024 } }],
  [TOOL.startMachine]: [{ args: M }],
  [TOOL.stopMachine]: [{ args: M }],
  [TOOL.restartMachine]: [{ args: M }],
  [TOOL.suspendMachine]: [{ args: M }],
  [TOOL.cordonMachine]: [{ args: M }],
  [TOOL.uncordonMachine]: [{ args: M }],
  [TOOL.destroyMachine]: [{ args: M }],
  [TOOL.execMachine]: [{ args: { ...M, command: ['ls', '/data'] } }],
  [TOOL.listVolumes]: [{ args: { app: 'acme-gw' } }],
  [TOOL.getVolume]: [{ args: V }],
  [TOOL.listSnapshots]: [{ args: V }],
  [TOOL.createVolume]: [
    { args: { app: 'acme-gw', name: 'data', region: 'cdg', size_gb: 1 } },
    { args: { app: 'acme-gw', name: 'data', region: 'cdg', size_gb: 1, snapshot_id: 'vs_1' } },
    {
      args: { app: 'acme-gw', name: 'data', region: 'cdg', size_gb: 1, snapshot_retention: 14 },
    },
  ],
  [TOOL.extendVolume]: [{ args: { ...V, size_gb: 5 } }],
  [TOOL.updateVolume]: [{ args: { ...V, snapshot_retention: 30 } }],
  [TOOL.createSnapshot]: [{ args: V }],
  [TOOL.destroyVolume]: [{ args: V }],
  [TOOL.listSecrets]: [{ args: { app: 'acme-gw' } }],
  [TOOL.setSecrets]: [{ args: { app: 'acme-gw', values: { OIDC_ISSUER: 'https://id.example' } } }],
  [TOOL.unsetSecret]: [{ args: { app: 'acme-gw', name: 'OIDC_ISSUER' } }],
  [TOOL.listIps]: [{ args: { app: 'acme-gw' } }],
  [TOOL.allocateIp]: [{ args: { app: 'acme-gw', type: 'shared_v4' } }],
  [TOOL.releaseIp]: [{ args: { app: 'acme-gw', ip: '137.66.1.2' } }],
  [TOOL.listCertificates]: [{ args: { app: 'acme-gw' } }],
  [TOOL.getCertificate]: [{ args: H }],
  [TOOL.requestCertificate]: [{ args: H }],
  [TOOL.checkCertificate]: [{ args: H }],
  [TOOL.removeCertificate]: [{ args: H }],
  [TOOL.getLogs]: [
    { args: { app: 'acme-gw', machine_id: 'm1', next_token: '1779235200000000000' } },
  ],
};

describe('fly plugin — structural kit', () => {
  test('well-formed, presets valid, no wildcard', () => {
    assertPluginWellFormed(flyPlugin);
    assertPresetsValid(flyPlugin);
    assertNoWildcard(flyPlugin);
  });

  test('every tool classifies to slices the catalog covers, every risk is reached, no fallback', () => {
    const report = assertCatalogCoverage(flyPlugin, SAMPLES, { resources: [acme, canary] });
    expect(report.toolsChecked).toBe(flyPlugin.tools.length);
    expect(report.fallbackHits).toEqual([]);
    expect(report.risksUntouched).toEqual([]);
    expect(report.risksTouched).toEqual(
      flyCatalog.catalog.risks.filter((r) => !r.fallback).map((r) => r.id),
    );
  });

  test('hostile identifiers are refused by classify and by execute, or named exactly', async () => {
    const report = await assertIdentifiersRefused(flyPlugin, SAMPLES, {
      resources: [acme, canary],
      routes: [appIdentityRoute(), machineRoute(config()), ...leaseRoutes],
      context: (fetch, resources) => context(fetch, resources),
      exempt: {
        [TOOL.execMachine]: { stdin: 'free text sent in the JSON body, never in a URL' },
      },
    });
    expect(report.toolsChecked).toBe(flyPlugin.tools.length);
    expect(report.pathIdentifiers).toContainEqual({
      tool: TOOL.getMachine,
      argument: 'machine_id',
    });
    expect(report.pathIdentifiers).toContainEqual({ tool: TOOL.getMachine, argument: 'app' });
    expect(report.pathIdentifiers).toContainEqual({ tool: TOOL.getVolume, argument: 'volume_id' });
    expect(report.pathIdentifiers).toContainEqual({
      tool: TOOL.getCertificate,
      argument: 'hostname',
    });
    expect(report.pathIdentifiers).toContainEqual({ tool: TOOL.unsetSecret, argument: 'name' });
    expect(report.pathIdentifiers).toContainEqual({ tool: TOOL.releaseIp, argument: 'ip' });
  });

  test('the catalog is read from a filesystem path next to the plugin module', () => {
    const path = catalogPathNextTo(new URL('../../src/index.ts', import.meta.url));
    expect(path).toBe(fileURLToPath(new URL('../../src/risk-catalog.yaml', import.meta.url)));
    expect(existsSync(path)).toBe(true);
    expect(flyCatalog.catalog.provider).toBe(PROVIDER_ID);
    expect(flyCatalog.catalog.risks.find((r) => r.fallback)?.id).toBe(
      `${PROVIDER_ID}.uncategorized-write`,
    );
  });

  test('tool names are derived from the provider id, once, and every tool has a title', () => {
    const prefix = toolPrefixFor(PROVIDER_ID);
    expect(flyPlugin.tools.map((t) => t.name)).toEqual(Object.values(TOOL));
    expect(Object.values(TOOL).every((name) => name.startsWith(prefix))).toBe(true);
    expect(Object.keys(flyPlugin.toolTitles ?? {}).sort()).toEqual(Object.values(TOOL).sort());
  });

  test('the secret values of set_secrets are declared for masking', () => {
    expect(flyPlugin.secretArguments).toEqual({ [TOOL.setSecrets]: ['values'] });
  });

  test('creating an app is declared as creating a resource, and nothing else is', () => {
    // An app is what discovery lists : after fly__create_app the host runs
    // discovery again (ADR created-resources-join-the-mission). A machine, a
    // volume or a certificate lives inside an app and creates no resource.
    expect(flyPlugin.resourceCreatingTools).toEqual([TOOL.createApp]);
    expect(flyPlugin.tools.map((t) => t.name)).toContain(TOOL.createApp);
  });

  test('the plugin is the default export, and its version is the package version', () => {
    expect(defaultExport).toBe(flyPlugin);
    const manifest: unknown = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    );
    expect(manifest).toMatchObject({ version: flyPlugin.version });
  });
});
