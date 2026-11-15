/**
 * Representative calls of every tool of the `cloudflare-dns` service
 * (`ServicePlugin.examples`) : the samples the plugin's tests run through the
 * kit and the site classifies when it builds (ADR
 * plugin-contract-and-credential-spec, amendment 2026-11-05).
 *
 * Unless a sample names its own, it runs on the zone `example.com`. Every
 * risk of the catalog is reached, none through the fallback.
 */
import { samplesOn, type Resource, type ToolSamples } from '@vaubaan/plugin-sdk';

import { SERVICE_ID, TOOL } from './identity.ts';

/** The zone the samples run on, as discovery returns it. */
export const EXAMPLE_ZONE: Resource = {
  service: SERVICE_ID,
  ref: 'z1',
  displayName: 'example.com',
  metadata: { account_id: 'acct1', zone_name: 'example.com' },
};

/** A resource of another service : a mission holding no zone. */
const FOREIGN_RESOURCE: Resource = { service: 'github', ref: 'acme/app', displayName: 'app' };

export const cloudflareDnsExamples: ToolSamples = samplesOn([EXAMPLE_ZONE], {
  [TOOL.listZones]: [{ args: {} }, { args: {}, resources: [FOREIGN_RESOURCE], expectDenied: true }],
  [TOOL.getZone]: [{ args: { zone_id: 'z1' } }],
  [TOOL.listRecords]: [{ args: { zone_id: 'z1', type: 'A' } }],
  [TOOL.getRecord]: [{ args: { zone_id: 'z1', record_id: 'r1' } }],
  [TOOL.exportRecords]: [{ args: { zone_id: 'z1' } }],
  [TOOL.getZoneSettings]: [{ args: { zone_id: 'z1' } }],
  [TOOL.getDnssec]: [{ args: { zone_id: 'z1' } }],
  [TOOL.createRecord]: [
    { args: { zone_id: 'z1', type: 'A', name: 'www.example.com', content: '192.0.2.1' } },
    { args: { zone_id: 'z1', type: 'A', name: 'example.com', content: '192.0.2.1' } },
  ],
  [TOOL.updateRecord]: [
    { args: { zone_id: 'z1', record_id: 'r1', type: 'A', name: 'www.example.com' } },
    { args: { zone_id: 'z1', record_id: 'r1', type: 'MX', name: 'example.com' } },
    { args: { zone_id: 'z1', type: 'A', name: 'www.example.com' }, expectDenied: true },
  ],
  [TOOL.deleteRecord]: [
    { args: { zone_id: 'z1', record_id: 'r1' } },
    { args: { zone_id: 'z1', record_id: 'r1', type: 'A', name: 'www.example.com' } },
    { args: { zone_id: 'z1', record_id: 'r1', type: 'NS', name: 'sub.example.com' } },
    { args: { zone_id: 'z1', record_id: '..' }, expectDenied: true },
  ],
  [TOOL.importRecords]: [{ args: { zone_id: 'z1', file: ';; bind' } }],
  [TOOL.editZoneSettings]: [{ args: { zone_id: 'z1', items: [{ id: 'ssl', value: 'strict' }] } }],
  [TOOL.purgeCache]: [{ args: { zone_id: 'z1', purge_everything: true } }],
  [TOOL.editDnssec]: [{ args: { zone_id: 'z1', status: 'active' } }],
  [TOOL.deleteZone]: [{ args: { zone_id: 'z1' } }],
});
