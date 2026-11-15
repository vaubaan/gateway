/**
 * Identity of the `fly` service — the one place its ids are written.
 *
 * Everything else (data-model service, tool names, resources, credential
 * fields) is derived from this module.
 */

import { toolPrefixFor } from '@vaubaan/plugin-sdk';

/** The service id. */
export const SERVICE_ID = 'fly';

/** Secret field of the `api-key` credential : a token printed by `fly tokens create org`. */
export const API_TOKEN_FIELD = 'api_token';

/** Non-secret field : the slug of the one Fly organization the account works in. */
export const ORG_SLUG_FIELD = 'org_slug';

/**
 * Non-secret field : the image prefixes a machine may run, comma-separated.
 * Empty means `DEFAULT_IMAGE_PREFIXES`.
 */
export const IMAGE_PREFIXES_FIELD = 'image_prefixes';

/** The images an account may deploy when its owner names none. */
export const DEFAULT_IMAGE_PREFIXES: readonly string[] = ['ghcr.io/vaubaan/gateway'];

const prefix = toolPrefixFor(SERVICE_ID);

/** The MCP tool names, `fly__<verb>_<noun>`. */
export const TOOL = {
  listRegions: `${prefix}list_regions`,
  listApps: `${prefix}list_apps`,
  getApp: `${prefix}get_app`,
  createApp: `${prefix}create_app`,
  destroyApp: `${prefix}destroy_app`,

  listMachines: `${prefix}list_machines`,
  getMachine: `${prefix}get_machine`,
  listMachineEvents: `${prefix}list_machine_events`,
  listMachineProcesses: `${prefix}list_machine_processes`,
  waitMachine: `${prefix}wait_machine`,
  createMachine: `${prefix}create_machine`,
  updateMachine: `${prefix}update_machine`,
  deployImage: `${prefix}deploy_image`,
  scaleMachine: `${prefix}scale_machine`,
  startMachine: `${prefix}start_machine`,
  stopMachine: `${prefix}stop_machine`,
  restartMachine: `${prefix}restart_machine`,
  suspendMachine: `${prefix}suspend_machine`,
  cordonMachine: `${prefix}cordon_machine`,
  uncordonMachine: `${prefix}uncordon_machine`,
  destroyMachine: `${prefix}destroy_machine`,
  execMachine: `${prefix}exec_machine`,

  listVolumes: `${prefix}list_volumes`,
  getVolume: `${prefix}get_volume`,
  listSnapshots: `${prefix}list_snapshots`,
  createVolume: `${prefix}create_volume`,
  extendVolume: `${prefix}extend_volume`,
  updateVolume: `${prefix}update_volume`,
  createSnapshot: `${prefix}create_snapshot`,
  destroyVolume: `${prefix}destroy_volume`,

  listSecrets: `${prefix}list_secrets`,
  setSecrets: `${prefix}set_secrets`,
  unsetSecret: `${prefix}unset_secret`,

  listIps: `${prefix}list_ips`,
  allocateIp: `${prefix}allocate_ip`,
  releaseIp: `${prefix}release_ip`,

  listCertificates: `${prefix}list_certificates`,
  getCertificate: `${prefix}get_certificate`,
  requestCertificate: `${prefix}request_certificate`,
  checkCertificate: `${prefix}check_certificate`,
  removeCertificate: `${prefix}remove_certificate`,

  getLogs: `${prefix}get_logs`,
} as const;
