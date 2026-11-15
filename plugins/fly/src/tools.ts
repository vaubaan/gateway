/**
 * MCP tools of the `fly` service.
 *
 * Every tool that acts on an app takes `app`, the app name — one of the
 * mission's Fly apps ; absent, the mission's single app. The `properties` of
 * each schema are the whole argument surface of the tool : the classifier
 * refuses any other argument (handbook).
 */

import type { McpToolDeclaration } from '@vaubaan/plugin-sdk';

import { TOOL } from './identity.ts';

type Schema = Readonly<Record<string, unknown>>;

const APP: Schema = {
  type: 'string',
  description:
    'The Fly app name, one of the apps of the mission. Optional when the mission has one app.',
};
const MACHINE_ID: Schema = { type: 'string', description: 'The machine id (from list_machines).' };
const VOLUME_ID: Schema = { type: 'string', description: 'The volume id (`vol_…`).' };
const HOSTNAME: Schema = {
  type: 'string',
  description: 'The hostname of the certificate, lower case (`app.example.com`). No wildcard.',
};
const IMAGE: Schema = {
  type: 'string',
  description:
    'Image reference pinned by digest, under an allowed prefix of the account: ' +
    '`ghcr.io/vaubaan/gateway:1.4.0@sha256:<64 hex>`. A tag alone is refused.',
};
const CONFIG: Schema = {
  type: 'object',
  description:
    'The whole machine config of the Machines API (image, env, services, mounts, guest…). ' +
    'Every image it names must pass the image guard.',
};
const REGION: Schema = { type: 'string', description: 'Fly region code (`cdg`, `iad`).' };

function tool(
  name: string,
  description: string,
  properties: Readonly<Record<string, Schema>>,
  required: readonly string[] = [],
): McpToolDeclaration {
  return {
    name,
    description,
    inputSchema: {
      type: 'object',
      properties: { ...properties },
      ...(required.length > 0 ? { required: [...required] } : {}),
    },
  };
}

const onMachine = { app: APP, machine_id: MACHINE_ID };
const onVolume = { app: APP, volume_id: VOLUME_ID };
const onCertificate = { app: APP, hostname: HOSTNAME };

