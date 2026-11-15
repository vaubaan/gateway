/**
 * Identity of the `cloudflare-dns` service — the one place its ids are written.
 *
 * Handbook : docs/handbook/services/cloudflare-dns.md.
 *
 * `SERVICE_ID` is also written as `service:` and as the prefix of every id
 * in `risk-catalog.yaml`, and in the package name. Everything else — the
 * plugin id, the data-model service, the tool names, the resources
 * discovery returns — is derived from this module.
 */

import { toolPrefixFor } from '@vaubaan/plugin-sdk';

/** The service id. */
export const SERVICE_ID = 'cloudflare-dns';

/** `cloudflare_dns__` : prepended to every tool name. */
export const TOOL_PREFIX = toolPrefixFor(SERVICE_ID);

/** Public API of the service — a fact about Cloudflare, not instance configuration. */
export const CLOUDFLARE_API_BASE = 'https://api.cloudflare.com/client/v4';

/** Credential field holding the API token. */
export const API_TOKEN_FIELD = 'api_token';

/** The MCP tool names, in the order `tools/list` gives them. */
export const TOOL = {
  listZones: `${TOOL_PREFIX}list_zones`,
  getZone: `${TOOL_PREFIX}get_zone`,
  listRecords: `${TOOL_PREFIX}list_records`,
  getRecord: `${TOOL_PREFIX}get_record`,
  exportRecords: `${TOOL_PREFIX}export_records`,
  getZoneSettings: `${TOOL_PREFIX}get_zone_settings`,
  getDnssec: `${TOOL_PREFIX}get_dnssec`,
  createRecord: `${TOOL_PREFIX}create_record`,
  updateRecord: `${TOOL_PREFIX}update_record`,
  deleteRecord: `${TOOL_PREFIX}delete_record`,
  importRecords: `${TOOL_PREFIX}import_records`,
  editZoneSettings: `${TOOL_PREFIX}edit_zone_settings`,
  purgeCache: `${TOOL_PREFIX}purge_cache`,
  editDnssec: `${TOOL_PREFIX}edit_dnssec`,
  deleteZone: `${TOOL_PREFIX}delete_zone`,
} as const;
