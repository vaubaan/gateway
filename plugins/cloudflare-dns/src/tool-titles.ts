/**
 * What each tool of the `cloudflare-dns` service does, in a few words a person reads at
 * a glance (`ServicePlugin.toolTitles`) : the head of an approval request in
 * the web interface, before the resource the call resolves to. A verb and its
 * object, sentence case, no final period. For people only : never part of
 * `tools/list`, and the host decides nothing from it.
 *
 * A structural test of the gateway checks that every tool of a shipped plugin
 * has its title : a new tool is added here with its declaration.
 */

import { TOOL } from './identity.ts';

export const cloudflareDnsToolTitles: Readonly<Record<string, string>> = {
  [TOOL.listZones]: 'List DNS zones',
  [TOOL.getZone]: 'Read a DNS zone',
  [TOOL.listRecords]: 'List DNS records',
  [TOOL.getRecord]: 'Read a DNS record',
  [TOOL.exportRecords]: 'Export the DNS records of a zone',
  [TOOL.getZoneSettings]: 'Read the settings of a zone',
  [TOOL.getDnssec]: 'Read the DNSSEC status',
  [TOOL.createRecord]: 'Create a DNS record',
  [TOOL.updateRecord]: 'Change a DNS record',
  [TOOL.deleteRecord]: 'Delete a DNS record',
  [TOOL.importRecords]: 'Import DNS records in bulk',
  [TOOL.editZoneSettings]: 'Change the settings of a zone',
  [TOOL.purgeCache]: 'Purge the cache of a zone',
  [TOOL.editDnssec]: 'Turn DNSSEC on or off',
  [TOOL.deleteZone]: 'Delete a DNS zone',
};