export const flyTools: readonly McpToolDeclaration[] = [
  tool(TOOL.listRegions, 'List the Fly regions a machine or volume can be placed in.', {}),
  tool(
    TOOL.listApps,
    "List the organization's apps that this mission may touch (other apps are left out).",
    {},
  ),
  tool(TOOL.getApp, 'Read one app: id, status, network, organization.', { app: APP }),
  tool(
    TOOL.createApp,
    'Create an app in the account organization, on a private network of its own. ' +
      'The new app is not part of this mission until its owner labels it and adds it.',
    {
      name: { type: 'string', description: 'The new app name (lower case, digits, hyphens).' },
      network: {
        type: 'string',
        description: 'Name of the private network the app is isolated on; required.',
      },
    },
    ['name', 'network'],
  ),
  tool(
    TOOL.destroyApp,
    'Destroy an app with its machines, volumes and their snapshots. Cannot be undone. ' +
      'Running machines must be stopped first.',
    { app: APP },
  ),

  tool(TOOL.listMachines, 'List the machines of an app.', {
    app: APP,
    region: { ...REGION, description: 'Only the machines of this region.' },
  }),
  tool(TOOL.getMachine, 'Read one machine: state, config, image, events.', onMachine, [
    'machine_id',
  ]),
  tool(
    TOOL.listMachineEvents,
    'List the events of a machine.',
    { ...onMachine, limit: { type: 'integer', minimum: 1, maximum: 100 } },
    ['machine_id'],
  ),
  tool(TOOL.listMachineProcesses, 'List the processes running in a machine.', onMachine, [
    'machine_id',
  ]),
  tool(
    TOOL.waitMachine,
    'Wait until a machine reaches a state (at most 60 seconds).',
    {
      ...onMachine,
      state: { type: 'string', enum: ['started', 'stopped', 'suspended', 'destroyed'] },
      timeout: { type: 'integer', minimum: 1, maximum: 60 },
    },
    ['machine_id', 'state'],
  ),
  tool(
    TOOL.createMachine,
    'Create a machine in an app from a full config. Every image of the config must be pinned ' +
      'by digest under an allowed prefix.',
    {
      app: APP,
      config: CONFIG,
      region: REGION,
      name: { type: 'string', description: 'Optional machine name.' },
      skip_launch: { type: 'boolean', description: 'Create without starting it.' },
    },
    ['config', 'region'],
  ),
  tool(
    TOOL.updateMachine,
    'Replace the whole config of a machine (Fly takes no partial update); the machine restarts. ' +
      'Prefer deploy_image or scale_machine to change one thing. A volume it mounts needs a ' +
      'fresh snapshot when the image changes.',
    { ...onMachine, config: CONFIG, skip_launch: { type: 'boolean' } },
    ['machine_id', 'config'],
  ),
  tool(
    TOOL.deployImage,
    'Change only the image of a machine, under a lease; the machine restarts. Every volume it ' +
      'mounts needs a snapshot taken in the last hour (create_snapshot, then wait for it).',
    { ...onMachine, image: IMAGE },
    ['machine_id', 'image'],
  ),
  tool(
    TOOL.scaleMachine,
    'Change only the CPU and memory of a machine, under a lease; the machine restarts.',
    {
      ...onMachine,
      cpu_kind: { type: 'string', enum: ['shared', 'performance'] },
      cpus: { type: 'integer', minimum: 1, maximum: 16 },
      memory_mb: { type: 'integer', minimum: 256, maximum: 131072 },
    },
    ['machine_id', 'cpu_kind', 'cpus', 'memory_mb'],
  ),
  tool(TOOL.startMachine, 'Start a stopped or suspended machine.', onMachine, ['machine_id']),
  tool(TOOL.stopMachine, 'Stop a machine.', onMachine, ['machine_id']),
  tool(TOOL.restartMachine, 'Restart a machine.', onMachine, ['machine_id']),
  tool(TOOL.suspendMachine, 'Suspend a machine (memory snapshot).', onMachine, ['machine_id']),
  tool(TOOL.cordonMachine, 'Route traffic away from a machine.', onMachine, ['machine_id']),
  tool(TOOL.uncordonMachine, 'Route traffic back to a machine.', onMachine, ['machine_id']),
  tool(TOOL.destroyMachine, 'Destroy a stopped machine. Its volumes stay.', onMachine, [
    'machine_id',
  ]),
  tool(
    TOOL.execMachine,
    'Run one command inside a machine and return its output (at most 60 seconds, output cut ' +
      'at 64 KiB). The command runs with the app secrets in its environment.',
    {
      ...onMachine,
      command: {
        type: 'array',
        items: { type: 'string' },
        minItems: 1,
        description: 'The program and its arguments.',
      },
      stdin: { type: 'string', description: 'Standard input of the command.' },
      timeout: { type: 'integer', minimum: 1, maximum: 60 },
    },
    ['machine_id', 'command'],
  ),

  tool(TOOL.listVolumes, 'List the volumes of an app.', { app: APP }),
  tool(TOOL.getVolume, 'Read one volume.', onVolume, ['volume_id']),
  tool(TOOL.listSnapshots, 'List the snapshots of a volume.', onVolume, ['volume_id']),
  tool(
    TOOL.createVolume,
    'Create a volume, empty or from a snapshot or another volume of the same app.',
    {
      app: APP,
      name: { type: 'string', description: 'Volume name: letters, digits, underscores.' },
      region: REGION,
      size_gb: { type: 'integer', minimum: 1, maximum: 500 },
      snapshot_id: { type: 'string', description: 'Restore from this snapshot of the same app.' },
      source_volume_id: { type: 'string', description: 'Fork this volume of the same app.' },
      auto_backup_enabled: { type: 'boolean', description: 'Daily snapshots; default on.' },
      snapshot_retention: { type: 'integer', minimum: 1, maximum: 60 },
    },
    ['name', 'region', 'size_gb'],
  ),
  tool(
    TOOL.extendVolume,
    'Grow a volume. It cannot shrink.',
    { ...onVolume, size_gb: { type: 'integer', minimum: 1, maximum: 500 } },
    ['volume_id', 'size_gb'],
  ),
  tool(
    TOOL.updateVolume,
    'Change the automatic daily snapshots of a volume and their retention.',
    {
      ...onVolume,
      auto_backup_enabled: { type: 'boolean' },
      snapshot_retention: { type: 'integer', minimum: 1, maximum: 60 },
    },
    ['volume_id'],
  ),
  tool(TOOL.createSnapshot, 'Take a snapshot of a volume now.', onVolume, ['volume_id']),
  tool(
    TOOL.destroyVolume,
    'Destroy a volume. Cannot be undone; only its snapshots remain, until they expire.',
    onVolume,
    ['volume_id'],
  ),

  tool(TOOL.listSecrets, 'List the names and digests of the app secrets (never their values).', {
    app: APP,
  }),
  tool(
    TOOL.setSecrets,
    'Set app secrets. Machines pick them up when next updated (deploy_image with the same image).',
    {
      app: APP,
      values: {
        type: 'object',
        additionalProperties: { type: 'string' },
        description: 'Secret name → value; at most 50.',
      },
    },
    ['values'],
  ),
  tool(TOOL.unsetSecret, 'Remove one app secret.', { app: APP, name: { type: 'string' } }, [
    'name',
  ]),

  tool(TOOL.listIps, 'List the IP addresses of an app.', { app: APP }),
  tool(
    TOOL.allocateIp,
    'Allocate an IP address to an app. A dedicated IPv4 is billed monthly.',
    {
      app: APP,
      type: { type: 'string', enum: ['v4', 'v6', 'shared_v4', 'private_v6'] },
      region: REGION,
    },
    ['type'],
  ),
  tool(TOOL.releaseIp, 'Release an IP address of an app.', { app: APP, ip: { type: 'string' } }, [
    'ip',
  ]),

  tool(TOOL.listCertificates, 'List the TLS certificates of an app.', { app: APP }),
  tool(TOOL.getCertificate, 'Read one certificate and its DNS requirements.', onCertificate, [
    'hostname',
  ]),
  tool(
    TOOL.requestCertificate,
    'Ask Fly to issue a certificate (ACME) for a hostname pointing at the app.',
    onCertificate,
    ['hostname'],
  ),
  tool(
    TOOL.checkCertificate,
    'Check the DNS of a hostname and validate its certificate again.',
    onCertificate,
    ['hostname'],
  ),
  tool(TOOL.removeCertificate, 'Remove the certificate of a hostname.', onCertificate, [
    'hostname',
  ]),

  tool(TOOL.getLogs, 'Read recent logs of an app (100 lines per page).', {
    app: APP,
    machine_id: { ...MACHINE_ID, description: 'Only the logs of this machine.' },
    region: { ...REGION, description: 'Only the logs of this region.' },
    next_token: {
      type: 'string',
      description: 'Cursor of the next page: the meta.next_token of the previous answer.',
    },
  }),
];

