/**
 * Classifier of the `fly` provider : `(tool, args, resources) → slices`.
 *
 * Spec : docs/spec/gateway-risk-model.md §7. Handbook : docs/handbook/providers/fly.md.
 *
 * Pure. Every identifier and value is read by `readFlyCall`, the reader
 * `execute` uses too ; this module only says what the call touches. The
 * `org[<slug>]` segment names the connection's organization (its public form
 * field), else the one the mission's apps share, else `org[*]` : the catalog
 * matches `org[*]`, so the name is for the reader, never a way around a risk. A call
 * that does several things returns one slice per thing : creating a machine
 * writes the collection, a configuration and an image ; replacing a config
 * may change the image and the size as well.
 */

import {
  ANY_IDENT,
  identSegment,
  type ClassifyConnection,
  type ClassifyOutcome,
  type Resource,
  type Slice,
  type SliceSegment,
} from '@vaubaan/plugin-sdk';

import { isDenial, readFlyCall, type FlyCall } from './call.ts';
import { PROVIDER_ID, TOOL } from './identity.ts';

const name = (value: string): SliceSegment => ({ kind: 'name', value });

function slice(path: readonly SliceSegment[], action: 'R' | 'W'): Slice {
  return { provider: PROVIDER_ID, path: [...path], action };
}

function orgPath(call: FlyCall): SliceSegment[] {
  return [name('org'), call.org ? identSegment(call.org) : ANY_IDENT];
}

function appPath(call: FlyCall): SliceSegment[] {
  return [...orgPath(call), name('app'), identSegment(call.app!.ref)];
}

function machinePath(call: FlyCall): SliceSegment[] {
  return [...appPath(call), name('machine'), identSegment(call.machineId!)];
}

function volumePath(call: FlyCall): SliceSegment[] {
  return [...appPath(call), name('volume'), identSegment(call.volumeId!)];
}

function certificatePath(call: FlyCall): SliceSegment[] {
  return [...appPath(call), name('certificate'), identSegment(call.hostname!)];
}

/** The slices a read call touches. */
function readSlices(call: FlyCall): Slice[] | null {
  switch (call.tool) {
    case TOOL.listRegions:
      return [slice([...orgPath(call), name('region'), ANY_IDENT], 'R')];
    case TOOL.listApps:
      return [slice([...orgPath(call), name('app'), ANY_IDENT], 'R')];
    case TOOL.getApp:
      return [slice(appPath(call), 'R')];
    case TOOL.listMachines:
      return [slice([...appPath(call), name('machine'), ANY_IDENT], 'R')];
    case TOOL.getMachine:
    case TOOL.waitMachine:
      return [slice(machinePath(call), 'R')];
    case TOOL.listMachineEvents:
      return [slice([...machinePath(call), name('event'), ANY_IDENT], 'R')];
    case TOOL.listMachineProcesses:
      return [slice([...machinePath(call), name('process'), ANY_IDENT], 'R')];
    case TOOL.listVolumes:
      return [slice([...appPath(call), name('volume'), ANY_IDENT], 'R')];
    case TOOL.getVolume:
      return [slice(volumePath(call), 'R')];
    case TOOL.listSnapshots:
      return [slice([...volumePath(call), name('snapshot'), ANY_IDENT], 'R')];
    case TOOL.listSecrets:
      return [slice([...appPath(call), name('secret'), ANY_IDENT], 'R')];
    case TOOL.listIps:
      return [slice([...appPath(call), name('ip'), ANY_IDENT], 'R')];
    case TOOL.listCertificates:
      return [slice([...appPath(call), name('certificate'), ANY_IDENT], 'R')];
    case TOOL.getCertificate:
      return [slice(certificatePath(call), 'R')];
    case TOOL.getLogs:
      return [slice([...appPath(call), name('logs')], 'R')];
    default:
      return null;
  }
}

