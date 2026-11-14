/**
 * Representative calls of every tool of the `fly` provider
 * (`ProviderPlugin.examples`) : the samples the plugin's tests run through the
 * kit and the site classifies when it builds (ADR
 * plugin-contract-and-credential-spec, amendment 2026-11-05).
 *
 * One realistic call per tool, and the refusals worth showing. Unless a sample
 * names its own, it runs on two apps of the `vaubaan` organization : a
 * production one and a staging canary.
 */
import { samplesOn, type Resource, type ToolSamples } from '@vaubaan/plugin-sdk';

import { PROVIDER_ID, TOOL } from './identity.ts';

/** An app of the `vaubaan` organization as discovery returns it, labelled by its owner. */
function exampleApp(name: string, env: 'prod' | 'staging', id: string): Resource {
  return {
    provider: PROVIDER_ID,
    ref: name,
    env,
    displayName: name,
    metadata: {
      app_id: id,
      org_slug: 'vaubaan',
      network: `${name}-net`,
      image_prefixes: 'ghcr.io/vaubaan/gateway',
    },
  };
}

/** A production app. */
export const EXAMPLE_PROD_APP = exampleApp('acme-gw', 'prod', 'app-acme');
/** A canary instance. */
export const EXAMPLE_CANARY_APP = exampleApp('canary-gw', 'staging', 'app-canary');

/** An image pinned by digest, under the account's allowed prefix. */
const IMAGE = `ghcr.io/vaubaan/gateway:1.4.0@sha256:${'a'.repeat(64)}`;

const config = (image: string = IMAGE) => ({
  image,
  guest: { cpu_kind: 'shared', cpus: 1, memory_mb: 512 },
  mounts: [],
});

const M = { app: 'acme-gw', machine_id: 'm1' };
const V = { app: 'acme-gw', volume_id: 'vol_1' };
const H = { app: 'acme-gw', hostname: 'acme.example.com' };

export const flyExamples: ToolSamples = samplesOn([EXAMPLE_PROD_APP, EXAMPLE_CANARY_APP], {
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
});