/** What each tool does, for the head of an approval request. */
export const flyToolTitles: Readonly<Record<string, string>> = {
  [TOOL.listRegions]: 'List regions',
  [TOOL.listApps]: 'List apps',
  [TOOL.getApp]: 'Read an app',
  [TOOL.createApp]: 'Create an app',
  [TOOL.destroyApp]: 'Destroy an app',
  [TOOL.listMachines]: 'List machines',
  [TOOL.getMachine]: 'Read a machine',
  [TOOL.listMachineEvents]: 'List machine events',
  [TOOL.listMachineProcesses]: 'List machine processes',
  [TOOL.waitMachine]: 'Wait for a machine state',
  [TOOL.createMachine]: 'Create a machine',
  [TOOL.updateMachine]: 'Replace a machine configuration',
  [TOOL.deployImage]: 'Change the image of a machine',
  [TOOL.scaleMachine]: 'Resize a machine',
  [TOOL.startMachine]: 'Start a machine',
  [TOOL.stopMachine]: 'Stop a machine',
  [TOOL.restartMachine]: 'Restart a machine',
  [TOOL.suspendMachine]: 'Suspend a machine',
  [TOOL.cordonMachine]: 'Route traffic away from a machine',
  [TOOL.uncordonMachine]: 'Route traffic back to a machine',
  [TOOL.destroyMachine]: 'Destroy a machine',
  [TOOL.execMachine]: 'Run a command inside a machine',
  [TOOL.listVolumes]: 'List volumes',
  [TOOL.getVolume]: 'Read a volume',
  [TOOL.listSnapshots]: 'List volume snapshots',
  [TOOL.createVolume]: 'Create a volume',
  [TOOL.extendVolume]: 'Extend a volume',
  [TOOL.updateVolume]: 'Change automatic snapshots',
  [TOOL.createSnapshot]: 'Take a volume snapshot',
  [TOOL.destroyVolume]: 'Destroy a volume',
  [TOOL.listSecrets]: 'List secret names',
  [TOOL.setSecrets]: 'Set app secrets',
  [TOOL.unsetSecret]: 'Remove an app secret',
  [TOOL.listIps]: 'List IP addresses',
  [TOOL.allocateIp]: 'Allocate an IP address',
  [TOOL.releaseIp]: 'Release an IP address',
  [TOOL.listCertificates]: 'List certificates',
  [TOOL.getCertificate]: 'Read a certificate',
  [TOOL.requestCertificate]: 'Request a certificate',
  [TOOL.checkCertificate]: 'Check a certificate',
  [TOOL.removeCertificate]: 'Remove a certificate',
  [TOOL.getLogs]: 'Read app logs',
};