/** The slices a write call touches. */
function writeSlices(call: FlyCall): Slice[] {
  const machines = (): SliceSegment[] => [...appPath(call), name('machine')];
  const volumes = (): SliceSegment[] => [...appPath(call), name('volume')];
  switch (call.tool) {
    case TOOL.createApp:
      return [slice([...orgPath(call), name('app')], 'W')];
    case TOOL.destroyApp:
      return [slice([...appPath(call), name('app-destroy')], 'W')];
    case TOOL.createMachine:
      return [
        slice(machines(), 'W'),
        slice([...machines(), name('config')], 'W'),
        slice([...machines(), name('image')], 'W'),
      ];
    case TOOL.updateMachine:
      // A whole config replaces everything : what runs, its size, the rest.
      return [
        slice([...machinePath(call), name('config')], 'W'),
        slice([...machinePath(call), name('image')], 'W'),
        slice([...machinePath(call), name('guest')], 'W'),
      ];
    case TOOL.deployImage:
      return [slice([...machinePath(call), name('image')], 'W')];
    case TOOL.scaleMachine:
      return [slice([...machinePath(call), name('guest')], 'W')];
    case TOOL.startMachine:
    case TOOL.stopMachine:
    case TOOL.restartMachine:
    case TOOL.suspendMachine:
    case TOOL.cordonMachine:
    case TOOL.uncordonMachine:
      return [slice([...machinePath(call), name('power')], 'W')];
    case TOOL.destroyMachine:
      return [slice([...machinePath(call), name('machine-destroy')], 'W')];
    case TOOL.execMachine:
      return [slice([...machinePath(call), name('exec')], 'W')];
    case TOOL.createVolume: {
      const out = [slice(volumes(), 'W')];
      if (call.values.snapshot_id !== undefined || call.values.source_volume_id !== undefined) {
        out.push(slice([...volumes(), name('restore')], 'W'));
      }
      if (
        call.values.auto_backup_enabled !== undefined ||
        call.values.snapshot_retention !== undefined
      ) {
        out.push(slice([...volumes(), name('backup-settings')], 'W'));
      }
      return out;
    }
    case TOOL.extendVolume:
      return [slice([...volumePath(call), name('extend')], 'W')];
    case TOOL.updateVolume:
      return [slice([...volumePath(call), name('backup-settings')], 'W')];
    case TOOL.createSnapshot:
      return [slice([...volumePath(call), name('snapshot')], 'W')];
    case TOOL.destroyVolume:
      return [slice([...volumePath(call), name('volume-destroy')], 'W')];
    case TOOL.setSecrets:
    case TOOL.unsetSecret: {
      const names = call.secretNames ?? [];
      const segment: SliceSegment =
        names.length === 1 ? identSegment(names[0]!) : { kind: 'list', values: [...names] };
      return [slice([...appPath(call), name('secret'), segment], 'W')];
    }
    case TOOL.allocateIp:
      return [slice([...appPath(call), name('ip')], 'W')];
    case TOOL.releaseIp:
      return [
        slice([...appPath(call), name('ip'), identSegment(call.ip!), name('ip-release')], 'W'),
      ];
    case TOOL.requestCertificate:
    case TOOL.checkCertificate:
      return [slice(certificatePath(call), 'W')];
    case TOOL.removeCertificate:
      return [slice([...certificatePath(call), name('certificate-remove')], 'W')];
    default:
      return [];
  }
}

export function classifyFly(
  tool: string,
  args: Readonly<Record<string, unknown>>,
  resources: readonly Resource[],
  connection?: ClassifyConnection,
): ClassifyOutcome {
  const call = readFlyCall(tool, args, resources, connection);
  if (isDenial(call)) return call;
  const slices = readSlices(call) ?? writeSlices(call);
  // A tool of the list that maps to nothing is a defect of this module : refuse it.
  if (slices.length === 0) return { denied: `unknown tool '${tool}'` };
  return { slices };
}
